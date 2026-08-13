BEGIN;

-- Generated from connector manifests. Do not hand-edit field columns.
-- Exact raw payloads remain in immutable object storage; these tables hold only typed projections.

CREATE SCHEMA IF NOT EXISTS source_square;
COMMENT ON SCHEMA source_square IS 'Typed Square staging and governed native-field projections.';
REVOKE ALL ON SCHEMA source_square FROM PUBLIC;
GRANT USAGE ON SCHEMA source_square TO ingest_rw, transform_rw, diagnostic_ro, semantic_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE albert_migration_owner IN SCHEMA source_square GRANT SELECT, INSERT, UPDATE ON TABLES TO ingest_rw;
ALTER DEFAULT PRIVILEGES FOR ROLE albert_migration_owner IN SCHEMA source_square GRANT SELECT ON TABLES TO transform_rw, diagnostic_ro, semantic_ro;

CREATE TABLE IF NOT EXISTS "source_square"."square_merchants" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_merchants" IS 'Typed square square_merchants staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_merchants_connection_watermark_idx"
  ON "source_square"."square_merchants" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_merchants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_merchants" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_merchants";
CREATE POLICY tenant_scope ON "source_square"."square_merchants"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_locations" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_locations" IS 'Typed square square_locations staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_locations_connection_watermark_idx"
  ON "source_square"."square_locations" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_locations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_locations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_locations";
CREATE POLICY tenant_scope ON "source_square"."square_locations"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_merchant_custom_attribute_definitions" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_merchant_custom_attribute_definitions" IS 'Typed square square_merchant_custom_attribute_definitions staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_merchant_custom_attribute_definitions_connection_watermark_idx"
  ON "source_square"."square_merchant_custom_attribute_definitions" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_merchant_custom_attribute_definitions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_merchant_custom_attribute_definitions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_merchant_custom_attribute_definitions";
CREATE POLICY tenant_scope ON "source_square"."square_merchant_custom_attribute_definitions"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_merchant_custom_attributes" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_merchant_custom_attributes" IS 'Typed square square_merchant_custom_attributes staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_merchant_custom_attributes_connection_watermark_idx"
  ON "source_square"."square_merchant_custom_attributes" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_merchant_custom_attributes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_merchant_custom_attributes" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_merchant_custom_attributes";
CREATE POLICY tenant_scope ON "source_square"."square_merchant_custom_attributes"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_location_custom_attribute_definitions" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_location_custom_attribute_definitions" IS 'Typed square square_location_custom_attribute_definitions staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_location_custom_attribute_definitions_connection_watermark_idx"
  ON "source_square"."square_location_custom_attribute_definitions" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_location_custom_attribute_definitions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_location_custom_attribute_definitions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_location_custom_attribute_definitions";
CREATE POLICY tenant_scope ON "source_square"."square_location_custom_attribute_definitions"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_location_custom_attributes" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_location_custom_attributes" IS 'Typed square square_location_custom_attributes staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_location_custom_attributes_connection_watermark_idx"
  ON "source_square"."square_location_custom_attributes" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_location_custom_attributes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_location_custom_attributes" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_location_custom_attributes";
CREATE POLICY tenant_scope ON "source_square"."square_location_custom_attributes"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_orders" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_orders" IS 'Typed square square_orders staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_orders_connection_watermark_idx"
  ON "source_square"."square_orders" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_orders" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_orders";
CREATE POLICY tenant_scope ON "source_square"."square_orders"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_order_custom_attribute_definitions" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_order_custom_attribute_definitions" IS 'Typed square square_order_custom_attribute_definitions staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_order_custom_attribute_definitions_connection_watermark_idx"
  ON "source_square"."square_order_custom_attribute_definitions" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_order_custom_attribute_definitions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_order_custom_attribute_definitions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_order_custom_attribute_definitions";
