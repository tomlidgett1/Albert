BEGIN;

-- Source exploration is useful only if its mandatory promotion candidate can
-- cross the analytical/control database boundary durably.  The analytical
-- side remains the source outbox.  Every mutation below is token scoped and
-- lease fenced; semantic_meta_rw receives no direct table mutation authority.

ALTER TABLE semantic_internal.promotion_candidate_outbox
  ADD COLUMN IF NOT EXISTS conversation_id text,
  ADD COLUMN IF NOT EXISTS turn_id text,
  ADD COLUMN IF NOT EXISTS candidate_digest text,
  ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD COLUMN IF NOT EXISTS lease_owner text,
  ADD COLUMN IF NOT EXISTS lease_token text,
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS control_inbox_item_id text,
  ADD COLUMN IF NOT EXISTS last_error_code text,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT clock_timestamp();

CREATE OR REPLACE FUNCTION semantic_internal.compute_promotion_candidate_digest(
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
          chr(31),
          p_tenant_id,
          p_candidate_id,
          p_query_id,
          p_connection_id,
          p_connector_id,
          p_source_table,
          array_to_string(p_source_fields,chr(30)),
          p_question_digest,
          coalesce(p_requested_metric_concept,'')
        ),
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  )
$$;

-- Historical rows were written before delivery leasing existed.  Normalize
-- their field order once so every replay has one cross-database digest.
-- The migration owner temporarily suspends FORCE for this bounded metadata
-- backfill; RLS remains enabled and FORCE is restored before any new ACL.
ALTER TABLE semantic_internal.promotion_candidate_outbox NO FORCE ROW LEVEL SECURITY;
UPDATE semantic_internal.promotion_candidate_outbox item
   SET source_fields=(
         SELECT array_agg(field ORDER BY field)
           FROM (SELECT DISTINCT unnest(item.source_fields) AS field) fields
       )
 WHERE source_fields IS DISTINCT FROM (
         SELECT array_agg(field ORDER BY field)
           FROM (SELECT DISTINCT unnest(item.source_fields) AS field) fields
       );

UPDATE semantic_internal.promotion_candidate_outbox item
   SET candidate_digest=semantic_internal.compute_promotion_candidate_digest(
         item.tenant_id,item.candidate_id,item.query_id,item.connection_id,
         item.connector_id,item.source_table,item.source_fields,
         item.question_digest,item.requested_metric_concept
       )
 WHERE item.candidate_digest IS NULL;
ALTER TABLE semantic_internal.promotion_candidate_outbox FORCE ROW LEVEL SECURITY;

