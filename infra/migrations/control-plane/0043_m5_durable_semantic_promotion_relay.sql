BEGIN;

-- Cross-database semantic promotion delivery uses the transactional inbox
-- pattern.  Candidate ids are delivery idempotency keys: a replay can recover
-- from a crash after control-plane acceptance without incrementing the inbox
-- occurrence twice.

ALTER TABLE control_plane.semantic_inbox
  ADD COLUMN IF NOT EXISTS connection_id text,
  ADD COLUMN IF NOT EXISTS connector_id text,
  ADD COLUMN IF NOT EXISTS candidate_fingerprint text,
  ADD COLUMN IF NOT EXISTS latest_question_digest text;

ALTER TABLE control_plane.semantic_inbox
  ADD CONSTRAINT semantic_inbox_connection_reference
    FOREIGN KEY(tenant_id,connection_id)
    REFERENCES control_plane.connections(tenant_id,connection_id)
    ON DELETE CASCADE,
  ADD CONSTRAINT semantic_inbox_connector_shape
    CHECK(connector_id IS NULL OR connector_id ~ '^[a-z][a-z0-9-]{0,62}$'),
  ADD CONSTRAINT semantic_inbox_candidate_fingerprint_shape
    CHECK(candidate_fingerprint IS NULL OR candidate_fingerprint ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT semantic_inbox_question_digest_shape
    CHECK(latest_question_digest IS NULL OR latest_question_digest ~ '^[a-f0-9]{64}$');

CREATE UNIQUE INDEX semantic_inbox_candidate_fingerprint_unique
  ON control_plane.semantic_inbox(tenant_id,candidate_fingerprint)
  WHERE candidate_fingerprint IS NOT NULL;

CREATE TABLE control_plane.semantic_promotion_deliveries(
  tenant_id text NOT NULL,
  candidate_id text NOT NULL CHECK(control_plane.is_ulid(candidate_id)),
  candidate_digest text NOT NULL CHECK(candidate_digest ~ '^[a-f0-9]{64}$'),
  query_id text NOT NULL CHECK(control_plane.is_ulid(query_id)),
  connection_id text NOT NULL,
  semantic_inbox_item_id text NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,candidate_id),
  FOREIGN KEY(tenant_id) REFERENCES control_plane.tenants(tenant_id) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id,connection_id)
    REFERENCES control_plane.connections(tenant_id,connection_id) ON DELETE CASCADE,
  FOREIGN KEY(tenant_id,semantic_inbox_item_id)
    REFERENCES control_plane.semantic_inbox(tenant_id,semantic_inbox_item_id)
    ON DELETE CASCADE
);

CREATE INDEX semantic_promotion_deliveries_inbox_idx
  ON control_plane.semantic_promotion_deliveries(
    tenant_id,semantic_inbox_item_id,accepted_at DESC
  );

-- This table is a narrow, control-plane-owned tenant scan ledger.  It exposes
-- no tenant metadata and gives a replica a bounded recovery lease before a
-- signed per-tenant analytical capability is issued.
CREATE TABLE control_plane.semantic_promotion_relay_tenants(
  tenant_id text PRIMARY KEY
    REFERENCES control_plane.tenants(tenant_id) ON DELETE CASCADE,
  next_scan_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_owner text,
  lease_token text UNIQUE,
  lease_expires_at timestamptz,
  consecutive_failure_count integer NOT NULL DEFAULT 0
    CHECK(consecutive_failure_count BETWEEN 0 AND 1000000),
  last_claimed_count integer NOT NULL DEFAULT 0 CHECK(last_claimed_count>=0),
  last_delivered_count integer NOT NULL DEFAULT 0 CHECK(last_delivered_count>=0),
  last_failed_count integer NOT NULL DEFAULT 0 CHECK(last_failed_count>=0),
  last_error_code text CHECK(
    last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,79}$'
  ),
  last_scanned_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK(
    (lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
    OR (
      lease_owner ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
      AND control_plane.is_ulid(lease_token)
      AND lease_expires_at IS NOT NULL
    )
  )
);

