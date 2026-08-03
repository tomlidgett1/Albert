BEGIN;

-- Review decisions are modelled as reversible graph edges.  Canonical source
-- entities remain immutable; semantic queries resolve historical facts through
-- the current tenant-local component representative.
CREATE TABLE IF NOT EXISTS core.entity_identity_edge (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)),
  identity_review_task_id text NOT NULL CHECK (core.is_ulid(identity_review_task_id)),
  entity_type text NOT NULL REFERENCES core.entity_type_lookup(value),
  left_entity_id text NOT NULL CHECK (core.is_ulid(left_entity_id)),
  right_entity_id text NOT NULL CHECK (core.is_ulid(right_entity_id)),
  decision_id text NOT NULL CHECK (core.is_ulid(decision_id)),
  decision_version integer NOT NULL CHECK (decision_version > 0),
  decision text NOT NULL REFERENCES core.match_status_lookup(value),
  decided_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,identity_review_task_id),
  CHECK (left_entity_id<>right_entity_id),
  CHECK (decision IN ('accepted','rejected','proposed'))
);

CREATE INDEX IF NOT EXISTS entity_identity_edge_active_idx
  ON core.entity_identity_edge (tenant_id,entity_type,left_entity_id,right_entity_id)
  WHERE decision='accepted';

CREATE TABLE IF NOT EXISTS core.entity_resolution (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)),
  entity_type text NOT NULL REFERENCES core.entity_type_lookup(value),
  member_entity_id text NOT NULL CHECK (core.is_ulid(member_entity_id)),
  resolved_entity_id text NOT NULL CHECK (core.is_ulid(resolved_entity_id)),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,entity_type,member_entity_id)
);

CREATE INDEX IF NOT EXISTS entity_resolution_group_idx
  ON core.entity_resolution (tenant_id,entity_type,resolved_entity_id,member_entity_id);

CREATE TABLE IF NOT EXISTS semantic_internal.identity_decision_history (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)),
  decision_id text NOT NULL CHECK (core.is_ulid(decision_id)),
  identity_review_task_id text NOT NULL CHECK (core.is_ulid(identity_review_task_id)),
  decision_version integer NOT NULL CHECK (decision_version > 0),
  decision text NOT NULL CHECK (decision IN ('accepted','rejected','proposed')),
  entity_type text NOT NULL REFERENCES core.entity_type_lookup(value),
  candidate_links jsonb NOT NULL CHECK (
    jsonb_typeof(candidate_links)='array' AND jsonb_array_length(candidate_links)=2
  ),
  candidate_links_hash text NOT NULL CHECK (candidate_links_hash~'^[0-9a-f]{32}$'),
  decided_by uuid NOT NULL,
  decided_at timestamptz NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id,decision_id),
  UNIQUE (tenant_id,identity_review_task_id,decision_version)
);

-- The baseline preserves the deterministic source-owned link that was current
-- when a review card was generated.  Undo creates a new effective-dated row
-- with these attributes instead of mutating history back in place.
CREATE TABLE IF NOT EXISTS semantic_internal.identity_link_baseline (
  tenant_id text NOT NULL CHECK (core.is_ulid(tenant_id)),
  identity_review_task_id text NOT NULL CHECK (core.is_ulid(identity_review_task_id)),
  entity_type text NOT NULL REFERENCES core.entity_type_lookup(value),
  connection_id text NOT NULL CHECK (core.is_ulid(connection_id)),
  source_object_type text NOT NULL,
  source_record_id text NOT NULL,
  canonical_entity_id text NOT NULL CHECK (core.is_ulid(canonical_entity_id)),
  match_method text NOT NULL REFERENCES core.match_method_lookup(value),
  confidence_band text NOT NULL REFERENCES core.confidence_band_lookup(value),
  evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence)='object'),
  sync_run_id text NOT NULL CHECK (core.is_ulid(sync_run_id)),
  captured_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (
    tenant_id,identity_review_task_id,connection_id,source_object_type,source_record_id
  )
);

