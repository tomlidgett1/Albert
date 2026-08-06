BEGIN;

-- Generated from connector manifests. Do not hand-edit field columns.
-- Exact raw payloads remain in immutable object storage; these tables hold only typed projections.

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_sales" (
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
  "sale_id" numeric(19,4),
  "completed" boolean,
  "voided" boolean,
  "archived" boolean,
  "create_time" timestamptz,
  "complete_time" timestamptz,
  "updatetime" timestamptz,
  "time_stamp" timestamptz,
  "reference_number" text,
  "reference_number_source" text,
  "tax1_rate" numeric(19,4),
  "tax2_rate" numeric(19,4),
  "change" numeric(19,4),
  "tip_enabled" boolean,
  "enable_promotions" boolean,
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
  "total" numeric(19,4),
  "total_due" numeric(19,4),
  "displayable_total" numeric(19,4),
  "balance" numeric(19,4),
  "customer_id" numeric(19,4),
  "discount_id" numeric(19,4),
  "discount_percent" numeric(19,4),
  "employee_id" numeric(19,4),
  "tip_employee_id" numeric(19,4),
  "quote_id" numeric(19,4),
  "register_id" numeric(19,4),
  "ship_to_id" numeric(19,4),
  "shop_id" numeric(19,4),
  "tax_category_id" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_sales" IS 'Typed lightspeed-r ls_sales staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_sales_connection_watermark_idx"
  ON "source_lightspeed"."ls_sales" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_sales" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_sales" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_sales";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_sales"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_sale_lines" (
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
  "sale_line_id" numeric(19,4),
  "sale_id" numeric(19,4),
  "create_time" timestamptz,
  "time_stamp" timestamptz,
  "unit_quantity" numeric(19,4),
  "unit_price" numeric(19,4),
  "normal_unit_price" numeric(19,4),
  "discount_amount" numeric(19,4),
  "discount_percent" numeric(19,4),
  "avg_cost" numeric(19,4),
  "fifo_cost" numeric(19,4),
  "tax" boolean,
  "tax1_rate" numeric(19,4),
  "tax2_rate" numeric(19,4),
  "is_layaway" boolean,
  "is_workorder" boolean,
  "is_special_order" boolean,
  "displayable_subtotal" numeric(19,4),
  "displayable_unit_price" numeric(19,4),
  "calc_line_discount" numeric(19,4),
  "calc_transaction_discount" numeric(19,4),
  "calc_total" numeric(19,4),
  "calc_subtotal" numeric(19,4),
  "calc_tax1" numeric(19,4),
  "calc_tax2" numeric(19,4),
  "tax_class_id" numeric(19,4),
  "customer_id" numeric(19,4),
  "discount_id" numeric(19,4),
  "employee_id" numeric(19,4),
  "item_id" numeric(19,4),
  "note_id" numeric(19,4),
  "parent_sale_line_id" numeric(19,4),
  "shop_id" numeric(19,4),
  "tax_category_id" numeric(19,4),
  "item_fee_id" numeric(19,4),
  "line_type" text,
  "require_full_reservation" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_sale_lines" IS 'Typed lightspeed-r ls_sale_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_sale_lines_connection_watermark_idx"
  ON "source_lightspeed"."ls_sale_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_sale_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_sale_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_sale_lines";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_sale_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_sale_payments" (
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
  "sale_payment_id" numeric(19,4),
  "amount" numeric(19,4),
  "create_time" timestamptz,
  "archived" boolean,
  "remote_reference" text,
  "tip_amount" numeric(19,4),
  "payment_id" text,
  "sale_id" numeric(19,4),
  "payment_type_id" numeric(19,4),
  "cc_charge_id" numeric(19,4),
  "ref_payment_id" numeric(19,4),
  "register_id" numeric(19,4),
  "employee_id" numeric(19,4),
  "credit_account_id" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_sale_payments" IS 'Typed lightspeed-r ls_sale_payments staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_sale_payments_connection_watermark_idx"
  ON "source_lightspeed"."ls_sale_payments" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_sale_payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_sale_payments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_sale_payments";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_sale_payments"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_sale_accounts" (
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
  "sale_account_id" numeric(19,4),
  "credit_account_id" numeric(19,4),
  "sale_payment_id" numeric(19,4),
  "sale_line_id" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_sale_accounts" IS 'Typed lightspeed-r ls_sale_accounts staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_sale_accounts_connection_watermark_idx"
  ON "source_lightspeed"."ls_sale_accounts" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_sale_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_sale_accounts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_sale_accounts";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_sale_accounts"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_sale_payment_signatures" (
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
  "sale_payment_signature_id" numeric(19,4),
  "file_path" text,
  "create_time" timestamptz,
  "sale_payment_id" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_sale_payment_signatures" IS 'Typed lightspeed-r ls_sale_payment_signatures staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_sale_payment_signatures_connection_watermark_idx"
  ON "source_lightspeed"."ls_sale_payment_signatures" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_sale_payment_signatures" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_sale_payment_signatures" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_sale_payment_signatures";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_sale_payment_signatures"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_sale_line_inventory_allocations" (
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
  "inventory_sale_id" numeric(19,4),
  "quantity" numeric(19,4),
  "create_time" timestamptz,
  "inventory_id" numeric(19,4),
  "sale_line_id" numeric(19,4),
  "sale_id" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_sale_line_inventory_allocations" IS 'Typed lightspeed-r ls_sale_line_inventory_allocations staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_sale_line_inventory_allocations_connection_watermark_idx"
  ON "source_lightspeed"."ls_sale_line_inventory_allocations" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_sale_line_inventory_allocations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_sale_line_inventory_allocations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_sale_line_inventory_allocations";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_sale_line_inventory_allocations"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_sale_voids" (
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
  "sale_void_id" numeric(19,4),
  "create_time" timestamptz,
  "reason" text,
  "sale_id" numeric(19,4),
  "employee_id" numeric(19,4),
  "shop_id" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_sale_voids" IS 'Typed lightspeed-r ls_sale_voids staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_sale_voids_connection_watermark_idx"
  ON "source_lightspeed"."ls_sale_voids" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_sale_voids" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_sale_voids" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_sale_voids";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_sale_voids"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_cc_charges" (
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
  "cc_charge_id" numeric(19,4),
  "gateway_trans_id" text,
  "xnum" text,
  "response" text,
  "voided" boolean,
  "refunded" numeric(19,4),
  "amount" numeric(19,4),
  "exp" text,
  "auth_only" boolean,
  "auth_code" text,
  "time_stamp" timestamptz,
  "declined" boolean,
  "sale_id" numeric(19,4),
  "entry_method" text,
  "cardholder_name" text,
  "communication_key" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_cc_charges" IS 'Typed lightspeed-r ls_cc_charges staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_cc_charges_connection_watermark_idx"
  ON "source_lightspeed"."ls_cc_charges" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_cc_charges" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_cc_charges" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_cc_charges";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_cc_charges"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_processing_fees" (
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
  "sale_payment_processing_fee_id" numeric(19,4),
  "sale_payment_id" numeric(19,4),
  "processing_fee_ref" text,
  "processor" text,
  "amount" numeric(19,4),
  "fixed_fee" numeric(19,4),
  "variable_fee" numeric(19,4),
  "variable_pct" numeric(19,4),
  "interchange_fees_fixed_fee" numeric(19,4),
  "interchange_fees_variable_fee" numeric(19,4),
  "interchange_fees_variable_pct" numeric(19,4),
  "scheme_fees_fixed_fee" numeric(19,4),
  "scheme_fees_variable_fee" numeric(19,4),
  "scheme_fees_variable_pct" numeric(19,4),
  "processing_time" timestamptz,
  "create_time" timestamptz,
  "update_time" timestamptz,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_processing_fees" IS 'Typed lightspeed-r ls_processing_fees staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_processing_fees_connection_watermark_idx"
  ON "source_lightspeed"."ls_processing_fees" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_processing_fees" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_processing_fees" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_processing_fees";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_processing_fees"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_quotes" (
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
  "quote_id" numeric(19,4),
  "issue_date" timestamptz,
  "notes" text,
  "archived" boolean,
  "employee_id" numeric(19,4),
  "sale_id" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_quotes" IS 'Typed lightspeed-r ls_quotes staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_quotes_connection_watermark_idx"
  ON "source_lightspeed"."ls_quotes" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_quotes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_quotes" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_quotes";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_quotes"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_discounts" (
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
  "discount_id" numeric(19,4),
  "name" text,
  "discount_amount" numeric(19,4),
  "discount_percent" numeric(19,4),
  "require_customer" boolean,
  "archived" boolean,
  "source_id" numeric(19,4),
  "time_stamp" timestamptz,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_discounts" IS 'Typed lightspeed-r ls_discounts staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_discounts_connection_watermark_idx"
  ON "source_lightspeed"."ls_discounts" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_discounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_discounts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_discounts";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_discounts"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_items" (
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
  "item_id" numeric(19,4),
  "system_sku" text,
  "default_cost" numeric(19,4),
  "avg_cost" numeric(19,4),
  "tax" boolean,
  "archived" boolean,
  "discountable" boolean,
  "item_type" text,
  "serialized" boolean,
  "description" text,
  "model_year" numeric(19,4),
  "upc" text,
  "ean" text,
  "custom_sku" text,
  "manufacturer_sku" text,
  "time_stamp" timestamptz,
  "create_time" timestamptz,
  "publish_to_ecom" boolean,
  "category_id" numeric(19,4),
  "tax_class_id" numeric(19,4),
  "department_id" numeric(19,4),
  "item_matrix_id" numeric(19,4),
  "manufacturer_id" numeric(19,4),
  "season_id" numeric(19,4),
  "default_vendor_id" numeric(19,4),
  "name" text,
  "full_path_name" text,
  "tax_class" jsonb,
  "note" jsonb,
  "custom_field_values" jsonb,
  "attribute1" text,
  "attribute2" text,
  "attribute3" text,
  "item_attribute_set_id" numeric(19,4),
  "attribute_name1" text,
  "attribute_name2" text,
  "attribute_name3" text,
  "item_e_commerce_id" numeric(19,4),
  "long_description" text,
  "short_description" text,
  "weight" numeric(19,4),
  "width" numeric(19,4),
  "height" numeric(19,4),
  "length" numeric(19,4),
  "list_on_store" boolean,
  "amount_where_use_type_default" numeric(19,4),
  "amount_where_use_type_msrp" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_items" IS 'Typed lightspeed-r ls_items staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_items_connection_watermark_idx"
  ON "source_lightspeed"."ls_items" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_items" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_items";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_items"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_item_shops" (
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
  "item_shop_id" numeric(19,4),
  "item_id" numeric(19,4),
  "shop_id" numeric(19,4),
  "qoh" numeric(19,4),
  "sellable" numeric(19,4),
  "backorder" numeric(19,4),
  "component_qoh" numeric(19,4),
  "component_backorder" numeric(19,4),
  "reorder_point" numeric(19,4),
  "reorder_level" numeric(19,4),
  "time_stamp" timestamptz,
  "description" text,
  "archived" boolean,
  "item_type" text,
  "avg_cost" numeric(19,4),
  "category_id" numeric(19,4),
  "manufacturer_id" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_item_shops" IS 'Typed lightspeed-r ls_item_shops staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_item_shops_connection_watermark_idx"
  ON "source_lightspeed"."ls_item_shops" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_item_shops" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_item_shops" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_item_shops";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_item_shops"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_item_prices" (
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
  "item_id" numeric(19,4),
  "use_type_id" numeric(19,4),
  "use_type" text,
  "amount" numeric(19,4),
  "description" text,
  "archived" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_item_prices" IS 'Typed lightspeed-r ls_item_prices staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_item_prices_connection_watermark_idx"
  ON "source_lightspeed"."ls_item_prices" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_item_prices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_item_prices" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_item_prices";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_item_prices"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_item_components" (
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
  "item_component_id" numeric(19,4),
  "assembly_item_id" numeric(19,4),
  "component_item_id" numeric(19,4),
  "quantity" numeric(19,4),
  "component_group" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_item_components" IS 'Typed lightspeed-r ls_item_components staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_item_components_connection_watermark_idx"
  ON "source_lightspeed"."ls_item_components" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_item_components" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_item_components" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_item_components";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_item_components"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_item_vendor_nums" (
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
  "item_vendor_num_id" numeric(19,4),
  "item_id" numeric(19,4),
  "vendor_id" numeric(19,4),
  "value" text,
  "cost" numeric(19,4),
  "time_stamp" timestamptz,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_item_vendor_nums" IS 'Typed lightspeed-r ls_item_vendor_nums staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_item_vendor_nums_connection_watermark_idx"
  ON "source_lightspeed"."ls_item_vendor_nums" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_item_vendor_nums" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_item_vendor_nums" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_item_vendor_nums";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_item_vendor_nums"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_item_matrices" (
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
  "item_matrix_id" numeric(19,4),
  "description" text,
  "item_type" text,
  "serialized" boolean,
  "tax" boolean,
  "default_cost" numeric(19,4),
  "model_year" numeric(19,4),
  "archived" boolean,
  "category_id" numeric(19,4),
  "tax_class_id" numeric(19,4),
  "department_id" numeric(19,4),
  "manufacturer_id" numeric(19,4),
  "season_id" numeric(19,4),
  "default_vendor_id" numeric(19,4),
  "item_attribute_set_id" numeric(19,4),
  "time_stamp" timestamptz,
  "name" text,
  "full_path_name" text,
  "attribute_name1" text,
  "attribute_name2" text,
  "attribute_name3" text,
  "tax_class" jsonb,
  "department" jsonb,
  "custom_field_values" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_item_matrices" IS 'Typed lightspeed-r ls_item_matrices staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_item_matrices_connection_watermark_idx"
  ON "source_lightspeed"."ls_item_matrices" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_item_matrices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_item_matrices" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_item_matrices";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_item_matrices"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_item_attribute_sets" (
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
  "item_attribute_set_id" numeric(19,4),
  "name" text,
  "attribute_name1" text,
  "attribute_name2" text,
  "attribute_name3" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_item_attribute_sets" IS 'Typed lightspeed-r ls_item_attribute_sets staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_item_attribute_sets_connection_watermark_idx"
  ON "source_lightspeed"."ls_item_attribute_sets" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_item_attribute_sets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_item_attribute_sets" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_item_attribute_sets";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_item_attribute_sets"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_item_fees" (
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
  "item_fee_id" numeric(19,4),
  "name" text,
  "calculation_method" text,
  "fee_value" numeric(19,4),
  "taxable" boolean,
  "discountable" boolean,
  "non_refundable" boolean,
  "archived" boolean,
  "create_time" timestamptz,
  "timestamp" timestamptz,
  "item_fee_categories" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_item_fees" IS 'Typed lightspeed-r ls_item_fees staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_item_fees_connection_watermark_idx"
  ON "source_lightspeed"."ls_item_fees" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_item_fees" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_item_fees" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_item_fees";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_item_fees"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_images" (
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
  "image_id" numeric(19,4),
  "item_id" numeric(19,4),
  "item_matrix_id" numeric(19,4),
  "description" text,
  "filename" text,
  "ordering" numeric(19,4),
  "public_id" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_images" IS 'Typed lightspeed-r ls_images staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_images_connection_watermark_idx"
  ON "source_lightspeed"."ls_images" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_images" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_images" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_images";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_images"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_serialized" (
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
  "serialized_id" numeric(19,4),
  "serial" text,
  "description" text,
  "color_name" text,
  "size_name" text,
  "item_id" numeric(19,4),
  "sale_line_id" numeric(19,4),
  "customer_id" numeric(19,4),
  "time_stamp" timestamptz,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_serialized" IS 'Typed lightspeed-r ls_serialized staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_serialized_connection_watermark_idx"
  ON "source_lightspeed"."ls_serialized" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_serialized" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_serialized" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_serialized";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_serialized"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_tags" (
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
  "tag_id" numeric(19,4),
  "name" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_tags" IS 'Typed lightspeed-r ls_tags staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_tags_connection_watermark_idx"
  ON "source_lightspeed"."ls_tags" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_tags" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_tags" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_tags";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_tags"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_tag_groups" (
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
  "name" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_tag_groups" IS 'Typed lightspeed-r ls_tag_groups staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_tag_groups_connection_watermark_idx"
  ON "source_lightspeed"."ls_tag_groups" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_tag_groups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_tag_groups" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_tag_groups";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_tag_groups"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_seasons" (
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
  "season_id" numeric(19,4),
  "name" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_seasons" IS 'Typed lightspeed-r ls_seasons staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_seasons_connection_watermark_idx"
  ON "source_lightspeed"."ls_seasons" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_seasons" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_seasons" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_seasons";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_seasons"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_manufacturers" (
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
  "manufacturer_id" numeric(19,4),
  "name" text,
  "create_time" timestamptz,
  "time_stamp" timestamptz,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_manufacturers" IS 'Typed lightspeed-r ls_manufacturers staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_manufacturers_connection_watermark_idx"
  ON "source_lightspeed"."ls_manufacturers" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_manufacturers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_manufacturers" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_manufacturers";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_manufacturers"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_categories" (
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
  "category_id" numeric(19,4),
  "name" text,
  "full_path_name" text,
  "parent_id" numeric(19,4),
  "node_depth" numeric(19,4),
  "left_node" numeric(19,4),
  "right_node" numeric(19,4),
  "create_time" timestamptz,
  "time_stamp" timestamptz,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_categories" IS 'Typed lightspeed-r ls_categories staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_categories_connection_watermark_idx"
  ON "source_lightspeed"."ls_categories" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_categories" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_categories";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_categories"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_options" (
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
  "name" text,
  "value" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_options" IS 'Typed lightspeed-r ls_options staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_options_connection_watermark_idx"
  ON "source_lightspeed"."ls_options" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_options" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_options" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_options";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_options"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_price_levels" (
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
  "price_level_id" numeric(19,4),
  "name" text,
  "archived" boolean,
  "can_be_archived" boolean,
  "type" text,
  "calculation" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_price_levels" IS 'Typed lightspeed-r ls_price_levels staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_price_levels_connection_watermark_idx"
  ON "source_lightspeed"."ls_price_levels" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_price_levels" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_price_levels" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_price_levels";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_price_levels"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_catalog_vendor_items" (
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
  "catalog_vendor_item_id" numeric(19,4),
  "catalog_vendor_id" numeric(19,4),
  "vendor_number" text,
  "manufacturer_number" text,
  "description" text,
  "category" text,
  "brand" text,
  "model" text,
  "year" text,
  "upc" text,
  "ean" text,
  "ean2" text,
  "color_name" text,
  "size_name" text,
  "retail_unit" numeric(19,4),
  "unit_of_measurement" text,
  "cost" numeric(19,4),
  "cost_level2" numeric(19,4),
  "cost_level3" numeric(19,4),
  "cost_level4" numeric(19,4),
  "msrp" numeric(19,4),
  "break_qty" numeric(19,4),
  "break_price" numeric(19,4),
  "break_qty2" numeric(19,4),
  "break_price2" numeric(19,4),
  "break_qty3" numeric(19,4),
  "break_price3" numeric(19,4),
  "status" text,
  "replacement" text,
  "replacement_description" text,
  "last_price_change" timestamptz,
  "last_qoh" numeric(19,4),
  "archived" boolean,
  "catalog_vendor" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_catalog_vendor_items" IS 'Typed lightspeed-r ls_catalog_vendor_items staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_catalog_vendor_items_connection_watermark_idx"
  ON "source_lightspeed"."ls_catalog_vendor_items" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_catalog_vendor_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_catalog_vendor_items" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_catalog_vendor_items";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_catalog_vendor_items"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_inventory_logs" (
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
  "inventory_log_id" numeric(19,4),
  "create_time" timestamptz,
  "qoh_change" numeric(19,4),
  "cost_change" numeric(19,4),
  "automated" boolean,
  "reason" text,
  "caused_negative" boolean,
  "employee_id" numeric(19,4),
  "item_id" numeric(19,4),
  "shop_id" numeric(19,4),
  "order_id" numeric(19,4),
  "transfer_id" numeric(19,4),
  "sale_id" numeric(19,4),
  "inventory_count_id" numeric(19,4),
  "customer_id" numeric(19,4),
  "vendor_return_id" numeric(19,4),
  "item_import_id" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_inventory_logs" IS 'Typed lightspeed-r ls_inventory_logs staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_inventory_logs_connection_watermark_idx"
  ON "source_lightspeed"."ls_inventory_logs" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_inventory_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_inventory_logs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_inventory_logs";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_inventory_logs"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_inventory_count_calcs" (
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
  "inventory_count_calc_id" numeric(19,4),
  "time_stamp" timestamptz,
  "calc_qoh" numeric(19,4),
  "counted_qoh" numeric(19,4),
  "inventory_count_id" numeric(19,4),
  "item_id" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_inventory_count_calcs" IS 'Typed lightspeed-r ls_inventory_count_calcs staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_inventory_count_calcs_connection_watermark_idx"
  ON "source_lightspeed"."ls_inventory_count_calcs" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_inventory_count_calcs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_inventory_count_calcs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_inventory_count_calcs";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_inventory_count_calcs"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_inventory_count_items" (
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
  "inventory_count_item_id" numeric(19,4),
  "qty" numeric(19,4),
  "time_stamp" timestamptz,
  "inventory_count_id" numeric(19,4),
  "item_id" numeric(19,4),
  "employee_id" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_inventory_count_items" IS 'Typed lightspeed-r ls_inventory_count_items staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_inventory_count_items_connection_watermark_idx"
  ON "source_lightspeed"."ls_inventory_count_items" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_inventory_count_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_inventory_count_items" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_inventory_count_items";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_inventory_count_items"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_inventory_count_reconciles" (
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
  "inventory_count_reconcile_id" numeric(19,4),
  "create_time" timestamptz,
  "cost_change" numeric(19,4),
  "qoh_change" numeric(19,4),
  "inventory_count_id" numeric(19,4),
  "item_id" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_inventory_count_reconciles" IS 'Typed lightspeed-r ls_inventory_count_reconciles staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_inventory_count_reconciles_connection_watermark_idx"
  ON "source_lightspeed"."ls_inventory_count_reconciles" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_inventory_count_reconciles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_inventory_count_reconciles" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_inventory_count_reconciles";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_inventory_count_reconciles"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_transfers" (
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
  "transfer_id" numeric(19,4),
  "sent" boolean,
  "received" boolean,
  "note" text,
  "archived" boolean,
  "transfer_from_id" numeric(19,4),
  "transfer_to_id" numeric(19,4),
  "order_id" numeric(19,4),
  "sent_on" timestamptz,
  "employee_id" numeric(19,4),
  "shop_id" numeric(19,4),
  "need_by" timestamptz,
  "time_stamp" timestamptz,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_transfers" IS 'Typed lightspeed-r ls_transfers staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_transfers_connection_watermark_idx"
  ON "source_lightspeed"."ls_transfers" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_transfers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_transfers" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_transfers";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_transfers"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_transfer_items" (
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
  "transfer_item_id" numeric(19,4),
  "transfer_id" numeric(19,4),
  "item_id" numeric(19,4),
  "to_send" numeric(19,4),
  "to_receive" numeric(19,4),
  "sent" numeric(19,4),
  "received" numeric(19,4),
  "sent_value" numeric(19,4),
  "received_value" numeric(19,4),
  "comment" text,
  "time_stamp" timestamptz,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_transfer_items" IS 'Typed lightspeed-r ls_transfer_items staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_transfer_items_connection_watermark_idx"
  ON "source_lightspeed"."ls_transfer_items" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_transfer_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_transfer_items" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_transfer_items";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_transfer_items"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_special_orders" (
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
  "special_order_id" numeric(19,4),
  "unit_quantity" numeric(19,4),
  "contacted" boolean,
  "completed" boolean,
  "customer_id" numeric(19,4),
  "shop_id" numeric(19,4),
  "sale_line_id" numeric(19,4),
  "order_line_id" numeric(19,4),
  "transfer_item_id" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_special_orders" IS 'Typed lightspeed-r ls_special_orders staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_special_orders_connection_watermark_idx"
  ON "source_lightspeed"."ls_special_orders" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_special_orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_special_orders" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_special_orders";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_special_orders"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_transfer_from" (
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
  "transfer_from_id" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_transfer_from" IS 'Typed lightspeed-r ls_transfer_from staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_transfer_from_connection_watermark_idx"
  ON "source_lightspeed"."ls_transfer_from" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_transfer_from" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_transfer_from" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_transfer_from";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_transfer_from"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_transfer_to" (
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
  "transfer_to_id" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_transfer_to" IS 'Typed lightspeed-r ls_transfer_to staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_transfer_to_connection_watermark_idx"
  ON "source_lightspeed"."ls_transfer_to" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_transfer_to" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_transfer_to" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_transfer_to";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_transfer_to"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_purchase_orders" (
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
  "order_id" numeric(19,4),
  "ordered_date" timestamptz,
  "received_date" timestamptz,
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
  "vendor_id" numeric(19,4),
  "name" text,
  "note_id" numeric(19,4),
  "shop_id" numeric(19,4),
  "created_by_employee_id" numeric(19,4),
  "custom_field_values" jsonb,
  "create_time" timestamptz,
  "time_stamp" timestamptz,
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
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_purchase_orders" IS 'Typed lightspeed-r ls_purchase_orders staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_purchase_orders_connection_watermark_idx"
  ON "source_lightspeed"."ls_purchase_orders" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_purchase_orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_purchase_orders" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_purchase_orders";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_purchase_orders"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_purchase_order_lines" (
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
  "order_line_id" numeric(19,4),
  "order_id" numeric(19,4),
  "item_id" numeric(19,4),
  "quantity" numeric(19,4),
  "price" numeric(19,4),
  "original_price" numeric(19,4),
  "vendor_cost" numeric(19,4),
  "checked_in" numeric(19,4),
  "num_received" numeric(19,4),
  "total" numeric(19,4),
  "shipping_cost" numeric(19,4),
  "shipping_vendor_cost" numeric(19,4),
  "discount_money_value" numeric(19,4),
  "discount_money_vendor_value" numeric(19,4),
  "discount_percent_value" numeric(19,4),
  "create_time" timestamptz,
  "time_stamp" timestamptz,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_purchase_order_lines" IS 'Typed lightspeed-r ls_purchase_order_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_purchase_order_lines_connection_watermark_idx"
  ON "source_lightspeed"."ls_purchase_order_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_purchase_order_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_purchase_order_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_purchase_order_lines";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_purchase_order_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_order_shipments" (
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
  "order_shipment_id" numeric(19,4),
  "order_id" numeric(19,4),
  "sequence_number" numeric(19,4),
  "total_qty_received" numeric(19,4),
  "total_vendor_cost" numeric(19,4),
  "total_cost" numeric(19,4),
  "currency_code" text,
  "vendor_currency_code" text,
  "vendor_currency_rate" numeric(19,4),
  "create_time" timestamptz,
  "payment_due_date" date,
  "shipment_packing_ref_num" text,
  "time_stamp" timestamptz,
  "employee_id" numeric(19,4),
  "reception_date" timestamptz,
  "shipping_cost_method" text,
  "shipping_vendor_cost" numeric(19,4),
  "shipping_cost" numeric(19,4),
  "shipping_cost_order_full_value" numeric(19,4),
  "shipping_cost_order_full_vendor_value" numeric(19,4),
  "discount_method" text,
  "discount_money_vendor_value" numeric(19,4),
  "discount_money_value" numeric(19,4),
  "discount_percent_value" numeric(19,4),
  "discount_order_full_money_value" numeric(19,4),
  "discount_order_full_money_vendor_value" numeric(19,4),
  "cost" numeric(19,4),
  "vendor_cost" numeric(19,4),
  "status" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_order_shipments" IS 'Typed lightspeed-r ls_order_shipments staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_order_shipments_connection_watermark_idx"
  ON "source_lightspeed"."ls_order_shipments" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_order_shipments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_order_shipments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_order_shipments";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_order_shipments"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_order_shipment_items" (
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
  "order_shipment_item_id" numeric(19,4),
  "order_shipment_id" numeric(19,4),
  "qty_received" numeric(19,4),
  "vendor_cost" numeric(19,4),
  "cost" numeric(19,4),
  "total_vendor_cost" numeric(19,4),
  "total_cost" numeric(19,4),
  "shipping_cost" numeric(19,4),
  "shipping_vendor_cost" numeric(19,4),
  "discount_money_value" numeric(19,4),
  "discount_money_vendor_value" numeric(19,4),
  "discount_percent_value" numeric(19,4),
  "currency_code" text,
  "vendor_currency_code" text,
  "vendor_currency_rate" numeric(19,4),
  "create_time" timestamptz,
  "time_stamp" timestamptz,
  "item_id" numeric(19,4),
  "item_vendor_id" text,
  "item_description" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_order_shipment_items" IS 'Typed lightspeed-r ls_order_shipment_items staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_order_shipment_items_connection_watermark_idx"
  ON "source_lightspeed"."ls_order_shipment_items" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_order_shipment_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_order_shipment_items" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_order_shipment_items";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_order_shipment_items"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_vendors" (
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
  "vendor_id" numeric(19,4),
  "name" text,
  "archived" boolean,
  "account_number" text,
  "price_level" text,
  "update_price" boolean,
  "update_cost" boolean,
  "update_description" boolean,
  "share_sell_through" boolean,
  "b2b_seller_uid" text,
  "contact" jsonb,
  "code" text,
  "symbol" text,
  "rate" numeric(19,4),
  "time_stamp" timestamptz,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_vendors" IS 'Typed lightspeed-r ls_vendors staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_vendors_connection_watermark_idx"
  ON "source_lightspeed"."ls_vendors" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_vendors" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_vendors" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_vendors";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_vendors"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_vendor_returns" (
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
  "vendor_return_id" numeric(19,4),
  "vendor_id" numeric(19,4),
  "shop_id" numeric(19,4),
  "ref_num" text,
  "status" text,
  "sent_date" timestamptz,
  "ship_cost" numeric(19,4),
  "other_cost" numeric(19,4),
  "hide_vendor_details" boolean,
  "archived" boolean,
  "subtotal" numeric(19,4),
  "total" numeric(19,4),
  "name" text,
  "time_stamp" timestamptz,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_vendor_returns" IS 'Typed lightspeed-r ls_vendor_returns staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_vendor_returns_connection_watermark_idx"
  ON "source_lightspeed"."ls_vendor_returns" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_vendor_returns" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_vendor_returns" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_vendor_returns";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_vendor_returns"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_customers" (
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
  "customer_id" numeric(19,4),
  "first_name" text,
  "last_name" text,
  "dob" timestamptz,
  "archived" boolean,
  "title" text,
  "company" text,
  "company_registration_number" text,
  "vat_number" text,
  "create_time" timestamptz,
  "time_stamp" timestamptz,
  "credit_account_id" numeric(19,4),
  "customer_type_id" numeric(19,4),
  "discount_id" numeric(19,4),
  "tax_category_id" numeric(19,4),
  "contact_id" numeric(19,4),
  "contact" jsonb,
  "custom_field_values" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_customers" IS 'Typed lightspeed-r ls_customers staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_customers_connection_watermark_idx"
  ON "source_lightspeed"."ls_customers" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_customers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_customers" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_customers";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_customers"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_contacts" (
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
  "contact_id" numeric(19,4),
  "contact" text,
  "ship_to_id" numeric(19,4),
  "address1" text,
  "address2" text,
  "city" text,
  "state" text,
  "state_code" text,
  "zip" text,
  "country" text,
  "country_code" text,
  "no_email" boolean,
  "no_mail" boolean,
  "no_phone" boolean,
  "time_stamp" timestamptz,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_contacts" IS 'Typed lightspeed-r ls_contacts staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_contacts_connection_watermark_idx"
  ON "source_lightspeed"."ls_contacts" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_contacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_contacts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_contacts";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_contacts"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_contact_emails" (
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
  "contact_id" numeric(19,4),
  "contact_email" numeric(19,4),
  "address" text,
  "use_type" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_contact_emails" IS 'Typed lightspeed-r ls_contact_emails staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_contact_emails_connection_watermark_idx"
  ON "source_lightspeed"."ls_contact_emails" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_contact_emails" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_contact_emails" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_contact_emails";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_contact_emails"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_contact_phones" (
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
  "contact_id" numeric(19,4),
  "contact_phone" numeric(19,4),
  "number" text,
  "use_type" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_contact_phones" IS 'Typed lightspeed-r ls_contact_phones staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_contact_phones_connection_watermark_idx"
  ON "source_lightspeed"."ls_contact_phones" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_contact_phones" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_contact_phones" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_contact_phones";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_contact_phones"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_contact_websites" (
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
  "contact_id" numeric(19,4),
  "contact_website" numeric(19,4),
  "url" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_contact_websites" IS 'Typed lightspeed-r ls_contact_websites staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_contact_websites_connection_watermark_idx"
  ON "source_lightspeed"."ls_contact_websites" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_contact_websites" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_contact_websites" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_contact_websites";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_contact_websites"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_customer_types" (
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
  "customer_type_id" numeric(19,4),
  "name" text,
  "tax_category_id" numeric(19,4),
  "discount_id" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_customer_types" IS 'Typed lightspeed-r ls_customer_types staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_customer_types_connection_watermark_idx"
  ON "source_lightspeed"."ls_customer_types" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_customer_types" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_customer_types" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_customer_types";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_customer_types"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_credit_accounts" (
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
  "credit_account_id" numeric(19,4),
  "name" text,
  "code" text,
  "description" text,
  "gift_card" boolean,
  "archived" boolean,
  "customer_id" numeric(19,4),
  "balance" numeric(19,4),
  "contact_id" numeric(19,4),
  "time_stamp" timestamptz,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_credit_accounts" IS 'Typed lightspeed-r ls_credit_accounts staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_credit_accounts_connection_watermark_idx"
  ON "source_lightspeed"."ls_credit_accounts" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_credit_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_credit_accounts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_credit_accounts";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_credit_accounts"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_ship_tos" (
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
  "ship_to_id" numeric(19,4),
  "shipped" boolean,
  "ship_note" text,
  "first_name" text,
  "last_name" text,
  "customer_id" numeric(19,4),
  "sale_id" numeric(19,4),
  "time_stamp" timestamptz,
  "contact" jsonb,
  "contact_id" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_ship_tos" IS 'Typed lightspeed-r ls_ship_tos staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_ship_tos_connection_watermark_idx"
  ON "source_lightspeed"."ls_ship_tos" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_ship_tos" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_ship_tos" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_ship_tos";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_ship_tos"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_custom_fields" (
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
  "custom_field_id" numeric(19,4),
  "type" text,
  "name" text,
  "uom" text,
  "decimal_precision" numeric(19,4),
  "archived" boolean,
  "default" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_custom_fields" IS 'Typed lightspeed-r ls_custom_fields staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_custom_fields_connection_watermark_idx"
  ON "source_lightspeed"."ls_custom_fields" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_custom_fields" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_custom_fields" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_custom_fields";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_custom_fields"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_custom_field_choices" (
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
  "custom_field_choice_id" numeric(19,4),
  "custom_field_id" numeric(19,4),
  "name" text,
  "value" text,
  "can_be_deleted" boolean,
  "time_stamp" timestamptz,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_custom_field_choices" IS 'Typed lightspeed-r ls_custom_field_choices staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_custom_field_choices_connection_watermark_idx"
  ON "source_lightspeed"."ls_custom_field_choices" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_custom_field_choices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_custom_field_choices" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_custom_field_choices";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_custom_field_choices"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_customer_custom_field_values" (
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
  "custom_field_value_id" numeric(19,4),
  "customer_id" numeric(19,4),
  "custom_field_id" numeric(19,4),
  "name" text,
  "type" text,
  "value" jsonb,
  "custom_field_choice_id" numeric(19,4),
  "deleted" boolean,
  "time_stamp" timestamptz,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_customer_custom_field_values" IS 'Typed lightspeed-r ls_customer_custom_field_values staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_customer_custom_field_values_connection_watermark_idx"
  ON "source_lightspeed"."ls_customer_custom_field_values" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_customer_custom_field_values" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_customer_custom_field_values" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_customer_custom_field_values";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_customer_custom_field_values"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_customer_notes" (
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
  "note_id" numeric(19,4),
  "customer_id" numeric(19,4),
  "note" text,
  "is_public" boolean,
  "time_stamp" timestamptz,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_customer_notes" IS 'Typed lightspeed-r ls_customer_notes staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_customer_notes_connection_watermark_idx"
  ON "source_lightspeed"."ls_customer_notes" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_customer_notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_customer_notes" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_customer_notes";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_customer_notes"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_workorders" (
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
  "workorder_id" numeric(19,4),
  "time_in" timestamptz,
  "eta_out" timestamptz,
  "note" text,
  "internal_note" text,
  "warranty" boolean,
  "tax" boolean,
  "archived" boolean,
  "hook_in" text,
  "hook_out" text,
  "save_parts" boolean,
  "assign_employee_to_all" boolean,
  "customer_id" numeric(19,4),
  "discount_id" numeric(19,4),
  "employee_id" numeric(19,4),
  "serialized_id" numeric(19,4),
  "shop_id" numeric(19,4),
  "sale_id" numeric(19,4),
  "sale_line_id" numeric(19,4),
  "workorder_status_id" numeric(19,4),
  "customer" text,
  "name" text,
  "system_value" text,
  "description" text,
  "serial" text,
  "time_stamp" timestamptz,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_workorders" IS 'Typed lightspeed-r ls_workorders staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_workorders_connection_watermark_idx"
  ON "source_lightspeed"."ls_workorders" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_workorders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_workorders" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_workorders";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_workorders"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_workorder_lines" (
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
  "workorder_line_id" numeric(19,4),
  "workorder_id" numeric(19,4),
  "note" text,
  "hours" numeric(19,4),
  "minutes" numeric(19,4),
  "unit_price_override" numeric(19,4),
  "unit_quantity" numeric(19,4),
  "unit_cost" numeric(19,4),
  "done" boolean,
  "approved" boolean,
  "warranty" boolean,
  "tax" boolean,
  "employee_id" numeric(19,4),
  "sale_line_id" numeric(19,4),
  "sale_id" numeric(19,4),
  "item_id" numeric(19,4),
  "discount_id" numeric(19,4),
  "tax_class_id" numeric(19,4),
  "time_stamp" timestamptz,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_workorder_lines" IS 'Typed lightspeed-r ls_workorder_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_workorder_lines_connection_watermark_idx"
  ON "source_lightspeed"."ls_workorder_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_workorder_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_workorder_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_workorder_lines";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_workorder_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_workorder_items" (
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
  "workorder_item_id" numeric(19,4),
  "workorder_id" numeric(19,4),
  "approved" boolean,
  "unit_price" numeric(19,4),
  "unit_quantity" numeric(19,4),
  "warranty" boolean,
  "tax" boolean,
  "is_special_order" boolean,
  "note" text,
  "employee_id" numeric(19,4),
  "sale_line_id" numeric(19,4),
  "sale_id" numeric(19,4),
  "item_id" numeric(19,4),
  "discount_id" numeric(19,4),
  "time_stamp" timestamptz,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_workorder_items" IS 'Typed lightspeed-r ls_workorder_items staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_workorder_items_connection_watermark_idx"
  ON "source_lightspeed"."ls_workorder_items" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_workorder_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_workorder_items" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_workorder_items";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_workorder_items"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_workorder_statuses" (
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
  "workorder_status_id" numeric(19,4),
  "name" text,
  "sort_order" numeric(19,4),
  "html_color" text,
  "system_value" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_workorder_statuses" IS 'Typed lightspeed-r ls_workorder_statuses staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_workorder_statuses_connection_watermark_idx"
  ON "source_lightspeed"."ls_workorder_statuses" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_workorder_statuses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_workorder_statuses" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_workorder_statuses";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_workorder_statuses"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_workorder_images" (
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
  "workorder_image_id" numeric(19,4),
  "workorder_id" numeric(19,4),
  "description" text,
  "filename" text,
  "ordering" numeric(19,4),
  "public_id" text,
  "base_image_url" text,
  "size" numeric(19,4),
  "create_time" timestamptz,
  "time_stamp" timestamptz,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_workorder_images" IS 'Typed lightspeed-r ls_workorder_images staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_workorder_images_connection_watermark_idx"
  ON "source_lightspeed"."ls_workorder_images" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_workorder_images" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_workorder_images" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_workorder_images";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_workorder_images"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_shops" (
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
  "shop_id" numeric(19,4),
  "name" text,
  "service_rate" numeric(19,4),
  "time_zone" text,
  "tax_labor" boolean,
  "label_title" text,
  "label_msrp" boolean,
  "archived" boolean,
  "contact_id" numeric(19,4),
  "tax_category_id" numeric(19,4),
  "receipt_setup_id" numeric(19,4),
  "cc_gateway_id" numeric(19,4),
  "price_level_id" numeric(19,4),
  "contact" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_shops" IS 'Typed lightspeed-r ls_shops staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_shops_connection_watermark_idx"
  ON "source_lightspeed"."ls_shops" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_shops" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_shops" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_shops";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_shops"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_registers" (
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
  "register_id" numeric(19,4),
  "name" text,
  "open" boolean,
  "open_time" timestamptz,
  "tip_enabled" boolean,
  "open_employee_id" numeric(19,4),
  "shop_id" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_registers" IS 'Typed lightspeed-r ls_registers staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_registers_connection_watermark_idx"
  ON "source_lightspeed"."ls_registers" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_registers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_registers" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_registers";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_registers"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_employees" (
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
  "employee_id" numeric(19,4),
  "first_name" text,
  "last_name" text,
  "lock_out" boolean,
  "archived" boolean,
  "contact_id" numeric(19,4),
  "clock_in_employee_hours_id" numeric(19,4),
  "employee_role_id" numeric(19,4),
  "limit_to_shop_id" numeric(19,4),
  "last_shop_id" numeric(19,4),
  "last_sale_id" numeric(19,4),
  "last_register_id" numeric(19,4),
  "time_stamp" timestamptz,
  "contact" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_employees" IS 'Typed lightspeed-r ls_employees staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_employees_connection_watermark_idx"
  ON "source_lightspeed"."ls_employees" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_employees" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_employees" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_employees";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_employees"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_employee_roles" (
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
  "employee_role_id" numeric(19,4),
  "name" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_employee_roles" IS 'Typed lightspeed-r ls_employee_roles staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_employee_roles_connection_watermark_idx"
  ON "source_lightspeed"."ls_employee_roles" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_employee_roles" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_employee_roles" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_employee_roles";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_employee_roles"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_employee_role_rights" (
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
  "employee_role_id" numeric(19,4),
  "employee_right_id" numeric(19,4),
  "name" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_employee_role_rights" IS 'Typed lightspeed-r ls_employee_role_rights staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_employee_role_rights_connection_watermark_idx"
  ON "source_lightspeed"."ls_employee_role_rights" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_employee_role_rights" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_employee_role_rights" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_employee_role_rights";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_employee_role_rights"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_employee_rights" (
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
  "employee_id" numeric(19,4),
  "employee_right_id" numeric(19,4),
  "name" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_employee_rights" IS 'Typed lightspeed-r ls_employee_rights staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_employee_rights_connection_watermark_idx"
  ON "source_lightspeed"."ls_employee_rights" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_employee_rights" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_employee_rights" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_employee_rights";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_employee_rights"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_employee_hours" (
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
  "employee_hours_id" numeric(19,4),
  "check_in" timestamptz,
  "check_out" timestamptz,
  "employee_id" numeric(19,4),
  "shop_id" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_employee_hours" IS 'Typed lightspeed-r ls_employee_hours staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_employee_hours_connection_watermark_idx"
  ON "source_lightspeed"."ls_employee_hours" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_employee_hours" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_employee_hours" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_employee_hours";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_employee_hours"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_session" (
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
  "session_id" numeric(19,4),
  "session_cookie" text,
  "employee_id" numeric(19,4),
  "system_customer_id" numeric(19,4),
  "system_user_id" numeric(19,4),
  "system_api_client_id" numeric(19,4),
  "system_api_key_id" numeric(19,4),
  "ecom_url" text,
  "shop_count" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_session" IS 'Typed lightspeed-r ls_session staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_session_connection_watermark_idx"
  ON "source_lightspeed"."ls_session" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_session" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_session" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_session";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_session"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_account" (
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
  "account_id" numeric(19,4),
  "name" text,
  "link" text,
  "system_customer_id" numeric(19,4),
  "status" text,
  "employee_count" numeric(19,4),
  "employee_limit" numeric(19,4),
  "unique_subscription_identifier" text,
  "code" text,
  "symbol" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_account" IS 'Typed lightspeed-r ls_account staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_account_connection_watermark_idx"
  ON "source_lightspeed"."ls_account" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_account" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_account" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_account";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_account"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_account_purchasing_currencies" (
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
  "account_id" numeric(19,4),
  "code" text,
  "symbol" text,
  "rate" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_account_purchasing_currencies" IS 'Typed lightspeed-r ls_account_purchasing_currencies staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_account_purchasing_currencies_connection_watermark_idx"
  ON "source_lightspeed"."ls_account_purchasing_currencies" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_account_purchasing_currencies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_account_purchasing_currencies" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_account_purchasing_currencies";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_account_purchasing_currencies"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_locales" (
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
  "name" text,
  "country" text,
  "states" text,
  "currency_symbol" text,
  "currency_code" text,
  "currency_precision" numeric(19,4),
  "cash_rounding_precision" numeric(19,4),
  "include_tax_on_labels" boolean,
  "language_tag" text,
  "date_format" text,
  "datetime_format" text,
  "tax_name1" text,
  "tax_name2" text,
  "currency_denominations" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_locales" IS 'Typed lightspeed-r ls_locales staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_locales_connection_watermark_idx"
  ON "source_lightspeed"."ls_locales" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_locales" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_locales" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_locales";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_locales"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_industries" (
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
  "industry_id" numeric(19,4),
  "name" text,
  "enabled" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_industries" IS 'Typed lightspeed-r ls_industries staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_industries_connection_watermark_idx"
  ON "source_lightspeed"."ls_industries" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_industries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_industries" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_industries";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_industries"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_cc_gateways" (
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
  "cc_gateway_id" numeric(19,4),
  "gateway" text,
  "enabled" boolean,
  "test_mode" boolean,
  "allow_credits" boolean,
  "market_type" text,
  "device_type" numeric(19,4),
  "terminal_num" text,
  "login" text,
  "trans_key" text,
  "account_num" text,
  "hash_value" text,
  "other_credentials1" text,
  "other_credentials2" text,
  "visa_payment_type_id" numeric(19,4),
  "master_payment_type_id" numeric(19,4),
  "discover_payment_type_id" numeric(19,4),
  "american_payment_type_id" numeric(19,4),
  "debit_payment_type_id" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_cc_gateways" IS 'Typed lightspeed-r ls_cc_gateways staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_cc_gateways_connection_watermark_idx"
  ON "source_lightspeed"."ls_cc_gateways" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_cc_gateways" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_cc_gateways" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_cc_gateways";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_cc_gateways"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_receipt_setups" (
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
  "receipt_setup_id" numeric(19,4),
  "header" text,
  "general_msg" text,
  "workorder_agree" text,
  "creditcard_agree" text,
  "logo" text,
  "logo_height" numeric(19,4),
  "logo_width" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_receipt_setups" IS 'Typed lightspeed-r ls_receipt_setups staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_receipt_setups_connection_watermark_idx"
  ON "source_lightspeed"."ls_receipt_setups" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_receipt_setups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_receipt_setups" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_receipt_setups";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_receipt_setups"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_currency_rates" (
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
  "currency_rate_id" numeric(19,4),
  "currency_code" text,
  "rate" numeric(19,4),
  "create_time" timestamptz,
  "time_stamp" timestamptz,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_currency_rates" IS 'Typed lightspeed-r ls_currency_rates staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_currency_rates_connection_watermark_idx"
  ON "source_lightspeed"."ls_currency_rates" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_currency_rates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_currency_rates" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_currency_rates";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_currency_rates"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_currency_denominations" (
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
  "locale_id" numeric(19,4),
  "currency_denominations" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_currency_denominations" IS 'Typed lightspeed-r ls_currency_denominations staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_currency_denominations_connection_watermark_idx"
  ON "source_lightspeed"."ls_currency_denominations" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_currency_denominations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_currency_denominations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_currency_denominations";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_currency_denominations"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_register_counts" (
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
  "register_count_id" numeric(19,4),
  "create_time" timestamptz,
  "open_time" timestamptz,
  "notes" text,
  "register_id" numeric(19,4),
  "open_employee_id" numeric(19,4),
  "close_employee_id" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_register_counts" IS 'Typed lightspeed-r ls_register_counts staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_register_counts_connection_watermark_idx"
  ON "source_lightspeed"."ls_register_counts" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_register_counts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_register_counts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_register_counts";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_register_counts"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_register_count_amounts" (
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
  "register_count_amount_id" numeric(19,4),
  "register_count_id" numeric(19,4),
  "payment_type_id" numeric(19,4),
  "calculated" numeric(19,4),
  "actual" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_register_count_amounts" IS 'Typed lightspeed-r ls_register_count_amounts staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_register_count_amounts_connection_watermark_idx"
  ON "source_lightspeed"."ls_register_count_amounts" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_register_count_amounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_register_count_amounts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_register_count_amounts";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_register_count_amounts"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_register_withdraws" (
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
  "register_withdraw_id" numeric(19,4),
  "amount" numeric(19,4),
  "create_time" timestamptz,
  "notes" text,
  "employee_id" numeric(19,4),
  "payment_type_id" numeric(19,4),
  "register_id" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_register_withdraws" IS 'Typed lightspeed-r ls_register_withdraws staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_register_withdraws_connection_watermark_idx"
  ON "source_lightspeed"."ls_register_withdraws" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_register_withdraws" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_register_withdraws" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_register_withdraws";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_register_withdraws"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_register_calculated" (
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
  "register_calculated_path_parameter_register_id" numeric(19,4),
  "payment_type_id" numeric(19,4),
  "payment" numeric(19,4),
  "add" numeric(19,4),
  "withdraw" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_register_calculated" IS 'Typed lightspeed-r ls_register_calculated staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_register_calculated_connection_watermark_idx"
  ON "source_lightspeed"."ls_register_calculated" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_register_calculated" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_register_calculated" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_register_calculated";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_register_calculated"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_tax_categories" (
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
  "tax_category_id" numeric(19,4),
  "is_tax_inclusive" boolean,
  "tax1_name" text,
  "tax2_name" text,
  "tax1_rate" numeric(19,4),
  "tax2_rate" numeric(19,4),
  "time_stamp" timestamptz,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_tax_categories" IS 'Typed lightspeed-r ls_tax_categories staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_tax_categories_connection_watermark_idx"
  ON "source_lightspeed"."ls_tax_categories" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_tax_categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_tax_categories" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_tax_categories";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_tax_categories"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_tax_category_classes" (
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
  "tax_category_id" numeric(19,4),
  "tax_category_class_id" numeric(19,4),
  "tax_class_id" numeric(19,4),
  "tax1_rate" numeric(19,4),
  "tax2_rate" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_tax_category_classes" IS 'Typed lightspeed-r ls_tax_category_classes staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_tax_category_classes_connection_watermark_idx"
  ON "source_lightspeed"."ls_tax_category_classes" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_tax_category_classes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_tax_category_classes" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_tax_category_classes";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_tax_category_classes"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_tax_classes" (
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
  "tax_class_id" numeric(19,4),
  "name" text,
  "time_stamp" timestamptz,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_tax_classes" IS 'Typed lightspeed-r ls_tax_classes staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_tax_classes_connection_watermark_idx"
  ON "source_lightspeed"."ls_tax_classes" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_tax_classes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_tax_classes" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_tax_classes";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_tax_classes"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_payment_types" (
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
  "payment_type_id" numeric(19,4),
  "name" text,
  "require_customer" boolean,
  "archived" boolean,
  "internal_reserved" boolean,
  "type" text,
  "refund_as_payment_type_id" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_payment_types" IS 'Typed lightspeed-r ls_payment_types staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_payment_types_connection_watermark_idx"
  ON "source_lightspeed"."ls_payment_types" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_payment_types" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_payment_types" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_payment_types";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_payment_types"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_report_payments_by_day" (
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
  "date" date,
  "shop_id" numeric(19,4),
  "layaway" boolean,
  "amount" numeric(19,4),
  "payment_type_name" text,
  "payment_type_id" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_report_payments_by_day" IS 'Typed lightspeed-r ls_report_payments_by_day staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_report_payments_by_day_connection_watermark_idx"
  ON "source_lightspeed"."ls_report_payments_by_day" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_report_payments_by_day" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_report_payments_by_day" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_report_payments_by_day";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_report_payments_by_day"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_report_taxes_by_day" (
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
  "date" date,
  "shop_id" numeric(19,4),
  "tax_category_id" numeric(19,4),
  "tax_category_name" text,
  "tax" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_report_taxes_by_day" IS 'Typed lightspeed-r ls_report_taxes_by_day staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_report_taxes_by_day_connection_watermark_idx"
  ON "source_lightspeed"."ls_report_taxes_by_day" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_report_taxes_by_day" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_report_taxes_by_day" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_report_taxes_by_day";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_report_taxes_by_day"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_report_discounts_by_day" (
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
  "date" date,
  "shop_id" numeric(19,4),
  "discount" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_report_discounts_by_day" IS 'Typed lightspeed-r ls_report_discounts_by_day staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_report_discounts_by_day_connection_watermark_idx"
  ON "source_lightspeed"."ls_report_discounts_by_day" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_report_discounts_by_day" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_report_discounts_by_day" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_report_discounts_by_day";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_report_discounts_by_day"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_report_tax_class_sales_by_day" (
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
  "date" date,
  "shop_id" numeric(19,4),
  "tax_class_id" numeric(19,4),
  "tax_class_name" text,
  "subtotal" numeric(19,4),
  "fifo_cost" numeric(19,4),
  "avg_cost" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_report_tax_class_sales_by_day" IS 'Typed lightspeed-r ls_report_tax_class_sales_by_day staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_report_tax_class_sales_by_day_connection_watermark_idx"
  ON "source_lightspeed"."ls_report_tax_class_sales_by_day" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_report_tax_class_sales_by_day" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_report_tax_class_sales_by_day" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_report_tax_class_sales_by_day";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_report_tax_class_sales_by_day"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_lightspeed"."ls_report_orders_by_tax_class" (
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
  "date" date,
  "shop_id" numeric(19,4),
  "vendor_id" numeric(19,4),
  "vendor_name" text,
  "tax_class_id" numeric(19,4),
  "tax_class_name" text,
  "cost" numeric(19,4),
  "order_id" numeric(19,4),
  "total_ship_cost" numeric(19,4),
  "total_other_cost" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_lightspeed"."ls_report_orders_by_tax_class" IS 'Typed lightspeed-r ls_report_orders_by_tax_class staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "ls_report_orders_by_tax_class_connection_watermark_idx"
  ON "source_lightspeed"."ls_report_orders_by_tax_class" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_lightspeed"."ls_report_orders_by_tax_class" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_lightspeed"."ls_report_orders_by_tax_class" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_lightspeed"."ls_report_orders_by_tax_class";
CREATE POLICY tenant_scope ON "source_lightspeed"."ls_report_orders_by_tax_class"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA "source_lightspeed" TO ingest_rw;
GRANT SELECT ON ALL TABLES IN SCHEMA "source_lightspeed" TO transform_rw, diagnostic_ro;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA "source_xero" TO ingest_rw;
GRANT SELECT ON ALL TABLES IN SCHEMA "source_xero" TO transform_rw, diagnostic_ro;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA "source_deputy" TO ingest_rw;
GRANT SELECT ON ALL TABLES IN SCHEMA "source_deputy" TO transform_rw, diagnostic_ro;

COMMIT;