CREATE POLICY tenant_scope ON "source_square"."square_order_custom_attribute_definitions"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_order_custom_attributes" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_order_custom_attributes" IS 'Typed square square_order_custom_attributes staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_order_custom_attributes_connection_watermark_idx"
  ON "source_square"."square_order_custom_attributes" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_order_custom_attributes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_order_custom_attributes" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_order_custom_attributes";
CREATE POLICY tenant_scope ON "source_square"."square_order_custom_attributes"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_payments" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_payments" IS 'Typed square square_payments staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_payments_connection_watermark_idx"
  ON "source_square"."square_payments" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_payments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_payments";
CREATE POLICY tenant_scope ON "source_square"."square_payments"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_refunds" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_refunds" IS 'Typed square square_refunds staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_refunds_connection_watermark_idx"
  ON "source_square"."square_refunds" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_refunds" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_refunds" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_refunds";
CREATE POLICY tenant_scope ON "source_square"."square_refunds"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_payment_links" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_payment_links" IS 'Typed square square_payment_links staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_payment_links_connection_watermark_idx"
  ON "source_square"."square_payment_links" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_payment_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_payment_links" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_payment_links";
CREATE POLICY tenant_scope ON "source_square"."square_payment_links"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_checkout_merchant_settings" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_checkout_merchant_settings" IS 'Typed square square_checkout_merchant_settings staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_checkout_merchant_settings_connection_watermark_idx"
  ON "source_square"."square_checkout_merchant_settings" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_checkout_merchant_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_checkout_merchant_settings" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_checkout_merchant_settings";
CREATE POLICY tenant_scope ON "source_square"."square_checkout_merchant_settings"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_checkout_location_settings" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_checkout_location_settings" IS 'Typed square square_checkout_location_settings staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_checkout_location_settings_connection_watermark_idx"
  ON "source_square"."square_checkout_location_settings" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_checkout_location_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_checkout_location_settings" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_checkout_location_settings";
CREATE POLICY tenant_scope ON "source_square"."square_checkout_location_settings"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_catalog_objects" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_catalog_objects" IS 'Typed square square_catalog_objects staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_catalog_objects_connection_watermark_idx"
  ON "source_square"."square_catalog_objects" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_catalog_objects" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_catalog_objects" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_catalog_objects";
CREATE POLICY tenant_scope ON "source_square"."square_catalog_objects"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_inventory_counts" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_inventory_counts" IS 'Typed square square_inventory_counts staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_inventory_counts_connection_watermark_idx"
  ON "source_square"."square_inventory_counts" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_inventory_counts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_inventory_counts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_inventory_counts";
CREATE POLICY tenant_scope ON "source_square"."square_inventory_counts"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_inventory_changes" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_inventory_changes" IS 'Typed square square_inventory_changes staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_inventory_changes_connection_watermark_idx"
  ON "source_square"."square_inventory_changes" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_inventory_changes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_inventory_changes" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_inventory_changes";
CREATE POLICY tenant_scope ON "source_square"."square_inventory_changes"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_inventory_adjustment_reasons" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_inventory_adjustment_reasons" IS 'Typed square square_inventory_adjustment_reasons staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_inventory_adjustment_reasons_connection_watermark_idx"
  ON "source_square"."square_inventory_adjustment_reasons" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_inventory_adjustment_reasons" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_inventory_adjustment_reasons" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_inventory_adjustment_reasons";
CREATE POLICY tenant_scope ON "source_square"."square_inventory_adjustment_reasons"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_transfer_orders" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_transfer_orders" IS 'Typed square square_transfer_orders staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_transfer_orders_connection_watermark_idx"
  ON "source_square"."square_transfer_orders" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_transfer_orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_transfer_orders" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_transfer_orders";
CREATE POLICY tenant_scope ON "source_square"."square_transfer_orders"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_customers" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_customers" IS 'Typed square square_customers staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_customers_connection_watermark_idx"
  ON "source_square"."square_customers" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_customers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_customers" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_customers";
