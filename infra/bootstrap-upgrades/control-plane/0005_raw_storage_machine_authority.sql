BEGIN;

-- Generated Supabase S3 access keys bypass every Storage policy and therefore
-- cannot enforce immutable ingestion. Albert uses short-lived machine-user JWT
-- session credentials instead. This administrator-owned mapping is the only
-- authority consulted by the raw-payloads policies and is intentionally
-- outside every application/runtime schema.
DO $$
BEGIN
  IF current_user <> 'postgres' OR session_user <> 'postgres' THEN
    RAISE EXCEPTION 'raw Storage machine authority requires the protected postgres login';
  END IF;
  IF to_regclass('storage.objects') IS NULL
     OR to_regclass('auth.users') IS NULL
     OR to_regprocedure('extensions.albert_auth_uid()') IS NULL
     OR to_regprocedure('extensions.albert_auth_jwt()') IS NULL THEN
    RAISE EXCEPTION 'managed Storage and Auth compatibility objects are required';
  END IF;
END;
$$;

CREATE TABLE IF NOT EXISTS albert_bootstrap.raw_storage_machine_principal (
  purpose text PRIMARY KEY CHECK (purpose IN ('sync','webhook','deletion')),
  auth_user_id uuid NOT NULL UNIQUE
    REFERENCES auth.users(id) ON UPDATE NO ACTION ON DELETE RESTRICT,
  credential_generation bigint NOT NULL CHECK (credential_generation > 0),
  active boolean NOT NULL DEFAULT true,
  provisioned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  rotated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (active)
);
ALTER TABLE albert_bootstrap.raw_storage_machine_principal OWNER TO postgres;
REVOKE ALL ON TABLE albert_bootstrap.raw_storage_machine_principal
  FROM PUBLIC, anon, authenticated, service_role,
       albert_control_migration_owner, albert_sync_control,
       albert_webhook_control, albert_transform_control,
       albert_semantic_control, albert_operator_diagnostic_control,
       albert_deletion_control;

CREATE OR REPLACE FUNCTION extensions.albert_raw_storage_machine_authorized(
  p_purpose text
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT p_purpose IN ('sync','webhook','deletion')
     AND extensions.albert_auth_uid() IS NOT NULL
     AND extensions.albert_auth_jwt()->>'role' = 'authenticated'
     AND extensions.albert_auth_jwt()->'app_metadata'->>'albert_raw_storage_purpose' = p_purpose
     AND extensions.albert_auth_jwt()->'app_metadata'->>'albert_machine_principal' = 'true'
     AND EXISTS (
       SELECT 1
         FROM albert_bootstrap.raw_storage_machine_principal AS principal
        WHERE principal.purpose = p_purpose
          AND principal.auth_user_id = extensions.albert_auth_uid()
          AND principal.active
     )
$$;

REVOKE ALL ON FUNCTION extensions.albert_raw_storage_machine_authorized(text)
  FROM PUBLIC, anon, authenticated, service_role,
       albert_control_migration_owner, albert_sync_control,
       albert_webhook_control, albert_transform_control,
       albert_semantic_control, albert_operator_diagnostic_control,
       albert_deletion_control;
GRANT EXECUTE ON FUNCTION extensions.albert_raw_storage_machine_authorized(text)
  TO authenticated;

-- Keep the path grammar in policy as defence in depth. Sync and webhook
-- principals cannot see one another's evidence; deletion can enumerate and
-- remove both only after the separate durable deletion fence is claimed.
DROP POLICY IF EXISTS albert_raw_sync_insert ON storage.objects;
CREATE POLICY albert_raw_sync_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'raw-payloads'
    AND extensions.albert_raw_storage_machine_authorized('sync')
    AND name ~ '^tenant/[0-9A-HJKMNP-TV-Z]{26}/connection/[0-9A-HJKMNP-TV-Z]{26}/stream/[A-Za-z0-9._-]{1,120}/date/[0-9]{4}-[0-9]{2}-[0-9]{2}/batch-[0-9A-HJKMNP-TV-Z]{26}[.]jsonl[.]gz$'
    AND name !~ '/stream/webhook_'
  );

DROP POLICY IF EXISTS albert_raw_sync_select ON storage.objects;
CREATE POLICY albert_raw_sync_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'raw-payloads'
    AND extensions.albert_raw_storage_machine_authorized('sync')
    AND name ~ '^tenant/[0-9A-HJKMNP-TV-Z]{26}/connection/[0-9A-HJKMNP-TV-Z]{26}/stream/[A-Za-z0-9._-]{1,120}/date/[0-9]{4}-[0-9]{2}-[0-9]{2}/batch-[0-9A-HJKMNP-TV-Z]{26}[.]jsonl[.]gz$'
    AND name !~ '/stream/webhook_'
  );

