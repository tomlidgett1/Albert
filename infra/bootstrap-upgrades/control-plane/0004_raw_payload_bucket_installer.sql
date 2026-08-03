BEGIN;

-- storage.buckets is protected by RLS with no browser policy. Managed postgres
-- has BYPASSRLS, while Albert's migration owner deliberately does not. Expose
-- only the one V1 bucket definition and consume the installer in migration
-- 0042 after every application table migration has succeeded.
DO $$
BEGIN
  IF current_user <> 'postgres' OR session_user <> 'postgres' THEN
    RAISE EXCEPTION 'raw payload bucket installation requires the protected postgres login';
  END IF;
  IF NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname='postgres') THEN
    RAISE EXCEPTION 'managed postgres must retain its Storage RLS bypass';
  END IF;
  IF to_regclass('storage.buckets') IS NULL THEN
    RAISE EXCEPTION 'the managed Supabase Storage bucket catalogue is missing';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION extensions.albert_install_raw_payload_bucket()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = off
SET lock_timeout = '10s'
AS $$
DECLARE
  installed storage.buckets%ROWTYPE;
BEGIN
  INSERT INTO storage.buckets(
    id,
    name,
    public,
    file_size_limit,
    allowed_mime_types
  ) VALUES (
    'raw-payloads',
    'raw-payloads',
    false,
    52428800,
    ARRAY['application/gzip', 'application/x-gzip']::text[]
  )
  ON CONFLICT(id) DO UPDATE SET
    name=excluded.name,
    public=false,
    file_size_limit=excluded.file_size_limit,
    allowed_mime_types=excluded.allowed_mime_types;

  SELECT * INTO STRICT installed
    FROM storage.buckets
   WHERE id='raw-payloads';
  IF installed.name<>'raw-payloads'
     OR installed.public
     OR installed.file_size_limit<>52428800
     OR installed.allowed_mime_types IS DISTINCT FROM
        ARRAY['application/gzip', 'application/x-gzip']::text[] THEN
    RAISE EXCEPTION 'raw payload bucket did not converge to its fixed private definition';
  END IF;

  REVOKE EXECUTE ON FUNCTION extensions.albert_install_raw_payload_bucket()
    FROM albert_control_migration_owner;
END;
$$;

REVOKE ALL ON FUNCTION extensions.albert_install_raw_payload_bucket()
  FROM PUBLIC, anon, authenticated, service_role,
       albert_sync_control, albert_webhook_control, albert_transform_control,
       albert_semantic_control, albert_deletion_control;
GRANT EXECUTE ON FUNCTION extensions.albert_install_raw_payload_bucket()
  TO albert_control_migration_owner;

COMMIT;