CREATE INDEX semantic_promotion_relay_tenants_due_idx
  ON control_plane.semantic_promotion_relay_tenants(next_scan_at,tenant_id);

ALTER TABLE control_plane.semantic_promotion_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.semantic_promotion_relay_tenants ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION control_plane.compute_semantic_promotion_candidate_digest(
  p_tenant_id text,
  p_candidate_id text,
  p_query_id text,
  p_connection_id text,
  p_connector_id text,
  p_source_table text,
  p_source_fields text[],
  p_question_digest text,
  p_requested_metric_concept text
) RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path=pg_catalog
AS $$
  SELECT encode(
    extensions.digest(
      convert_to(
        concat_ws(
          chr(31),p_tenant_id,p_candidate_id,p_query_id,p_connection_id,
          p_connector_id,p_source_table,array_to_string(p_source_fields,chr(30)),
          p_question_digest,coalesce(p_requested_metric_concept,'')
        ),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
$$;

CREATE OR REPLACE FUNCTION control_plane.compute_semantic_promotion_fingerprint(
  p_connection_id text,
  p_connector_id text,
  p_source_table text,
  p_source_fields text[],
  p_requested_metric_concept text
) RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path=pg_catalog
AS $$
  SELECT encode(
    extensions.digest(
      convert_to(
        concat_ws(
          chr(31),p_connection_id,p_connector_id,p_source_table,
          array_to_string(p_source_fields,chr(30)),
          coalesce(p_requested_metric_concept,'')
        ),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
$$;

CREATE OR REPLACE FUNCTION control_plane.accept_semantic_promotion_candidate(
  p_tenant_id text,
  p_candidate_id text,
  p_query_id text,
  p_connection_id text,
  p_connector_id text,
  p_source_table text,
  p_source_fields text[],
  p_question_digest text,
  p_requested_metric_concept text,
  p_candidate_digest text
) RETURNS TABLE(
  semantic_inbox_item_id text,
  occurrence_count bigint,
  replayed boolean
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE
  canonical_fields text[];
  expected_digest text;
  fingerprint text;
  existing_delivery record;
  existing_item control_plane.semantic_inbox%ROWTYPE;
BEGIN
  PERFORM control_plane.require_exact_runtime_login(
    'albert_semantic_control_runtime','albert_semantic_control'
  );
  SELECT array_agg(field ORDER BY field)
    INTO canonical_fields
    FROM (SELECT DISTINCT unnest(p_source_fields) AS field) fields;
  IF NOT control_plane.is_ulid(p_tenant_id)
     OR NOT control_plane.is_ulid(p_candidate_id)
     OR NOT control_plane.is_ulid(p_query_id)
     OR NOT control_plane.is_ulid(p_connection_id)
     OR p_connector_id !~ '^[a-z][a-z0-9-]{0,62}$'
     OR p_source_table !~ '^[a-z_][a-z0-9_]{0,62}$'
     OR canonical_fields IS NULL OR cardinality(canonical_fields) NOT BETWEEN 1 AND 20
     OR canonical_fields IS DISTINCT FROM p_source_fields
     OR EXISTS(
       SELECT 1 FROM unnest(canonical_fields) field
        WHERE field<>'*' AND field !~ '^[a-z_][a-z0-9_]{0,62}$'
     )
     OR ('*'=ANY(canonical_fields) AND cardinality(canonical_fields)<>1)
     OR p_question_digest !~ '^[a-f0-9]{64}$'
     OR p_candidate_digest !~ '^[a-f0-9]{64}$'
     OR (
       p_requested_metric_concept IS NOT NULL
       AND p_requested_metric_concept !~ '^[a-z][a-z0-9_.]{0,159}$'
     ) THEN
    RAISE EXCEPTION 'semantic promotion candidate is invalid' USING ERRCODE='22023';
  END IF;

  expected_digest:=control_plane.compute_semantic_promotion_candidate_digest(
    p_tenant_id,p_candidate_id,p_query_id,p_connection_id,p_connector_id,
    p_source_table,p_source_fields,p_question_digest,p_requested_metric_concept
  );
  IF expected_digest IS DISTINCT FROM p_candidate_digest THEN
    RAISE EXCEPTION 'semantic promotion candidate digest does not match'
      USING ERRCODE='42501';
  END IF;

  -- These row locks serialize deletion/disconnect with durable acceptance.
  PERFORM 1
    FROM control_plane.tenants tenant
    JOIN control_plane.connections connection
      ON connection.tenant_id=tenant.tenant_id
   WHERE tenant.tenant_id=p_tenant_id AND tenant.status='active'
     AND connection.connection_id=p_connection_id
     AND connection.connector_key=p_connector_id
     AND connection.status IN ('connected','degraded')
     AND NOT EXISTS(
       SELECT 1 FROM control_plane.deletion_requests request
        WHERE request.tenant_id=p_tenant_id
          AND (request.scope='tenant' OR request.connection_id=p_connection_id)
          AND request.status IN ('queued','running','retry_wait','verifying','failed')
     )
   FOR SHARE OF tenant,connection;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'semantic promotion is fenced by connection or tenant lifecycle'
      USING ERRCODE='55000';
  END IF;

  SELECT delivery.candidate_digest,delivery.semantic_inbox_item_id,
         inbox.occurrence_count
    INTO existing_delivery
    FROM control_plane.semantic_promotion_deliveries delivery
    JOIN control_plane.semantic_inbox inbox
      ON inbox.tenant_id=delivery.tenant_id
     AND inbox.semantic_inbox_item_id=delivery.semantic_inbox_item_id
   WHERE delivery.tenant_id=p_tenant_id AND delivery.candidate_id=p_candidate_id;
  IF FOUND THEN
    IF existing_delivery.candidate_digest IS DISTINCT FROM p_candidate_digest THEN
      RAISE EXCEPTION 'semantic promotion idempotency key was reused'
        USING ERRCODE='42501';
    END IF;
    semantic_inbox_item_id:=existing_delivery.semantic_inbox_item_id;
    occurrence_count:=existing_delivery.occurrence_count;
    replayed:=true;
    RETURN NEXT;
    RETURN;
  END IF;

  fingerprint:=control_plane.compute_semantic_promotion_fingerprint(
    p_connection_id,p_connector_id,p_source_table,p_source_fields,
    p_requested_metric_concept
  );
  PERFORM pg_advisory_xact_lock(
    hashtextextended('semantic-promotion:'||p_tenant_id||':'||fingerprint,0)
  );

  -- A second exact candidate may have committed while this transaction waited
  -- for the fingerprint lock. Re-check before changing occurrence_count.
  SELECT delivery.candidate_digest,delivery.semantic_inbox_item_id,
         inbox.occurrence_count
    INTO existing_delivery
    FROM control_plane.semantic_promotion_deliveries delivery
    JOIN control_plane.semantic_inbox inbox
      ON inbox.tenant_id=delivery.tenant_id
     AND inbox.semantic_inbox_item_id=delivery.semantic_inbox_item_id
   WHERE delivery.tenant_id=p_tenant_id AND delivery.candidate_id=p_candidate_id;
  IF FOUND THEN
    IF existing_delivery.candidate_digest IS DISTINCT FROM p_candidate_digest THEN
      RAISE EXCEPTION 'semantic promotion idempotency key was reused'
        USING ERRCODE='42501';
    END IF;
    semantic_inbox_item_id:=existing_delivery.semantic_inbox_item_id;
    occurrence_count:=existing_delivery.occurrence_count;
    replayed:=true;
    RETURN NEXT;
    RETURN;
  END IF;

  SELECT inbox.* INTO existing_item
    FROM control_plane.semantic_inbox inbox
   WHERE inbox.tenant_id=p_tenant_id
     AND inbox.candidate_fingerprint=fingerprint
   FOR UPDATE;

  IF NOT FOUND THEN
    INSERT INTO control_plane.semantic_inbox(
      tenant_id,semantic_inbox_item_id,status,source_kind,topic_hint,
      field_reference,sample_question,occurrence_count,evidence,
      first_seen_at,last_seen_at,connection_id,connector_id,
      candidate_fingerprint,latest_question_digest
    ) VALUES (
      p_tenant_id,p_candidate_id,'candidate','source_exploration',
      p_requested_metric_concept,
      p_connector_id||':'||p_source_table||':'||array_to_string(p_source_fields,','),
      'Question content withheld; digest '||substr(p_question_digest,1,12),
      1,
      jsonb_build_object(
        'connectorId',p_connector_id,'connectionId',p_connection_id,
        'sourceTable',p_source_table,'sourceFields',to_jsonb(p_source_fields),
        'questionDigest',p_question_digest,'lastCandidateId',p_candidate_id
      ),
      clock_timestamp(),clock_timestamp(),p_connection_id,p_connector_id,
      fingerprint,p_question_digest
    ) RETURNING * INTO existing_item;
  END IF;

  INSERT INTO control_plane.semantic_promotion_deliveries(
    tenant_id,candidate_id,candidate_digest,query_id,connection_id,
    semantic_inbox_item_id
  ) VALUES (
    p_tenant_id,p_candidate_id,p_candidate_digest,p_query_id,p_connection_id,
    existing_item.semantic_inbox_item_id
  );

  IF existing_item.semantic_inbox_item_id<>p_candidate_id THEN
    UPDATE control_plane.semantic_inbox inbox SET
      occurrence_count=inbox.occurrence_count+1,
      last_seen_at=clock_timestamp(),
      latest_question_digest=p_question_digest,
      evidence=inbox.evidence||jsonb_build_object(
        'questionDigest',p_question_digest,'lastCandidateId',p_candidate_id
      )
     WHERE inbox.tenant_id=p_tenant_id
       AND inbox.semantic_inbox_item_id=existing_item.semantic_inbox_item_id
    RETURNING * INTO existing_item;
  END IF;

  INSERT INTO control_plane.audit_log(
    tenant_id,audit_id,actor_user_id,actor_type,action,resource_type,
    resource_id,audit_metadata
  ) VALUES (
    p_tenant_id,control_plane.generate_ulid(),NULL,'service',
    'semantic.promotion_candidate_accepted','semantic_inbox',
    existing_item.semantic_inbox_item_id,
    jsonb_build_object(
      'candidate_id',p_candidate_id,'candidate_digest',p_candidate_digest,
      'candidate_fingerprint',fingerprint,'connection_id',p_connection_id,
      'connector_id',p_connector_id,'query_id',p_query_id,
      'question_content_persisted',false
    )
  );

  semantic_inbox_item_id:=existing_item.semantic_inbox_item_id;
  occurrence_count:=existing_item.occurrence_count;
  replayed:=false;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.claim_semantic_promotion_relay_tenants(
  p_worker_id text,p_limit integer DEFAULT 10,p_lease_seconds integer DEFAULT 90
) RETURNS TABLE(
  tenant_id text,lease_token text,lease_expires_at timestamptz,
  analytical_capability text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE candidate record;generated_token text;deadline timestamptz;
BEGIN
  PERFORM control_plane.require_exact_runtime_login(
    'albert_semantic_control_runtime','albert_semantic_control'
  );
  IF p_worker_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
     OR p_limit NOT BETWEEN 1 AND 50 OR p_lease_seconds NOT BETWEEN 15 AND 180 THEN
    RAISE EXCEPTION 'semantic promotion recovery claim is invalid' USING ERRCODE='22023';
  END IF;

  INSERT INTO control_plane.semantic_promotion_relay_tenants(tenant_id)
  SELECT tenant.tenant_id
    FROM control_plane.tenants tenant
   WHERE tenant.status='active'
     AND NOT EXISTS(
       SELECT 1 FROM control_plane.deletion_requests request
        WHERE request.tenant_id=tenant.tenant_id
          AND request.status IN ('queued','running','retry_wait','verifying','failed')
     )
  ON CONFLICT ON CONSTRAINT semantic_promotion_relay_tenants_pkey DO NOTHING;

  FOR candidate IN
    SELECT relay.tenant_id
      FROM control_plane.semantic_promotion_relay_tenants relay
      JOIN control_plane.tenants tenant ON tenant.tenant_id=relay.tenant_id
     WHERE tenant.status='active' AND relay.next_scan_at<=clock_timestamp()
       AND (relay.lease_expires_at IS NULL OR relay.lease_expires_at<=clock_timestamp())
       AND NOT EXISTS(
         SELECT 1 FROM control_plane.deletion_requests request
          WHERE request.tenant_id=relay.tenant_id
            AND request.status IN ('queued','running','retry_wait','verifying','failed')
       )
     ORDER BY relay.next_scan_at,relay.tenant_id
     FOR UPDATE OF relay SKIP LOCKED
     LIMIT p_limit
  LOOP
    generated_token:=control_plane.generate_ulid();
    deadline:=clock_timestamp()+make_interval(secs=>p_lease_seconds);
    UPDATE control_plane.semantic_promotion_relay_tenants relay SET
      lease_owner=p_worker_id,lease_token=generated_token,
      lease_expires_at=deadline,updated_at=clock_timestamp()
     WHERE relay.tenant_id=candidate.tenant_id;
    tenant_id:=candidate.tenant_id;
    lease_token:=generated_token;
    lease_expires_at:=deadline;
    analytical_capability:=control_plane.sign_analytical_capability(
      candidate.tenant_id,'analytical:semantic-metadata','semantic_metadata',
      'semantic-promotion-recovery:'||p_worker_id||':'||generated_token,
      deadline,
      jsonb_build_object(
        'kind','semantic_promotion_recovery','worker_id',p_worker_id,
        'relay_lease_token',generated_token
      )
    );
    RETURN NEXT;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.complete_semantic_promotion_relay_tenant(
  p_tenant_id text,p_worker_id text,p_lease_token text,
  p_claimed_count integer,p_delivered_count integer,p_failed_count integer
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
BEGIN
  PERFORM control_plane.require_exact_runtime_login(
    'albert_semantic_control_runtime','albert_semantic_control'
  );
  IF NOT control_plane.is_ulid(p_tenant_id) OR NOT control_plane.is_ulid(p_lease_token)
     OR p_worker_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
     OR p_claimed_count NOT BETWEEN 0 AND 50
     OR p_delivered_count NOT BETWEEN 0 AND p_claimed_count
     OR p_failed_count NOT BETWEEN 0 AND p_claimed_count
     OR p_delivered_count+p_failed_count<>p_claimed_count THEN
    RAISE EXCEPTION 'semantic promotion recovery outcome is invalid' USING ERRCODE='22023';
  END IF;
  UPDATE control_plane.semantic_promotion_relay_tenants relay SET
    next_scan_at=clock_timestamp()+CASE WHEN p_claimed_count=50
      THEN interval '1 second' ELSE interval '20 seconds' END,
    lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
    consecutive_failure_count=CASE WHEN p_failed_count=0 THEN 0
      ELSE least(relay.consecutive_failure_count+1,1000000) END,
    last_claimed_count=p_claimed_count,last_delivered_count=p_delivered_count,
    last_failed_count=p_failed_count,
    last_error_code=CASE WHEN p_failed_count=0 THEN NULL ELSE 'CANDIDATE_DELIVERY_FAILED' END,
    last_scanned_at=clock_timestamp(),updated_at=clock_timestamp()
   WHERE relay.tenant_id=p_tenant_id AND relay.lease_owner=p_worker_id
     AND relay.lease_token=p_lease_token AND relay.lease_expires_at>clock_timestamp();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'semantic promotion recovery lease is stale' USING ERRCODE='55000';
  END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.fail_semantic_promotion_relay_tenant(
  p_tenant_id text,p_worker_id text,p_lease_token text,
  p_error_code text,p_retry_after_seconds integer
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
BEGIN
  PERFORM control_plane.require_exact_runtime_login(
    'albert_semantic_control_runtime','albert_semantic_control'
  );
  IF NOT control_plane.is_ulid(p_tenant_id) OR NOT control_plane.is_ulid(p_lease_token)
     OR p_worker_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
     OR p_error_code !~ '^[A-Z][A-Z0-9_]{0,79}$'
     OR p_retry_after_seconds NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'semantic promotion recovery failure is invalid' USING ERRCODE='22023';
  END IF;
  UPDATE control_plane.semantic_promotion_relay_tenants relay SET
    next_scan_at=clock_timestamp()+make_interval(secs=>p_retry_after_seconds),
    lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
    consecutive_failure_count=least(relay.consecutive_failure_count+1,1000000),
    last_error_code=p_error_code,last_scanned_at=clock_timestamp(),
    updated_at=clock_timestamp()
   WHERE relay.tenant_id=p_tenant_id AND relay.lease_owner=p_worker_id
     AND relay.lease_token=p_lease_token AND relay.lease_expires_at>clock_timestamp();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'semantic promotion recovery lease is stale' USING ERRCODE='55000';
  END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.assert_semantic_promotion_relay_ready()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
BEGIN
  PERFORM control_plane.require_exact_runtime_login(
    'albert_semantic_control_runtime','albert_semantic_control'
  );
  PERFORM control_plane.assert_analytical_capability_issuer_ready();
  RETURN true;
END;
$$;

-- Operator-only metadata projection.  No raw question, customer row, SQL, or
-- analytical credential is exposed; every drill-down is audited.
CREATE OR REPLACE FUNCTION public.albert_operator_semantic_inbox(
  p_tenant_id text,p_limit integer DEFAULT 200
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE actor uuid:=extensions.albert_auth_uid();result jsonb;
BEGIN
  IF NOT control_plane.is_internal_operator() THEN
    RAISE EXCEPTION 'internal operator access required' USING ERRCODE='42501';
  END IF;
  IF NOT control_plane.is_ulid(p_tenant_id) OR p_limit NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'semantic inbox operator request is invalid' USING ERRCODE='22023';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM control_plane.tenants tenant WHERE tenant.tenant_id=p_tenant_id) THEN
    RAISE EXCEPTION 'tenant was not found' USING ERRCODE='P0002';
  END IF;
  INSERT INTO control_plane.operator_audit_log(
    operator_audit_id,actor_user_id,action,target_tenant_id,request_metadata
  ) VALUES (
    control_plane.generate_ulid(),actor,'operator.semantic_inbox_read',p_tenant_id,
    jsonb_build_object('limit',p_limit)
  );
  SELECT jsonb_build_object(
    'stage','semantic_inbox','generated_at',clock_timestamp(),
    'summary',jsonb_build_object(
      'candidate_count',(SELECT count(*) FROM control_plane.semantic_inbox inbox
        WHERE inbox.tenant_id=p_tenant_id AND inbox.status='candidate'),
      'occurrence_count',(SELECT coalesce(sum(inbox.occurrence_count),0)
        FROM control_plane.semantic_inbox inbox WHERE inbox.tenant_id=p_tenant_id),
      'last_scanned_at',(SELECT relay.last_scanned_at
        FROM control_plane.semantic_promotion_relay_tenants relay
        WHERE relay.tenant_id=p_tenant_id),
      'last_error_code',(SELECT relay.last_error_code
        FROM control_plane.semantic_promotion_relay_tenants relay
        WHERE relay.tenant_id=p_tenant_id)
    ),
    'groups',jsonb_build_array(
      jsonb_build_object(
        'id','semantic_inbox','label','Semantic promotion candidates',
        'description','Documented source fields awaiting governed-model review; question content is never retained.',
        'rows',coalesce((
          SELECT jsonb_agg(jsonb_build_object(
            'semantic_inbox_item_id',item.semantic_inbox_item_id,
            'connector_id',item.connector_id,'connection_id',item.connection_id,
            'status',item.status,'topic_hint',item.topic_hint,
            'field_reference',item.field_reference,
            'occurrence_count',item.occurrence_count,
            'first_seen_at',item.first_seen_at,'last_seen_at',item.last_seen_at,
            'delivery_count',(SELECT count(*)
              FROM control_plane.semantic_promotion_deliveries delivery
              WHERE delivery.tenant_id=item.tenant_id
                AND delivery.semantic_inbox_item_id=item.semantic_inbox_item_id)
          ) ORDER BY item.last_seen_at DESC)
          FROM (SELECT * FROM control_plane.semantic_inbox inbox
            WHERE inbox.tenant_id=p_tenant_id
            ORDER BY inbox.last_seen_at DESC LIMIT p_limit) item
        ),'[]'::jsonb)
      ),
      jsonb_build_object(
        'id','promotion_relay','label','Promotion relay health',
        'description','Bounded recovery lease and the most recent tenant-scoped drain outcome.',
        'rows',coalesce((
          SELECT jsonb_agg(jsonb_build_object(
            'next_scan_at',relay.next_scan_at,
            'lease_active',relay.lease_expires_at>clock_timestamp(),
            'consecutive_failure_count',relay.consecutive_failure_count,
            'last_claimed_count',relay.last_claimed_count,
            'last_delivered_count',relay.last_delivered_count,
            'last_failed_count',relay.last_failed_count,
            'last_error_code',relay.last_error_code,
            'last_scanned_at',relay.last_scanned_at,
            'updated_at',relay.updated_at
          )) FROM control_plane.semantic_promotion_relay_tenants relay
          WHERE relay.tenant_id=p_tenant_id
        ),'[]'::jsonb)
      )
    )
  ) INTO result;
  RETURN result;
END;
$$;

REVOKE ALL ON TABLE
  control_plane.semantic_promotion_deliveries,
  control_plane.semantic_promotion_relay_tenants
FROM PUBLIC,anon,authenticated,service_role,albert_semantic_control;

REVOKE ALL ON FUNCTION
  control_plane.compute_semantic_promotion_candidate_digest(text,text,text,text,text,text,text[],text,text),
  control_plane.compute_semantic_promotion_fingerprint(text,text,text,text[],text),
  control_plane.accept_semantic_promotion_candidate(text,text,text,text,text,text,text[],text,text,text),
  control_plane.claim_semantic_promotion_relay_tenants(text,integer,integer),
  control_plane.complete_semantic_promotion_relay_tenant(text,text,text,integer,integer,integer),
  control_plane.fail_semantic_promotion_relay_tenant(text,text,text,text,integer),
  control_plane.assert_semantic_promotion_relay_ready()
FROM PUBLIC,anon,authenticated,service_role,albert_sync_control,
     albert_transform_control,albert_semantic_control,albert_webhook_control,
     albert_deletion_control,albert_operator_diagnostic_control;

GRANT EXECUTE ON FUNCTION
  control_plane.accept_semantic_promotion_candidate(text,text,text,text,text,text,text[],text,text,text),
  control_plane.claim_semantic_promotion_relay_tenants(text,integer,integer),
  control_plane.complete_semantic_promotion_relay_tenant(text,text,text,integer,integer,integer),
  control_plane.fail_semantic_promotion_relay_tenant(text,text,text,text,integer),
  control_plane.assert_semantic_promotion_relay_ready()
TO albert_semantic_control;

REVOKE ALL ON FUNCTION public.albert_operator_semantic_inbox(text,integer)
  FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.albert_operator_semantic_inbox(text,integer)
  TO authenticated;

ALTER DEFAULT PRIVILEGES FOR ROLE albert_control_migration_owner
  IN SCHEMA control_plane REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

COMMIT;