ALTER TABLE semantic_internal.promotion_candidate_outbox
  ALTER COLUMN candidate_digest SET NOT NULL,
  ADD CONSTRAINT promotion_candidate_digest_shape
    CHECK(candidate_digest ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT promotion_candidate_attempt_count_nonnegative
    CHECK(attempt_count>=0),
  ADD CONSTRAINT promotion_candidate_conversation_id_shape
    CHECK(conversation_id IS NULL OR core.is_ulid(conversation_id)),
  ADD CONSTRAINT promotion_candidate_turn_id_shape
    CHECK(turn_id IS NULL OR core.is_ulid(turn_id)),
  ADD CONSTRAINT promotion_candidate_lease_shape
    CHECK(
      (lease_owner IS NULL AND lease_token IS NULL AND lease_expires_at IS NULL)
      OR (
        length(btrim(lease_owner)) BETWEEN 1 AND 160
        AND core.is_ulid(lease_token)
        AND lease_expires_at IS NOT NULL
      )
    ),
  ADD CONSTRAINT promotion_candidate_control_item_shape
    CHECK(control_inbox_item_id IS NULL OR core.is_ulid(control_inbox_item_id)),
  ADD CONSTRAINT promotion_candidate_error_code_shape
    CHECK(last_error_code IS NULL OR last_error_code ~ '^[A-Z][A-Z0-9_]{0,79}$'),
  ADD CONSTRAINT promotion_candidate_delivery_shape
    CHECK(
      (published_at IS NULL AND control_inbox_item_id IS NULL)
      OR (published_at IS NOT NULL AND control_inbox_item_id IS NOT NULL)
    );

DROP INDEX IF EXISTS semantic_internal.promotion_outbox_tenant_unpublished_idx;
CREATE INDEX promotion_outbox_tenant_delivery_due_idx
  ON semantic_internal.promotion_candidate_outbox(
    tenant_id,available_at,created_at,candidate_id
  )
  WHERE published_at IS NULL;
CREATE INDEX promotion_outbox_expired_lease_idx
  ON semantic_internal.promotion_candidate_outbox(lease_expires_at)
  WHERE published_at IS NULL AND lease_expires_at IS NOT NULL;

CREATE OR REPLACE FUNCTION semantic_internal.prepare_promotion_candidate_payload()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog
AS $$
DECLARE canonical_fields text[];
BEGIN
  IF TG_OP='UPDATE' THEN
    RAISE EXCEPTION 'promotion candidate payload is immutable' USING ERRCODE='55000';
  END IF;
  SELECT array_agg(field ORDER BY field)
    INTO canonical_fields
    FROM (SELECT DISTINCT unnest(NEW.source_fields) AS field) fields;
  IF canonical_fields IS NULL OR cardinality(canonical_fields) NOT BETWEEN 1 AND 20
     OR canonical_fields IS DISTINCT FROM NEW.source_fields
     OR EXISTS(
       SELECT 1 FROM unnest(canonical_fields) field
        WHERE field<>'*' AND field !~ '^[a-z_][a-z0-9_]{0,62}$'
     )
     OR ('*'=ANY(canonical_fields) AND cardinality(canonical_fields)<>1) THEN
    RAISE EXCEPTION 'promotion candidate source fields are invalid' USING ERRCODE='22023';
  END IF;
  NEW.candidate_digest:=semantic_internal.compute_promotion_candidate_digest(
    NEW.tenant_id,NEW.candidate_id,NEW.query_id,NEW.connection_id,
    NEW.connector_id,NEW.source_table,NEW.source_fields,
    NEW.question_digest,NEW.requested_metric_concept
  );
  NEW.available_at:=coalesce(NEW.available_at,clock_timestamp());
  NEW.updated_at:=clock_timestamp();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS promotion_candidate_payload_guard
  ON semantic_internal.promotion_candidate_outbox;
CREATE TRIGGER promotion_candidate_payload_guard
  BEFORE INSERT OR UPDATE OF
    tenant_id,candidate_id,query_id,connection_id,connector_id,source_table,
    source_fields,question_digest,requested_metric_concept,candidate_digest
  ON semantic_internal.promotion_candidate_outbox
  FOR EACH ROW EXECUTE FUNCTION semantic_internal.prepare_promotion_candidate_payload();

CREATE OR REPLACE FUNCTION semantic_internal.require_semantic_metadata_claims()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
BEGIN
  RETURN capability_internal.verify_token(
    nullif(current_setting('albert.tenant_capability',true),''),
    'semantic_metadata'
  );
END;
$$;

CREATE OR REPLACE FUNCTION semantic_internal.enqueue_promotion_candidate(
  p_candidate_id text,
  p_query_id text,
  p_conversation_id text,
  p_turn_id text,
  p_connection_id text,
  p_connector_id text,
  p_source_table text,
  p_source_fields text[],
  p_question_digest text,
  p_requested_metric_concept text
) RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE claims jsonb;selected_tenant text;inserted_digest text;
BEGIN
  claims:=semantic_internal.require_semantic_metadata_claims();
  selected_tenant:=claims->>'tenant_id';
  IF NOT core.is_ulid(p_candidate_id) OR NOT core.is_ulid(p_query_id)
     OR NOT core.is_ulid(p_conversation_id) OR NOT core.is_ulid(p_turn_id)
     OR NOT core.is_ulid(p_connection_id)
     OR p_connector_id !~ '^[a-z][a-z0-9-]{0,62}$'
     OR p_source_table !~ '^[a-z_][a-z0-9_]{0,62}$'
     OR p_question_digest !~ '^[a-f0-9]{64}$'
     OR (
       p_requested_metric_concept IS NOT NULL
       AND p_requested_metric_concept !~ '^[a-z][a-z0-9_.]{0,159}$'
     )
     OR claims->'evidence'->>'conversation_id' IS DISTINCT FROM p_conversation_id
     OR claims->'evidence'->>'turn_id' IS DISTINCT FROM p_turn_id THEN
    RAISE EXCEPTION 'promotion candidate authorization is invalid' USING ERRCODE='42501';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(
    hashtextextended('deletion:'||selected_tenant,0)
  );
  INSERT INTO semantic_internal.promotion_candidate_outbox(
    tenant_id,candidate_id,query_id,conversation_id,turn_id,connection_id,
    connector_id,source_table,source_fields,question_digest,
    requested_metric_concept
  ) VALUES (
    selected_tenant,p_candidate_id,p_query_id,p_conversation_id,p_turn_id,
    p_connection_id,p_connector_id,p_source_table,p_source_fields,
    p_question_digest,p_requested_metric_concept
  )
  RETURNING candidate_digest INTO inserted_digest;
  RETURN inserted_digest;
END;
$$;

CREATE OR REPLACE FUNCTION semantic_internal.claim_promotion_candidate(
  p_candidate_id text,p_worker_id text,p_lease_token text,
  p_lease_seconds integer DEFAULT 90
) RETURNS TABLE(
  claim_status text,candidate_id text,query_id text,connection_id text,
  connector_id text,source_table text,source_fields text[],
  question_digest text,requested_metric_concept text,candidate_digest text,
  attempt_count integer,control_inbox_item_id text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE claims jsonb;selected_tenant text;item semantic_internal.promotion_candidate_outbox%ROWTYPE;
BEGIN
  claims:=semantic_internal.require_semantic_metadata_claims();
  selected_tenant:=claims->>'tenant_id';
  IF NOT core.is_ulid(p_candidate_id) OR NOT core.is_ulid(p_lease_token)
     OR p_worker_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
     OR p_lease_seconds NOT BETWEEN 15 AND 180 THEN
    RAISE EXCEPTION 'promotion candidate lease input is invalid' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('deletion:'||selected_tenant,0));
  SELECT outbox.* INTO item
    FROM semantic_internal.promotion_candidate_outbox outbox
   WHERE outbox.tenant_id=selected_tenant
     AND outbox.candidate_id=p_candidate_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'promotion candidate was not found' USING ERRCODE='P0002';
  END IF;
  IF item.published_at IS NOT NULL THEN
    claim_status:='delivered';
  ELSIF item.available_at>clock_timestamp()
     OR (item.lease_expires_at IS NOT NULL AND item.lease_expires_at>clock_timestamp()) THEN
    claim_status:='busy';
  ELSE
    UPDATE semantic_internal.promotion_candidate_outbox outbox SET
      attempt_count=outbox.attempt_count+1,
      lease_owner=p_worker_id,
      lease_token=p_lease_token,
      lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds),
      last_error_code=NULL,
      updated_at=clock_timestamp()
    WHERE outbox.tenant_id=selected_tenant AND outbox.candidate_id=p_candidate_id
    RETURNING outbox.* INTO item;
    claim_status:='claimed';
  END IF;
  candidate_id:=item.candidate_id;query_id:=item.query_id;
  connection_id:=item.connection_id;connector_id:=item.connector_id;
  source_table:=item.source_table;source_fields:=item.source_fields;
  question_digest:=item.question_digest;
  requested_metric_concept:=item.requested_metric_concept;
  candidate_digest:=item.candidate_digest;attempt_count:=item.attempt_count;
  control_inbox_item_id:=item.control_inbox_item_id;
  RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION semantic_internal.claim_due_promotion_candidates(
  p_worker_id text,p_lease_token text,p_limit integer DEFAULT 20,
  p_lease_seconds integer DEFAULT 90
) RETURNS TABLE(
  candidate_id text,query_id text,connection_id text,connector_id text,
  source_table text,source_fields text[],question_digest text,
  requested_metric_concept text,candidate_digest text,attempt_count integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE claims jsonb;selected_tenant text;
BEGIN
  claims:=semantic_internal.require_semantic_metadata_claims();
  selected_tenant:=claims->>'tenant_id';
  IF NOT core.is_ulid(p_lease_token)
     OR p_worker_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
     OR p_limit NOT BETWEEN 1 AND 50 OR p_lease_seconds NOT BETWEEN 15 AND 180 THEN
    RAISE EXCEPTION 'promotion recovery lease input is invalid' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('deletion:'||selected_tenant,0));
  RETURN QUERY
  WITH due AS (
    SELECT outbox.candidate_id
      FROM semantic_internal.promotion_candidate_outbox outbox
     WHERE outbox.tenant_id=selected_tenant
       AND outbox.published_at IS NULL
       AND outbox.available_at<=clock_timestamp()
       AND (outbox.lease_expires_at IS NULL OR outbox.lease_expires_at<=clock_timestamp())
     ORDER BY outbox.created_at,outbox.candidate_id
     FOR UPDATE SKIP LOCKED
     LIMIT p_limit
  ), claimed AS (
    UPDATE semantic_internal.promotion_candidate_outbox outbox SET
      attempt_count=outbox.attempt_count+1,
      lease_owner=p_worker_id,lease_token=p_lease_token,
      lease_expires_at=clock_timestamp()+make_interval(secs=>p_lease_seconds),
      last_error_code=NULL,updated_at=clock_timestamp()
    FROM due
    WHERE outbox.tenant_id=selected_tenant
      AND outbox.candidate_id=due.candidate_id
    RETURNING outbox.*
  )
  SELECT claimed.candidate_id,claimed.query_id,claimed.connection_id,
         claimed.connector_id,claimed.source_table,claimed.source_fields,
         claimed.question_digest,claimed.requested_metric_concept,
         claimed.candidate_digest,claimed.attempt_count
    FROM claimed ORDER BY claimed.created_at,claimed.candidate_id;
