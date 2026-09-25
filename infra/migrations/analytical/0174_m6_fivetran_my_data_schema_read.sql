-- Let the capability-scoped diagnostic runtime resolve registered Fivetran
-- destination schemas. Table SELECT remains unavailable until the existing
-- tenant-stamping path applies RLS and grants it explicitly.

BEGIN;

CREATE OR REPLACE FUNCTION ingestion.grant_fivetran_schema_reader(p_schema text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_schema IS NULL OR p_schema !~ '^[a-z][a-z0-9_]{0,62}$' THEN
    RAISE EXCEPTION 'Fivetran destination schema is invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM ingestion.fivetran_destination_bindings AS binding
     WHERE binding.destination_schema = p_schema
  ) THEN
    RAISE EXCEPTION 'Fivetran destination schema is not registered' USING ERRCODE = 'P0002';
  END IF;
  EXECUTE format('GRANT USAGE ON SCHEMA %I TO diagnostic_ro, transform_rw', p_schema);
END;
$$;

CREATE OR REPLACE FUNCTION ingestion.register_fivetran_destination(
  p_destination_schema text,
  p_tenant_id text,
  p_connection_id text,
  p_writer_role text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
BEGIN
  IF p_destination_schema IS NULL OR p_destination_schema !~ '^[a-z][a-z0-9_]{0,62}$' THEN
    RAISE EXCEPTION 'Fivetran destination schema is invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT ingestion.is_ulid(p_tenant_id) OR NOT ingestion.is_ulid(p_connection_id) THEN
    RAISE EXCEPTION 'Fivetran destination identity is invalid' USING ERRCODE = '22023';
  END IF;
  IF p_destination_schema <> ('xero_' || lower(p_connection_id))
     AND p_destination_schema !~ ('^[a-z][a-z0-9_]*_' || lower(p_connection_id) || '$') THEN
    RAISE EXCEPTION 'Fivetran destination schema is not bound to this connection'
      USING ERRCODE = '22023';
  END IF;

  EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I', p_destination_schema);
  EXECUTE format('REVOKE ALL ON SCHEMA %I FROM PUBLIC', p_destination_schema);
  PERFORM ingestion.grant_fivetran_schema_writer(p_destination_schema, 'ingest_rw');
  PERFORM ingestion.grant_fivetran_schema_writer(p_destination_schema, 'fivetran');
  PERFORM ingestion.grant_fivetran_schema_writer(p_destination_schema, p_writer_role);

  INSERT INTO ingestion.fivetran_destination_bindings (
    destination_schema, tenant_id, connection_id
  ) VALUES (
    p_destination_schema, p_tenant_id, p_connection_id
  )
  ON CONFLICT (destination_schema) DO UPDATE
    SET tenant_id = EXCLUDED.tenant_id
  WHERE ingestion.fivetran_destination_bindings.tenant_id = EXCLUDED.tenant_id
    AND ingestion.fivetran_destination_bindings.connection_id = EXCLUDED.connection_id;

  IF NOT EXISTS (
    SELECT 1
      FROM ingestion.fivetran_destination_bindings AS binding
     WHERE binding.destination_schema = p_destination_schema
       AND binding.tenant_id = p_tenant_id
       AND binding.connection_id = p_connection_id
  ) THEN
    RAISE EXCEPTION 'Fivetran destination schema is already bound to another tenant'
      USING ERRCODE = '23505';
  END IF;

  PERFORM ingestion.grant_fivetran_schema_reader(p_destination_schema);
END;
$$;

DO $$
DECLARE
  binding record;
BEGIN
  FOR binding IN
    SELECT destination_schema
      FROM ingestion.fivetran_destination_bindings
     WHERE retired_at IS NULL
       AND purged_at IS NULL
       AND pg_catalog.to_regnamespace(destination_schema) IS NOT NULL
     ORDER BY destination_schema
  LOOP
    PERFORM ingestion.grant_fivetran_schema_reader(binding.destination_schema);
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION ingestion.grant_fivetran_schema_reader(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ingestion.register_fivetran_destination(text, text, text, text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ingestion.register_fivetran_destination(text, text, text, text)
  TO ingest_rw;

COMMIT;