DROP POLICY IF EXISTS albert_raw_webhook_insert ON storage.objects;
CREATE POLICY albert_raw_webhook_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'raw-payloads'
    AND extensions.albert_raw_storage_machine_authorized('webhook')
    AND name ~ '^tenant/[0-9A-HJKMNP-TV-Z]{26}/connection/[0-9A-HJKMNP-TV-Z]{26}/stream/webhook_(xero|deputy)/date/[0-9]{4}-[0-9]{2}-[0-9]{2}/batch-[0-9A-HJKMNP-TV-Z]{26}[.]json[.]gz$'
  );

DROP POLICY IF EXISTS albert_raw_webhook_select ON storage.objects;
CREATE POLICY albert_raw_webhook_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'raw-payloads'
    AND extensions.albert_raw_storage_machine_authorized('webhook')
    AND name ~ '^tenant/[0-9A-HJKMNP-TV-Z]{26}/connection/[0-9A-HJKMNP-TV-Z]{26}/stream/webhook_(xero|deputy)/date/[0-9]{4}-[0-9]{2}-[0-9]{2}/batch-[0-9A-HJKMNP-TV-Z]{26}[.]json[.]gz$'
  );

DROP POLICY IF EXISTS albert_raw_deletion_select ON storage.objects;
CREATE POLICY albert_raw_deletion_select ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'raw-payloads'
    AND extensions.albert_raw_storage_machine_authorized('deletion')
    AND name ~ '^tenant/[0-9A-HJKMNP-TV-Z]{26}/connection/[0-9A-HJKMNP-TV-Z]{26}/stream/[A-Za-z0-9._-]{1,120}/date/[0-9]{4}-[0-9]{2}-[0-9]{2}/batch-[0-9A-HJKMNP-TV-Z]{26}[.]jsonl?[.]gz$'
  );

DROP POLICY IF EXISTS albert_raw_deletion_delete ON storage.objects;
CREATE POLICY albert_raw_deletion_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'raw-payloads'
    AND extensions.albert_raw_storage_machine_authorized('deletion')
    AND name ~ '^tenant/[0-9A-HJKMNP-TV-Z]{26}/connection/[0-9A-HJKMNP-TV-Z]{26}/stream/[A-Za-z0-9._-]{1,120}/date/[0-9]{4}-[0-9]{2}-[0-9]{2}/batch-[0-9A-HJKMNP-TV-Z]{26}[.]jsonl?[.]gz$'
  );

CREATE OR REPLACE FUNCTION extensions.albert_verify_raw_storage_machine_authority()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  expected_policy_count integer;
BEGIN
  IF pg_get_userbyid((
    SELECT class.relowner
      FROM pg_class AS class
     WHERE class.oid = 'albert_bootstrap.raw_storage_machine_principal'::regclass
  )) <> 'postgres' THEN
    RAISE EXCEPTION 'raw Storage principal mapping is not administrator-owned';
  END IF;
  IF has_table_privilege('authenticated','albert_bootstrap.raw_storage_machine_principal','SELECT')
     OR has_table_privilege('service_role','albert_bootstrap.raw_storage_machine_principal','SELECT')
     OR has_table_privilege('albert_control_migration_owner','albert_bootstrap.raw_storage_machine_principal','SELECT') THEN
    RAISE EXCEPTION 'raw Storage principal mapping is directly readable';
  END IF;
  SELECT count(*) INTO expected_policy_count
    FROM pg_policy
   WHERE polrelid = 'storage.objects'::regclass
     AND polname IN (
       'albert_raw_sync_insert','albert_raw_sync_select',
       'albert_raw_webhook_insert','albert_raw_webhook_select',
       'albert_raw_deletion_select','albert_raw_deletion_delete'
     );
  IF expected_policy_count <> 6 THEN
    RAISE EXCEPTION 'the exact raw Storage policy set is incomplete';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policy
     WHERE polrelid = 'storage.objects'::regclass
       AND polname LIKE 'albert_raw_%'
       AND polcmd = 'w'
  ) THEN
    RAISE EXCEPTION 'raw Storage must not grant UPDATE through an Albert policy';
  END IF;
  REVOKE EXECUTE ON FUNCTION extensions.albert_verify_raw_storage_machine_authority()
    FROM albert_control_migration_owner;
END;
$$;

REVOKE ALL ON FUNCTION extensions.albert_verify_raw_storage_machine_authority()
  FROM PUBLIC, anon, authenticated, service_role,
       albert_sync_control, albert_webhook_control, albert_transform_control,
       albert_semantic_control, albert_operator_diagnostic_control,
       albert_deletion_control;
GRANT EXECUTE ON FUNCTION extensions.albert_verify_raw_storage_machine_authority()
  TO albert_control_migration_owner;

COMMIT;
