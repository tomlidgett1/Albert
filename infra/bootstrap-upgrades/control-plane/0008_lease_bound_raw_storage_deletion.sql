BEGIN;

-- ADR 0040 removes ambient customer-object authority from every durable raw
-- Storage machine principal. Storage RLS now requires a short-lived Auth
-- session grant whose exact object/scope is independently joined to a live
-- sync permit, webhook receipt/lease, or deletion queue attempt.
DO $$
BEGIN
  IF current_user <> 'postgres' OR session_user <> 'postgres' THEN
    RAISE EXCEPTION 'lease-bound raw Storage authority requires the protected postgres login';
  END IF;
  IF to_regclass('storage.objects') IS NULL
     OR to_regprocedure('extensions.albert_auth_uid()') IS NULL
     OR to_regprocedure('extensions.albert_auth_jwt()') IS NULL
     OR to_regprocedure('extensions.albert_raw_storage_machine_authorized(text)') IS NULL THEN
    RAISE EXCEPTION 'raw Storage machine-session authority must be installed first';
  END IF;
END;
$$;

-- Capability issuers can prove that a presented subject is still the one
-- protected Auth identity for its purpose without receiving read access to
-- the administrator-owned principal mapping.
CREATE OR REPLACE FUNCTION extensions.albert_raw_storage_machine_user_matches(
  p_purpose text,
  p_auth_user_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT p_purpose IN ('sync','webhook','deletion')
     AND p_auth_user_id IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM albert_bootstrap.raw_storage_machine_principal AS principal
        WHERE principal.purpose = p_purpose
          AND principal.auth_user_id = p_auth_user_id
          AND principal.active
     )
$$;

REVOKE ALL ON FUNCTION
  extensions.albert_raw_storage_machine_user_matches(text,uuid)
FROM PUBLIC,anon,authenticated,service_role,
     albert_sync_control,albert_webhook_control,albert_transform_control,
     albert_semantic_control,albert_operator_diagnostic_control,
     albert_deletion_control;
GRANT EXECUTE ON FUNCTION
  extensions.albert_raw_storage_machine_user_matches(text,uuid)
TO albert_control_migration_owner;