-- Semantic bundles pin this state alongside the registry and tenant overlay.
-- A review decision advances the version and recomputes a deterministic digest
-- of the effective graph, preventing cached or in-flight answers from silently
-- spanning two different identity interpretations.
CREATE TABLE IF NOT EXISTS semantic_internal.identity_graph_state (
  tenant_id text PRIMARY KEY CHECK (core.is_ulid(tenant_id)),
  version bigint NOT NULL CHECK (version>0),
  graph_hash text NOT NULL CHECK (graph_hash~'^[0-9a-f]{32}$'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- At most one effective source-to-entity link may be selected.  This is the
-- database fence that prevents a concurrent sync and a review decision from
-- creating ambiguous references.
CREATE UNIQUE INDEX IF NOT EXISTS entity_source_link_one_current_idx
  ON core.entity_source_link (
    tenant_id,entity_type,connection_id,source_object_type,source_record_id
  ) WHERE valid_to IS NULL;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['entity_identity_edge','entity_resolution'] LOOP
    EXECUTE format('ALTER TABLE core.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE core.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON core.%I',table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON core.%I USING (tenant_id=core.current_tenant_id()) WITH CHECK (tenant_id=core.current_tenant_id())',
      table_name
    );
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY['identity_decision_history','identity_link_baseline','identity_graph_state'] LOOP
    EXECUTE format('ALTER TABLE semantic_internal.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE semantic_internal.%I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON semantic_internal.%I',table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON semantic_internal.%I USING (tenant_id=core.current_tenant_id()) WITH CHECK (tenant_id=core.current_tenant_id())',
      table_name
    );
  END LOOP;
END $$;

DROP TRIGGER IF EXISTS identity_decision_history_immutable
  ON semantic_internal.identity_decision_history;
CREATE TRIGGER identity_decision_history_immutable
  BEFORE UPDATE OR DELETE ON semantic_internal.identity_decision_history
  FOR EACH ROW EXECUTE FUNCTION semantic_internal.reject_audit_mutation();

CREATE OR REPLACE FUNCTION semantic_internal.apply_identity_decision(
  p_tenant_id text,
  p_decision_id text,
  p_task_id text,
  p_decision_version integer,
  p_decision text,
  p_entity_type text,
  p_candidate_links jsonb,
  p_decided_by uuid,
  p_decided_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog,core,semantic_internal
AS $$
DECLARE
  prior semantic_internal.identity_decision_history%ROWTYPE;
  current_edge core.entity_identity_edge%ROWTYPE;
  candidate jsonb;
  left_id text;
  right_id text;
  dimension_count integer;
  resolved_count integer;
  cache_rows bigint;
  baseline_row semantic_internal.identity_link_baseline%ROWTYPE;
  current_link core.entity_source_link%ROWTYPE;
  baseline_found boolean;
  graph_version bigint;
  graph_hash text;
BEGIN
  IF p_tenant_id IS DISTINCT FROM core.current_tenant_id()
     OR NOT pg_catalog.pg_has_role(session_user,'transform_rw','member') THEN
    RAISE EXCEPTION 'trusted transform tenant context is required' USING ERRCODE='42501';
  END IF;
  IF NOT core.is_ulid(p_tenant_id) OR NOT core.is_ulid(p_decision_id)
     OR NOT core.is_ulid(p_task_id) OR p_decision_version<1
     OR p_decision NOT IN ('accepted','rejected','proposed')
     OR p_entity_type NOT IN ('worker','location','product_variant','customer_account','supplier')
     OR p_decided_by IS NULL OR p_decided_at IS NULL
     OR jsonb_typeof(p_candidate_links)<>'array'
     OR jsonb_array_length(p_candidate_links)<>2 THEN
    RAISE EXCEPTION 'identity decision projection is invalid' USING ERRCODE='22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_candidate_links) AS item(value)
     WHERE NOT core.is_ulid(item.value->>'canonical_entity_id')
        OR NOT core.is_ulid(item.value->>'connection_id')
        OR length(btrim(coalesce(item.value->>'source_object_type',''))) NOT BETWEEN 1 AND 160
        OR length(btrim(coalesce(item.value->>'source_record_id',''))) NOT BETWEEN 1 AND 500
  ) THEN
    RAISE EXCEPTION 'identity decision candidate is invalid' USING ERRCODE='22023';
  END IF;
  left_id:=p_candidate_links->0->>'canonical_entity_id';
  right_id:=p_candidate_links->1->>'canonical_entity_id';
  IF left_id=right_id OR (
    p_candidate_links->0->>'connection_id'=p_candidate_links->1->>'connection_id'
    AND p_candidate_links->0->>'source_object_type'=p_candidate_links->1->>'source_object_type'
    AND p_candidate_links->0->>'source_record_id'=p_candidate_links->1->>'source_record_id'
  ) THEN
    RAISE EXCEPTION 'identity decision candidates must be distinct' USING ERRCODE='22023';
  END IF;

  -- Projection shares the tenant-wide deletion fence, then takes the narrower
  -- graph lock.  Erasure and identity changes can never interleave.
  PERFORM pg_advisory_xact_lock(hashtextextended('deletion:'||p_tenant_id,0));
  PERFORM pg_advisory_xact_lock(
    hashtextextended('identity:'||p_tenant_id||':'||p_entity_type,0)
  );

  SELECT * INTO prior
    FROM semantic_internal.identity_decision_history AS history
   WHERE history.tenant_id=p_tenant_id AND history.decision_id=p_decision_id;
  IF FOUND THEN
    IF prior.identity_review_task_id<>p_task_id
       OR prior.decision_version<>p_decision_version
       OR prior.decision<>p_decision
       OR prior.entity_type<>p_entity_type
       OR prior.candidate_links_hash<>md5(p_candidate_links::text)
       OR prior.decided_by<>p_decided_by
       OR prior.decided_at<>p_decided_at THEN
      RAISE EXCEPTION 'identity decision replay payload changed' USING ERRCODE='22000';
    END IF;
    SELECT count(*) INTO resolved_count FROM core.entity_resolution
     WHERE tenant_id=p_tenant_id AND entity_type=p_entity_type;
    SELECT state.version,state.graph_hash INTO graph_version,graph_hash
      FROM semantic_internal.identity_graph_state AS state
     WHERE state.tenant_id=p_tenant_id;
    RETURN jsonb_build_object(
      'applied',false,'replayed',true,'stale',false,
      'decisionVersion',p_decision_version,'resolvedEntities',resolved_count,
      'cacheRowsInvalidated',0,
      'identityGraphVersion',coalesce(graph_version,0),
      'identityGraphHash',coalesce(graph_hash,md5(''))
    );
  END IF;

  -- Reject superseded commands before touching dimensions, baselines or the
  -- immutable decision history.  Per-task outbox ordering is also fenced in
  -- the control plane, but this is the authoritative analytical-store guard.
  SELECT * INTO current_edge FROM core.entity_identity_edge AS edge
   WHERE edge.tenant_id=p_tenant_id AND edge.identity_review_task_id=p_task_id
   FOR UPDATE;
  IF FOUND AND current_edge.decision_version>=p_decision_version THEN
    SELECT state.version,state.graph_hash INTO graph_version,graph_hash
      FROM semantic_internal.identity_graph_state AS state
     WHERE state.tenant_id=p_tenant_id;
    RETURN jsonb_build_object(
      'applied',false,'replayed',false,'stale',true,
      'decisionVersion',p_decision_version,'resolvedEntities',0,
      'cacheRowsInvalidated',0,
      'identityGraphVersion',coalesce(graph_version,0),
      'identityGraphHash',coalesce(graph_hash,md5(''))
    );
  END IF;

  -- Both candidate IDs must be real entities of the declared type.
  SELECT count(DISTINCT id) INTO dimension_count FROM (
    SELECT id FROM core.worker WHERE p_entity_type='worker' AND tenant_id=p_tenant_id AND id IN (left_id,right_id)
    UNION ALL
    SELECT id FROM core.location WHERE p_entity_type='location' AND tenant_id=p_tenant_id AND id IN (left_id,right_id)
    UNION ALL
    SELECT id FROM core.product_variant WHERE p_entity_type='product_variant' AND tenant_id=p_tenant_id AND id IN (left_id,right_id)
    UNION ALL
    SELECT id FROM core.customer_account WHERE p_entity_type='customer_account' AND tenant_id=p_tenant_id AND id IN (left_id,right_id)
    UNION ALL
    SELECT id FROM core.supplier WHERE p_entity_type='supplier' AND tenant_id=p_tenant_id AND id IN (left_id,right_id)
  ) AS dimensions;
  IF dimension_count<>2 THEN
    RAISE EXCEPTION 'identity candidate entity is missing' USING ERRCODE='P0002';
  END IF;

  -- Capture the exact current source-owned links on the first decision.  A
  -- historical link is never eligible: accepting a stale card must not
  -- overwrite a newer source mapping.  Subsequent versions validate the same
  -- immutable anchors and only change the graph edge.
  FOR candidate IN SELECT value FROM jsonb_array_elements(p_candidate_links) AS item(value) LOOP
    SELECT * INTO baseline_row
      FROM semantic_internal.identity_link_baseline AS baseline
     WHERE baseline.tenant_id=p_tenant_id
       AND baseline.identity_review_task_id=p_task_id
       AND baseline.connection_id=candidate->>'connection_id'
       AND baseline.source_object_type=candidate->>'source_object_type'
       AND baseline.source_record_id=candidate->>'source_record_id';
    baseline_found:=FOUND;

    SELECT * INTO current_link
      FROM core.entity_source_link AS link
     WHERE link.tenant_id=p_tenant_id AND link.entity_type=p_entity_type
       AND link.connection_id=candidate->>'connection_id'
       AND link.source_object_type=candidate->>'source_object_type'
       AND link.source_record_id=candidate->>'source_record_id'
       AND link.match_status='accepted' AND link.valid_to IS NULL
     FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'identity candidate source is no longer active' USING ERRCODE='P0002';
    END IF;

    IF NOT baseline_found THEN
      IF current_link.canonical_entity_id<>(candidate->>'canonical_entity_id')
         OR current_link.match_method='user_confirmed' THEN
        RAISE EXCEPTION 'identity review card does not reference a source-owned link' USING ERRCODE='P0002';
      END IF;
      INSERT INTO semantic_internal.identity_link_baseline (
        tenant_id,identity_review_task_id,entity_type,connection_id,
        source_object_type,source_record_id,canonical_entity_id,match_method,
        confidence_band,evidence,sync_run_id
      ) VALUES (
        p_tenant_id,p_task_id,p_entity_type,current_link.connection_id,
        current_link.source_object_type,current_link.source_record_id,
        current_link.canonical_entity_id,current_link.match_method,
        current_link.confidence_band,current_link.evidence,current_link.sync_run_id
      );
    ELSE
      IF baseline_row.entity_type<>p_entity_type
         OR baseline_row.canonical_entity_id<>(candidate->>'canonical_entity_id')
         OR (
           current_link.match_method<>'user_confirmed'
           AND current_link.canonical_entity_id<>baseline_row.canonical_entity_id
      ) THEN
        RAISE EXCEPTION 'identity review card is stale' USING ERRCODE='P0002';
      END IF;
    END IF;
  END LOOP;

  INSERT INTO semantic_internal.identity_decision_history (
    tenant_id,decision_id,identity_review_task_id,decision_version,decision,
    entity_type,candidate_links,candidate_links_hash,decided_by,decided_at
  ) VALUES (
    p_tenant_id,p_decision_id,p_task_id,p_decision_version,p_decision,
    p_entity_type,p_candidate_links,md5(p_candidate_links::text),p_decided_by,p_decided_at
  );

  INSERT INTO core.entity_identity_edge (
    tenant_id,identity_review_task_id,entity_type,left_entity_id,right_entity_id,
    decision_id,decision_version,decision,decided_at
  ) VALUES (
    p_tenant_id,p_task_id,p_entity_type,left_id,right_id,
    p_decision_id,p_decision_version,p_decision,p_decided_at
  )
  ON CONFLICT (tenant_id,identity_review_task_id) DO UPDATE SET
    entity_type=excluded.entity_type,left_entity_id=excluded.left_entity_id,
    right_entity_id=excluded.right_entity_id,decision_id=excluded.decision_id,
    decision_version=excluded.decision_version,decision=excluded.decision,
    decided_at=excluded.decided_at,updated_at=now();

  DELETE FROM core.entity_resolution
   WHERE tenant_id=p_tenant_id AND entity_type=p_entity_type;
  WITH RECURSIVE
  directed(source_id,target_id) AS (
    SELECT edge.left_entity_id,edge.right_entity_id
      FROM core.entity_identity_edge AS edge
     WHERE edge.tenant_id=p_tenant_id AND edge.entity_type=p_entity_type
       AND edge.decision='accepted'
    UNION ALL
    SELECT edge.right_entity_id,edge.left_entity_id
      FROM core.entity_identity_edge AS edge
     WHERE edge.tenant_id=p_tenant_id AND edge.entity_type=p_entity_type
       AND edge.decision='accepted'
  ),
  nodes(entity_id) AS (
    SELECT source_id FROM directed UNION SELECT target_id FROM directed
  ),
  reach(origin_id,entity_id) AS (
    SELECT entity_id,entity_id FROM nodes
    UNION
    SELECT reach.origin_id,directed.target_id
      FROM reach JOIN directed ON directed.source_id=reach.entity_id
  ),
  mapping AS (
    SELECT entity_id AS member_entity_id,min(origin_id) AS resolved_entity_id
      FROM reach GROUP BY entity_id
  )
  INSERT INTO core.entity_resolution (
    tenant_id,entity_type,member_entity_id,resolved_entity_id
  )
  SELECT p_tenant_id,p_entity_type,mapping.member_entity_id,mapping.resolved_entity_id
    FROM mapping;
  GET DIAGNOSTICS resolved_count=ROW_COUNT;

  -- Source links and fact foreign keys remain source-owned.  Confirmations are
  -- effective graph edges, resolved at query time.  This is what makes undo
  -- lossless even when new facts arrive between a merge and its reversal.
  SELECT md5(coalesce(string_agg(graph_row.value,E'\n' ORDER BY graph_row.value),''))
    INTO graph_hash
    FROM (
      SELECT concat_ws('|','edge',edge.entity_type,edge.identity_review_task_id,
                        edge.left_entity_id,edge.right_entity_id,edge.decision,
                        edge.decision_version::text) AS value
        FROM core.entity_identity_edge AS edge
       WHERE edge.tenant_id=p_tenant_id
      UNION ALL
      SELECT concat_ws('|','resolution',resolution.entity_type,
                        resolution.member_entity_id,resolution.resolved_entity_id) AS value
        FROM core.entity_resolution AS resolution
       WHERE resolution.tenant_id=p_tenant_id
    ) AS graph_row;
  INSERT INTO semantic_internal.identity_graph_state (tenant_id,version,graph_hash)
  VALUES (p_tenant_id,1,graph_hash)
  ON CONFLICT (tenant_id) DO UPDATE SET
    version=semantic_internal.identity_graph_state.version+1,
    graph_hash=excluded.graph_hash,
    updated_at=now()
  RETURNING version INTO graph_version;

  DELETE FROM semantic_internal.result_cache WHERE tenant_id=p_tenant_id;
  GET DIAGNOSTICS cache_rows=ROW_COUNT;
  RETURN jsonb_build_object(
    'applied',true,'replayed',false,'stale',false,
    'decisionVersion',p_decision_version,'resolvedEntities',resolved_count,
    'cacheRowsInvalidated',cache_rows,
    'identityGraphVersion',graph_version,'identityGraphHash',graph_hash
  );
END;
$$;

-- Customer lifecycle windows must be calculated after identity resolution;
-- resolving only in the outer compiler would still classify two source
-- accounts for one person as two separate first purchases.
CREATE OR REPLACE VIEW mart.customer_order_activity
WITH (security_barrier = true, security_invoker = true)
AS
WITH resolved_orders AS (
  SELECT
    order_row.tenant_id,
    order_row.id,
    coalesce(resolution.resolved_entity_id,order_row.customer_account_id) AS customer_account_id,
    order_row.location_id,
    order_row.channel_id,
    order_row.business_date,
    order_row.completed_at,
    order_row.ordered_at,
    order_row.net_amount_ex_tax
  FROM core.commerce_order AS order_row
  LEFT JOIN core.entity_resolution AS resolution
    ON resolution.tenant_id=order_row.tenant_id
   AND resolution.entity_type='customer_account'
   AND resolution.member_entity_id=order_row.customer_account_id
  WHERE order_row.customer_account_id IS NOT NULL
    AND order_row.status='completed'
    AND NOT order_row.voided
    AND NOT order_row.internal_transaction
)
SELECT
  order_row.tenant_id,
  order_row.id,
  order_row.customer_account_id,
  order_row.location_id,
  order_row.channel_id,
  order_row.business_date,
  row_number() OVER (
    PARTITION BY order_row.tenant_id,order_row.customer_account_id
    ORDER BY coalesce(order_row.completed_at,order_row.ordered_at),order_row.id
  ) AS customer_order_number,
  count(*) OVER (
    PARTITION BY order_row.tenant_id,order_row.customer_account_id
  ) AS period_order_count,
  max(coalesce(order_row.completed_at,order_row.ordered_at)) OVER (
    PARTITION BY order_row.tenant_id,order_row.customer_account_id
  ) AS last_order_at,
  order_row.net_amount_ex_tax
FROM resolved_orders AS order_row;

-- Candidate cards carry safe canonical display labels.  Provider names remain
-- a control-plane concern and are derived there from connection_id.
CREATE OR REPLACE FUNCTION semantic_internal.generate_identity_review_candidates(p_tenant_id text)
RETURNS bigint LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,core,semantic_internal AS $$
DECLARE inserted_count bigint;
BEGIN
  IF p_tenant_id IS DISTINCT FROM core.current_tenant_id() THEN
    RAISE EXCEPTION 'trusted tenant context mismatch' USING ERRCODE='42501';
  END IF;
  WITH candidates AS (
    SELECT
      left_row.entity_type,
      left_row.connection_id AS left_connection_id,
      left_row.source_object_type AS left_object_type,
      left_row.source_record_id AS left_record_id,
      right_row.connection_id AS right_connection_id,
      right_row.source_object_type AS right_object_type,
      right_row.source_record_id AS right_record_id,
      CASE
        WHEN left_row.external_id_digest IS NOT NULL AND left_row.external_id_digest=right_row.external_id_digest THEN 'external_id'
        WHEN EXISTS (
          SELECT 1 FROM jsonb_each_text(left_row.deterministic_key_digests) l
          JOIN jsonb_each_text(right_row.deterministic_key_digests) r ON r.key=l.key AND r.value=l.value
        ) THEN 'deterministic_key'
        ELSE 'composite_suggestion'
      END AS method
    FROM semantic_internal.identity_observation left_row
    JOIN semantic_internal.identity_observation right_row
      ON right_row.tenant_id=left_row.tenant_id
     AND right_row.entity_type=left_row.entity_type
     AND right_row.connection_id>left_row.connection_id
     AND right_row.active AND left_row.active
    WHERE left_row.tenant_id=p_tenant_id
      AND (
        (left_row.external_id_digest IS NOT NULL AND left_row.external_id_digest=right_row.external_id_digest)
        OR EXISTS (
          SELECT 1 FROM jsonb_each_text(left_row.deterministic_key_digests) l
          JOIN jsonb_each_text(right_row.deterministic_key_digests) r ON r.key=l.key AND r.value=l.value
        )
        OR (
          left_row.normalized_name_digest IS NOT NULL
          AND left_row.normalized_name_digest=right_row.normalized_name_digest
          AND left_row.corroborating_scope_digest IS NOT NULL
          AND left_row.corroborating_scope_digest=right_row.corroborating_scope_digest
        )
      )
  ), linked AS (
    SELECT candidate.*,
      left_link.canonical_entity_id AS left_entity_id,
      right_link.canonical_entity_id AS right_entity_id,
      md5('identity-review-a|'||concat_ws('|',candidate.entity_type,candidate.left_connection_id,candidate.left_object_type,candidate.left_record_id,candidate.right_connection_id,candidate.right_object_type,candidate.right_record_id,candidate.method))
      ||md5('identity-review-b|'||concat_ws('|',candidate.entity_type,candidate.left_connection_id,candidate.left_object_type,candidate.left_record_id,candidate.right_connection_id,candidate.right_object_type,candidate.right_record_id,candidate.method)) AS suggestion_key
    FROM candidates candidate
    JOIN core.entity_source_link left_link
      ON left_link.tenant_id=p_tenant_id AND left_link.entity_type=candidate.entity_type
     AND left_link.connection_id=candidate.left_connection_id AND left_link.source_object_type=candidate.left_object_type
     AND left_link.source_record_id=candidate.left_record_id AND left_link.match_status='accepted' AND left_link.valid_to IS NULL
    JOIN core.entity_source_link right_link
      ON right_link.tenant_id=p_tenant_id AND right_link.entity_type=candidate.entity_type
     AND right_link.connection_id=candidate.right_connection_id AND right_link.source_object_type=candidate.right_object_type
     AND right_link.source_record_id=candidate.right_record_id AND right_link.match_status='accepted' AND right_link.valid_to IS NULL
    WHERE left_link.canonical_entity_id<>right_link.canonical_entity_id
  ), labelled AS (
    SELECT linked.*,
      CASE linked.entity_type
        WHEN 'worker' THEN (SELECT display_name FROM core.worker WHERE tenant_id=p_tenant_id AND id=linked.left_entity_id)
        WHEN 'location' THEN (SELECT name FROM core.location WHERE tenant_id=p_tenant_id AND id=linked.left_entity_id)
        WHEN 'product_variant' THEN (SELECT name FROM core.product_variant WHERE tenant_id=p_tenant_id AND id=linked.left_entity_id)
        WHEN 'customer_account' THEN (SELECT display_name FROM core.customer_account WHERE tenant_id=p_tenant_id AND id=linked.left_entity_id)
        WHEN 'supplier' THEN (SELECT name FROM core.supplier WHERE tenant_id=p_tenant_id AND id=linked.left_entity_id)
      END AS left_label,
      CASE linked.entity_type
        WHEN 'worker' THEN (SELECT display_name FROM core.worker WHERE tenant_id=p_tenant_id AND id=linked.right_entity_id)
        WHEN 'location' THEN (SELECT name FROM core.location WHERE tenant_id=p_tenant_id AND id=linked.right_entity_id)
        WHEN 'product_variant' THEN (SELECT name FROM core.product_variant WHERE tenant_id=p_tenant_id AND id=linked.right_entity_id)
        WHEN 'customer_account' THEN (SELECT display_name FROM core.customer_account WHERE tenant_id=p_tenant_id AND id=linked.right_entity_id)
        WHEN 'supplier' THEN (SELECT name FROM core.supplier WHERE tenant_id=p_tenant_id AND id=linked.right_entity_id)
      END AS right_label
    FROM linked
  )
  INSERT INTO semantic_internal.identity_review_projection_outbox (
    tenant_id,projection_id,task_id,suggestion_key,entity_type,confidence_band,candidate_links,evidence
  )
  SELECT p_tenant_id,
    semantic_internal.deterministic_ulid('identity-projection|'||p_tenant_id||'|'||suggestion_key),
    semantic_internal.deterministic_ulid('identity-task|'||p_tenant_id||'|'||suggestion_key),
    suggestion_key,entity_type,CASE WHEN method='composite_suggestion' THEN 'medium' ELSE 'high' END,
    jsonb_build_array(
      jsonb_build_object(
        'canonical_entity_id',left_entity_id,'connection_id',left_connection_id,
        'source_object_type',left_object_type,'source_record_id',left_record_id,
        'label',coalesce(left_label,left_record_id)
      ),
      jsonb_build_object(
        'canonical_entity_id',right_entity_id,'connection_id',right_connection_id,
        'source_object_type',right_object_type,'source_record_id',right_record_id,
        'label',coalesce(right_label,right_record_id)
      )
    ),
    jsonb_build_object(
      'suggestion_key',suggestion_key,'match_method',method,
      'summary',CASE WHEN method='composite_suggestion'
        THEN 'Normalized name and confirmed organisational scope match.'
        ELSE 'A deterministic cross-source identity key matches.' END
    )
  FROM labelled ON CONFLICT (tenant_id,suggestion_key) DO NOTHING;
  GET DIAGNOSTICS inserted_count=ROW_COUNT;
  RETURN inserted_count;
END $$;

REVOKE ALL ON core.entity_identity_edge,core.entity_resolution,
  semantic_internal.identity_decision_history,
  semantic_internal.identity_link_baseline,
  semantic_internal.identity_graph_state
FROM PUBLIC,ingest_rw,semantic_ro,semantic_meta_rw,transform_rw;
GRANT SELECT ON core.entity_resolution TO semantic_ro,transform_rw,diagnostic_ro;
GRANT SELECT ON semantic_internal.identity_graph_state TO semantic_ro,diagnostic_ro;
GRANT SELECT ON core.entity_identity_edge,
  semantic_internal.identity_decision_history,
  semantic_internal.identity_link_baseline TO diagnostic_ro;
REVOKE ALL ON FUNCTION semantic_internal.apply_identity_decision(
  text,text,text,integer,text,text,jsonb,uuid,timestamptz
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION semantic_internal.apply_identity_decision(
  text,text,text,integer,text,text,jsonb,uuid,timestamptz
) TO transform_rw;

COMMIT;
