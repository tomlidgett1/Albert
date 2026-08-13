BEGIN;

-- Generated from connector manifests. Do not hand-edit field columns.
-- Exact raw payloads remain in immutable object storage; these tables hold only typed projections.

CREATE SCHEMA IF NOT EXISTS source_shopify;
COMMENT ON SCHEMA source_shopify IS 'Typed Shopify staging and governed native-field projections.';
REVOKE ALL ON SCHEMA source_shopify FROM PUBLIC;
GRANT USAGE ON SCHEMA source_shopify TO ingest_rw, transform_rw, diagnostic_ro, semantic_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE albert_migration_owner IN SCHEMA source_shopify GRANT SELECT, INSERT, UPDATE ON TABLES TO ingest_rw;
ALTER DEFAULT PRIVILEGES FOR ROLE albert_migration_owner IN SCHEMA source_shopify GRANT SELECT ON TABLES TO transform_rw, diagnostic_ro, semantic_ro;

CREATE TABLE IF NOT EXISTS "source_shopify"."shopify_shop" (
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
  "id" text,
  "name" text,
  "myshopify_domain" text,
  "primary_domain_host" text,
  "email" text,
  "contact_email" text,
  "currency_code" text,
  "billing_address" jsonb,
  "iana_timezone" text,
  "timezone_abbreviation" text,
  "plan_display_name" text,
  "customer_accounts" text,
  "created_at" timestamptz,
  "updated_at" timestamptz,
  "raw_node" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_shopify"."shopify_shop" IS 'Typed shopify shopify_shop staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "shopify_shop_connection_watermark_idx"
  ON "source_shopify"."shopify_shop" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_shopify"."shopify_shop" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_shopify"."shopify_shop" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_shopify"."shopify_shop";
CREATE POLICY tenant_scope ON "source_shopify"."shopify_shop"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_shopify"."shopify_locations" (
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
  "id" text,
  "legacy_resource_id" text,
  "name" text,
  "active" boolean,
  "address" jsonb,
  "fulfills_online_orders" boolean,
  "ships_inventory" boolean,
  "has_active_inventory" boolean,
  "has_unfulfilled_orders" boolean,
  "created_at" timestamptz,
  "updated_at" timestamptz,
  "raw_node" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_shopify"."shopify_locations" IS 'Typed shopify shopify_locations staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "shopify_locations_connection_watermark_idx"
  ON "source_shopify"."shopify_locations" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_shopify"."shopify_locations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_shopify"."shopify_locations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_shopify"."shopify_locations";
CREATE POLICY tenant_scope ON "source_shopify"."shopify_locations"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_shopify"."shopify_products" (
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
  "id" text,
  "legacy_resource_id" text,
  "title" text,
  "handle" text,
  "description" text,
  "description_html" text,
  "vendor" text,
  "product_type" text,
  "status" text,
  "tags" jsonb,
  "template_suffix" text,
  "category_id" text,
  "category_name" text,
  "total_inventory" numeric(19,4),
  "tracks_inventory" boolean,
  "created_at" timestamptz,
  "updated_at" timestamptz,
  "published_at" timestamptz,
  "online_store_url" text,
  "seo_title" text,
  "seo_description" text,
  "raw_node" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_shopify"."shopify_products" IS 'Typed shopify shopify_products staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "shopify_products_connection_watermark_idx"
  ON "source_shopify"."shopify_products" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_shopify"."shopify_products" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_shopify"."shopify_products" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_shopify"."shopify_products";
CREATE POLICY tenant_scope ON "source_shopify"."shopify_products"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_shopify"."shopify_product_variants" (
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
  "id" text,
  "legacy_resource_id" text,
  "product_id" text,
  "category_id" text,
  "category_name" text,
  "title" text,
  "display_name" text,
  "sku" text,
  "barcode" text,
  "price" numeric(19,4),
  "compare_at_price" numeric(19,4),
  "inventory_policy" text,
  "inventory_quantity" numeric(19,4),
  "sellable_online_quantity" numeric(19,4),
  "taxable" boolean,
  "tax_code" text,
  "available_for_sale" boolean,
  "position" numeric(19,4),
  "created_at" timestamptz,
  "updated_at" timestamptz,
  "raw_node" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_shopify"."shopify_product_variants" IS 'Typed shopify shopify_product_variants staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "shopify_product_variants_connection_watermark_idx"
  ON "source_shopify"."shopify_product_variants" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_shopify"."shopify_product_variants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_shopify"."shopify_product_variants" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_shopify"."shopify_product_variants";
CREATE POLICY tenant_scope ON "source_shopify"."shopify_product_variants"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_shopify"."shopify_customers" (
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
  "id" text,
  "legacy_resource_id" text,
  "display_name" text,
  "first_name" text,
  "last_name" text,
  "email" text,
  "phone" text,
  "state" text,
  "tags" jsonb,
  "note" text,
  "locale" text,
  "verified_email" boolean,
  "valid_email_address" boolean,
  "tax_exempt" boolean,
  "number_of_orders" numeric(19,4),
  "amount_spent" numeric(19,4),
  "created_at" timestamptz,
  "updated_at" timestamptz,
  "raw_node" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_shopify"."shopify_customers" IS 'Typed shopify shopify_customers staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "shopify_customers_connection_watermark_idx"
  ON "source_shopify"."shopify_customers" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_shopify"."shopify_customers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_shopify"."shopify_customers" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_shopify"."shopify_customers";
CREATE POLICY tenant_scope ON "source_shopify"."shopify_customers"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_shopify"."shopify_orders" (
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
  "id" text,
  "legacy_resource_id" text,
  "name" text,
  "number" numeric(19,4),
  "confirmation_number" text,
  "email" text,
  "phone" text,
  "customer_id" text,
  "location_id" text,
  "app_id" text,
  "channel_name" text,
  "source_name" text,
  "created_at" timestamptz,
  "processed_at" timestamptz,
  "updated_at" timestamptz,
  "cancelled_at" timestamptz,
  "closed_at" timestamptz,
  "cancel_reason" text,
  "display_financial_status" text,
  "display_fulfillment_status" text,
  "currency_code" text,
  "presentment_currency_code" text,
  "subtotal_amount" numeric(19,4),
  "total_discounts_amount" numeric(19,4),
  "total_shipping_amount" numeric(19,4),
  "total_tax_amount" numeric(19,4),
  "total_refunded_amount" numeric(19,4),
  "total_outstanding_amount" numeric(19,4),
  "total_price_amount" numeric(19,4),
  "current_subtotal_amount" numeric(19,4),
  "current_total_discounts_amount" numeric(19,4),
  "current_total_tax_amount" numeric(19,4),
  "current_total_price_amount" numeric(19,4),
  "test" boolean,
  "taxes_included" boolean,
  "confirmed" boolean,
  "fully_paid" boolean,
  "tags" jsonb,
  "note" text,
  "billing_address" jsonb,
  "shipping_address" jsonb,
  "raw_node" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_shopify"."shopify_orders" IS 'Typed shopify shopify_orders staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "shopify_orders_connection_watermark_idx"
  ON "source_shopify"."shopify_orders" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_shopify"."shopify_orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_shopify"."shopify_orders" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_shopify"."shopify_orders";
CREATE POLICY tenant_scope ON "source_shopify"."shopify_orders"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_shopify"."shopify_order_lines" (
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
  "id" text,
  "order_id" text,
  "product_id" text,
  "variant_id" text,
  "name" text,
  "title" text,
  "sku" text,
  "vendor" text,
  "location_id" text,
  "customer_id" text,
  "channel_name" text,
  "source_name" text,
  "order_created_at" timestamptz,
  "order_processed_at" timestamptz,
  "order_closed_at" timestamptz,
  "order_cancelled_at" timestamptz,
  "order_financial_status" text,
  "order_fulfillment_status" text,
  "currency_code" text,
  "taxes_included" boolean,
  "order_test" boolean,
  "quantity" numeric(19,4),
  "current_quantity" numeric(19,4),
  "refundable_quantity" numeric(19,4),
  "fulfillable_quantity" numeric(19,4),
  "unfulfilled_quantity" numeric(19,4),
  "requires_shipping" boolean,
  "taxable" boolean,
  "original_unit_price_amount" numeric(19,4),
  "discounted_unit_price_amount" numeric(19,4),
  "original_total_amount" numeric(19,4),
  "discounted_total_amount" numeric(19,4),
  "total_discount_amount" numeric(19,4),
  "total_tax_amount" numeric(19,4),
  "raw_node" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_shopify"."shopify_order_lines" IS 'Typed shopify shopify_order_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "shopify_order_lines_connection_watermark_idx"
  ON "source_shopify"."shopify_order_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_shopify"."shopify_order_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_shopify"."shopify_order_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_shopify"."shopify_order_lines";
CREATE POLICY tenant_scope ON "source_shopify"."shopify_order_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_shopify"."shopify_transactions" (
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
  "id" text,
  "order_id" text,
  "parent_transaction_id" text,
  "created_at" timestamptz,
  "processed_at" timestamptz,
  "kind" text,
  "status" text,
  "location_id" text,
  "channel_name" text,
  "source_name" text,
  "gateway" text,
  "payment_id" text,
  "authorization_code" text,
  "amount" numeric(19,4),
  "currency_code" text,
  "test" boolean,
  "manually_capturable" boolean,
  "maximum_refundable" numeric(19,4),
  "payment_method" text,
  "raw_node" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_shopify"."shopify_transactions" IS 'Typed shopify shopify_transactions staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "shopify_transactions_connection_watermark_idx"
  ON "source_shopify"."shopify_transactions" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_shopify"."shopify_transactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_shopify"."shopify_transactions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_shopify"."shopify_transactions";
CREATE POLICY tenant_scope ON "source_shopify"."shopify_transactions"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_shopify"."shopify_refund_lines" (
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
  "id" text,
  "refund_id" text,
  "order_id" text,
  "line_item_id" text,
  "variant_id" text,
  "location_id" text,
  "order_location_id" text,
  "currency_code" text,
  "quantity" numeric(19,4),
  "restock_type" text,
  "subtotal_amount" numeric(19,4),
  "tax_amount" numeric(19,4),
  "total_amount" numeric(19,4),
  "refunded_at" timestamptz,
  "raw_node" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_shopify"."shopify_refund_lines" IS 'Typed shopify shopify_refund_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "shopify_refund_lines_connection_watermark_idx"
  ON "source_shopify"."shopify_refund_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_shopify"."shopify_refund_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_shopify"."shopify_refund_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_shopify"."shopify_refund_lines";
CREATE POLICY tenant_scope ON "source_shopify"."shopify_refund_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_shopify"."shopify_inventory_levels" (
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
  "id" text,
  "inventory_item_id" text,
  "variant_id" text,
  "location_id" text,
  "updated_at" timestamptz,
  "can_deactivate" boolean,
  "available" numeric(19,4),
  "incoming" numeric(19,4),
  "on_hand" numeric(19,4),
  "committed" numeric(19,4),
  "reserved" numeric(19,4),
  "damaged" numeric(19,4),
  "safety_stock" numeric(19,4),
  "quality_control" numeric(19,4),
  "raw_node" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_shopify"."shopify_inventory_levels" IS 'Typed shopify shopify_inventory_levels staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "shopify_inventory_levels_connection_watermark_idx"
  ON "source_shopify"."shopify_inventory_levels" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_shopify"."shopify_inventory_levels" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_shopify"."shopify_inventory_levels" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_shopify"."shopify_inventory_levels";
CREATE POLICY tenant_scope ON "source_shopify"."shopify_inventory_levels"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_shopify"."shopify_fulfillments" (
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
  "id" text,
  "order_id" text,
  "name" text,
  "status" text,
  "display_status" text,
  "created_at" timestamptz,
  "updated_at" timestamptz,
  "delivered_at" timestamptz,
  "estimated_delivery_at" timestamptz,
  "in_transit_at" timestamptz,
  "total_quantity" numeric(19,4),
  "tracking_info" jsonb,
  "location_id" text,
  "service_handle" text,
  "raw_node" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_shopify"."shopify_fulfillments" IS 'Typed shopify shopify_fulfillments staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "shopify_fulfillments_connection_watermark_idx"
  ON "source_shopify"."shopify_fulfillments" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_shopify"."shopify_fulfillments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_shopify"."shopify_fulfillments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_shopify"."shopify_fulfillments";
CREATE POLICY tenant_scope ON "source_shopify"."shopify_fulfillments"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_shopify"."shopify_returns" (
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
  "id" text,
  "order_id" text,
  "name" text,
  "status" text,
  "created_at" timestamptz,
  "updated_at" timestamptz,
  "closed_at" timestamptz,
  "total_quantity" numeric(19,4),
  "exchange_line_item_count" numeric(19,4),
  "return_line_item_count" numeric(19,4),
  "refund_count" numeric(19,4),
  "raw_node" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_shopify"."shopify_returns" IS 'Typed shopify shopify_returns staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "shopify_returns_connection_watermark_idx"
  ON "source_shopify"."shopify_returns" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_shopify"."shopify_returns" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_shopify"."shopify_returns" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_shopify"."shopify_returns";
CREATE POLICY tenant_scope ON "source_shopify"."shopify_returns"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_shopify"."shopify_discounts" (
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
  "id" text,
  "typename" text,
  "title" text,
  "status" text,
  "created_at" timestamptz,
  "updated_at" timestamptz,
  "starts_at" timestamptz,
  "ends_at" timestamptz,
  "total_sales" numeric(19,4),
  "usage_limit" numeric(19,4),
  "async_usage_count" numeric(19,4),
  "discount_classes" jsonb,
  "combines_with" jsonb,
  "raw_node" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_shopify"."shopify_discounts" IS 'Typed shopify shopify_discounts staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "shopify_discounts_connection_watermark_idx"
  ON "source_shopify"."shopify_discounts" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_shopify"."shopify_discounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_shopify"."shopify_discounts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_shopify"."shopify_discounts";
CREATE POLICY tenant_scope ON "source_shopify"."shopify_discounts"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_shopify"."shopify_metafield_definitions" (
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
  "id" text,
  "name" text,
  "namespace" text,
  "key" text,
  "owner_type" text,
  "type_name" text,
  "type_category" text,
  "description" text,
  "admin_access" text,
  "storefront_access" text,
  "customer_account_access" text,
  "capabilities" jsonb,
  "constraints" jsonb,
  "validations" jsonb,
  "validation_status" text,
  "pinned_position" numeric(19,4),
  "use_as_collection_condition" boolean,
  "metafields_count" numeric(19,4),
  "observed_at" timestamptz,
  "raw_node" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_shopify"."shopify_metafield_definitions" IS 'Cursor-complete Shopify metafield definitions for least-privilege owner types.';
CREATE INDEX IF NOT EXISTS "shopify_metafield_definitions_connection_owner_idx"
  ON "source_shopify"."shopify_metafield_definitions" (tenant_id, connection_id, owner_type, namespace, key);
ALTER TABLE "source_shopify"."shopify_metafield_definitions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_shopify"."shopify_metafield_definitions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_shopify"."shopify_metafield_definitions";
CREATE POLICY tenant_scope ON "source_shopify"."shopify_metafield_definitions"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_shopify"."shopify_metafield_values" (
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
  "id" text,
  "legacy_resource_id" text,
  "definition_id" text,
  "owner_id" text,
  "owner_type" text,
  "owner_graphql_type" text,
  "namespace" text,
  "key" text,
  "metafield_type" text,
  "value" text,
  "json_value" jsonb,
  "numeric_value" numeric(19,4),
  "boolean_value" boolean,
  "datetime_value" timestamptz,
  "size_in_bytes" numeric(19,4),
  "compare_digest" text,
  "created_at" timestamptz,
  "updated_at" timestamptz,
  "raw_node" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_shopify"."shopify_metafield_values" IS 'Private Shopify metafield literals. Values are unclassified sensitive data and are redacted from public Cube members.';
CREATE INDEX IF NOT EXISTS "shopify_metafield_values_connection_owner_idx"
  ON "source_shopify"."shopify_metafield_values" (tenant_id, connection_id, owner_type, namespace, key, updated_at DESC);
ALTER TABLE "source_shopify"."shopify_metafield_values" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_shopify"."shopify_metafield_values" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_shopify"."shopify_metafield_values";
CREATE POLICY tenant_scope ON "source_shopify"."shopify_metafield_values"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_shopify"."shopify_fields" (
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
  "id" text,
  "definition_kind" text,
  "schema_path" text,
  "root_field" text,
  "object_type" text,
  "graphql_id" text,
  "parent_graphql_id" text,
  "field_name" text,
  "field_type" text,
  "value_kind" text,
  "value_form" text,
  "observation_form" text,
  "ordinal" numeric(19,4),
  "json_pointer" text,
  "string_value" text,
  "numeric_value" numeric(19,4),
  "boolean_value" boolean,
  "datetime_value" timestamptz,
  "json_value" jsonb,
  "node_payload" jsonb,
  "api_version" text,
  "required_scopes" jsonb,
  "required_access" text,
  "field_arguments" jsonb,
  "description" text,
  "protected_data_level" text,
  "availability" text,
  "availability_reason" text,
  "deprecated" boolean,
  "deprecation_reason" text,
  "documentation_url" text,
  "schema_sha256" text,
  "observed_at" timestamptz,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_shopify"."shopify_fields" IS 'Typed shopify shopify_fields staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "shopify_fields_connection_watermark_idx"
  ON "source_shopify"."shopify_fields" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_shopify"."shopify_fields" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_shopify"."shopify_fields" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_shopify"."shopify_fields";
CREATE POLICY tenant_scope ON "source_shopify"."shopify_fields"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA "source_shopify" TO ingest_rw;
GRANT SELECT ON ALL TABLES IN SCHEMA "source_shopify" TO transform_rw, diagnostic_ro, semantic_ro;

COMMIT;