CREATE OR REPLACE FUNCTION extensions.albert_raw_storage_sync_authorized(
  p_object_name text,
  p_command text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  jwt jsonb;
  subject_id uuid;
  auth_session_id uuid;
  permitted boolean := false;
BEGIN
  IF p_command NOT IN ('select','insert')
     OR NOT extensions.albert_raw_storage_machine_authorized('sync')
     OR to_regclass('control_plane.raw_storage_sync_session_grants') IS NULL THEN
    RETURN false;
  END IF;
  jwt := extensions.albert_auth_jwt();
  IF coalesce(jwt->>'session_id','') !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;
  subject_id := extensions.albert_auth_uid();
  auth_session_id := (jwt->>'session_id')::uuid;

  -- Dynamic SQL keeps this administrator upgrade installable before the
  -- immutable application migration creates the grant relations. Until then
  -- every customer-object branch fails closed.
  EXECUTE $query$
    SELECT EXISTS (
      SELECT 1
        FROM control_plane.raw_storage_sync_session_grants AS grant_row
        JOIN control_plane.sync_write_permits AS permit
          ON permit.tenant_id=grant_row.tenant_id
         AND permit.permit_id=grant_row.permit_id
        JOIN control_plane.sync_job_requests AS request
          ON request.tenant_id=permit.tenant_id
         AND request.job_request_id=permit.job_request_id
        JOIN control_plane.sync_job_attempts AS attempt
          ON attempt.tenant_id=permit.tenant_id
         AND attempt.job_request_id=permit.job_request_id
         AND attempt.attempt_number=permit.read_count
         AND attempt.worker_id=permit.worker_id
        JOIN control_plane.sync_runs AS run
          ON run.tenant_id=permit.tenant_id
         AND run.sync_run_id=permit.sync_run_id
        JOIN control_plane.connections AS connection
          ON connection.tenant_id=permit.tenant_id
         AND connection.connection_id=permit.connection_id
        JOIN control_plane.tenants AS tenant
          ON tenant.tenant_id=permit.tenant_id
       WHERE grant_row.auth_user_id=$1
         AND grant_row.auth_session_id=$2
         AND grant_row.object_key=$3
         AND grant_row.revoked_at IS NULL
         AND grant_row.expires_at>statement_timestamp()
         AND permit.expires_at>statement_timestamp()
         AND request.status='running'
         AND request.queue_name=permit.queue_name
         AND request.queue_message_id=permit.message_id
         AND attempt.visibility_deadline>statement_timestamp()
         AND attempt.finished_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM control_plane.sync_job_attempt_outcomes AS outcome
            WHERE outcome.tenant_id=attempt.tenant_id
              AND outcome.job_attempt_id=attempt.job_attempt_id
         )
         AND NOT EXISTS (
           SELECT 1 FROM control_plane.sync_job_attempts AS later
            WHERE later.tenant_id=attempt.tenant_id
              AND later.job_request_id=attempt.job_request_id
              AND later.attempt_number>attempt.attempt_number
         )
         AND run.status='running'
         AND run.connection_id=permit.connection_id
         AND run.connection_generation=permit.connection_generation
         AND connection.connection_generation=permit.connection_generation
         AND connection.status IN ('connected','degraded')
         AND tenant.status='active'
         AND NOT EXISTS (
           SELECT 1 FROM control_plane.deletion_requests AS deletion
            WHERE deletion.tenant_id=permit.tenant_id
              AND (deletion.scope='tenant' OR deletion.connection_id=permit.connection_id)
              AND deletion.status IN ('queued','running','retry_wait','verifying','failed')
         )
    )
  $query$ INTO permitted USING subject_id,auth_session_id,p_object_name;
  RETURN permitted;
