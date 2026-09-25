-- 0178: Keep the Stripe Fivetran ERD catalog current with 2026 connector tables.
--
-- Fivetran ENABLE ALL still lands every official table. stripe_erd_tables
-- drives source_stripe.st_source_catalog and the leftover st_* explorer
-- views, so missing Payment Link children would look like an incomplete ERD
-- after the first backfill. latest_charge_id is the August 2026 PaymentIntent
-- column the cubes already SELECT * through.
--
-- Also: Fivetran Stripe creates varchar(256) and writes NULL tenant_id. Stamp
-- widens those columns to text and leaves tenant_id nullable on stripe_
-- destinations so the historical load is not aborted.

BEGIN;

INSERT INTO ingestion.stripe_erd_tables (table_name) VALUES
  ('credit_note_line_item_tax_rate'),
  ('invoice_account_tax_id'),
  ('invoice_line_item_proration_details_credited_items'),
  ('payment_link_custom_field'),
  ('payment_link_custom_field_dropdown_option'),
  ('payment_link_invoice_creation_invoice_data_account_tax'),
  ('payment_link_invoice_creation_invoice_data_custom_field'),
  ('payment_link_payment_method_type'),
  ('payment_link_shipping_option')
ON CONFLICT (table_name) DO NOTHING;

INSERT INTO ingestion.stripe_contract_columns (view_name, ordinal, column_name, candidates, data_type) VALUES
  ('st_payment_intent', 14, 'latest_charge_id', ARRAY['latest_charge_id', 'latest_charge'], 'text')
ON CONFLICT (view_name, column_name) DO UPDATE SET
  ordinal = EXCLUDED.ordinal,
  candidates = EXCLUDED.candidates,
  data_type = EXCLUDED.data_type;

-- Fivetran Stripe creates varchar(256). Live values overflow and abort the
-- historical sync. Widen new columns before they enter the union views.
CREATE OR REPLACE FUNCTION ingestion.widen_fivetran_varchar_columns(p_destination_schema text)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  target record;
  widened integer := 0;
BEGIN
  IF p_destination_schema IS NULL OR p_destination_schema !~ '^stripe_[a-z0-9_]{1,120}$' THEN
    RETURN 0;
  END IF;
  IF to_regnamespace(p_destination_schema) IS NULL THEN
    RETURN 0;
  END IF;

  FOR target IN
    SELECT class.relname AS table_name, attribute.attname AS column_name
      FROM pg_catalog.pg_attribute AS attribute
      JOIN pg_catalog.pg_class AS class ON class.oid = attribute.attrelid
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = class.relnamespace
     WHERE namespace.nspname = p_destination_schema
       AND class.relkind = 'r'
       AND attribute.attnum > 0
       AND NOT attribute.attisdropped
       AND format_type(attribute.atttypid, attribute.atttypmod) LIKE 'character varying%'
     ORDER BY class.relname, attribute.attname
  LOOP
    BEGIN
      EXECUTE format(
        'ALTER TABLE %I.%I ALTER COLUMN %I TYPE text',
        p_destination_schema, target.table_name, target.column_name
      );
      widened := widened + 1;
    EXCEPTION
      WHEN insufficient_privilege OR dependent_objects_still_exist OR feature_not_supported THEN
        NULL;
    END;
  END LOOP;
  RETURN widened;
END;
$$;

REVOKE ALL ON FUNCTION ingestion.widen_fivetran_varchar_columns(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ingestion.widen_fivetran_varchar_columns(text) TO ingest_rw;

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

  PERFORM ingestion.widen_fivetran_varchar_columns(p_destination_schema);

  FOR target IN
    SELECT class.relname AS table_name, class.oid AS relid
      FROM pg_catalog.pg_class AS class
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = class.relnamespace
     WHERE namespace.nspname = p_destination_schema
       AND class.relkind = 'r'
       AND NOT class.relispartition
       AND NOT (
         EXISTS (
           SELECT 1 FROM pg_catalog.pg_attribute AS attribute
            WHERE attribute.attrelid = class.oid
              AND attribute.attname = 'tenant_id'
              AND NOT attribute.attisdropped
              AND (
                p_destination_schema LIKE 'stripe\_%'
                OR attribute.attnotnull
              )
         )
         AND EXISTS (
           SELECT 1 FROM pg_catalog.pg_policy AS policy
            WHERE policy.polrelid = class.oid AND policy.polname = 'tenant_scope'
         )
       )
  LOOP
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_attribute AS attribute
         WHERE attribute.attrelid = target.relid
           AND attribute.attname = 'tenant_id'
           AND NOT attribute.attisdropped
      ) THEN
        EXECUTE format('ALTER TABLE %I.%I ADD COLUMN tenant_id text', p_destination_schema, target.table_name);
      END IF;
      EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN tenant_id SET DEFAULT %L',
                     p_destination_schema, target.table_name, binding.tenant_id);
      EXECUTE format('UPDATE %I.%I SET tenant_id = %L WHERE tenant_id IS NULL',
                     p_destination_schema, target.table_name, binding.tenant_id);
      -- Fivetran Stripe drops NOT NULL on tenant_id during schema sync. Forcing
      -- it back races the historical load and is labelled as a permission task.
      IF p_destination_schema NOT LIKE 'stripe\_%' THEN
        EXECUTE format('ALTER TABLE %I.%I ALTER COLUMN tenant_id SET NOT NULL',
                       p_destination_schema, target.table_name);
      END IF;
      EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', p_destination_schema, target.table_name);
      EXECUTE format('DROP POLICY IF EXISTS tenant_scope ON %I.%I', p_destination_schema, target.table_name);
      EXECUTE format(
        'CREATE POLICY tenant_scope ON %I.%I
           USING (tenant_id = (SELECT ingestion.current_tenant_id()))
           WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()))',
        p_destination_schema, target.table_name);
      EXECUTE format('GRANT SELECT ON TABLE %I.%I TO diagnostic_ro, transform_rw',
                     p_destination_schema, target.table_name);
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

SELECT ingestion.widen_fivetran_varchar_columns(binding.destination_schema)
  FROM ingestion.fivetran_destination_bindings AS binding
 WHERE binding.retired_at IS NULL
   AND binding.destination_schema LIKE 'stripe\_%';

SELECT ingestion.rebuild_stripe_official_views();

COMMIT;