CREATE POLICY tenant_scope ON "source_square"."square_customers"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_customer_custom_attribute_definitions" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_customer_custom_attribute_definitions" IS 'Typed square square_customer_custom_attribute_definitions staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_customer_custom_attribute_definitions_connection_watermark_idx"
  ON "source_square"."square_customer_custom_attribute_definitions" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_customer_custom_attribute_definitions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_customer_custom_attribute_definitions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_customer_custom_attribute_definitions";
CREATE POLICY tenant_scope ON "source_square"."square_customer_custom_attribute_definitions"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_customer_custom_attributes" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_customer_custom_attributes" IS 'Typed square square_customer_custom_attributes staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_customer_custom_attributes_connection_watermark_idx"
  ON "source_square"."square_customer_custom_attributes" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_customer_custom_attributes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_customer_custom_attributes" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_customer_custom_attributes";
CREATE POLICY tenant_scope ON "source_square"."square_customer_custom_attributes"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_customer_groups" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_customer_groups" IS 'Typed square square_customer_groups staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_customer_groups_connection_watermark_idx"
  ON "source_square"."square_customer_groups" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_customer_groups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_customer_groups" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_customer_groups";
CREATE POLICY tenant_scope ON "source_square"."square_customer_groups"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_customer_segments" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_customer_segments" IS 'Typed square square_customer_segments staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_customer_segments_connection_watermark_idx"
  ON "source_square"."square_customer_segments" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_customer_segments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_customer_segments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_customer_segments";
CREATE POLICY tenant_scope ON "source_square"."square_customer_segments"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_jobs" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_jobs" IS 'Typed square square_jobs staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_jobs_connection_watermark_idx"
  ON "source_square"."square_jobs" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_jobs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_jobs";
CREATE POLICY tenant_scope ON "source_square"."square_jobs"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_team_members" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_team_members" IS 'Typed square square_team_members staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_team_members_connection_watermark_idx"
  ON "source_square"."square_team_members" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_team_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_team_members" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_team_members";
CREATE POLICY tenant_scope ON "source_square"."square_team_members"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_team_member_wage_settings" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_team_member_wage_settings" IS 'Typed square square_team_member_wage_settings staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_team_member_wage_settings_connection_watermark_idx"
  ON "source_square"."square_team_member_wage_settings" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_team_member_wage_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_team_member_wage_settings" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_team_member_wage_settings";
CREATE POLICY tenant_scope ON "source_square"."square_team_member_wage_settings"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_break_types" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_break_types" IS 'Typed square square_break_types staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_break_types_connection_watermark_idx"
  ON "source_square"."square_break_types" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_break_types" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_break_types" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_break_types";
CREATE POLICY tenant_scope ON "source_square"."square_break_types"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_scheduled_shifts" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_scheduled_shifts" IS 'Typed square square_scheduled_shifts staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_scheduled_shifts_connection_watermark_idx"
  ON "source_square"."square_scheduled_shifts" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_scheduled_shifts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_scheduled_shifts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_scheduled_shifts";
CREATE POLICY tenant_scope ON "source_square"."square_scheduled_shifts"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_timecards" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_timecards" IS 'Typed square square_timecards staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_timecards_connection_watermark_idx"
  ON "source_square"."square_timecards" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_timecards" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_timecards" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_timecards";
CREATE POLICY tenant_scope ON "source_square"."square_timecards"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_team_member_wages" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_team_member_wages" IS 'Typed square square_team_member_wages staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_team_member_wages_connection_watermark_idx"
  ON "source_square"."square_team_member_wages" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_team_member_wages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_team_member_wages" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_team_member_wages";
CREATE POLICY tenant_scope ON "source_square"."square_team_member_wages"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_workweek_configs" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_workweek_configs" IS 'Typed square square_workweek_configs staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_workweek_configs_connection_watermark_idx"
  ON "source_square"."square_workweek_configs" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_workweek_configs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_workweek_configs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_workweek_configs";
