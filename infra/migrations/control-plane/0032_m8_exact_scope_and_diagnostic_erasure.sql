BEGIN;

-- Diagnostic reveal records are append-only during ordinary operation, but
-- erasure is a different, narrowly authorized state transition.  Without this
-- exception the RESTRICT children make a tenant that has ever used a reveal
-- impossible to delete.
CREATE OR REPLACE FUNCTION control_plane.reject_operator_diagnostic_reveal_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path=pg_catalog
AS $$
BEGIN
  IF TG_OP='DELETE' AND control_plane.deletion_mutation_authorized() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'operator diagnostic reveal records are append-only' USING ERRCODE='55000';
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.purge_operator_diagnostic_reveals(
  p_tenant_id text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path=pg_catalog
AS $$
DECLARE
  removed bigint:=0;
  affected bigint;
BEGIN
  IF NOT control_plane.deletion_mutation_authorized() THEN
    RAISE EXCEPTION 'deletion purge context required' USING ERRCODE='42501';
  END IF;
  IF NOT control_plane.is_ulid(p_tenant_id) THEN
    RAISE EXCEPTION 'deletion tenant identity is invalid' USING ERRCODE='22023';
  END IF;

  DELETE FROM control_plane.operator_diagnostic_reveal_outcomes outcome
  USING control_plane.operator_diagnostic_reveal_requests request
  WHERE request.tenant_id=p_tenant_id AND outcome.reveal_id=request.reveal_id;
  GET DIAGNOSTICS affected=ROW_COUNT;
  removed:=removed+affected;

  DELETE FROM control_plane.operator_diagnostic_reveal_claims claim
  USING control_plane.operator_diagnostic_reveal_requests request
  WHERE request.tenant_id=p_tenant_id AND claim.reveal_id=request.reveal_id;
  GET DIAGNOSTICS affected=ROW_COUNT;
  removed:=removed+affected;

  DELETE FROM control_plane.operator_diagnostic_reveal_requests request
  WHERE request.tenant_id=p_tenant_id;
  GET DIAGNOSTICS affected=ROW_COUNT;
  removed:=removed+affected;
  RETURN removed;
END;
$$;

-- PGMQ messages are JSON documents.  Substring matching can erase a different
-- tenant's job when a provider-controlled source value happens to contain the
-- target ULID.  A normal/dead-lettered job carries scope at the top level; an
-- orphan quarantine envelope carries the original job under payload.  Prefer
-- the authoritative top-level identity when present and otherwise inspect only
-- those two exact nested fields.
CREATE OR REPLACE FUNCTION control_plane.deletion_queue_scope_matches(
  p_message jsonb,p_tenant_id text,p_connection_id text DEFAULT NULL
)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path=pg_catalog
AS $$
  SELECT coalesce(
           nullif(p_message->>'tenantId',''),
           nullif(p_message#>>'{payload,tenantId}','')
         )=p_tenant_id
     AND (
       p_connection_id IS NULL
       OR coalesce(
            nullif(p_message->>'connectionId',''),
            nullif(p_message#>>'{payload,connectionId}','')
          )=p_connection_id
     )
$$;

CREATE OR REPLACE FUNCTION control_plane.purge_deletion_queue_scope(
  p_tenant_id text, p_connection_id text DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE
  queue_name text;
  table_name text;
  removed bigint:=0;
  affected bigint;
BEGIN
  IF NOT control_plane.deletion_mutation_authorized() THEN
    RAISE EXCEPTION 'deletion purge context required' USING ERRCODE='42501';
  END IF;
  IF NOT control_plane.is_ulid(p_tenant_id)
     OR (p_connection_id IS NOT NULL AND NOT control_plane.is_ulid(p_connection_id)) THEN
    RAISE EXCEPTION 'deletion queue scope is invalid' USING ERRCODE='22023';
  END IF;
  FOREACH queue_name IN ARRAY ARRAY[
    'albert_sync_high','albert_sync_standard','albert_sync_backfill','albert_sync_deadletter'
  ] LOOP
    FOREACH table_name IN ARRAY ARRAY['q_'||queue_name,'a_'||queue_name] LOOP
      IF to_regclass('pgmq.'||table_name) IS NOT NULL THEN
        EXECUTE format(
          'DELETE FROM pgmq.%I
            WHERE control_plane.deletion_queue_scope_matches(message,$1,$2)',
          table_name
        ) USING p_tenant_id,p_connection_id;
        GET DIAGNOSTICS affected=ROW_COUNT;
        removed:=removed+affected;
      END IF;
    END LOOP;
  END LOOP;
  RETURN removed;
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.purge_tenant_control(
  p_message_id bigint,p_deletion_request_id text,p_worker_id text,p_read_count integer
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE
  request_row control_plane.deletion_requests%ROWTYPE;
  table_row record;
  affected bigint;
  removed bigint:=0;
  pass integer;
  changed boolean;
BEGIN
  request_row:=control_plane.require_active_deletion_lease(
    p_message_id,p_deletion_request_id,p_worker_id,p_read_count
  );
  IF request_row.scope<>'tenant' OR request_row.credential_destroyed_at IS NULL THEN
    RAISE EXCEPTION 'tenant deletion is not purge-ready' USING ERRCODE='55000';
  END IF;
  PERFORM set_config('albert.deletion_authorized','on',true);

  DELETE FROM control_plane.operator_audit_log
  WHERE target_tenant_id=request_row.tenant_id;
  GET DIAGNOSTICS affected=ROW_COUNT;
  removed:=removed+affected;

  -- These two child tables deliberately carry no tenant_id, so the generic
  -- tenant-column walk cannot discover them.  Preserve the explicit FK order.
  removed:=removed+control_plane.purge_operator_diagnostic_reveals(request_row.tenant_id);

  FOR pass IN 1..50 LOOP
    changed:=false;
    FOR table_row IN
      SELECT column_row.table_name
      FROM information_schema.columns column_row
      WHERE column_row.table_schema='control_plane'
        AND column_row.column_name='tenant_id'
        AND column_row.table_name NOT IN (
          'tenants','deletion_requests','deletion_job_attempts'
        )
      ORDER BY column_row.table_name
    LOOP
      BEGIN
        EXECUTE format(
          'DELETE FROM control_plane.%I WHERE tenant_id=$1',table_row.table_name
        ) USING request_row.tenant_id;
        GET DIAGNOSTICS affected=ROW_COUNT;
        IF affected>0 THEN
          removed:=removed+affected;
          changed:=true;
        END IF;
      EXCEPTION WHEN foreign_key_violation THEN
        NULL;
      END;
    END LOOP;
    EXIT WHEN NOT changed;
  END LOOP;

  removed:=removed+control_plane.purge_deletion_queue_scope(request_row.tenant_id,NULL);
  RETURN jsonb_build_object(
    'scope','tenant','rowsRemoved',removed,'tenantAnchorPendingProof',true
  );
END;
$$;

CREATE OR REPLACE FUNCTION control_plane.verify_control_deletion(
  p_deletion_request_id text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE
  request_row control_plane.deletion_requests%ROWTYPE;
  table_row record;
  affected bigint;
  remaining bigint:=0;
  queue_remaining bigint:=0;
  table_name text;
  derived_remaining bigint:=0;
BEGIN
  SELECT * INTO STRICT request_row
  FROM control_plane.deletion_requests
  WHERE deletion_request_id=p_deletion_request_id;

  IF request_row.scope='tenant' THEN
    FOR table_row IN
      SELECT column_row.table_name
      FROM information_schema.columns column_row
      WHERE column_row.table_schema='control_plane'
        AND column_row.column_name='tenant_id'
        AND column_row.table_name NOT IN (
          'tenants','deletion_requests','deletion_job_attempts'
        )
    LOOP
      EXECUTE format(
        'SELECT count(*) FROM control_plane.%I WHERE tenant_id=$1',table_row.table_name
      ) INTO affected USING request_row.tenant_id;
      remaining:=remaining+affected;
    END LOOP;

    -- Verify the non-tenant-keyed reveal children independently.  This also
    -- guards a future FK change from turning their absence into an assumption.
    SELECT
      (SELECT count(*)
         FROM control_plane.operator_diagnostic_reveal_claims claim
         JOIN control_plane.operator_diagnostic_reveal_requests request
           ON request.reveal_id=claim.reveal_id
        WHERE request.tenant_id=request_row.tenant_id)
      +(SELECT count(*)
          FROM control_plane.operator_diagnostic_reveal_outcomes outcome
          JOIN control_plane.operator_diagnostic_reveal_requests request
            ON request.reveal_id=outcome.reveal_id
         WHERE request.tenant_id=request_row.tenant_id)
    INTO derived_remaining;
  ELSE
    FOR table_row IN
      SELECT column_row.table_name
      FROM information_schema.columns column_row
      WHERE column_row.table_schema='control_plane'
        AND column_row.column_name='connection_id'
        AND column_row.table_name NOT IN ('connections','deletion_requests')
    LOOP
      EXECUTE format(
        'SELECT count(*) FROM control_plane.%I WHERE tenant_id=$1 AND connection_id=$2',
        table_row.table_name
      ) INTO affected USING request_row.tenant_id,request_row.connection_id;
      remaining:=remaining+affected;
    END LOOP;
    SELECT
      (SELECT count(*) FROM control_plane.conversations
        WHERE tenant_id=request_row.tenant_id)
      +(SELECT count(*) FROM control_plane.dossiers
        WHERE tenant_id=request_row.tenant_id)
      +(SELECT count(*) FROM control_plane.identity_review_tasks
        WHERE tenant_id=request_row.tenant_id)
      +(SELECT count(*) FROM control_plane.semantic_inbox
        WHERE tenant_id=request_row.tenant_id)
      +(SELECT count(*) FROM control_plane.audit_log
        WHERE tenant_id=request_row.tenant_id)
      +(SELECT count(*) FROM control_plane.pipeline_stats
        WHERE tenant_id=request_row.tenant_id)
    INTO derived_remaining;
  END IF;

  FOREACH table_name IN ARRAY ARRAY[
    'q_albert_sync_high','a_albert_sync_high',
    'q_albert_sync_standard','a_albert_sync_standard',
    'q_albert_sync_backfill','a_albert_sync_backfill',
    'q_albert_sync_deadletter','a_albert_sync_deadletter'
  ] LOOP
    IF to_regclass('pgmq.'||table_name) IS NOT NULL THEN
      EXECUTE format(
        'SELECT count(*) FROM pgmq.%I
          WHERE control_plane.deletion_queue_scope_matches(message,$1,$2)',
        table_name
      ) INTO affected USING request_row.tenant_id,request_row.connection_id;
      queue_remaining:=queue_remaining+affected;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'verified',remaining=0 AND queue_remaining=0 AND derived_remaining=0,
    'remainingTenantOrConnectionRows',remaining,
    'remainingDerivedArtifacts',derived_remaining,
    'remainingQueueMessages',queue_remaining
  );
END;
$$;

REVOKE ALL ON FUNCTION control_plane.purge_operator_diagnostic_reveals(text)
  FROM PUBLIC,anon,authenticated,service_role,albert_sync_control,
       albert_transform_control,albert_semantic_control,albert_webhook_control,
       albert_deletion_control,albert_operator_diagnostic_control;
REVOKE ALL ON FUNCTION control_plane.deletion_queue_scope_matches(jsonb,text,text)
  FROM PUBLIC,anon,authenticated,service_role,albert_sync_control,
       albert_transform_control,albert_semantic_control,albert_webhook_control,
       albert_deletion_control,albert_operator_diagnostic_control;

COMMIT;