EXCEPTION
  WHEN undefined_table OR undefined_function OR invalid_text_representation THEN
    RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION extensions.albert_raw_storage_webhook_authorized(
  p_object_name text,
  p_command text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  jwt jsonb;
  subject_id uuid;
  auth_session_id uuid;
  permitted boolean := false;
BEGIN
  IF p_command NOT IN ('select','insert')
     OR NOT extensions.albert_raw_storage_machine_authorized('webhook')
     OR to_regclass('control_plane.raw_storage_webhook_session_grants') IS NULL THEN
    RETURN false;
  END IF;
  jwt := extensions.albert_auth_jwt();
  IF coalesce(jwt->>'session_id','') !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;
  subject_id := extensions.albert_auth_uid();
  auth_session_id := (jwt->>'session_id')::uuid;
  EXECUTE $query$
    SELECT EXISTS (
      SELECT 1
        FROM control_plane.raw_storage_webhook_session_grants AS grant_row
        JOIN control_plane.webhook_receipts AS receipt
          ON receipt.tenant_id=grant_row.tenant_id
         AND receipt.connection_id=grant_row.connection_id
         AND receipt.webhook_receipt_id=grant_row.webhook_receipt_id
        JOIN control_plane.connections AS connection
          ON connection.tenant_id=receipt.tenant_id
         AND connection.connection_id=receipt.connection_id
        JOIN control_plane.tenants AS tenant
          ON tenant.tenant_id=receipt.tenant_id
       WHERE grant_row.auth_user_id=$1
         AND grant_row.auth_session_id=$2
         AND grant_row.object_key=$3
         AND grant_row.revoked_at IS NULL
         AND grant_row.expires_at>statement_timestamp()
         AND grant_row.connector_key=receipt.connector_key
         AND receipt.signature_verified
         AND receipt.status IN ('received','failed')
         AND (receipt.raw_object_key IS NULL OR receipt.raw_object_key=grant_row.object_key)
         AND connection.status IN ('connected','degraded')
         AND tenant.status='active'
         AND NOT EXISTS (
           SELECT 1 FROM control_plane.deletion_requests AS deletion
            WHERE deletion.tenant_id=receipt.tenant_id
              AND (deletion.scope='tenant' OR deletion.connection_id=receipt.connection_id)
              AND deletion.status IN ('queued','running','retry_wait','verifying','failed')
         )
         AND (
           (
             receipt.connector_key='deputy'
             AND grant_row.xero_inbox_id IS NULL
             AND EXISTS (
               SELECT 1 FROM control_plane.deputy_webhook_material AS material
                WHERE material.tenant_id=receipt.tenant_id
                  AND material.connection_id=receipt.connection_id
                  AND material.material_id=grant_row.verification_reference
                  AND material.setup_status='active'
                  AND material.retired_at IS NULL
             )
           )
           OR (
             receipt.connector_key='xero'
             AND grant_row.xero_inbox_id=receipt.vendor_event_id
             AND EXISTS (
               SELECT 1 FROM control_plane.xero_webhook_inbox AS inbox
                WHERE inbox.inbox_id=grant_row.xero_inbox_id
                  AND inbox.status='processing'
                  AND inbox.lease_owner=grant_row.xero_lease_owner
                  AND inbox.lease_token=grant_row.xero_lease_token
                  AND inbox.lease_version=grant_row.xero_lease_version
                  AND inbox.lease_expires_at>statement_timestamp()
             )
           )
         )
    )
  $query$ INTO permitted USING subject_id,auth_session_id,p_object_name;
  RETURN permitted;
EXCEPTION
  WHEN undefined_table OR undefined_function OR invalid_text_representation THEN
    RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION extensions.albert_raw_storage_deletion_authorized(
  p_object_name text,
  p_command text
)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  jwt jsonb;
  subject_id uuid;
  auth_session_id uuid;
  object_scope text[];
  permitted boolean := false;
BEGIN
  IF p_command NOT IN ('select','delete')
     OR NOT extensions.albert_raw_storage_machine_authorized('deletion')
     OR to_regclass('control_plane.raw_storage_deletion_session_grants') IS NULL THEN
    RETURN false;
  END IF;
  jwt := extensions.albert_auth_jwt();
  IF coalesce(jwt->>'session_id','') !~*
       '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN
    RETURN false;
  END IF;
  subject_id := extensions.albert_auth_uid();
  auth_session_id := (jwt->>'session_id')::uuid;
  object_scope := regexp_match(
    p_object_name,
    '^tenant/([0-9A-HJKMNP-TV-Z]{26})/connection/([0-9A-HJKMNP-TV-Z]{26})/stream/[A-Za-z0-9._-]{1,120}/date/[0-9]{4}-[0-9]{2}-[0-9]{2}/batch-[0-9A-HJKMNP-TV-Z]{26}[.]jsonl?[.]gz$'
  );
  IF object_scope IS NULL THEN RETURN false; END IF;
  EXECUTE $query$
    SELECT EXISTS (
      SELECT 1
        FROM control_plane.raw_storage_deletion_session_grants AS grant_row
        JOIN control_plane.deletion_requests AS request
          ON request.tenant_id=grant_row.tenant_id
         AND request.deletion_request_id=grant_row.deletion_request_id
        JOIN control_plane.deletion_job_attempts AS attempt
          ON attempt.tenant_id=grant_row.tenant_id
         AND attempt.deletion_request_id=grant_row.deletion_request_id
         AND attempt.attempt_number=grant_row.attempt_number
         AND attempt.worker_id=grant_row.worker_id
       WHERE grant_row.auth_user_id=$1
         AND grant_row.auth_session_id=$2
         AND grant_row.tenant_id=$3
         AND (
           grant_row.scope='tenant'
           OR (grant_row.scope='connection' AND grant_row.connection_id=$4)
         )
         AND (
           ($5='select' AND grant_row.operation IN ('purge','verify'))
           OR ($5='delete' AND grant_row.operation='purge')
         )
         AND grant_row.revoked_at IS NULL
         AND grant_row.expires_at>statement_timestamp()
         AND request.queue_message_id=grant_row.message_id
         AND (
           (grant_row.operation='purge' AND request.status='running')
           OR (grant_row.operation='verify' AND request.status='verifying')
         )
         AND attempt.visibility_deadline>statement_timestamp()
         AND attempt.outcome IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM control_plane.deletion_job_attempts AS later
            WHERE later.tenant_id=attempt.tenant_id
              AND later.deletion_request_id=attempt.deletion_request_id
              AND later.attempt_number>attempt.attempt_number
         )
    )
  $query$ INTO permitted
  USING subject_id,auth_session_id,object_scope[1],object_scope[2],p_command;
  RETURN permitted;