CREATE POLICY tenant_scope ON "source_square"."square_workweek_configs"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_cash_drawer_shifts" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_cash_drawer_shifts" IS 'Typed square square_cash_drawer_shifts staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_cash_drawer_shifts_connection_watermark_idx"
  ON "source_square"."square_cash_drawer_shifts" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_cash_drawer_shifts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_cash_drawer_shifts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_cash_drawer_shifts";
CREATE POLICY tenant_scope ON "source_square"."square_cash_drawer_shifts"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_cash_drawer_shift_events" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_cash_drawer_shift_events" IS 'Typed square square_cash_drawer_shift_events staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_cash_drawer_shift_events_connection_watermark_idx"
  ON "source_square"."square_cash_drawer_shift_events" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_cash_drawer_shift_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_cash_drawer_shift_events" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_cash_drawer_shift_events";
CREATE POLICY tenant_scope ON "source_square"."square_cash_drawer_shift_events"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_payouts" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_payouts" IS 'Typed square square_payouts staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_payouts_connection_watermark_idx"
  ON "source_square"."square_payouts" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_payouts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_payouts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_payouts";
CREATE POLICY tenant_scope ON "source_square"."square_payouts"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_payout_entries" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_payout_entries" IS 'Typed square square_payout_entries staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_payout_entries_connection_watermark_idx"
  ON "source_square"."square_payout_entries" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_payout_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_payout_entries" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_payout_entries";
CREATE POLICY tenant_scope ON "source_square"."square_payout_entries"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_bank_accounts" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_bank_accounts" IS 'Typed square square_bank_accounts staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_bank_accounts_connection_watermark_idx"
  ON "source_square"."square_bank_accounts" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_bank_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_bank_accounts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_bank_accounts";
CREATE POLICY tenant_scope ON "source_square"."square_bank_accounts"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_cards" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_cards" IS 'Typed square square_cards staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_cards_connection_watermark_idx"
  ON "source_square"."square_cards" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_cards" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_cards" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_cards";
CREATE POLICY tenant_scope ON "source_square"."square_cards"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_gift_cards" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_gift_cards" IS 'Typed square square_gift_cards staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_gift_cards_connection_watermark_idx"
  ON "source_square"."square_gift_cards" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_gift_cards" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_gift_cards" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_gift_cards";
CREATE POLICY tenant_scope ON "source_square"."square_gift_cards"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_gift_card_activities" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_gift_card_activities" IS 'Typed square square_gift_card_activities staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_gift_card_activities_connection_watermark_idx"
  ON "source_square"."square_gift_card_activities" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_gift_card_activities" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_gift_card_activities" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_gift_card_activities";
CREATE POLICY tenant_scope ON "source_square"."square_gift_card_activities"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_loyalty_accounts" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_loyalty_accounts" IS 'Typed square square_loyalty_accounts staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_loyalty_accounts_connection_watermark_idx"
  ON "source_square"."square_loyalty_accounts" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_loyalty_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_loyalty_accounts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_loyalty_accounts";
CREATE POLICY tenant_scope ON "source_square"."square_loyalty_accounts"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_loyalty_events" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_loyalty_events" IS 'Typed square square_loyalty_events staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_loyalty_events_connection_watermark_idx"
  ON "source_square"."square_loyalty_events" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_loyalty_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_loyalty_events" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_loyalty_events";
CREATE POLICY tenant_scope ON "source_square"."square_loyalty_events"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_loyalty_programs" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_loyalty_programs" IS 'Typed square square_loyalty_programs staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_loyalty_programs_connection_watermark_idx"
  ON "source_square"."square_loyalty_programs" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_loyalty_programs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_loyalty_programs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_loyalty_programs";
CREATE POLICY tenant_scope ON "source_square"."square_loyalty_programs"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_loyalty_promotions" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_loyalty_promotions" IS 'Typed square square_loyalty_promotions staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_loyalty_promotions_connection_watermark_idx"
  ON "source_square"."square_loyalty_promotions" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_loyalty_promotions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_loyalty_promotions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_loyalty_promotions";
