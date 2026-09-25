BEGIN;

-- Generated from connector manifests. Do not hand-edit field columns.
-- Exact raw payloads remain in immutable object storage; these tables hold only typed projections.

CREATE SCHEMA IF NOT EXISTS source_lightspeed_x;
COMMENT ON SCHEMA source_lightspeed_x IS 'Typed Lightspeed X-Series staging and governed native-field projections.';
REVOKE ALL ON SCHEMA source_lightspeed_x FROM PUBLIC;
GRANT USAGE ON SCHEMA source_lightspeed_x TO ingest_rw, transform_rw, diagnostic_ro, semantic_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE albert_migration_owner IN SCHEMA source_lightspeed_x GRANT SELECT, INSERT, UPDATE ON TABLES TO ingest_rw;
ALTER DEFAULT PRIVILEGES FOR ROLE albert_migration_owner IN SCHEMA source_lightspeed_x GRANT SELECT ON TABLES TO transform_rw, diagnostic_ro, semantic_ro;

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_retailer" (
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
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_retailer" IS 'Typed lightspeed-x lx_retailer staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_retailer_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_retailer" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_retailer" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_retailer" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_retailer";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_retailer"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_outlets" (
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
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_outlets" IS 'Typed lightspeed-x lx_outlets staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_outlets_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_outlets" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_outlets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_outlets" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_outlets";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_outlets"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_registers" (
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
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_registers" IS 'Typed lightspeed-x lx_registers staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_registers_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_registers" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_registers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_registers" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_registers";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_registers"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_users" (
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
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_users" IS 'Typed lightspeed-x lx_users staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_users_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_users" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_users" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_users";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_users"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_user_sale_totals" (
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
  "albert_parent_user_id" text,
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_user_sale_totals" IS 'Typed lightspeed-x lx_user_sale_totals staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_user_sale_totals_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_user_sale_totals" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_user_sale_totals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_user_sale_totals" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_user_sale_totals";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_user_sale_totals"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_brands" (
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
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_brands" IS 'Typed lightspeed-x lx_brands staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_brands_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_brands" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_brands" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_brands" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_brands";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_brands"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_product_types" (
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
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_product_types" IS 'Typed lightspeed-x lx_product_types staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_product_types_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_product_types" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_product_types" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_product_types" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_product_types";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_product_types"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_product_categories" (
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
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_product_categories" IS 'Typed lightspeed-x lx_product_categories staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_product_categories_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_product_categories" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_product_categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_product_categories" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_product_categories";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_product_categories"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_tags" (
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
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_tags" IS 'Typed lightspeed-x lx_tags staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_tags_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_tags" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_tags" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_tags" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_tags";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_tags"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_products" (
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
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_products" IS 'Typed lightspeed-x lx_products staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_products_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_products" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_products" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_products" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_products";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_products"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_variant_attributes" (
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
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_variant_attributes" IS 'Typed lightspeed-x lx_variant_attributes staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_variant_attributes_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_variant_attributes" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_variant_attributes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_variant_attributes" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_variant_attributes";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_variant_attributes"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_price_books" (
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
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_price_books" IS 'Typed lightspeed-x lx_price_books staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_price_books_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_price_books" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_price_books" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_price_books" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_price_books";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_price_books"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_price_book_products" (
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
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_price_book_products" IS 'Typed lightspeed-x lx_price_book_products staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_price_book_products_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_price_book_products" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_price_book_products" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_price_book_products" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_price_book_products";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_price_book_products"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_inventory" (
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
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_inventory" IS 'Typed lightspeed-x lx_inventory staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_inventory_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_inventory" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_inventory" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_inventory" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_inventory";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_inventory"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_inventory_levels" (
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
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_inventory_levels" IS 'Typed lightspeed-x lx_inventory_levels staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_inventory_levels_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_inventory_levels" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_inventory_levels" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_inventory_levels" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_inventory_levels";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_inventory_levels"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_customer_groups" (
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
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_customer_groups" IS 'Typed lightspeed-x lx_customer_groups staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_customer_groups_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_customer_groups" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_customer_groups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_customer_groups" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_customer_groups";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_customer_groups"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_customers" (
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
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_customers" IS 'Typed lightspeed-x lx_customers staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_customers_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_customers" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_customers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_customers" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_customers";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_customers"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_customer_group_memberships" (
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
  "albert_parent_customer_group_id" text,
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_customer_group_memberships" IS 'Typed lightspeed-x lx_customer_group_memberships staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_customer_group_memberships_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_customer_group_memberships" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_customer_group_memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_customer_group_memberships" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_customer_group_memberships";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_customer_group_memberships"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_customer_addresses" (
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
  "albert_parent_customer_id" text,
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_customer_addresses" IS 'Typed lightspeed-x lx_customer_addresses staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_customer_addresses_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_customer_addresses" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_customer_addresses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_customer_addresses" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_customer_addresses";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_customer_addresses"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_suppliers" (
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
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_suppliers" IS 'Typed lightspeed-x lx_suppliers staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_suppliers_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_suppliers" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_suppliers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_suppliers" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_suppliers";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_suppliers"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_consignments" (
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
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_consignments" IS 'Typed lightspeed-x lx_consignments staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_consignments_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_consignments" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_consignments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_consignments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_consignments";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_consignments"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_consignment_products" (
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
  "albert_parent_consignment_id" text,
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_consignment_products" IS 'Typed lightspeed-x lx_consignment_products staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_consignment_products_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_consignment_products" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_consignment_products" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_consignment_products" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_consignment_products";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_consignment_products"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_consignment_totals" (
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
  "albert_parent_consignment_id" text,
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_consignment_totals" IS 'Typed lightspeed-x lx_consignment_totals staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_consignment_totals_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_consignment_totals" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_consignment_totals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_consignment_totals" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_consignment_totals";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_consignment_totals"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_taxes" (
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
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_taxes" IS 'Typed lightspeed-x lx_taxes staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_taxes_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_taxes" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_taxes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_taxes" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_taxes";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_taxes"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_outlet_taxes" (
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
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_outlet_taxes" IS 'Typed lightspeed-x lx_outlet_taxes staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_outlet_taxes_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_outlet_taxes" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_outlet_taxes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_outlet_taxes" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_outlet_taxes";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_outlet_taxes"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_payment_types" (
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
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_payment_types" IS 'Typed lightspeed-x lx_payment_types staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_payment_types_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_payment_types" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_payment_types" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_payment_types" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_payment_types";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_payment_types"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_sales" (
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
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_sales" IS 'Typed lightspeed-x lx_sales staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_sales_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_sales" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_sales" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_sales" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_sales";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_sales"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_register_payment_summaries" (
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
  "albert_parent_register_id" text,
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_register_payment_summaries" IS 'Typed lightspeed-x lx_register_payment_summaries staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_register_payment_summaries_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_register_payment_summaries" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_register_payment_summaries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_register_payment_summaries" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_register_payment_summaries";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_register_payment_summaries"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_fulfillments" (
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
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_fulfillments" IS 'Typed lightspeed-x lx_fulfillments staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_fulfillments_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_fulfillments" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_fulfillments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_fulfillments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_fulfillments";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_fulfillments"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_fulfillment_history" (
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
  "albert_parent_fulfillment_id" text,
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_fulfillment_history" IS 'Typed lightspeed-x lx_fulfillment_history staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_fulfillment_history_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_fulfillment_history" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_fulfillment_history" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_fulfillment_history" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_fulfillment_history";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_fulfillment_history"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_gift_cards" (
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
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_gift_cards" IS 'Typed lightspeed-x lx_gift_cards staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_gift_cards_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_gift_cards" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_gift_cards" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_gift_cards" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_gift_cards";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_gift_cards"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_promotions" (
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
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_promotions" IS 'Typed lightspeed-x lx_promotions staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_promotions_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_promotions" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_promotions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_promotions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_promotions";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_promotions"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_promotion_products" (
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
  "albert_parent_promotion_id" text,
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_promotion_products" IS 'Typed lightspeed-x lx_promotion_products staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_promotion_products_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_promotion_products" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_promotion_products" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_promotion_products" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_promotion_products";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_promotion_products"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_promotion_promocodes" (
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
  "albert_parent_promotion_id" text,
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_promotion_promocodes" IS 'Typed lightspeed-x lx_promotion_promocodes staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_promotion_promocodes_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_promotion_promocodes" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_promotion_promocodes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_promotion_promocodes" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_promotion_promocodes";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_promotion_promocodes"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_quotes" (
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
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_quotes" IS 'Typed lightspeed-x lx_quotes staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_quotes_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_quotes" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_quotes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_quotes" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_quotes";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_quotes"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_serial_numbers" (
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
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_serial_numbers" IS 'Typed lightspeed-x lx_serial_numbers staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_serial_numbers_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_serial_numbers" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_serial_numbers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_serial_numbers" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_serial_numbers";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_serial_numbers"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_services" (
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
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_services" IS 'Typed lightspeed-x lx_services staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_services_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_services" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_services" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_services" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_services";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_services"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_service_details" (
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
  "albert_parent_service_id" text,
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_service_details" IS 'Typed lightspeed-x lx_service_details staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_service_details_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_service_details" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_service_details" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_service_details" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_service_details";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_service_details"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_service_items" (
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
  "albert_parent_customer_id" text,
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_service_items" IS 'Typed lightspeed-x lx_service_items staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_service_items_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_service_items" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_service_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_service_items" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_service_items";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_service_items"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_service_statuses" (
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
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_service_statuses" IS 'Typed lightspeed-x lx_service_statuses staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_service_statuses_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_service_statuses" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_service_statuses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_service_statuses" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_service_statuses";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_service_statuses"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_service_agenda" (
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
  "albert_parent_outlet_id" text,
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_service_agenda" IS 'Typed lightspeed-x lx_service_agenda staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_service_agenda_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_service_agenda" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_service_agenda" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_service_agenda" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_service_agenda";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_service_agenda"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_shifts" (
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
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_shifts" IS 'Typed lightspeed-x lx_shifts staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_shifts_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_shifts" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_shifts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_shifts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_shifts";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_shifts"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_store_credits" (
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
  "albert_parent_customer_id" text,
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_store_credits" IS 'Typed lightspeed-x lx_store_credits staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_store_credits_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_store_credits" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_store_credits" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_store_credits" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_store_credits";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_store_credits"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_store_credit_report" (
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
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_store_credit_report" IS 'Typed lightspeed-x lx_store_credit_report staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_store_credit_report_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_store_credit_report" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_store_credit_report" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_store_credit_report" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_store_credit_report";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_store_credit_report"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_audit_log_events" (
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
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_audit_log_events" IS 'Typed lightspeed-x lx_audit_log_events staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_audit_log_events_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_audit_log_events" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_audit_log_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_audit_log_events" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_audit_log_events";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_audit_log_events"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_channels" (
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
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_channels" IS 'Typed lightspeed-x lx_channels staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_channels_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_channels" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_channels" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_channels" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_channels";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_channels"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_channel_requests" (
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
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_channel_requests" IS 'Typed lightspeed-x lx_channel_requests staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_channel_requests_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_channel_requests" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_channel_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_channel_requests" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_channel_requests";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_channel_requests"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_button_layouts" (
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
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_button_layouts" IS 'Typed lightspeed-x lx_button_layouts staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_button_layouts_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_button_layouts" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_button_layouts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_button_layouts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_button_layouts";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_button_layouts"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_partner_subscriptions" (
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
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_partner_subscriptions" IS 'Typed lightspeed-x lx_partner_subscriptions staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_partner_subscriptions_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_partner_subscriptions" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_partner_subscriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_partner_subscriptions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_partner_subscriptions";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_partner_subscriptions"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_business_rules" (
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
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_business_rules" IS 'Typed lightspeed-x lx_business_rules staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_business_rules_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_business_rules" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_business_rules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_business_rules" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_business_rules";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_business_rules"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_remote_rules" (
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
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_remote_rules" IS 'Typed lightspeed-x lx_remote_rules staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_remote_rules_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_remote_rules" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_remote_rules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_remote_rules" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_remote_rules";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_remote_rules"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed_x"."lx_custom_fields" (
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
  "field_index" jsonb,
  "payload_json" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed_x"."lx_custom_fields" IS 'Typed lightspeed-x lx_custom_fields staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "lx_custom_fields_connection_watermark_idx"
  ON "source_lightspeed_x"."lx_custom_fields" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed_x"."lx_custom_fields" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed_x"."lx_custom_fields" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed_x"."lx_custom_fields";
CREATE POLICY tenant_scope ON "source_lightspeed_x"."lx_custom_fields"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE OR REPLACE VIEW source_lightspeed_x.lx_source_fields
WITH (security_invoker = true)
AS
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_retailer'::text AS parent_stream,
  'Retailer'::text AS source_object_type,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_retailer" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_outlets'::text AS parent_stream,
  'Outlet'::text AS source_object_type,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_outlets" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_registers'::text AS parent_stream,
  'Register'::text AS source_object_type,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_registers" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_users'::text AS parent_stream,
  'User'::text AS source_object_type,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_users" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_user_sale_totals'::text AS parent_stream,
  'UserSaleTotal'::text AS source_object_type,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_user_sale_totals" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_brands'::text AS parent_stream,
  'Brand'::text AS source_object_type,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_brands" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_product_types'::text AS parent_stream,
  'ProductType'::text AS source_object_type,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_product_types" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_product_categories'::text AS parent_stream,
  'ProductCategory'::text AS source_object_type,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_product_categories" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_tags'::text AS parent_stream,
  'Tag'::text AS source_object_type,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_tags" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_products'::text AS parent_stream,
  'Product'::text AS source_object_type,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_products" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_variant_attributes'::text AS parent_stream,
  'VariantAttribute'::text AS source_object_type,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_variant_attributes" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_price_books'::text AS parent_stream,
  'PriceBook'::text AS source_object_type,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_price_books" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_price_book_products'::text AS parent_stream,
  'PriceBookProduct'::text AS source_object_type,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_price_book_products" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_inventory'::text AS parent_stream,
  'Inventory'::text AS source_object_type,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_inventory" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_inventory_levels'::text AS parent_stream,
  'InventoryLevel'::text AS source_object_type,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_inventory_levels" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_customer_groups'::text AS parent_stream,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_customer_groups" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_customers'::text AS parent_stream,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_customers" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_customer_group_memberships'::text AS parent_stream,
  'CustomerGroupMembership'::text AS source_object_type,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_customer_group_memberships" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_customer_addresses'::text AS parent_stream,
  'CustomerAddress'::text AS source_object_type,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_customer_addresses" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_suppliers'::text AS parent_stream,
  'Supplier'::text AS source_object_type,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_suppliers" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_consignments'::text AS parent_stream,
  'Consignment'::text AS source_object_type,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_consignments" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_consignment_products'::text AS parent_stream,
  'ConsignmentProduct'::text AS source_object_type,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_consignment_products" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_consignment_totals'::text AS parent_stream,
  'ConsignmentTotals'::text AS source_object_type,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_consignment_totals" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_taxes'::text AS parent_stream,
  'Tax'::text AS source_object_type,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_taxes" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_outlet_taxes'::text AS parent_stream,
  'OutletTax'::text AS source_object_type,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_outlet_taxes" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_payment_types'::text AS parent_stream,
  'PaymentType'::text AS source_object_type,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_payment_types" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_sales'::text AS parent_stream,
  'Sale'::text AS source_object_type,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_sales" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_register_payment_summaries'::text AS parent_stream,
  'RegisterPaymentsSummary'::text AS source_object_type,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_register_payment_summaries" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_fulfillments'::text AS parent_stream,
  'Fulfillment'::text AS source_object_type,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_fulfillments" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_fulfillment_history'::text AS parent_stream,
  'FulfillmentHistoryEntry'::text AS source_object_type,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_fulfillment_history" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_gift_cards'::text AS parent_stream,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_gift_cards" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_promotions'::text AS parent_stream,
  'Promotion'::text AS source_object_type,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_promotions" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_promotion_products'::text AS parent_stream,
  'PromotionProduct'::text AS source_object_type,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_promotion_products" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_promotion_promocodes'::text AS parent_stream,
  'PromotionPromoCode'::text AS source_object_type,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_promotion_promocodes" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_quotes'::text AS parent_stream,
  'Quote'::text AS source_object_type,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_quotes" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_serial_numbers'::text AS parent_stream,
  'SerialNumber'::text AS source_object_type,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_serial_numbers" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_services'::text AS parent_stream,
  'ServiceOrder'::text AS source_object_type,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_services" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_service_details'::text AS parent_stream,
  'DetailedService'::text AS source_object_type,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_service_details" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_service_items'::text AS parent_stream,
  'ServiceItem'::text AS source_object_type,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_service_items" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_service_statuses'::text AS parent_stream,
  'ServiceStatus'::text AS source_object_type,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_service_statuses" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_service_agenda'::text AS parent_stream,
  'DailyAgenda'::text AS source_object_type,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_service_agenda" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_shifts'::text AS parent_stream,
  'Shift'::text AS source_object_type,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_shifts" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_store_credits'::text AS parent_stream,
  'StoreCreditCustomer'::text AS source_object_type,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_store_credits" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_store_credit_report'::text AS parent_stream,
  'StoreCreditReport'::text AS source_object_type,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_store_credit_report" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_audit_log_events'::text AS parent_stream,
  'AuditLogEvent'::text AS source_object_type,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_audit_log_events" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_channels'::text AS parent_stream,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_channels" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_channel_requests'::text AS parent_stream,
  'ChannelRequest'::text AS source_object_type,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_channel_requests" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_button_layouts'::text AS parent_stream,
  'ButtonLayout'::text AS source_object_type,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_button_layouts" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_partner_subscriptions'::text AS parent_stream,
  'PartnerSubscription'::text AS source_object_type,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_partner_subscriptions" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_business_rules'::text AS parent_stream,
  'BusinessRule'::text AS source_object_type,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_business_rules" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_remote_rules'::text AS parent_stream,
  'RemoteBusinessRule'::text AS source_object_type,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_remote_rules" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
UNION ALL
SELECT
  parent.namespaced_source_key || ':field:' || coalesce(field.item ->> 'pointer', field.item ->> 'path', '') || ':' || coalesce(field.item ->> 'ordinal', '0') AS namespaced_source_key,
  parent.tenant_id,
  parent.connection_id,
  parent.external_account_reference,
  'lx_custom_fields'::text AS parent_stream,
  'CustomFieldDefinition'::text AS source_object_type,
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
  regexp_replace(field.item ->> 'path', '^.*(?:\.|\[)', '') AS field_name,
  field.item ->> 'kind' AS value_type,
  field.item ->> 'textValue' AS string_value,
  CASE WHEN field.item ->> 'numericValue' ~ '^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$' THEN (field.item ->> 'numericValue')::numeric END AS number_value,
  CASE WHEN field.item ->> 'kind' = 'boolean' THEN (field.item ->> 'booleanValue')::boolean END AS boolean_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN (field.item ->> 'timestampValue')::timestamptz END AS timestamp_value,
  CASE WHEN field.item ->> 'timestampValue' IS NOT NULL THEN ((field.item ->> 'timestampValue')::timestamptz AT TIME ZONE 'UTC')::date END AS date_value,
  field.item -> 'rawValue' AS json_value
FROM "source_lightspeed_x"."lx_custom_fields" AS parent
CROSS JOIN LATERAL jsonb_array_elements(coalesce(parent.field_index, '[]'::jsonb)) AS field(item)
;
COMMENT ON VIEW source_lightspeed_x.lx_source_fields IS 'One tenant-safe row per lossless Lightspeed X-Series source-field occurrence; exhaustive fallback for curated semantic coverage.';
GRANT SELECT ON source_lightspeed_x.lx_source_fields TO transform_rw, diagnostic_ro, semantic_ro;

GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA "source_lightspeed_x" TO ingest_rw;
GRANT SELECT ON ALL TABLES IN SCHEMA "source_lightspeed_x" TO transform_rw, diagnostic_ro, semantic_ro;

COMMIT;