END;
$$;

CREATE OR REPLACE FUNCTION semantic_internal.complete_promotion_candidate(
  p_candidate_id text,p_worker_id text,p_lease_token text,
  p_control_inbox_item_id text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE claims jsonb;selected_tenant text;item semantic_internal.promotion_candidate_outbox%ROWTYPE;
BEGIN
  claims:=semantic_internal.require_semantic_metadata_claims();
  selected_tenant:=claims->>'tenant_id';
  IF NOT core.is_ulid(p_candidate_id) OR NOT core.is_ulid(p_lease_token)
     OR NOT core.is_ulid(p_control_inbox_item_id)
     OR p_worker_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$' THEN
    RAISE EXCEPTION 'promotion completion input is invalid' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('deletion:'||selected_tenant,0));
  SELECT outbox.* INTO item
    FROM semantic_internal.promotion_candidate_outbox outbox
   WHERE outbox.tenant_id=selected_tenant AND outbox.candidate_id=p_candidate_id
   FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'promotion candidate was not found' USING ERRCODE='P0002';END IF;
  IF item.published_at IS NOT NULL THEN
    IF item.control_inbox_item_id IS DISTINCT FROM p_control_inbox_item_id THEN
      RAISE EXCEPTION 'promotion completion receipt does not match' USING ERRCODE='55000';
    END IF;
    RETURN true;
  END IF;
  IF item.lease_owner IS DISTINCT FROM p_worker_id
     OR item.lease_token IS DISTINCT FROM p_lease_token
     OR item.lease_expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'promotion candidate lease is stale' USING ERRCODE='55000';
  END IF;
  UPDATE semantic_internal.promotion_candidate_outbox outbox SET
    published_at=clock_timestamp(),control_inbox_item_id=p_control_inbox_item_id,
    lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
    last_error_code=NULL,updated_at=clock_timestamp()
   WHERE outbox.tenant_id=selected_tenant AND outbox.candidate_id=p_candidate_id;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION semantic_internal.fail_promotion_candidate(
  p_candidate_id text,p_worker_id text,p_lease_token text,
  p_error_code text,p_retry_after_seconds integer
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE claims jsonb;selected_tenant text;
BEGIN
  claims:=semantic_internal.require_semantic_metadata_claims();
  selected_tenant:=claims->>'tenant_id';
  IF NOT core.is_ulid(p_candidate_id) OR NOT core.is_ulid(p_lease_token)
     OR p_worker_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
     OR p_error_code !~ '^[A-Z][A-Z0-9_]{0,79}$'
     OR p_retry_after_seconds NOT BETWEEN 1 AND 300 THEN
    RAISE EXCEPTION 'promotion failure input is invalid' USING ERRCODE='22023';
  END IF;
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('deletion:'||selected_tenant,0));
  UPDATE semantic_internal.promotion_candidate_outbox outbox SET
    available_at=clock_timestamp()+make_interval(secs=>p_retry_after_seconds),
    lease_owner=NULL,lease_token=NULL,lease_expires_at=NULL,
    last_error_code=p_error_code,updated_at=clock_timestamp()
   WHERE outbox.tenant_id=selected_tenant AND outbox.candidate_id=p_candidate_id
     AND outbox.published_at IS NULL
     AND outbox.lease_owner=p_worker_id AND outbox.lease_token=p_lease_token
     AND outbox.lease_expires_at>clock_timestamp();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'promotion candidate lease is stale' USING ERRCODE='55000';
  END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION semantic_internal.assert_promotion_relay_ready()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE binding record;