CREATE POLICY tenant_scope ON "source_square"."square_loyalty_promotions"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_loyalty_rewards" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_loyalty_rewards" IS 'Typed square square_loyalty_rewards staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_loyalty_rewards_connection_watermark_idx"
  ON "source_square"."square_loyalty_rewards" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_loyalty_rewards" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_loyalty_rewards" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_loyalty_rewards";
CREATE POLICY tenant_scope ON "source_square"."square_loyalty_rewards"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_invoices" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_invoices" IS 'Typed square square_invoices staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_invoices_connection_watermark_idx"
  ON "source_square"."square_invoices" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_invoices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_invoices" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_invoices";
CREATE POLICY tenant_scope ON "source_square"."square_invoices"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_subscriptions" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_subscriptions" IS 'Typed square square_subscriptions staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_subscriptions_connection_watermark_idx"
  ON "source_square"."square_subscriptions" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_subscriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_subscriptions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_subscriptions";
CREATE POLICY tenant_scope ON "source_square"."square_subscriptions"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_subscription_events" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_subscription_events" IS 'Typed square square_subscription_events staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_subscription_events_connection_watermark_idx"
  ON "source_square"."square_subscription_events" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_subscription_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_subscription_events" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_subscription_events";
CREATE POLICY tenant_scope ON "source_square"."square_subscription_events"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_bookings" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_bookings" IS 'Typed square square_bookings staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_bookings_connection_watermark_idx"
  ON "source_square"."square_bookings" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_bookings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_bookings" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_bookings";
CREATE POLICY tenant_scope ON "source_square"."square_bookings"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_booking_custom_attribute_definitions" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_booking_custom_attribute_definitions" IS 'Typed square square_booking_custom_attribute_definitions staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_booking_custom_attribute_definitions_connection_watermark_idx"
  ON "source_square"."square_booking_custom_attribute_definitions" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_booking_custom_attribute_definitions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_booking_custom_attribute_definitions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_booking_custom_attribute_definitions";
CREATE POLICY tenant_scope ON "source_square"."square_booking_custom_attribute_definitions"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_booking_custom_attributes" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_booking_custom_attributes" IS 'Typed square square_booking_custom_attributes staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_booking_custom_attributes_connection_watermark_idx"
  ON "source_square"."square_booking_custom_attributes" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_booking_custom_attributes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_booking_custom_attributes" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_booking_custom_attributes";
CREATE POLICY tenant_scope ON "source_square"."square_booking_custom_attributes"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_booking_business_profile" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_booking_business_profile" IS 'Typed square square_booking_business_profile staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_booking_business_profile_connection_watermark_idx"
  ON "source_square"."square_booking_business_profile" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_booking_business_profile" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_booking_business_profile" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_booking_business_profile";
CREATE POLICY tenant_scope ON "source_square"."square_booking_business_profile"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_booking_location_profiles" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_booking_location_profiles" IS 'Typed square square_booking_location_profiles staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_booking_location_profiles_connection_watermark_idx"
  ON "source_square"."square_booking_location_profiles" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_booking_location_profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_booking_location_profiles" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_booking_location_profiles";
CREATE POLICY tenant_scope ON "source_square"."square_booking_location_profiles"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_booking_team_member_profiles" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_booking_team_member_profiles" IS 'Typed square square_booking_team_member_profiles staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_booking_team_member_profiles_connection_watermark_idx"
  ON "source_square"."square_booking_team_member_profiles" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_booking_team_member_profiles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_booking_team_member_profiles" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_booking_team_member_profiles";
CREATE POLICY tenant_scope ON "source_square"."square_booking_team_member_profiles"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_disputes" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_disputes" IS 'Typed square square_disputes staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_disputes_connection_watermark_idx"
  ON "source_square"."square_disputes" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_disputes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_disputes" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_disputes";
