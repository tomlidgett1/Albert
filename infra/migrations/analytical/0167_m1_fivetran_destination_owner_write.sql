-- register/stamp run as albert_migration_owner via SECURITY DEFINER, but
-- FORCE RLS still evaluated ingestion.current_tenant_id() against the ingest
-- runtime session_user. That login has no signed capability during Fivetran
-- OAuth start, so Connect failed with "analytical capability is missing".
-- ENABLE RLS stays on so transform/diagnostic readers remain tenant-scoped.
-- The table owner (these functions) can write the binding they already
-- validated against p_tenant_id.

BEGIN;

ALTER TABLE ingestion.fivetran_destination_bindings NO FORCE ROW LEVEL SECURITY;

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
  IF p_destination_schema IS NULL OR p_destination_schema !~ '^[a-z][a-z0-9_]{0,127}$' THEN
    RAISE EXCEPTION 'fivetran destination schema is invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT ingestion.is_ulid(p_tenant_id) OR NOT ingestion.is_ulid(p_connection_id) THEN
    RAISE EXCEPTION 'fivetran destination identity is invalid' USING ERRCODE = '22023';
  END IF;
  IF p_destination_schema <> ('xero_' || lower(p_connection_id))
     AND p_destination_schema !~ ('^[a-z][a-z0-9_]*_' || lower(p_connection_id) || '$') THEN
    RAISE EXCEPTION 'fivetran destination schema is not bound to this connection' USING ERRCODE = '22023';
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
    RAISE EXCEPTION 'fivetran destination schema is already bound to another tenant'
      USING ERRCODE = '23505';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION ingestion.stamp_fivetran_destination(
  p_destination_schema text,
  p_tenant_id text
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  binding ingestion.fivetran_destination_bindings%ROWTYPE;
  target record;
  stamped integer := 0;
BEGIN
  IF p_destination_schema IS NULL OR p_destination_schema !~ '^[a-z][a-z0-9_]{0,127}$' THEN
    RAISE EXCEPTION 'fivetran destination schema is invalid' USING ERRCODE = '22023';
  END IF;
  IF NOT ingestion.is_ulid(p_tenant_id) THEN
    RAISE EXCEPTION 'fivetran destination identity is invalid' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO binding
    FROM ingestion.fivetran_destination_bindings
   WHERE destination_schema = p_destination_schema
     AND tenant_id = p_tenant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fivetran destination schema is not registered' USING ERRCODE = 'P0002';
  END IF;

  FOR target IN
    SELECT class.relname AS table_name
      FROM pg_catalog.pg_class AS class
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = class.relnamespace
     WHERE namespace.nspname = p_destination_schema
       AND class.relkind = 'r'
       AND NOT class.relispartition
  LOOP
    BEGIN
      IF NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_attribute AS attribute
         WHERE attribute.attrelid = format('%I.%I', p_destination_schema, target.table_name)::regclass
           AND attribute.attname = 'tenant_id'
           AND NOT attribute.attisdropped
      ) THEN
        EXECUTE format(
          'ALTER TABLE %I.%I ADD COLUMN tenant_id text',
          p_destination_schema,
          target.table_name
        );
      END IF;
      EXECUTE format(
        'ALTER TABLE %I.%I ALTER COLUMN tenant_id SET DEFAULT %L',
        p_destination_schema,
        target.table_name,
        binding.tenant_id
      );
      EXECUTE format(
        'UPDATE %I.%I SET tenant_id = %L WHERE tenant_id IS NULL',
        p_destination_schema,
        target.table_name,
        binding.tenant_id
      );
      EXECUTE format(
        'ALTER TABLE %I.%I ALTER COLUMN tenant_id SET NOT NULL',
        p_destination_schema,
        target.table_name
      );
      EXECUTE format(
        'ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY',
        p_destination_schema,
        target.table_name
      );
      EXECUTE format(
        'DROP POLICY IF EXISTS tenant_scope ON %I.%I',
        p_destination_schema,
        target.table_name
      );
      EXECUTE format(
        'CREATE POLICY tenant_scope ON %I.%I
           USING (tenant_id = (SELECT ingestion.current_tenant_id()))
           WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()))',
        p_destination_schema,
        target.table_name
      );
      EXECUTE format(
        'GRANT SELECT ON TABLE %I.%I TO diagnostic_ro, transform_rw',
        p_destination_schema,
        target.table_name
      );
      stamped := stamped + 1;
    EXCEPTION
      WHEN insufficient_privilege OR feature_not_supported OR datatype_mismatch
        OR not_null_violation OR undefined_column OR duplicate_object THEN
        NULL;
    END;
  END LOOP;

  RETURN stamped;
END;
$$;

COMMIT;