BEGIN
  SELECT * INTO STRICT binding FROM capability_internal.expected_runtime_binding();
  IF binding.audience<>'analytical:semantic-metadata'
     OR NOT ('semantic_metadata'=ANY(binding.allowed_scopes)) THEN
    RAISE EXCEPTION 'semantic promotion relay has an unsafe runtime identity'
      USING ERRCODE='42501';
  END IF;
  RETURN true;
END;
$$;

-- Include the new outbox evidence in connection-scope verification without
-- weakening the one-use deletion capability wrapper introduced in 0083.
ALTER FUNCTION deletion_internal.verify_connection_pre_capability(text,text)
  RENAME TO verify_connection_before_promotion_relay;

CREATE OR REPLACE FUNCTION deletion_internal.verify_connection_pre_capability(
  p_tenant_id text,p_connection_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE base jsonb;promotion_remaining bigint;
BEGIN
  base:=deletion_internal.verify_connection_before_promotion_relay(
    p_tenant_id,p_connection_id
  );
  SELECT count(*) INTO promotion_remaining
    FROM semantic_internal.promotion_candidate_outbox outbox
   WHERE outbox.tenant_id=p_tenant_id AND outbox.connection_id=p_connection_id;
  RETURN jsonb_set(
    jsonb_set(
      base,
      '{remainingRows}',
      to_jsonb(coalesce((base->>'remainingRows')::bigint,0)+promotion_remaining)
    ),
    '{verified}',
    to_jsonb((base->>'verified')::boolean AND promotion_remaining=0)
  );
END;
$$;

REVOKE ALL ON TABLE semantic_internal.promotion_candidate_outbox
  FROM PUBLIC,ingest_rw,transform_rw,semantic_ro,semantic_meta_rw;
GRANT SELECT ON TABLE semantic_internal.promotion_candidate_outbox TO diagnostic_ro;

REVOKE ALL ON FUNCTION
  semantic_internal.compute_promotion_candidate_digest(text,text,text,text,text,text,text[],text,text),
  semantic_internal.prepare_promotion_candidate_payload(),
  semantic_internal.require_semantic_metadata_claims(),
  semantic_internal.enqueue_promotion_candidate(text,text,text,text,text,text,text,text[],text,text),
  semantic_internal.claim_promotion_candidate(text,text,text,integer),
  semantic_internal.claim_due_promotion_candidates(text,text,integer,integer),
  semantic_internal.complete_promotion_candidate(text,text,text,text),
  semantic_internal.fail_promotion_candidate(text,text,text,text,integer),
  semantic_internal.assert_promotion_relay_ready(),
  deletion_internal.verify_connection_before_promotion_relay(text,text),
  deletion_internal.verify_connection_pre_capability(text,text)
FROM PUBLIC,ingest_rw,transform_rw,semantic_ro,semantic_meta_rw,diagnostic_ro,deletion_rw;

GRANT EXECUTE ON FUNCTION
  semantic_internal.enqueue_promotion_candidate(text,text,text,text,text,text,text,text[],text,text),
  semantic_internal.claim_promotion_candidate(text,text,text,integer),
  semantic_internal.claim_due_promotion_candidates(text,text,integer,integer),
  semantic_internal.complete_promotion_candidate(text,text,text,text),
  semantic_internal.fail_promotion_candidate(text,text,text,text,integer),
  semantic_internal.assert_promotion_relay_ready()
TO semantic_meta_rw;

-- The one-use deletion wrapper calls this helper as its owner.  No runtime
-- role can invoke the pre-capability implementation directly.
GRANT EXECUTE ON FUNCTION
  deletion_internal.verify_connection_pre_capability(text,text)
TO albert_migration_owner;

ALTER DEFAULT PRIVILEGES FOR ROLE albert_migration_owner
  IN SCHEMA semantic_internal REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

COMMIT;