CREATE POLICY tenant_scope ON "source_square"."square_disputes"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_dispute_evidence" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_dispute_evidence" IS 'Typed square square_dispute_evidence staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_dispute_evidence_connection_watermark_idx"
  ON "source_square"."square_dispute_evidence" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_dispute_evidence" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_dispute_evidence" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_dispute_evidence";
CREATE POLICY tenant_scope ON "source_square"."square_dispute_evidence"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_vendors" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_vendors" IS 'Typed square square_vendors staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_vendors_connection_watermark_idx"
  ON "source_square"."square_vendors" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_vendors" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_vendors" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_vendors";
CREATE POLICY tenant_scope ON "source_square"."square_vendors"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_channels" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_channels" IS 'Typed square square_channels staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_channels_connection_watermark_idx"
  ON "source_square"."square_channels" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_channels" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_channels" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_channels";
CREATE POLICY tenant_scope ON "source_square"."square_channels"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_devices" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_devices" IS 'Typed square square_devices staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_devices_connection_watermark_idx"
  ON "source_square"."square_devices" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_devices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_devices" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_devices";
CREATE POLICY tenant_scope ON "source_square"."square_devices"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_sites" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_sites" IS 'Typed square square_sites staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_sites_connection_watermark_idx"
  ON "source_square"."square_sites" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_sites" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_sites" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_sites";
CREATE POLICY tenant_scope ON "source_square"."square_sites"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_snippets" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_snippets" IS 'Typed square square_snippets staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_snippets_connection_watermark_idx"
  ON "source_square"."square_snippets" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_snippets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_snippets" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_snippets";
CREATE POLICY tenant_scope ON "source_square"."square_snippets"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_terminal_actions" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_terminal_actions" IS 'Typed square square_terminal_actions staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_terminal_actions_connection_watermark_idx"
  ON "source_square"."square_terminal_actions" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_terminal_actions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_terminal_actions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_terminal_actions";
CREATE POLICY tenant_scope ON "source_square"."square_terminal_actions"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_terminal_checkouts" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_terminal_checkouts" IS 'Typed square square_terminal_checkouts staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_terminal_checkouts_connection_watermark_idx"
  ON "source_square"."square_terminal_checkouts" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_terminal_checkouts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_terminal_checkouts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_terminal_checkouts";
CREATE POLICY tenant_scope ON "source_square"."square_terminal_checkouts"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_square"."square_terminal_refunds" (
  tenant_id text NOT NULL,
  namespaced_source_key text NOT NULL,
  connection_id text NOT NULL CHECK (ingestion.is_ulid(connection_id)),
  external_account_reference text NOT NULL,
  source_record_id text NOT NULL,
  source_version text,
  source_updated_at timestamptz,
  payload_hash text NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  payload_batch_id text NOT NULL,
  sync_run_id text NOT NULL CHECK (ingestion.is_ulid(sync_run_id)),
  tombstone boolean NOT NULL DEFAULT false,
  mapping_version text NOT NULL,
  "payload_json" jsonb,
  "field_index" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_square"."square_terminal_refunds" IS 'Typed square square_terminal_refunds staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "square_terminal_refunds_connection_watermark_idx"
  ON "source_square"."square_terminal_refunds" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_square"."square_terminal_refunds" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_square"."square_terminal_refunds" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_square"."square_terminal_refunds";
