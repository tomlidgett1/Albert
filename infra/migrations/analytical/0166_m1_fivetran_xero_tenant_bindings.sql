-- Bind each Fivetran Xero destination schema to one Albert tenant and stamp
-- tenant_id onto Fivetran's native tables when the migration owner can alter
-- them. Schema names stay Fivetran-legal; Albert does not invent source_* tables.

BEGIN;

CREATE TABLE IF NOT EXISTS ingestion.fivetran_destination_bindings (
  destination_schema text PRIMARY KEY
    CHECK (destination_schema ~ '^[a-z][a-z0-9_]{0,127}$'),
  tenant_id text NOT NULL CHECK (ingestion.is_ulid(tenant_id)),
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (connection_id)
);

COMMENT ON TABLE ingestion.fivetran_destination_bindings IS
  'Maps one Fivetran destination schema to exactly one Albert tenant and connection.';

ALTER TABLE ingestion.fivetran_destination_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ingestion.fivetran_destination_bindings FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_scope ON ingestion.fivetran_destination_bindings;
CREATE POLICY tenant_scope ON ingestion.fivetran_destination_bindings
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE OR REPLACE FUNCTION ingestion.grant_fivetran_schema_writer(
  p_schema text,
  p_role text
)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_role IS NULL OR p_role !~ '^[a-z_][a-z0-9_]{0,62}$' THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = p_role) THEN
    RETURN;
  END IF;
  EXECUTE format('GRANT USAGE, CREATE ON SCHEMA %I TO %I', p_schema, p_role);
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

  PERFORM set_config('albert.tenant_id', p_tenant_id, true);

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

  PERFORM set_config('albert.tenant_id', p_tenant_id, true);

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

REVOKE ALL ON FUNCTION ingestion.grant_fivetran_schema_writer(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ingestion.register_fivetran_destination(text, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION ingestion.stamp_fivetran_destination(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ingestion.register_fivetran_destination(text, text, text, text)
  TO ingest_rw;
GRANT EXECUTE ON FUNCTION ingestion.stamp_fivetran_destination(text, text)
  TO ingest_rw;
GRANT SELECT ON ingestion.fivetran_destination_bindings TO transform_rw, diagnostic_ro;

COMMIT;
