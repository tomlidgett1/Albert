BEGIN;

-- Generated from connector manifests. Do not hand-edit field columns.
-- Exact raw payloads remain in immutable object storage; these tables hold only typed projections.

CREATE TABLE IF NOT EXISTS "source_lightspeed"."shops" (
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
  "shop_id" text,
  "name" text,
  "time_zone" text,
  "archived" boolean,
  "time_stamp" timestamptz,
  "contact" jsonb,
  "service_rate" numeric(19,4),
  "tax_labor" boolean,
  "label_title" text,
  "label_msrp" boolean,
  "company_registration_number" text,
  "vat_number" text,
  "zebra_browser_print" boolean,
  "contact_id" text,
  "tax_category_id" text,
  "receipt_setup_id" text,
  "vendor_id" text,
  "cc_gateway_id" text,
  "gateway_config_id" text,
  "price_level_id" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."shops" IS 'Typed lightspeed-r shops staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "shops_connection_watermark_idx"
  ON "source_lightspeed"."shops" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."shops" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."shops" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."shops";
CREATE POLICY tenant_scope ON "source_lightspeed"."shops"
  USING (tenant_id = ingestion.current_tenant_id())
  WITH CHECK (tenant_id = ingestion.current_tenant_id());

CREATE TABLE IF NOT EXISTS "source_lightspeed"."employees" (
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
  "employee_id" text,
  "first_name" text,
  "last_name" text,
  "lock_out" boolean,
  "archived" boolean,
  "time_stamp" timestamptz,
  "contact" jsonb,
  "contact_id" text,
  "clock_in_employee_hours_id" text,
  "employee_role_id" text,
  "limit_to_shop_id" text,
  "last_shop_id" text,
  "last_sale_id" text,
  "last_register_id" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."employees" IS 'Typed lightspeed-r employees staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "employees_connection_watermark_idx"
  ON "source_lightspeed"."employees" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."employees" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."employees" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."employees";
CREATE POLICY tenant_scope ON "source_lightspeed"."employees"
  USING (tenant_id = ingestion.current_tenant_id())
  WITH CHECK (tenant_id = ingestion.current_tenant_id());

CREATE TABLE IF NOT EXISTS "source_lightspeed"."categories" (
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
  "category_id" text,
  "name" text,
  "parent_id" text,
  "node_depth" numeric(19,4),
  "time_stamp" timestamptz,
  "full_path_name" text,
  "left_node" numeric(19,4),
  "right_node" numeric(19,4),
  "create_time" timestamptz,
  "parent" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."categories" IS 'Typed lightspeed-r categories staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "categories_connection_watermark_idx"
  ON "source_lightspeed"."categories" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."categories" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."categories";
CREATE POLICY tenant_scope ON "source_lightspeed"."categories"
  USING (tenant_id = ingestion.current_tenant_id())
  WITH CHECK (tenant_id = ingestion.current_tenant_id());

CREATE TABLE IF NOT EXISTS "source_lightspeed"."items" (
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
  "item_id" text,
  "system_sku" text,
  "description" text,
  "category_id" text,
  "default_cost" numeric(19,4),
  "archived" boolean,
  "time_stamp" timestamptz,
  "avg_cost" numeric(19,4),
  "tax" numeric(19,4),
  "discountable" boolean,
  "item_type" text,
  "serialized" boolean,
  "model_year" text,
  "upc" text,
  "ean" text,
  "custom_sku" text,
  "manufacturer_sku" text,
  "create_time" timestamptz,
  "publish_to_ecom" boolean,
  "tax_class_id" text,
  "department_id" text,
  "item_matrix_id" text,
  "manufacturer_id" text,
  "season_id" text,
  "default_vendor_id" text,
  "category" jsonb,
  "tax_class" jsonb,
  "department" jsonb,
  "item_attributes" jsonb,
  "manufacturer" jsonb,
  "note" jsonb,
  "season" jsonb,
  "item_shops" jsonb,
  "item_components" jsonb,
  "item_shelf_locations" jsonb,
  "item_vendor_nums" jsonb,
  "custom_field_values" jsonb,
  "prices" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."items" IS 'Typed lightspeed-r items staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "items_connection_watermark_idx"
  ON "source_lightspeed"."items" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."items" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."items";
CREATE POLICY tenant_scope ON "source_lightspeed"."items"
  USING (tenant_id = ingestion.current_tenant_id())
  WITH CHECK (tenant_id = ingestion.current_tenant_id());

CREATE TABLE IF NOT EXISTS "source_lightspeed"."item_shops" (
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
  "item_shop_id" text,
  "item_id" text,
  "shop_id" text,
  "qoh" numeric(19,4),
  "time_stamp" timestamptz,
  "sellable" numeric(19,4),
  "backorder" numeric(19,4),
  "component_qoh" numeric(19,4),
  "component_backorder" numeric(19,4),
  "reorder_point" numeric(19,4),
  "reorder_level" numeric(19,4),
  "on_layaway" numeric(19,4),
  "on_special_order" numeric(19,4),
  "on_work_order" numeric(19,4),
  "on_workorder" numeric(19,4),
  "on_transfer_out" numeric(19,4),
  "on_transfer_in" numeric(19,4),
  "average_cost" numeric(19,4),
  "total_value_fifo" numeric(19,4),
  "total_value_avg_cost" numeric(19,4),
  "total_value_negative_inventory" numeric(19,4),
  "last_received_cost" numeric(19,4),
  "last_received_lot_id" text,
  "next_fifo_lot_cost" numeric(19,4),
  "next_fifo_lot_id" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."item_shops" IS 'Typed lightspeed-r item_shops staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "item_shops_connection_watermark_idx"
  ON "source_lightspeed"."item_shops" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."item_shops" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."item_shops" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."item_shops";
CREATE POLICY tenant_scope ON "source_lightspeed"."item_shops"
  USING (tenant_id = ingestion.current_tenant_id())
  WITH CHECK (tenant_id = ingestion.current_tenant_id());

CREATE TABLE IF NOT EXISTS "source_lightspeed"."sales" (
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
  "sale_id" text,
  "shop_id" text,
  "employee_id" text,
  "register_id" text,
  "customer_id" text,
  "completed" boolean,
  "voided" boolean,
  "complete_time" timestamptz,
  "time_stamp" timestamptz,
  "total" numeric(19,4),
  "tax_total" numeric(19,4),
  "sale_lines" jsonb,
  "sale_payments" jsonb,
  "discount_percent" numeric(19,4),
  "archived" boolean,
  "enable_promotions" boolean,
  "is_tax_inclusive" boolean,
  "create_time" timestamptz,
  "updatetime" timestamptz,
  "update_time" timestamptz,
  "reference_number" text,
  "reference_number_source" text,
  "tax1_rate" numeric(19,4),
  "tax2_rate" numeric(19,4),
  "change" numeric(19,4),
  "tip_enabled" boolean,
  "receipt_preference" text,
  "displayable_subtotal" numeric(19,4),
  "ticket_number" text,
  "calc_discount" numeric(19,4),
  "calc_total" numeric(19,4),
  "calc_subtotal" numeric(19,4),
  "calc_taxable" numeric(19,4),
  "calc_non_taxable" numeric(19,4),
  "calc_avg_cost" numeric(19,4),
  "calc_fifo_cost" numeric(19,4),
  "calc_tax1" numeric(19,4),
  "calc_tax2" numeric(19,4),
  "calc_payments" numeric(19,4),
  "calc_tips" numeric(19,4),
  "calc_surcharges" numeric(19,4),
  "calc_item_fees" numeric(19,4),
  "total_due" numeric(19,4),
  "displayable_total" numeric(19,4),
  "balance" numeric(19,4),
  "cash_rounding_delta" numeric(19,4),
  "cash_rounded_balance" numeric(19,4),
  "cash_rounded_total" numeric(19,4),
  "discount_id" text,
  "tip_employee_id" text,
  "quote_id" text,
  "ship_to_id" text,
  "tax_category_id" text,
  "customer" jsonb,
  "discount" jsonb,
  "quote" jsonb,
  "ship_to" jsonb,
  "tax_category" jsonb,
  "tippable_amount" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."sales" IS 'Typed lightspeed-r sales staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "sales_connection_watermark_idx"
  ON "source_lightspeed"."sales" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."sales" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."sales" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."sales";
CREATE POLICY tenant_scope ON "source_lightspeed"."sales"
  USING (tenant_id = ingestion.current_tenant_id())
  WITH CHECK (tenant_id = ingestion.current_tenant_id());

CREATE TABLE IF NOT EXISTS "source_lightspeed"."customers" (
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
  "customer_id" text,
  "first_name" text,
  "last_name" text,
  "company" text,
  "archived" boolean,
  "time_stamp" timestamptz,
  "contact" jsonb,
  "dob" text,
  "title" text,
  "company_registration_number" text,
  "vat_number" text,
  "credit_account_id" text,
  "customer_type_id" text,
  "discount_id" text,
  "tax_category_id" text,
  "create_time" timestamptz,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."customers" IS 'Typed lightspeed-r customers staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "customers_connection_watermark_idx"
  ON "source_lightspeed"."customers" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."customers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."customers" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."customers";
CREATE POLICY tenant_scope ON "source_lightspeed"."customers"
  USING (tenant_id = ingestion.current_tenant_id())
  WITH CHECK (tenant_id = ingestion.current_tenant_id());

CREATE TABLE IF NOT EXISTS "source_lightspeed"."orders" (
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
  "order_id" text,
  "shop_id" text,
  "vendor_id" text,
  "created_by_employee_id" text,
  "ordered_date" timestamptz,
  "received_date" timestamptz,
  "total_cost" numeric(19,4),
  "time_stamp" timestamptz,
  "order_lines" jsonb,
  "arrival_date" timestamptz,
  "ref_num" text,
  "ship_instructions" text,
  "stock_instructions" text,
  "ship_cost" numeric(19,4),
  "ship_vendor_cost" numeric(19,4),
  "other_cost" numeric(19,4),
  "other_vendor_cost" numeric(19,4),
  "complete" boolean,
  "archived" boolean,
  "discount" numeric(19,4),
  "total_discount" numeric(19,4),
  "total_quantity" numeric(19,4),
  "sub_total_cost" numeric(19,4),
  "note_id" text,
  "create_time" timestamptz,
  "vendor_currency_rate" numeric(19,4),
  "vendor_currency_code" text,
  "shipping_cost_method" text,
  "has_shipments" boolean,
  "discount_method" text,
  "discount_money_value" numeric(19,4),
  "discount_money_vendor_value" numeric(19,4),
  "discount_is_percent" boolean,
  "discount_percent_value" numeric(19,4),
  "costs_modified_after_shipment" boolean,
  "b2b_order_uid" text,
  "b2b_order_number" text,
  "vendor" jsonb,
  "note" jsonb,
  "shop" jsonb,
  "custom_field_values" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."orders" IS 'Typed lightspeed-r orders staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "orders_connection_watermark_idx"
  ON "source_lightspeed"."orders" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."orders" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."orders";
CREATE POLICY tenant_scope ON "source_lightspeed"."orders"
  USING (tenant_id = ingestion.current_tenant_id())
  WITH CHECK (tenant_id = ingestion.current_tenant_id());

CREATE TABLE IF NOT EXISTS "source_lightspeed"."order_lines" (
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
  "order_line_id" text,
  "order_id" text,
  "item_id" text,
  "quantity" numeric(19,4),
  "price" numeric(19,4),
  "time_stamp" timestamptz,
  "original_price" numeric(19,4),
  "vendor_cost" numeric(19,4),
  "checked_in" numeric(19,4),
  "num_received" numeric(19,4),
  "total" numeric(19,4),
  "create_time" timestamptz,
  "shipping_cost" numeric(19,4),
  "shipping_vendor_cost" numeric(19,4),
  "discount_money_value" numeric(19,4),
  "discount_money_vendor_value" numeric(19,4),
  "discount_percent_value" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."order_lines" IS 'Typed lightspeed-r order_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "order_lines_connection_watermark_idx"
  ON "source_lightspeed"."order_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."order_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."order_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."order_lines";
CREATE POLICY tenant_scope ON "source_lightspeed"."order_lines"
  USING (tenant_id = ingestion.current_tenant_id())
  WITH CHECK (tenant_id = ingestion.current_tenant_id());

CREATE TABLE IF NOT EXISTS "source_lightspeed"."payment_types" (
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
  "payment_type_id" text,
  "name" text,
  "archived" boolean,
  "require_customer" boolean,
  "internal_reserved" boolean,
  "type" text,
  "refund_as_payment_type_id" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."payment_types" IS 'Typed lightspeed-r payment_types staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "payment_types_connection_watermark_idx"
  ON "source_lightspeed"."payment_types" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."payment_types" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."payment_types" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."payment_types";
CREATE POLICY tenant_scope ON "source_lightspeed"."payment_types"
  USING (tenant_id = ingestion.current_tenant_id())
  WITH CHECK (tenant_id = ingestion.current_tenant_id());

CREATE TABLE IF NOT EXISTS "source_lightspeed"."tax_categories" (
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
  "tax_category_id" text,
  "tax1_name" text,
  "tax1_rate" numeric(19,4),
  "is_tax_inclusive" boolean,
  "time_stamp" timestamptz,
  "tax2_name" text,
  "tax2_rate" numeric(19,4),
  "tax_category_classes" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."tax_categories" IS 'Typed lightspeed-r tax_categories staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "tax_categories_connection_watermark_idx"
  ON "source_lightspeed"."tax_categories" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."tax_categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."tax_categories" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."tax_categories";
CREATE POLICY tenant_scope ON "source_lightspeed"."tax_categories"
  USING (tenant_id = ingestion.current_tenant_id())
  WITH CHECK (tenant_id = ingestion.current_tenant_id());

CREATE TABLE IF NOT EXISTS "source_lightspeed"."inventory_logs" (
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
  "inventory_log_id" text,
  "item_id" text,
  "shop_id" text,
  "qoh_change" numeric(19,4),
  "cost_change" numeric(19,4),
  "create_time" timestamptz,
  "reason" text,
  "employee_id" text,
  "automated" boolean,
  "caused_negative" boolean,
  "order_id" text,
  "transfer_id" text,
  "sale_id" text,
  "inventory_count_id" text,
  "customer_id" text,
  "vendor_return_id" text,
  "item_import_id" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."inventory_logs" IS 'Typed lightspeed-r inventory_logs staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "inventory_logs_connection_watermark_idx"
  ON "source_lightspeed"."inventory_logs" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."inventory_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."inventory_logs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."inventory_logs";
CREATE POLICY tenant_scope ON "source_lightspeed"."inventory_logs"
  USING (tenant_id = ingestion.current_tenant_id())
  WITH CHECK (tenant_id = ingestion.current_tenant_id());

CREATE TABLE IF NOT EXISTS "source_xero"."organisation" (
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
  "organisation_id" text,
  "name" text,
  "legal_name" text,
  "base_currency" text,
  "sales_tax_basis" text,
  "financial_year_end_day" numeric(19,4),
  "financial_year_end_month" numeric(19,4),
  "tax_number" text,
  "updated_date_utc" timestamptz,
  "organisation_status" text,
  "version" text,
  "country_code" text,
  "short_code" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."organisation" IS 'Typed xero organisation staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "organisation_connection_watermark_idx"
  ON "source_xero"."organisation" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."organisation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."organisation" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."organisation";
CREATE POLICY tenant_scope ON "source_xero"."organisation"
  USING (tenant_id = ingestion.current_tenant_id())
  WITH CHECK (tenant_id = ingestion.current_tenant_id());

CREATE TABLE IF NOT EXISTS "source_xero"."accounts" (
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
  "account_id" text,
  "code" text,
  "name" text,
  "type" text,
  "tax_type" text,
  "status" text,
  "updated_date_utc" timestamptz,
  "class" text,
  "system_account" text,
  "enable_payments_to_account" boolean,
  "bank_account_number" text,
  "currency_code" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."accounts" IS 'Typed xero accounts staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "accounts_connection_watermark_idx"
  ON "source_xero"."accounts" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."accounts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."accounts";
CREATE POLICY tenant_scope ON "source_xero"."accounts"
  USING (tenant_id = ingestion.current_tenant_id())
  WITH CHECK (tenant_id = ingestion.current_tenant_id());

CREATE TABLE IF NOT EXISTS "source_xero"."contacts" (
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
  "contact_id" text,
  "name" text,
  "first_name" text,
  "last_name" text,
  "email_address" text,
  "contact_status" text,
  "is_supplier" boolean,
  "is_customer" boolean,
  "updated_date_utc" timestamptz,
  "tax_number" text,
  "contact_number" text,
  "addresses" jsonb,
  "phones" jsonb,
  "bank_account_details" text,
  "default_currency" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."contacts" IS 'Typed xero contacts staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "contacts_connection_watermark_idx"
  ON "source_xero"."contacts" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."contacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."contacts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."contacts";
CREATE POLICY tenant_scope ON "source_xero"."contacts"
  USING (tenant_id = ingestion.current_tenant_id())
  WITH CHECK (tenant_id = ingestion.current_tenant_id());

CREATE TABLE IF NOT EXISTS "source_xero"."invoices" (
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
  "invoice_id" text,
  "invoice_number" text,
  "type" text,
  "contact" jsonb,
  "date" date,
  "due_date" date,
  "status" text,
  "line_amount_types" text,
  "sub_total" numeric(19,4),
  "total_tax" numeric(19,4),
  "total" numeric(19,4),
  "amount_due" numeric(19,4),
  "amount_paid" numeric(19,4),
  "currency_code" text,
  "updated_date_utc" timestamptz,
  "line_items" jsonb,
  "updated_date_utc_string" timestamptz,
  "reference" text,
  "currency_rate" numeric(19,4),
  "fully_paid_on_date" date,
  "has_attachments" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."invoices" IS 'Typed xero invoices staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "invoices_connection_watermark_idx"
  ON "source_xero"."invoices" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."invoices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."invoices" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."invoices";
CREATE POLICY tenant_scope ON "source_xero"."invoices"
  USING (tenant_id = ingestion.current_tenant_id())
  WITH CHECK (tenant_id = ingestion.current_tenant_id());

CREATE TABLE IF NOT EXISTS "source_xero"."credit_notes" (
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
  "credit_note_id" text,
  "credit_note_number" text,
  "type" text,
  "contact" jsonb,
  "date" date,
  "status" text,
  "line_amount_types" text,
  "sub_total" numeric(19,4),
  "total_tax" numeric(19,4),
  "total" numeric(19,4),
  "remaining_credit" numeric(19,4),
  "currency_code" text,
  "updated_date_utc" timestamptz,
  "line_items" jsonb,
  "updated_date_utc_string" timestamptz,
  "reference" text,
  "currency_rate" numeric(19,4),
  "allocations" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."credit_notes" IS 'Typed xero credit_notes staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "credit_notes_connection_watermark_idx"
  ON "source_xero"."credit_notes" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."credit_notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."credit_notes" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."credit_notes";
CREATE POLICY tenant_scope ON "source_xero"."credit_notes"
  USING (tenant_id = ingestion.current_tenant_id())
  WITH CHECK (tenant_id = ingestion.current_tenant_id());

CREATE TABLE IF NOT EXISTS "source_xero"."payments" (
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
  "payment_id" text,
  "date" date,
  "amount" numeric(19,4),
  "bank_amount" numeric(19,4),
  "payment_type" text,
  "status" text,
  "invoice" jsonb,
  "credit_note" jsonb,
  "prepayment" jsonb,
  "overpayment" jsonb,
  "account" jsonb,
  "batch_payment_id" text,
  "batch_payment" jsonb,
  "reference" text,
  "is_reconciled" boolean,
  "updated_date_utc" timestamptz,
  "updated_date_utc_string" timestamptz,
  "date_string" timestamptz,
  "currency_rate" numeric(19,4),
  "has_account" boolean,
  "has_validation_errors" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."payments" IS 'Typed xero payments staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "payments_connection_watermark_idx"
  ON "source_xero"."payments" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."payments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."payments";
CREATE POLICY tenant_scope ON "source_xero"."payments"
  USING (tenant_id = ingestion.current_tenant_id())
  WITH CHECK (tenant_id = ingestion.current_tenant_id());

CREATE TABLE IF NOT EXISTS "source_xero"."bank_transactions" (
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
  "bank_transaction_id" text,
  "type" text,
  "contact" jsonb,
  "date" date,
  "status" text,
  "line_amount_types" text,
  "sub_total" numeric(19,4),
  "total_tax" numeric(19,4),
  "total" numeric(19,4),
  "currency_code" text,
  "updated_date_utc" timestamptz,
  "line_items" jsonb,
  "updated_date_utc_string" timestamptz,
  "reference" text,
  "currency_rate" numeric(19,4),
  "bank_account" jsonb,
  "is_reconciled" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."bank_transactions" IS 'Typed xero bank_transactions staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "bank_transactions_connection_watermark_idx"
  ON "source_xero"."bank_transactions" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."bank_transactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."bank_transactions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."bank_transactions";
CREATE POLICY tenant_scope ON "source_xero"."bank_transactions"
  USING (tenant_id = ingestion.current_tenant_id())
  WITH CHECK (tenant_id = ingestion.current_tenant_id());

CREATE TABLE IF NOT EXISTS "source_xero"."manual_journals" (
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
  "manual_journal_id" text,
  "date" date,
  "status" text,
  "line_amount_types" text,
  "narration" text,
  "journal_lines" jsonb,
  "updated_date_utc" timestamptz,
  "updated_date_utc_string" timestamptz,
  "show_on_cash_basis_reports" boolean,
  "url" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."manual_journals" IS 'Typed xero manual_journals staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "manual_journals_connection_watermark_idx"
  ON "source_xero"."manual_journals" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."manual_journals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."manual_journals" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."manual_journals";
CREATE POLICY tenant_scope ON "source_xero"."manual_journals"
  USING (tenant_id = ingestion.current_tenant_id())
  WITH CHECK (tenant_id = ingestion.current_tenant_id());

CREATE TABLE IF NOT EXISTS "source_xero"."journals" (
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
  "journal_id" text,
  "journal_number" numeric(19,4),
  "journal_date" date,
  "created_date_utc" timestamptz,
  "source_id" text,
  "source_type" text,
  "journal_lines" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."journals" IS 'Typed xero journals staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "journals_connection_watermark_idx"
  ON "source_xero"."journals" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."journals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."journals" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."journals";
CREATE POLICY tenant_scope ON "source_xero"."journals"
  USING (tenant_id = ingestion.current_tenant_id())
  WITH CHECK (tenant_id = ingestion.current_tenant_id());

CREATE TABLE IF NOT EXISTS "source_xero"."tax_rates" (
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
  "tax_type" text,
  "name" text,
  "status" text,
  "display_tax_rate" numeric(19,4),
  "effective_rate" numeric(19,4),
  "tax_components" jsonb,
  "can_apply_to_assets" boolean,
  "can_apply_to_equity" boolean,
  "can_apply_to_expenses" boolean,
  "can_apply_to_liabilities" boolean,
  "can_apply_to_revenue" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."tax_rates" IS 'Typed xero tax_rates staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "tax_rates_connection_watermark_idx"
  ON "source_xero"."tax_rates" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."tax_rates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."tax_rates" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."tax_rates";
CREATE POLICY tenant_scope ON "source_xero"."tax_rates"
  USING (tenant_id = ingestion.current_tenant_id())
  WITH CHECK (tenant_id = ingestion.current_tenant_id());

CREATE TABLE IF NOT EXISTS "source_xero"."tracking_categories" (
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
  "tracking_category_id" text,
  "name" text,
  "status" text,
  "options" jsonb,
  "updated_date_utc" timestamptz,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."tracking_categories" IS 'Typed xero tracking_categories staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "tracking_categories_connection_watermark_idx"
  ON "source_xero"."tracking_categories" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."tracking_categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."tracking_categories" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."tracking_categories";
CREATE POLICY tenant_scope ON "source_xero"."tracking_categories"
  USING (tenant_id = ingestion.current_tenant_id())
  WITH CHECK (tenant_id = ingestion.current_tenant_id());

CREATE TABLE IF NOT EXISTS "source_deputy"."companies" (
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
  "company_name" text,
  "trading_name" text,
  "company_number" text,
  "active" boolean,
  "address" text,
  "contact" text,
  "modified" timestamptz,
  "code" text,
  "parent_company" text,
  "is_workplace" boolean,
  "is_payroll_entity" boolean,
  "payroll_export_code" text,
  "created" timestamptz,
  "address_object" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_deputy"."companies" IS 'Typed deputy companies staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "companies_connection_watermark_idx"
  ON "source_deputy"."companies" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_deputy"."companies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_deputy"."companies" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_deputy"."companies";
CREATE POLICY tenant_scope ON "source_deputy"."companies"
  USING (tenant_id = ingestion.current_tenant_id())
  WITH CHECK (tenant_id = ingestion.current_tenant_id());

CREATE TABLE IF NOT EXISTS "source_deputy"."operational_units" (
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
  "company" text,
  "operational_unit_name" text,
  "active" boolean,
  "address" text,
  "contact" text,
  "modified" timestamptz,
  "work_type" text,
  "parent_operational_unit" text,
  "payroll_export_name" text,
  "roster_sort_order" numeric(19,4),
  "show_on_roster" boolean,
  "colour" text,
  "operational_unit_type" text,
  "created" timestamptz,
  "address_object" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_deputy"."operational_units" IS 'Typed deputy operational_units staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "operational_units_connection_watermark_idx"
  ON "source_deputy"."operational_units" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_deputy"."operational_units" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_deputy"."operational_units" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_deputy"."operational_units";
CREATE POLICY tenant_scope ON "source_deputy"."operational_units"
  USING (tenant_id = ingestion.current_tenant_id())
  WITH CHECK (tenant_id = ingestion.current_tenant_id());

CREATE TABLE IF NOT EXISTS "source_deputy"."employees" (
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
  "company" text,
  "first_name" text,
  "last_name" text,
  "display_name" text,
  "active" boolean,
  "start_date" date,
  "termination_date" date,
  "contact" text,
  "modified" timestamptz,
  "employee_id" text,
  "other_name" text,
  "role" text,
  "user" text,
  "created" timestamptz,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_deputy"."employees" IS 'Typed deputy employees staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "employees_connection_watermark_idx"
  ON "source_deputy"."employees" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_deputy"."employees" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_deputy"."employees" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_deputy"."employees";
CREATE POLICY tenant_scope ON "source_deputy"."employees"
  USING (tenant_id = ingestion.current_tenant_id())
  WITH CHECK (tenant_id = ingestion.current_tenant_id());

CREATE TABLE IF NOT EXISTS "source_deputy"."rosters" (
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
  "employee" text,
  "operational_unit" text,
  "date" date,
  "start_time" timestamptz,
  "end_time" timestamptz,
  "total_time" numeric(19,4),
  "cost" numeric(19,4),
  "published" boolean,
  "modified" timestamptz,
  "mealbreak" numeric(19,4),
  "slots" jsonb,
  "comment" text,
  "open" boolean,
  "matched_by_timesheet" text,
  "created" timestamptz,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_deputy"."rosters" IS 'Typed deputy rosters staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "rosters_connection_watermark_idx"
  ON "source_deputy"."rosters" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_deputy"."rosters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_deputy"."rosters" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_deputy"."rosters";
CREATE POLICY tenant_scope ON "source_deputy"."rosters"
  USING (tenant_id = ingestion.current_tenant_id())
  WITH CHECK (tenant_id = ingestion.current_tenant_id());

CREATE TABLE IF NOT EXISTS "source_deputy"."timesheets" (
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
  "employee" text,
  "roster" text,
  "operational_unit" text,
  "date" date,
  "start_time" timestamptz,
  "end_time" timestamptz,
  "total_time" numeric(19,4),
  "cost" numeric(19,4),
  "on_cost" numeric(19,4),
  "time_approved" boolean,
  "discarded" boolean,
  "is_leave" boolean,
  "modified" timestamptz,
  "mealbreak" numeric(19,4),
  "mealbreak_slots" jsonb,
  "pay_rule_approved" boolean,
  "exported" boolean,
  "start_time_localized" timestamptz,
  "end_time_localized" timestamptz,
  "created" timestamptz,
  "employee_comment" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_deputy"."timesheets" IS 'Typed deputy timesheets staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "timesheets_connection_watermark_idx"
  ON "source_deputy"."timesheets" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_deputy"."timesheets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_deputy"."timesheets" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_deputy"."timesheets";
CREATE POLICY tenant_scope ON "source_deputy"."timesheets"
  USING (tenant_id = ingestion.current_tenant_id())
  WITH CHECK (tenant_id = ingestion.current_tenant_id());

CREATE TABLE IF NOT EXISTS "source_deputy"."leave" (
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
  "employee" text,
  "company" text,
  "leave_rule" text,
  "start" timestamptz,
  "end" timestamptz,
  "date_start" date,
  "date_end" date,
  "days" numeric(19,4),
  "total_hours" numeric(19,4),
  "status" text,
  "modified" timestamptz,
  "time_zone" text,
  "start_time_localized" timestamptz,
  "end_time_localized" timestamptz,
  "employee_history" text,
  "approver_time" text,
  "approver_pay" text,
  "creator" text,
  "all_day" boolean,
  "date_start_all_day" boolean,
  "date_end_all_day" boolean,
  "notify_manager_array" jsonb,
  "leave_pay_line_array" jsonb,
  "comment" text,
  "approval_comment" text,
  "external_id" text,
  "created" timestamptz,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_deputy"."leave" IS 'Typed deputy leave staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "leave_connection_watermark_idx"
  ON "source_deputy"."leave" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_deputy"."leave" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_deputy"."leave" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_deputy"."leave";
CREATE POLICY tenant_scope ON "source_deputy"."leave"
  USING (tenant_id = ingestion.current_tenant_id())
  WITH CHECK (tenant_id = ingestion.current_tenant_id());

CREATE TABLE IF NOT EXISTS "source_deputy"."contacts" (
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
  "email1" text,
  "phone1" text,
  "modified" timestamptz,
  "email2" text,
  "phone2" text,
  "phone3" text,
  "primary_email" boolean,
  "primary_phone" boolean,
  "notes" text,
  "created" timestamptz,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_deputy"."contacts" IS 'Typed deputy contacts staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "contacts_connection_watermark_idx"
  ON "source_deputy"."contacts" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_deputy"."contacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_deputy"."contacts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_deputy"."contacts";
CREATE POLICY tenant_scope ON "source_deputy"."contacts"
  USING (tenant_id = ingestion.current_tenant_id())
  WITH CHECK (tenant_id = ingestion.current_tenant_id());

GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA "source_lightspeed" TO ingest_rw;
GRANT SELECT ON ALL TABLES IN SCHEMA "source_lightspeed" TO transform_rw, diagnostic_ro;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA "source_xero" TO ingest_rw;
GRANT SELECT ON ALL TABLES IN SCHEMA "source_xero" TO transform_rw, diagnostic_ro;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA "source_deputy" TO ingest_rw;
GRANT SELECT ON ALL TABLES IN SCHEMA "source_deputy" TO transform_rw, diagnostic_ro;

COMMIT;
