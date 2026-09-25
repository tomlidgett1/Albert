-- 0170: disconnecting a Fivetran-managed source erases its landed data.
--
-- Disconnect already deletes the Fivetran connection and retires the binding
-- (the schema leaves the Cube contract instantly), but the destination schema
-- itself stayed in the analytical database indefinitely — the verified
-- deletion chain covers native source_* schemas only. This adds
-- ingestion.purge_fivetran_destination(): drop the schema CASCADE, but only
-- when its binding is already retired, so a purge can never race a live sync
-- and can never target a schema the tenant still uses. purged_at records the
-- erasure on the binding row, which is retained as the audit trail.
--
-- The one-off DO block erases every already-retired destination schema left
-- behind before this migration existed (nine empty connect-attempt shells and
-- the superseded standard-connector schema).
BEGIN;

ALTER TABLE ingestion.fivetran_destination_bindings
  ADD COLUMN IF NOT EXISTS purged_at timestamptz;

CREATE OR REPLACE FUNCTION ingestion.purge_fivetran_destination(
  p_destination_schema text,
  p_tenant_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  binding ingestion.fivetran_destination_bindings%ROWTYPE;
BEGIN
  IF p_destination_schema IS NULL OR p_destination_schema !~ '^[a-z][a-z0-9_]{0,127}$' THEN
    RAISE EXCEPTION 'fivetran destination schema is invalid' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO binding
    FROM ingestion.fivetran_destination_bindings
   WHERE destination_schema = p_destination_schema
     AND tenant_id = p_tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fivetran destination schema is not registered' USING ERRCODE = 'P0002';
  END IF;
  IF binding.retired_at IS NULL THEN
    RAISE EXCEPTION 'fivetran destination schema is still active; retire it before purging'
      USING ERRCODE = '55000';
  END IF;
  IF to_regnamespace(p_destination_schema) IS NOT NULL THEN
    EXECUTE format('DROP SCHEMA %I CASCADE', p_destination_schema);
  END IF;
  UPDATE ingestion.fivetran_destination_bindings
     SET purged_at = coalesce(purged_at, clock_timestamp())
   WHERE destination_schema = p_destination_schema;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION ingestion.purge_fivetran_destination(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ingestion.purge_fivetran_destination(text, text) TO ingest_rw;

-- One-off: erase every schema whose binding was retired before purge existed.
DO $$
DECLARE binding record;
BEGIN
  FOR binding IN
    SELECT destination_schema, tenant_id
      FROM ingestion.fivetran_destination_bindings
     WHERE retired_at IS NOT NULL AND purged_at IS NULL
  LOOP
    PERFORM ingestion.purge_fivetran_destination(binding.destination_schema, binding.tenant_id);
  END LOOP;
END $$;

COMMIT;