EXCEPTION
  WHEN undefined_table OR undefined_function OR invalid_text_representation THEN
    RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION
  extensions.albert_raw_storage_sync_authorized(text,text),
  extensions.albert_raw_storage_webhook_authorized(text,text),
  extensions.albert_raw_storage_deletion_authorized(text,text)
FROM PUBLIC,anon,authenticated,service_role,
     albert_control_migration_owner,albert_sync_control,albert_webhook_control,
     albert_transform_control,albert_semantic_control,
     albert_operator_diagnostic_control,albert_deletion_control;
GRANT EXECUTE ON FUNCTION
  extensions.albert_raw_storage_sync_authorized(text,text),
  extensions.albert_raw_storage_webhook_authorized(text,text),
  extensions.albert_raw_storage_deletion_authorized(text,text)
TO authenticated;

-- The unscoped principals can exercise only fixed non-customer sentinels for
-- readiness. Every customer key takes a lease-bound branch.
DROP POLICY IF EXISTS albert_raw_sync_insert ON storage.objects;
CREATE POLICY albert_raw_sync_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id='raw-payloads'
    AND (
      (
        extensions.albert_raw_storage_machine_authorized('sync')
        AND name='tenant/00000000000000000000000000/connection/00000000000000000000000000/stream/albert_readiness/date/2000-01-01/batch-00000000000000000000000000.jsonl.gz'
      )
      OR extensions.albert_raw_storage_sync_authorized(name,'insert')
    )
  );

DROP POLICY IF EXISTS albert_raw_sync_select ON storage.objects;
CREATE POLICY albert_raw_sync_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id='raw-payloads'
    AND (
      (
        extensions.albert_raw_storage_machine_authorized('sync')
        AND name='tenant/00000000000000000000000000/connection/00000000000000000000000000/stream/albert_readiness/date/2000-01-01/batch-00000000000000000000000000.jsonl.gz'
      )
      OR extensions.albert_raw_storage_sync_authorized(name,'select')
    )
  );

DROP POLICY IF EXISTS albert_raw_webhook_insert ON storage.objects;
CREATE POLICY albert_raw_webhook_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id='raw-payloads'
    AND (
      (
        extensions.albert_raw_storage_machine_authorized('webhook')
        AND name='tenant/00000000000000000000000000/connection/00000000000000000000000000/stream/webhook_xero/date/2000-01-01/batch-00000000000000000000000000.json.gz'
      )
      OR extensions.albert_raw_storage_webhook_authorized(name,'insert')
    )
  );

DROP POLICY IF EXISTS albert_raw_webhook_select ON storage.objects;
CREATE POLICY albert_raw_webhook_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id='raw-payloads'
    AND (
      (
        extensions.albert_raw_storage_machine_authorized('webhook')
        AND name='tenant/00000000000000000000000000/connection/00000000000000000000000000/stream/webhook_xero/date/2000-01-01/batch-00000000000000000000000000.json.gz'
      )
      OR extensions.albert_raw_storage_webhook_authorized(name,'select')
    )
  );