CREATE POLICY tenant_scope ON "source_square"."square_terminal_refunds"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE OR REPLACE VIEW source_square.sq_source_fields
WITH (security_invoker = true)
AS
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_merchants'::text AS parent_stream,
  'Merchant'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_merchants" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_locations'::text AS parent_stream,
  'Location'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_locations" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_merchant_custom_attribute_definitions'::text AS parent_stream,
  'CustomAttributeDefinition'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_merchant_custom_attribute_definitions" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_merchant_custom_attributes'::text AS parent_stream,
  'CustomAttribute'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_merchant_custom_attributes" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_location_custom_attribute_definitions'::text AS parent_stream,
  'CustomAttributeDefinition'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_location_custom_attribute_definitions" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_location_custom_attributes'::text AS parent_stream,
  'CustomAttribute'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_location_custom_attributes" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_orders'::text AS parent_stream,
  'Order'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_orders" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_order_custom_attribute_definitions'::text AS parent_stream,
  'CustomAttributeDefinition'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_order_custom_attribute_definitions" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_order_custom_attributes'::text AS parent_stream,
  'CustomAttribute'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_order_custom_attributes" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_payments'::text AS parent_stream,
  'Payment'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_payments" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_refunds'::text AS parent_stream,
  'PaymentRefund'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_refunds" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_payment_links'::text AS parent_stream,
  'PaymentLink'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_payment_links" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_checkout_merchant_settings'::text AS parent_stream,
  'CheckoutMerchantSettings'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_checkout_merchant_settings" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_checkout_location_settings'::text AS parent_stream,
  'CheckoutLocationSettings'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_checkout_location_settings" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_catalog_objects'::text AS parent_stream,
  'CatalogObject'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_catalog_objects" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_inventory_counts'::text AS parent_stream,
  'InventoryCount'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_inventory_counts" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_inventory_changes'::text AS parent_stream,
  'InventoryChange'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_inventory_changes" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_inventory_adjustment_reasons'::text AS parent_stream,
  'InventoryAdjustmentReason'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_inventory_adjustment_reasons" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_transfer_orders'::text AS parent_stream,
  'TransferOrder'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_transfer_orders" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_customers'::text AS parent_stream,
  'Customer'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_customers" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_customer_custom_attribute_definitions'::text AS parent_stream,
  'CustomAttributeDefinition'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_customer_custom_attribute_definitions" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_customer_custom_attributes'::text AS parent_stream,
  'CustomAttribute'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_customer_custom_attributes" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_customer_groups'::text AS parent_stream,
  'CustomerGroup'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_customer_groups" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_customer_segments'::text AS parent_stream,
  'CustomerSegment'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_customer_segments" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_jobs'::text AS parent_stream,
  'Job'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_jobs" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_team_members'::text AS parent_stream,
  'TeamMember'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_team_members" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_team_member_wage_settings'::text AS parent_stream,
  'WageSetting'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_team_member_wage_settings" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_break_types'::text AS parent_stream,
  'BreakType'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_break_types" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_scheduled_shifts'::text AS parent_stream,
  'ScheduledShift'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_scheduled_shifts" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_timecards'::text AS parent_stream,
  'Timecard'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_timecards" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_team_member_wages'::text AS parent_stream,
  'TeamMemberWage'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_team_member_wages" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_workweek_configs'::text AS parent_stream,
  'WorkweekConfig'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_workweek_configs" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_cash_drawer_shifts'::text AS parent_stream,
  'CashDrawerShiftSummary'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_cash_drawer_shifts" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_cash_drawer_shift_events'::text AS parent_stream,
  'CashDrawerShiftEvent'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_cash_drawer_shift_events" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_payouts'::text AS parent_stream,
  'Payout'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_payouts" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_payout_entries'::text AS parent_stream,
  'PayoutEntry'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_payout_entries" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_bank_accounts'::text AS parent_stream,
  'BankAccount'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_bank_accounts" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_cards'::text AS parent_stream,
  'Card'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_cards" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_gift_cards'::text AS parent_stream,
  'GiftCard'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_gift_cards" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_gift_card_activities'::text AS parent_stream,
  'GiftCardActivity'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_gift_card_activities" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_loyalty_accounts'::text AS parent_stream,
  'LoyaltyAccount'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_loyalty_accounts" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_loyalty_events'::text AS parent_stream,
  'LoyaltyEvent'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_loyalty_events" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_loyalty_programs'::text AS parent_stream,
  'LoyaltyProgram'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_loyalty_programs" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_loyalty_promotions'::text AS parent_stream,
  'LoyaltyPromotion'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_loyalty_promotions" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_loyalty_rewards'::text AS parent_stream,
  'LoyaltyReward'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_loyalty_rewards" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_invoices'::text AS parent_stream,
  'Invoice'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_invoices" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_subscriptions'::text AS parent_stream,
  'Subscription'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_subscriptions" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_subscription_events'::text AS parent_stream,
  'SubscriptionEvent'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_subscription_events" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_bookings'::text AS parent_stream,
  'Booking'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_bookings" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_booking_custom_attribute_definitions'::text AS parent_stream,
  'CustomAttributeDefinition'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_booking_custom_attribute_definitions" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_booking_custom_attributes'::text AS parent_stream,
  'CustomAttribute'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_booking_custom_attributes" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_booking_business_profile'::text AS parent_stream,
  'BusinessBookingProfile'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_booking_business_profile" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_booking_location_profiles'::text AS parent_stream,
  'LocationBookingProfile'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_booking_location_profiles" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_booking_team_member_profiles'::text AS parent_stream,
  'TeamMemberBookingProfile'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_booking_team_member_profiles" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_disputes'::text AS parent_stream,
  'Dispute'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_disputes" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_dispute_evidence'::text AS parent_stream,
  'DisputeEvidence'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_dispute_evidence" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_vendors'::text AS parent_stream,
  'Vendor'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_vendors" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_channels'::text AS parent_stream,
  'Channel'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_channels" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_devices'::text AS parent_stream,
  'Device'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_devices" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_sites'::text AS parent_stream,
  'Site'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_sites" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_snippets'::text AS parent_stream,
  'Snippet'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_snippets" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_terminal_actions'::text AS parent_stream,
  'TerminalAction'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_terminal_actions" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_terminal_checkouts'::text AS parent_stream,
  'TerminalCheckout'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_terminal_checkouts" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