DROP POLICY IF EXISTS albert_raw_deletion_select ON storage.objects;
CREATE POLICY albert_raw_deletion_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id='raw-payloads'
    AND (
      (
        extensions.albert_raw_storage_machine_authorized('deletion')
        AND name IN (
          'tenant/00000000000000000000000000/connection/00000000000000000000000000/stream/albert_readiness/date/2000-01-01/batch-00000000000000000000000000.jsonl.gz',
          'tenant/00000000000000000000000000/connection/00000000000000000000000000/stream/webhook_xero/date/2000-01-01/batch-00000000000000000000000000.json.gz'
        )
      )
      OR extensions.albert_raw_storage_deletion_authorized(name,'select')
    )
  );

DROP POLICY IF EXISTS albert_raw_deletion_delete ON storage.objects;
CREATE POLICY albert_raw_deletion_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id='raw-payloads'
    AND extensions.albert_raw_storage_deletion_authorized(name,'delete')
  );

CREATE OR REPLACE FUNCTION extensions.albert_verify_lease_bound_raw_storage_authority()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  policy_count integer;
  policy_expression text;
BEGIN
  IF to_regclass('control_plane.raw_storage_sync_session_grants') IS NULL
     OR to_regclass('control_plane.raw_storage_webhook_session_grants') IS NULL
     OR to_regclass('control_plane.raw_storage_deletion_session_grants') IS NULL THEN
    RAISE EXCEPTION 'raw Storage session grant relations are missing';
  END IF;
  SELECT count(*) INTO policy_count FROM pg_policy
   WHERE polrelid='storage.objects'::regclass
     AND polname IN (
       'albert_raw_sync_insert','albert_raw_sync_select',
       'albert_raw_webhook_insert','albert_raw_webhook_select',
       'albert_raw_deletion_select','albert_raw_deletion_delete'
     );
  IF policy_count<>6 THEN RAISE EXCEPTION 'lease-bound raw Storage policy set is incomplete'; END IF;
  SELECT string_agg(coalesce(pg_get_expr(policy.polqual,policy.polrelid),'')||' '||
                    coalesce(pg_get_expr(policy.polwithcheck,policy.polrelid),''),' ')
    INTO policy_expression FROM pg_policy AS policy
   WHERE policy.polrelid='storage.objects'::regclass
     AND policy.polname LIKE 'albert_raw_%';
  IF policy_expression NOT LIKE '%albert_raw_storage_sync_authorized%'
     OR policy_expression NOT LIKE '%albert_raw_storage_webhook_authorized%'
     OR policy_expression NOT LIKE '%albert_raw_storage_deletion_authorized%'
     OR policy_expression NOT LIKE '%00000000000000000000000000%'
     OR NOT has_function_privilege(
       'authenticated','extensions.albert_raw_storage_sync_authorized(text,text)','EXECUTE'
     )
     OR NOT has_function_privilege(
       'authenticated','extensions.albert_raw_storage_webhook_authorized(text,text)','EXECUTE'
     )
     OR NOT has_function_privilege(
       'authenticated','extensions.albert_raw_storage_deletion_authorized(text,text)','EXECUTE'
     )
     OR has_function_privilege(
       'service_role','extensions.albert_raw_storage_deletion_authorized(text,text)','EXECUTE'
     ) THEN
    RAISE EXCEPTION 'raw Storage policy is not fully lease-bound';
  END IF;
  REVOKE EXECUTE ON FUNCTION
    extensions.albert_verify_lease_bound_raw_storage_authority()
  FROM albert_control_migration_owner;
END;
$$;

REVOKE ALL ON FUNCTION extensions.albert_verify_lease_bound_raw_storage_authority()
FROM PUBLIC,anon,authenticated,service_role,
     albert_sync_control,albert_webhook_control,albert_transform_control,
     albert_semantic_control,albert_operator_diagnostic_control,
     albert_deletion_control;
GRANT EXECUTE ON FUNCTION extensions.albert_verify_lease_bound_raw_storage_authority()
TO albert_control_migration_owner;

COMMIT;