UNION ALL
SELECT
  parent.tenant_id,
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.connection_id,
  parent.external_account_reference,
  'square_terminal_refunds'::text AS parent_stream,
  'TerminalRefund'::text AS source_object_type,
  parent.source_record_id,
  parent.source_version,
  parent.source_updated_at,
  parent.payload_hash,
  parent.payload_batch_id,
  parent.sync_run_id,
  parent.tombstone,
  parent.mapping_version,
  parent.first_ingested_at,
  parent.ingested_at,
  field.item ->> 'path' AS field_path,
  field.item ->> 'pointer' AS field_ordinal_path,
  regexp_replace(field.item ->> 'path', '^.*\.', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  CASE WHEN field.item ->> 'kind' = 'string' THEN field.item ->> 'textValue' END AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)$' AND money.currency ~ '^[A-Z]{3}$' THEN (field.item ->> 'numericValue')::numeric END AS money_amount_minor,
  CASE WHEN field.item ->> 'pointer' ~ '/amount$' AND money.currency ~ '^[A-Z]{3}$' THEN money.currency END AS money_currency
FROM "source_square"."square_terminal_refunds" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
LEFT JOIN LATERAL (
  SELECT candidate.item ->> 'textValue' AS currency
  FROM jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS candidate(item)
  WHERE candidate.item ->> 'pointer' = regexp_replace(field.item ->> 'pointer', '/amount$', '/currency')
  LIMIT 1
) AS money ON field.item ->> 'pointer' ~ '/amount$'
;
COMMENT ON VIEW source_square.sq_source_fields IS 'One tenant-safe row per typed Square source-field occurrence; exhaustive fallback for curated semantic coverage.';
GRANT SELECT ON source_square.sq_source_fields TO transform_rw, diagnostic_ro, semantic_ro;

GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA "source_square" TO ingest_rw;
GRANT SELECT ON ALL TABLES IN SCHEMA "source_square" TO transform_rw, diagnostic_ro, semantic_ro;

COMMIT;
