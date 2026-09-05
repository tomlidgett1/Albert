-- Restores the Xero connector typed-staging schema that 0156 dropped.
-- 0156 assumed the dlt-loaded XER_OFFICIAL snapshot was the permanent Xero
-- data path; the product path is the connector worker writing source_xero,
-- with the source_xero_official.xo_* view contract repointed on top (0161)
-- so CubeCore keeps reading the same view columns. Table DDL below is the
-- current generator output for the Xero manifest and is byte-identical to
-- 0127; schema-level grants mirror 0138 (source_shopify), replacing the
-- source_xero grants from 0132 that died with the schema.

BEGIN;

CREATE SCHEMA IF NOT EXISTS source_xero;
COMMENT ON SCHEMA source_xero IS 'Typed Xero staging generated from the versioned field manifest.';
REVOKE ALL ON SCHEMA source_xero FROM PUBLIC;
GRANT USAGE ON SCHEMA source_xero TO ingest_rw, transform_rw, diagnostic_ro, semantic_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE albert_migration_owner IN SCHEMA source_xero GRANT SELECT, INSERT, UPDATE ON TABLES TO ingest_rw;
ALTER DEFAULT PRIVILEGES FOR ROLE albert_migration_owner IN SCHEMA source_xero GRANT SELECT ON TABLES TO transform_rw, diagnostic_ro, semantic_ro;

-- Generated from connector manifests. Do not hand-edit field columns.
-- Exact raw payloads remain in immutable object storage; these tables hold only typed projections.

CREATE TABLE IF NOT EXISTS "source_xero"."xero_1099_contacts" (
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
  "report_year" numeric(19,4),
  "contact_id" text,
  "box1" numeric(19,4),
  "box2" numeric(19,4),
  "box3" numeric(19,4),
  "box4" numeric(19,4),
  "box5" numeric(19,4),
  "box6" numeric(19,4),
  "box7" numeric(19,4),
  "box8" numeric(19,4),
  "box9" numeric(19,4),
  "box10" numeric(19,4),
  "box11" numeric(19,4),
  "box13" numeric(19,4),
  "box14" numeric(19,4),
  "name" text,
  "legal_name" text,
  "business_name" text,
  "federal_tax_id_type" text,
  "tax_id" text,
  "federal_tax_classification" text,
  "street_address" text,
  "city" text,
  "state" text,
  "zip" text,
  "email" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_1099_contacts" IS 'Typed xero xero_1099_contacts staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_1099_contacts_connection_watermark_idx"
  ON "source_xero"."xero_1099_contacts" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_1099_contacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_1099_contacts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_1099_contacts";
CREATE POLICY tenant_scope ON "source_xero"."xero_1099_contacts"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_1099_reports" (
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
  "report_year" numeric(19,4),
  "report_name" text,
  "report_type" text,
  "report_title" text,
  "report_date" date,
  "updated_date_utc" timestamptz,
  "contacts" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_1099_reports" IS 'Typed xero xero_1099_reports staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_1099_reports_connection_watermark_idx"
  ON "source_xero"."xero_1099_reports" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_1099_reports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_1099_reports" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_1099_reports";
CREATE POLICY tenant_scope ON "source_xero"."xero_1099_reports"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_accounts" (
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
  "bank_account_number" text,
  "status" text,
  "description" text,
  "bank_account_type" text,
  "currency_code" text,
  "tax_type" text,
  "enable_payments_to_account" boolean,
  "show_in_expense_claims" boolean,
  "class" text,
  "system_account" text,
  "reporting_code" text,
  "reporting_code_name" text,
  "has_attachments" boolean,
  "updated_date_utc" timestamptz,
  "add_to_watchlist" boolean,
  "validation_errors" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_accounts" IS 'Typed xero xero_accounts staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_accounts_connection_watermark_idx"
  ON "source_xero"."xero_accounts" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_accounts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_accounts";
CREATE POLICY tenant_scope ON "source_xero"."xero_accounts"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_asset_settings" (
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
  "singleton_id" text,
  "asset_number_prefix" text,
  "asset_number_sequence" text,
  "asset_start_date" date,
  "last_depreciation_date" date,
  "default_gain_on_disposal_account_id" text,
  "default_loss_on_disposal_account_id" text,
  "default_capital_gain_on_disposal_account_id" text,
  "opt_in_for_tax" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_asset_settings" IS 'Typed xero xero_asset_settings staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_asset_settings_connection_watermark_idx"
  ON "source_xero"."xero_asset_settings" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_asset_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_asset_settings" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_asset_settings";
CREATE POLICY tenant_scope ON "source_xero"."xero_asset_settings"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_asset_types" (
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
  "asset_type_id" text,
  "asset_type_name" text,
  "fixed_asset_account_id" text,
  "depreciation_expense_account_id" text,
  "accumulated_depreciation_account_id" text,
  "book_depreciation_setting_depreciation_method" text,
  "book_depreciation_setting_averaging_method" text,
  "book_depreciation_setting_depreciation_rate" numeric(19,4),
  "book_depreciation_setting_effective_life_years" numeric(19,4),
  "book_depreciation_setting_depreciation_calculation_method" text,
  "book_depreciation_setting_depreciable_object_id" text,
  "book_depreciation_setting_depreciable_object_type" text,
  "book_depreciation_setting_book_effective_date_of_change_id" text,
  "locks" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_asset_types" IS 'Typed xero xero_asset_types staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_asset_types_connection_watermark_idx"
  ON "source_xero"."xero_asset_types" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_asset_types" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_asset_types" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_asset_types";
CREATE POLICY tenant_scope ON "source_xero"."xero_asset_types"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_assets" (
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
  "asset_id" text,
  "asset_name" text,
  "asset_type_id" text,
  "asset_number" text,
  "purchase_date" date,
  "purchase_price" numeric(19,4),
  "disposal_date" date,
  "disposal_price" numeric(19,4),
  "asset_status" text,
  "warranty_expiry_date" date,
  "serial_number" text,
  "book_depreciation_setting_depreciation_method" text,
  "book_depreciation_setting_averaging_method" text,
  "book_depreciation_setting_depreciation_rate" numeric(19,4),
  "book_depreciation_setting_effective_life_years" numeric(19,4),
  "book_depreciation_setting_depreciation_calculation_method" text,
  "book_depreciation_setting_depreciable_object_id" text,
  "book_depreciation_setting_depreciable_object_type" text,
  "book_depreciation_setting_book_effective_date_of_change_id" text,
  "book_depreciation_detail_depreciation_start_date" date,
  "book_depreciation_detail_cost_limit" numeric(19,4),
  "book_depreciation_detail_residual_value" numeric(19,4),
  "book_depreciation_detail_prior_accum_depreciation_amount" numeric(19,4),
  "book_depreciation_detail_current_accum_depreciation_amount" numeric(19,4),
  "book_depreciation_detail_current_capital_gain" numeric(19,4),
  "book_depreciation_detail_current_gain_loss" numeric(19,4),
  "book_depreciation_detail_business_use_capital_gain" numeric(19,4),
  "book_depreciation_detail_business_use_current_gain_loss" numeric(19,4),
  "book_depreciation_detail_private_use_capital_gain" numeric(19,4),
  "book_depreciation_detail_private_use_current_gain_loss" numeric(19,4),
  "book_depreciation_detail_initial_deduction_percentage" numeric(19,4),
  "can_rollback" boolean,
  "accounting_book_value" numeric(19,4),
  "is_delete_enabled_for_date" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_assets" IS 'Typed xero xero_assets staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_assets_connection_watermark_idx"
  ON "source_xero"."xero_assets" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_assets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_assets" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_assets";
CREATE POLICY tenant_scope ON "source_xero"."xero_assets"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_attachments" (
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
  "parent_endpoint" text,
  "parent_id" text,
  "attachment_id" text,
  "file_name" text,
  "url" text,
  "mime_type" text,
  "content_length" numeric(19,4),
  "include_online" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_attachments" IS 'Typed xero xero_attachments staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_attachments_connection_watermark_idx"
  ON "source_xero"."xero_attachments" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_attachments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_attachments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_attachments";
CREATE POLICY tenant_scope ON "source_xero"."xero_attachments"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_bank_transaction_line_item_tracking" (
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
  "line_index" numeric(19,4),
  "tracking_index" numeric(19,4),
  "tracking_category_id" text,
  "tracking_option_id" text,
  "name" text,
  "option" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_bank_transaction_line_item_tracking" IS 'Typed xero xero_bank_transaction_line_item_tracking staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_bank_transaction_line_item_tracking_connection_watermark_idx"
  ON "source_xero"."xero_bank_transaction_line_item_tracking" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_bank_transaction_line_item_tracking" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_bank_transaction_line_item_tracking" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_bank_transaction_line_item_tracking";
CREATE POLICY tenant_scope ON "source_xero"."xero_bank_transaction_line_item_tracking"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_bank_transaction_line_items" (
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
  "line_index" numeric(19,4),
  "line_item_id" text,
  "description" text,
  "quantity" numeric(19,4),
  "unit_amount" numeric(19,4),
  "item_code" text,
  "account_code" text,
  "account_id" text,
  "tax_type" text,
  "tax_amount" numeric(19,4),
  "line_amount" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_bank_transaction_line_items" IS 'Typed xero xero_bank_transaction_line_items staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_bank_transaction_line_items_connection_watermark_idx"
  ON "source_xero"."xero_bank_transaction_line_items" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_bank_transaction_line_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_bank_transaction_line_items" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_bank_transaction_line_items";
CREATE POLICY tenant_scope ON "source_xero"."xero_bank_transaction_line_items"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_bank_transactions" (
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
  "contact_contact_id" text,
  "contact_name" text,
  "bank_account_account_id" text,
  "bank_account_code" text,
  "bank_account_name" text,
  "is_reconciled" boolean,
  "date" date,
  "reference" text,
  "currency_code" text,
  "currency_rate" numeric(19,4),
  "url" text,
  "status" text,
  "line_amount_types" text,
  "sub_total" numeric(19,4),
  "total_tax" numeric(19,4),
  "total" numeric(19,4),
  "prepayment_id" text,
  "overpayment_id" text,
  "updated_date_utc" timestamptz,
  "has_attachments" boolean,
  "status_attribute_string" text,
  "validation_errors" jsonb,
  "contact" jsonb,
  "line_items" jsonb,
  "bank_account" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_bank_transactions" IS 'Typed xero xero_bank_transactions staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_bank_transactions_connection_watermark_idx"
  ON "source_xero"."xero_bank_transactions" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_bank_transactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_bank_transactions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_bank_transactions";
CREATE POLICY tenant_scope ON "source_xero"."xero_bank_transactions"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_bank_transfers" (
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
  "bank_transfer_id" text,
  "from_bank_account_account_id" text,
  "from_bank_account_code" text,
  "from_bank_account_name" text,
  "to_bank_account_account_id" text,
  "to_bank_account_code" text,
  "to_bank_account_name" text,
  "amount" numeric(19,4),
  "date" date,
  "currency_rate" numeric(19,4),
  "from_bank_transaction_id" text,
  "to_bank_transaction_id" text,
  "from_is_reconciled" boolean,
  "to_is_reconciled" boolean,
  "reference" text,
  "has_attachments" boolean,
  "created_date_utc" timestamptz,
  "status" text,
  "from_tracking" jsonb,
  "to_tracking" jsonb,
  "validation_errors" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_bank_transfers" IS 'Typed xero xero_bank_transfers staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_bank_transfers_connection_watermark_idx"
  ON "source_xero"."xero_bank_transfers" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_bank_transfers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_bank_transfers" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_bank_transfers";
CREATE POLICY tenant_scope ON "source_xero"."xero_bank_transfers"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_batch_payments" (
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
  "batch_payment_id" text,
  "type" text,
  "status" text,
  "account_account_id" text,
  "date" date,
  "date_string" text,
  "amount" numeric(19,4),
  "total_amount" numeric(19,4),
  "is_reconciled" boolean,
  "reference" text,
  "particulars" text,
  "code" text,
  "details" text,
  "narrative" text,
  "payments" jsonb,
  "updated_date_utc" timestamptz,
  "validation_errors" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_batch_payments" IS 'Typed xero xero_batch_payments staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_batch_payments_connection_watermark_idx"
  ON "source_xero"."xero_batch_payments" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_batch_payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_batch_payments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_batch_payments";
CREATE POLICY tenant_scope ON "source_xero"."xero_batch_payments"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_branding_themes" (
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
  "branding_theme_id" text,
  "name" text,
  "logo_url" text,
  "type" text,
  "sort_order" numeric(19,4),
  "created_date_utc" timestamptz,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_branding_themes" IS 'Typed xero xero_branding_themes staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_branding_themes_connection_watermark_idx"
  ON "source_xero"."xero_branding_themes" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_branding_themes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_branding_themes" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_branding_themes";
CREATE POLICY tenant_scope ON "source_xero"."xero_branding_themes"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_budget_balances" (
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
  "budget_id" text,
  "account_id" text,
  "budget_balances" numeric(19,4),
  "period" text,
  "amount" numeric(19,4),
  "unit_amount" numeric(19,4),
  "notes" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_budget_balances" IS 'Typed xero xero_budget_balances staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_budget_balances_connection_watermark_idx"
  ON "source_xero"."xero_budget_balances" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_budget_balances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_budget_balances" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_budget_balances";
CREATE POLICY tenant_scope ON "source_xero"."xero_budget_balances"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_budget_lines" (
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
  "budget_id" text,
  "account_id" text,
  "account_code" text,
  "budget_lines" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_budget_lines" IS 'Typed xero xero_budget_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_budget_lines_connection_watermark_idx"
  ON "source_xero"."xero_budget_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_budget_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_budget_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_budget_lines";
CREATE POLICY tenant_scope ON "source_xero"."xero_budget_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_budget_tracking" (
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
  "budget_id" text,
  "tracking" numeric(19,4),
  "tracking_category_id" text,
  "tracking_option_id" text,
  "name" text,
  "option" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_budget_tracking" IS 'Typed xero xero_budget_tracking staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_budget_tracking_connection_watermark_idx"
  ON "source_xero"."xero_budget_tracking" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_budget_tracking" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_budget_tracking" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_budget_tracking";
CREATE POLICY tenant_scope ON "source_xero"."xero_budget_tracking"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_budgets" (
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
  "budget_id" text,
  "type" text,
  "description" text,
  "updated_date_utc" timestamptz,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_budgets" IS 'Typed xero xero_budgets staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_budgets_connection_watermark_idx"
  ON "source_xero"."xero_budgets" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_budgets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_budgets" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_budgets";
CREATE POLICY tenant_scope ON "source_xero"."xero_budgets"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_connections" (
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
  "connection_tenant_id" text,
  "auth_event_id" text,
  "tenant_type" text,
  "tenant_name" text,
  "created_date_utc" timestamptz,
  "updated_date_utc" timestamptz,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_connections" IS 'Typed xero xero_connections staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_connections_connection_watermark_idx"
  ON "source_xero"."xero_connections" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_connections" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_connections" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_connections";
CREATE POLICY tenant_scope ON "source_xero"."xero_connections"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_contact_addresses" (
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
  "address_type" text,
  "address_line1" text,
  "address_line2" text,
  "address_line3" text,
  "address_line4" text,
  "city" text,
  "region" text,
  "postal_code" text,
  "country" text,
  "attention_to" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_contact_addresses" IS 'Typed xero xero_contact_addresses staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_contact_addresses_connection_watermark_idx"
  ON "source_xero"."xero_contact_addresses" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_contact_addresses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_contact_addresses" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_contact_addresses";
CREATE POLICY tenant_scope ON "source_xero"."xero_contact_addresses"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_contact_balances" (
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
  "accounts_receivable_outstanding" numeric(19,4),
  "accounts_receivable_overdue" numeric(19,4),
  "accounts_payable_outstanding" numeric(19,4),
  "accounts_payable_overdue" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_contact_balances" IS 'Typed xero xero_contact_balances staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_contact_balances_connection_watermark_idx"
  ON "source_xero"."xero_contact_balances" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_contact_balances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_contact_balances" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_contact_balances";
CREATE POLICY tenant_scope ON "source_xero"."xero_contact_balances"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_contact_cis_settings" (
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
  "cis_enabled" boolean,
  "rate" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_contact_cis_settings" IS 'Typed xero xero_contact_cis_settings staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_contact_cis_settings_connection_watermark_idx"
  ON "source_xero"."xero_contact_cis_settings" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_contact_cis_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_contact_cis_settings" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_contact_cis_settings";
CREATE POLICY tenant_scope ON "source_xero"."xero_contact_cis_settings"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_contact_group_members" (
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
  "contact_group_id" text,
  "contact_id" text,
  "name" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_contact_group_members" IS 'Typed xero xero_contact_group_members staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_contact_group_members_connection_watermark_idx"
  ON "source_xero"."xero_contact_group_members" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_contact_group_members" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_contact_group_members" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_contact_group_members";
CREATE POLICY tenant_scope ON "source_xero"."xero_contact_group_members"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_contact_groups" (
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
  "contact_group_id" text,
  "name" text,
  "status" text,
  "contacts" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_contact_groups" IS 'Typed xero xero_contact_groups staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_contact_groups_connection_watermark_idx"
  ON "source_xero"."xero_contact_groups" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_contact_groups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_contact_groups" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_contact_groups";
CREATE POLICY tenant_scope ON "source_xero"."xero_contact_groups"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_contact_persons" (
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
  "person_ordinal" numeric(19,4),
  "first_name" text,
  "last_name" text,
  "email_address" text,
  "include_in_emails" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_contact_persons" IS 'Typed xero xero_contact_persons staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_contact_persons_connection_watermark_idx"
  ON "source_xero"."xero_contact_persons" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_contact_persons" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_contact_persons" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_contact_persons";
CREATE POLICY tenant_scope ON "source_xero"."xero_contact_persons"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_contact_phones" (
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
  "phone_type" text,
  "phone_number" text,
  "phone_area_code" text,
  "phone_country_code" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_contact_phones" IS 'Typed xero xero_contact_phones staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_contact_phones_connection_watermark_idx"
  ON "source_xero"."xero_contact_phones" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_contact_phones" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_contact_phones" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_contact_phones";
CREATE POLICY tenant_scope ON "source_xero"."xero_contact_phones"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_contacts" (
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
  "merged_to_contact_id" text,
  "contact_number" text,
  "account_number" text,
  "contact_status" text,
  "name" text,
  "first_name" text,
  "last_name" text,
  "company_number" text,
  "email_address" text,
  "bank_account_details" text,
  "tax_number" text,
  "tax_number_type" text,
  "accounts_receivable_tax_type" text,
  "accounts_payable_tax_type" text,
  "is_supplier" boolean,
  "is_customer" boolean,
  "sales_default_line_amount_type" text,
  "purchases_default_line_amount_type" text,
  "default_currency" text,
  "xero_network_key" text,
  "sales_default_account_code" text,
  "purchases_default_account_code" text,
  "sales_tracking_categories" jsonb,
  "purchases_tracking_categories" jsonb,
  "tracking_category_name" text,
  "tracking_category_option" text,
  "payment_terms" jsonb,
  "updated_date_utc" timestamptz,
  "contact_groups" jsonb,
  "website" text,
  "branding_theme_branding_theme_id" text,
  "batch_payments" jsonb,
  "balances" jsonb,
  "discount" numeric(19,4),
  "attachments" jsonb,
  "has_attachments" boolean,
  "validation_errors" jsonb,
  "has_validation_errors" boolean,
  "status_attribute_string" text,
  "addresses" jsonb,
  "phones" jsonb,
  "contact_persons" jsonb,
  "branding_theme" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_contacts" IS 'Typed xero xero_contacts staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_contacts_connection_watermark_idx"
  ON "source_xero"."xero_contacts" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_contacts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_contacts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_contacts";
CREATE POLICY tenant_scope ON "source_xero"."xero_contacts"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_credit_note_allocations" (
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
  "allocations" numeric(19,4),
  "allocations_invoice_invoice_id" text,
  "allocations_amount" numeric(19,4),
  "allocations_date" date,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_credit_note_allocations" IS 'Typed xero xero_credit_note_allocations staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_credit_note_allocations_connection_watermark_idx"
  ON "source_xero"."xero_credit_note_allocations" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_credit_note_allocations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_credit_note_allocations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_credit_note_allocations";
CREATE POLICY tenant_scope ON "source_xero"."xero_credit_note_allocations"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_credit_note_line_items" (
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
  "line_items_line_item_id" text,
  "credit_note_id" text,
  "line_items" numeric(19,4),
  "line_items_description" text,
  "line_items_quantity" numeric(19,4),
  "line_items_unit_amount" numeric(19,4),
  "line_items_line_amount" numeric(19,4),
  "line_items_tax_type" text,
  "line_items_tax_amount" numeric(19,4),
  "line_items_account_code" text,
  "line_items_account_id" text,
  "line_items_item_code" text,
  "line_items_item_item_id" text,
  "line_items_item" jsonb,
  "line_items_tracking" jsonb,
  "line_items_discount_rate" numeric(19,4),
  "line_items_discount_amount" numeric(19,4),
  "line_items_repeating_invoice_id" text,
  "line_items_taxability" text,
  "line_items_sales_tax_code_id" numeric(19,4),
  "line_items_tax_breakdown" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_credit_note_line_items" IS 'Typed xero xero_credit_note_line_items staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_credit_note_line_items_connection_watermark_idx"
  ON "source_xero"."xero_credit_note_line_items" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_credit_note_line_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_credit_note_line_items" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_credit_note_line_items";
CREATE POLICY tenant_scope ON "source_xero"."xero_credit_note_line_items"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_credit_notes" (
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
  "type" text,
  "status" text,
  "contact_contact_id" text,
  "contact_name" text,
  "credit_note_number" text,
  "reference" text,
  "date" date,
  "due_date" date,
  "line_amount_types" text,
  "currency_code" text,
  "currency_rate" numeric(19,4),
  "sub_total" numeric(19,4),
  "total_tax" numeric(19,4),
  "total" numeric(19,4),
  "remaining_credit" numeric(19,4),
  "applied_amount" numeric(19,4),
  "fully_paid_on_date" date,
  "cis_deduction" numeric(19,4),
  "cis_rate" numeric(19,4),
  "sent_to_contact" boolean,
  "branding_theme_id" text,
  "has_attachments" boolean,
  "has_errors" boolean,
  "status_attribute_string" text,
  "updated_date_utc" timestamptz,
  "updated_date_utc_string" text,
  "payments" jsonb,
  "validation_errors" jsonb,
  "warnings" jsonb,
  "invoice_addresses" jsonb,
  "contact" jsonb,
  "line_items" jsonb,
  "allocations" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_credit_notes" IS 'Typed xero xero_credit_notes staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_credit_notes_connection_watermark_idx"
  ON "source_xero"."xero_credit_notes" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_credit_notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_credit_notes" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_credit_notes";
CREATE POLICY tenant_scope ON "source_xero"."xero_credit_notes"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_currencies" (
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
  "code" text,
  "description" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_currencies" IS 'Typed xero xero_currencies staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_currencies_connection_watermark_idx"
  ON "source_xero"."xero_currencies" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_currencies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_currencies" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_currencies";
CREATE POLICY tenant_scope ON "source_xero"."xero_currencies"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_expense_claim_payments" (
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
  "expense_claim_id" text,
  "payment_ordinal" numeric(19,4),
  "date" date,
  "amount" numeric(19,4),
  "reference" text,
  "status" text,
  "payment_type" text,
  "updated_date_utc" timestamptz,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_expense_claim_payments" IS 'Typed xero xero_expense_claim_payments staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_expense_claim_payments_connection_watermark_idx"
  ON "source_xero"."xero_expense_claim_payments" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_expense_claim_payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_expense_claim_payments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_expense_claim_payments";
CREATE POLICY tenant_scope ON "source_xero"."xero_expense_claim_payments"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_expense_claim_receipts" (
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
  "expense_claim_id" text,
  "receipt_id" text,
  "receipt_ordinal" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_expense_claim_receipts" IS 'Typed xero xero_expense_claim_receipts staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_expense_claim_receipts_connection_watermark_idx"
  ON "source_xero"."xero_expense_claim_receipts" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_expense_claim_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_expense_claim_receipts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_expense_claim_receipts";
CREATE POLICY tenant_scope ON "source_xero"."xero_expense_claim_receipts"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_expense_claims" (
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
  "expense_claim_id" text,
  "status" text,
  "user_user_id" text,
  "total" numeric(19,4),
  "amount_due" numeric(19,4),
  "amount_paid" numeric(19,4),
  "payment_due_date" date,
  "reporting_date" date,
  "receipt_id" text,
  "updated_date_utc" timestamptz,
  "receipts" jsonb,
  "payments" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_expense_claims" IS 'Typed xero xero_expense_claims staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_expense_claims_connection_watermark_idx"
  ON "source_xero"."xero_expense_claims" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_expense_claims" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_expense_claims" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_expense_claims";
CREATE POLICY tenant_scope ON "source_xero"."xero_expense_claims"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_file_associations" (
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
  "file_id" text,
  "object_id" text,
  "object_group" text,
  "object_type" text,
  "send_with_object" boolean,
  "name" text,
  "size" numeric(19,4),
  "created_date_utc" timestamptz,
  "association_date_utc" timestamptz,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_file_associations" IS 'Typed xero xero_file_associations staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_file_associations_connection_watermark_idx"
  ON "source_xero"."xero_file_associations" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_file_associations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_file_associations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_file_associations";
CREATE POLICY tenant_scope ON "source_xero"."xero_file_associations"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_files" (
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
  "folder_id" text,
  "name" text,
  "mime_type" text,
  "size" numeric(19,4),
  "created_date_utc" timestamptz,
  "updated_date_utc" timestamptz,
  "user_id" text,
  "user_name" text,
  "user_first_name" text,
  "user_last_name" text,
  "user_full_name" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_files" IS 'Typed xero xero_files staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_files_connection_watermark_idx"
  ON "source_xero"."xero_files" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_files" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_files" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_files";
CREATE POLICY tenant_scope ON "source_xero"."xero_files"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_folders" (
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
  "file_count" numeric(19,4),
  "email" text,
  "is_inbox" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_folders" IS 'Typed xero xero_folders staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_folders_connection_watermark_idx"
  ON "source_xero"."xero_folders" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_folders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_folders" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_folders";
CREATE POLICY tenant_scope ON "source_xero"."xero_folders"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_history_records" (
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
  "parent_endpoint" text,
  "parent_id" text,
  "ordinal" numeric(19,4),
  "details" text,
  "changes" text,
  "user" text,
  "date_utc" timestamptz,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_history_records" IS 'Typed xero xero_history_records staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_history_records_connection_watermark_idx"
  ON "source_xero"."xero_history_records" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_history_records" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_history_records" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_history_records";
CREATE POLICY tenant_scope ON "source_xero"."xero_history_records"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_invoice_line_items" (
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
  "line_items_line_item_id" text,
  "invoice_id" text,
  "line_items" numeric(19,4),
  "line_items_description" text,
  "line_items_quantity" numeric(19,4),
  "line_items_unit_amount" numeric(19,4),
  "line_items_line_amount" numeric(19,4),
  "line_items_tax_type" text,
  "line_items_tax_amount" numeric(19,4),
  "line_items_account_code" text,
  "line_items_account_id" text,
  "line_items_item_code" text,
  "line_items_item_item_id" text,
  "line_items_item" jsonb,
  "line_items_tracking" jsonb,
  "line_items_discount_rate" numeric(19,4),
  "line_items_discount_amount" numeric(19,4),
  "line_items_repeating_invoice_id" text,
  "line_items_taxability" text,
  "line_items_sales_tax_code_id" numeric(19,4),
  "line_items_tax_breakdown" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_invoice_line_items" IS 'Typed xero xero_invoice_line_items staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_invoice_line_items_connection_watermark_idx"
  ON "source_xero"."xero_invoice_line_items" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_invoice_line_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_invoice_line_items" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_invoice_line_items";
CREATE POLICY tenant_scope ON "source_xero"."xero_invoice_line_items"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_invoice_reminders" (
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
  "settings_key" text,
  "enabled" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_invoice_reminders" IS 'Typed xero xero_invoice_reminders staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_invoice_reminders_connection_watermark_idx"
  ON "source_xero"."xero_invoice_reminders" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_invoice_reminders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_invoice_reminders" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_invoice_reminders";
CREATE POLICY tenant_scope ON "source_xero"."xero_invoice_reminders"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_invoices" (
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
  "type" text,
  "status" text,
  "contact_contact_id" text,
  "contact_name" text,
  "invoice_number" text,
  "reference" text,
  "date" date,
  "due_date" date,
  "line_amount_types" text,
  "currency_code" text,
  "currency_rate" numeric(19,4),
  "sub_total" numeric(19,4),
  "total_tax" numeric(19,4),
  "total" numeric(19,4),
  "total_discount" numeric(19,4),
  "amount_due" numeric(19,4),
  "amount_paid" numeric(19,4),
  "amount_credited" numeric(19,4),
  "fully_paid_on_date" date,
  "expected_payment_date" date,
  "planned_payment_date" date,
  "sent_to_contact" boolean,
  "cis_deduction" numeric(19,4),
  "cis_rate" numeric(19,4),
  "is_discounted" boolean,
  "has_attachments" boolean,
  "has_errors" boolean,
  "status_attribute_string" text,
  "url" text,
  "branding_theme_id" text,
  "repeating_invoice_id" text,
  "updated_date_utc" timestamptz,
  "updated_date_utc_string" text,
  "payments" jsonb,
  "prepayments" jsonb,
  "overpayments" jsonb,
  "credit_notes" jsonb,
  "attachments" jsonb,
  "validation_errors" jsonb,
  "warnings" jsonb,
  "invoice_addresses" jsonb,
  "contact" jsonb,
  "line_items" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_invoices" IS 'Typed xero xero_invoices staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_invoices_connection_watermark_idx"
  ON "source_xero"."xero_invoices" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_invoices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_invoices" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_invoices";
CREATE POLICY tenant_scope ON "source_xero"."xero_invoices"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_items" (
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
  "code" text,
  "name" text,
  "description" text,
  "purchase_description" text,
  "is_sold" boolean,
  "is_purchased" boolean,
  "is_tracked_as_inventory" boolean,
  "inventory_asset_account_code" text,
  "sales_details_unit_price" numeric(19,4),
  "sales_details_account_code" text,
  "sales_details_tax_type" text,
  "purchase_details_unit_price" numeric(19,4),
  "purchase_details_account_code" text,
  "purchase_details_cogs_account_code" text,
  "purchase_details_tax_type" text,
  "quantity_on_hand" numeric(19,4),
  "total_cost_pool" numeric(19,4),
  "status_attribute_string" text,
  "updated_date_utc" timestamptz,
  "validation_errors" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_items" IS 'Typed xero xero_items staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_items_connection_watermark_idx"
  ON "source_xero"."xero_items" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_items" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_items";
CREATE POLICY tenant_scope ON "source_xero"."xero_items"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_journal_line_tracking" (
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
  "journal_lines_journal_line_id" text,
  "journal_id" text,
  "journal_lines_tracking_categories" numeric(19,4),
  "tracking_category_id" text,
  "tracking_option_id" text,
  "name" text,
  "option" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_journal_line_tracking" IS 'Typed xero xero_journal_line_tracking staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_journal_line_tracking_connection_watermark_idx"
  ON "source_xero"."xero_journal_line_tracking" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_journal_line_tracking" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_journal_line_tracking" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_journal_line_tracking";
CREATE POLICY tenant_scope ON "source_xero"."xero_journal_line_tracking"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_journal_lines" (
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
  "journal_line_id" text,
  "journal_id" text,
  "journal_lines" numeric(19,4),
  "account_id" text,
  "account_code" text,
  "account_type" text,
  "account_name" text,
  "description" text,
  "net_amount" numeric(19,4),
  "gross_amount" numeric(19,4),
  "tax_amount" numeric(19,4),
  "tax_type" text,
  "tax_name" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_journal_lines" IS 'Typed xero xero_journal_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_journal_lines_connection_watermark_idx"
  ON "source_xero"."xero_journal_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_journal_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_journal_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_journal_lines";
CREATE POLICY tenant_scope ON "source_xero"."xero_journal_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_journals" (
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
  "journal_date" date,
  "journal_number" numeric(19,4),
  "created_date_utc" timestamptz,
  "reference" text,
  "source_id" text,
  "source_type" text,
  "journal_lines" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_journals" IS 'Typed xero xero_journals staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_journals_connection_watermark_idx"
  ON "source_xero"."xero_journals" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_journals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_journals" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_journals";
CREATE POLICY tenant_scope ON "source_xero"."xero_journals"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_linked_transactions" (
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
  "linked_transaction_id" text,
  "type" text,
  "status" text,
  "source_transaction_id" text,
  "source_line_item_id" text,
  "source_transaction_type_code" text,
  "target_transaction_id" text,
  "target_line_item_id" text,
  "contact_id" text,
  "updated_date_utc" timestamptz,
  "validation_errors" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_linked_transactions" IS 'Typed xero xero_linked_transactions staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_linked_transactions_connection_watermark_idx"
  ON "source_xero"."xero_linked_transactions" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_linked_transactions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_linked_transactions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_linked_transactions";
CREATE POLICY tenant_scope ON "source_xero"."xero_linked_transactions"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_manual_journal_line_tracking" (
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
  "line_ordinal" numeric(19,4),
  "journal_lines_tracking" numeric(19,4),
  "tracking_category_id" text,
  "tracking_option_id" text,
  "name" text,
  "option" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_manual_journal_line_tracking" IS 'Typed xero xero_manual_journal_line_tracking staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_manual_journal_line_tracking_connection_watermark_idx"
  ON "source_xero"."xero_manual_journal_line_tracking" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_manual_journal_line_tracking" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_manual_journal_line_tracking" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_manual_journal_line_tracking";
CREATE POLICY tenant_scope ON "source_xero"."xero_manual_journal_line_tracking"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_manual_journal_lines" (
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
  "journal_lines" numeric(19,4),
  "line_amount" numeric(19,4),
  "account_code" text,
  "account_id" text,
  "description" text,
  "tax_type" text,
  "tax_amount" numeric(19,4),
  "is_blank" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_manual_journal_lines" IS 'Typed xero xero_manual_journal_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_manual_journal_lines_connection_watermark_idx"
  ON "source_xero"."xero_manual_journal_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_manual_journal_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_manual_journal_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_manual_journal_lines";
CREATE POLICY tenant_scope ON "source_xero"."xero_manual_journal_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_manual_journals" (
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
  "narration" text,
  "date" date,
  "status" text,
  "line_amount_types" text,
  "url" text,
  "show_on_cash_basis_reports" boolean,
  "has_attachments" boolean,
  "updated_date_utc" timestamptz,
  "status_attribute_string" text,
  "warnings" jsonb,
  "validation_errors" jsonb,
  "attachments" jsonb,
  "journal_lines" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_manual_journals" IS 'Typed xero xero_manual_journals staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_manual_journals_connection_watermark_idx"
  ON "source_xero"."xero_manual_journals" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_manual_journals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_manual_journals" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_manual_journals";
CREATE POLICY tenant_scope ON "source_xero"."xero_manual_journals"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_online_invoices" (
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
  "online_invoice_url" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_online_invoices" IS 'Typed xero xero_online_invoices staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_online_invoices_connection_watermark_idx"
  ON "source_xero"."xero_online_invoices" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_online_invoices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_online_invoices" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_online_invoices";
CREATE POLICY tenant_scope ON "source_xero"."xero_online_invoices"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_organisation_actions" (
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
  "status" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_organisation_actions" IS 'Typed xero xero_organisation_actions staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_organisation_actions_connection_watermark_idx"
  ON "source_xero"."xero_organisation_actions" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_organisation_actions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_organisation_actions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_organisation_actions";
CREATE POLICY tenant_scope ON "source_xero"."xero_organisation_actions"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_organisation_addresses" (
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
  "address_type" text,
  "address_line1" text,
  "address_line2" text,
  "address_line3" text,
  "address_line4" text,
  "city" text,
  "region" text,
  "postal_code" text,
  "country" text,
  "attention_to" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_organisation_addresses" IS 'Typed xero xero_organisation_addresses staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_organisation_addresses_connection_watermark_idx"
  ON "source_xero"."xero_organisation_addresses" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_organisation_addresses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_organisation_addresses" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_organisation_addresses";
CREATE POLICY tenant_scope ON "source_xero"."xero_organisation_addresses"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_organisation_cis_settings" (
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
  "cis_contractor_enabled" boolean,
  "cis_sub_contractor_enabled" boolean,
  "rate" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_organisation_cis_settings" IS 'Typed xero xero_organisation_cis_settings staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_organisation_cis_settings_connection_watermark_idx"
  ON "source_xero"."xero_organisation_cis_settings" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_organisation_cis_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_organisation_cis_settings" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_organisation_cis_settings";
CREATE POLICY tenant_scope ON "source_xero"."xero_organisation_cis_settings"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_organisation_external_links" (
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
  "ordinal" numeric(19,4),
  "link_type" text,
  "url" text,
  "description" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_organisation_external_links" IS 'Typed xero xero_organisation_external_links staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_organisation_external_links_connection_watermark_idx"
  ON "source_xero"."xero_organisation_external_links" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_organisation_external_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_organisation_external_links" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_organisation_external_links";
CREATE POLICY tenant_scope ON "source_xero"."xero_organisation_external_links"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_organisation_payment_terms" (
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
  "term_scope" text,
  "bills_day" numeric(19,4),
  "bills_type" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_organisation_payment_terms" IS 'Typed xero xero_organisation_payment_terms staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_organisation_payment_terms_connection_watermark_idx"
  ON "source_xero"."xero_organisation_payment_terms" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_organisation_payment_terms" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_organisation_payment_terms" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_organisation_payment_terms";
CREATE POLICY tenant_scope ON "source_xero"."xero_organisation_payment_terms"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_organisation_phones" (
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
  "phone_type" text,
  "phone_number" text,
  "phone_area_code" text,
  "phone_country_code" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_organisation_phones" IS 'Typed xero xero_organisation_phones staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_organisation_phones_connection_watermark_idx"
  ON "source_xero"."xero_organisation_phones" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_organisation_phones" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_organisation_phones" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_organisation_phones";
CREATE POLICY tenant_scope ON "source_xero"."xero_organisation_phones"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_organisations" (
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
  "api_key" text,
  "name" text,
  "legal_name" text,
  "pays_tax" boolean,
  "version" text,
  "organisation_type" text,
  "base_currency" text,
  "country_code" text,
  "is_demo_company" boolean,
  "organisation_status" text,
  "registration_number" text,
  "employer_identification_number" text,
  "tax_number" text,
  "financial_year_end_day" numeric(19,4),
  "financial_year_end_month" numeric(19,4),
  "sales_tax_basis" text,
  "sales_tax_period" text,
  "default_sales_tax" text,
  "default_purchases_tax" text,
  "period_lock_date" date,
  "end_of_year_lock_date" date,
  "created_date_utc" timestamptz,
  "timezone" text,
  "organisation_entity_type" text,
  "short_code" text,
  "class" text,
  "edition" text,
  "line_of_business" text,
  "addresses" jsonb,
  "phones" jsonb,
  "external_links" jsonb,
  "payment_terms" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_organisations" IS 'Typed xero xero_organisations staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_organisations_connection_watermark_idx"
  ON "source_xero"."xero_organisations" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_organisations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_organisations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_organisations";
CREATE POLICY tenant_scope ON "source_xero"."xero_organisations"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_overpayment_allocations" (
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
  "overpayment_overpayment_id" text,
  "allocation_ordinal" numeric(19,4),
  "allocation_id" text,
  "invoice_invoice_id" text,
  "amount" numeric(19,4),
  "date" date,
  "is_deleted" boolean,
  "status_attribute_string" text,
  "validation_errors" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_overpayment_allocations" IS 'Typed xero xero_overpayment_allocations staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_overpayment_allocations_connection_watermark_idx"
  ON "source_xero"."xero_overpayment_allocations" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_overpayment_allocations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_overpayment_allocations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_overpayment_allocations";
CREATE POLICY tenant_scope ON "source_xero"."xero_overpayment_allocations"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_overpayments" (
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
  "overpayment_id" text,
  "type" text,
  "contact_contact_id" text,
  "date" date,
  "status" text,
  "line_amount_types" text,
  "line_items" jsonb,
  "sub_total" numeric(19,4),
  "total_tax" numeric(19,4),
  "total" numeric(19,4),
  "currency_code" text,
  "currency_rate" numeric(19,4),
  "remaining_credit" numeric(19,4),
  "applied_amount" numeric(19,4),
  "allocations" jsonb,
  "payments" jsonb,
  "reference" text,
  "has_attachments" boolean,
  "attachments" jsonb,
  "updated_date_utc" timestamptz,
  "updated_date_utc_string" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_overpayments" IS 'Typed xero xero_overpayments staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_overpayments_connection_watermark_idx"
  ON "source_xero"."xero_overpayments" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_overpayments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_overpayments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_overpayments";
CREATE POLICY tenant_scope ON "source_xero"."xero_overpayments"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payment_services" (
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
  "payment_service_id" text,
  "payment_service_name" text,
  "payment_service_url" text,
  "pay_now_text" text,
  "payment_service_type" text,
  "validation_errors" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payment_services" IS 'Typed xero xero_payment_services staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payment_services_connection_watermark_idx"
  ON "source_xero"."xero_payment_services" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payment_services" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payment_services" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payment_services";
CREATE POLICY tenant_scope ON "source_xero"."xero_payment_services"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payments" (
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
  "payment_type" text,
  "status" text,
  "date" date,
  "amount" numeric(19,4),
  "bank_amount" numeric(19,4),
  "currency_rate" numeric(19,4),
  "reference" text,
  "is_reconciled" boolean,
  "account_account_id" text,
  "code" text,
  "invoice_invoice_id" text,
  "invoice_number" text,
  "credit_note_credit_note_id" text,
  "credit_note_number" text,
  "prepayment_prepayment_id" text,
  "overpayment_overpayment_id" text,
  "batch_payment_id" text,
  "batch_payment" jsonb,
  "bank_account_number" text,
  "particulars" text,
  "details" text,
  "has_account" boolean,
  "has_validation_errors" boolean,
  "status_attribute_string" text,
  "validation_errors" jsonb,
  "warnings" jsonb,
  "updated_date_utc" timestamptz,
  "updated_date_utc_string" text,
  "invoice" jsonb,
  "credit_note" jsonb,
  "prepayment" jsonb,
  "overpayment" jsonb,
  "account" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payments" IS 'Typed xero xero_payments staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payments_connection_watermark_idx"
  ON "source_xero"."xero_payments" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payments";
CREATE POLICY tenant_scope ON "source_xero"."xero_payments"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_au_deduction_types" (
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
  "deduction_type_id" text,
  "name" text,
  "account_code" text,
  "reduces_tax" boolean,
  "reduces_super" boolean,
  "is_exempt_from_w1" boolean,
  "updated_date_utc" timestamptz,
  "deduction_category" text,
  "current_record" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_au_deduction_types" IS 'Typed xero xero_payroll_au_deduction_types staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_au_deduction_types_connection_watermark_idx"
  ON "source_xero"."xero_payroll_au_deduction_types" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_au_deduction_types" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_au_deduction_types" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_au_deduction_types";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_au_deduction_types"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_au_earnings_rates" (
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
  "earnings_rate_id" text,
  "name" text,
  "account_code" text,
  "type_of_units" text,
  "is_exempt_from_tax" boolean,
  "is_exempt_from_super" boolean,
  "is_reportable_as_w1" boolean,
  "is_qualifying_earnings" boolean,
  "allowance_contributes_to_annual_leave_rate" boolean,
  "allowance_contributes_to_overtime_rate" boolean,
  "earnings_type" text,
  "rate_type" text,
  "rate_per_unit" numeric(19,4),
  "multiplier" numeric(19,4),
  "accrue_leave" boolean,
  "amount" numeric(19,4),
  "employment_termination_payment_type" text,
  "updated_date_utc" timestamptz,
  "current_record" boolean,
  "allowance_type" text,
  "allowance_category" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_au_earnings_rates" IS 'Typed xero xero_payroll_au_earnings_rates staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_au_earnings_rates_connection_watermark_idx"
  ON "source_xero"."xero_payroll_au_earnings_rates" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_au_earnings_rates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_au_earnings_rates" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_au_earnings_rates";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_au_earnings_rates"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_au_employee_bank_accounts" (
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
  "line_index" numeric(19,4),
  "statement_text" text,
  "account_name" text,
  "bsb" text,
  "account_number" text,
  "remainder" boolean,
  "amount" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_au_employee_bank_accounts" IS 'Typed xero xero_payroll_au_employee_bank_accounts staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_au_employee_bank_accounts_connection_watermark_idx"
  ON "source_xero"."xero_payroll_au_employee_bank_accounts" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_au_employee_bank_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_au_employee_bank_accounts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_au_employee_bank_accounts";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_au_employee_bank_accounts"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_au_employee_home_addresses" (
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
  "address_line1" text,
  "address_line2" text,
  "city" text,
  "region" text,
  "postal_code" text,
  "country" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_au_employee_home_addresses" IS 'Typed xero xero_payroll_au_employee_home_addresses staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_au_employee_home_addresses_connection_watermark_idx"
  ON "source_xero"."xero_payroll_au_employee_home_addresses" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_au_employee_home_addresses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_au_employee_home_addresses" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_au_employee_home_addresses";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_au_employee_home_addresses"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_au_employee_leave_balances" (
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
  "leave_type_id" text,
  "leave_name" text,
  "number_of_units" numeric(19,4),
  "type_of_units" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_au_employee_leave_balances" IS 'Typed xero xero_payroll_au_employee_leave_balances staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_au_employee_leave_balances_connection_watermark_idx"
  ON "source_xero"."xero_payroll_au_employee_leave_balances" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_au_employee_leave_balances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_au_employee_leave_balances" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_au_employee_leave_balances";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_au_employee_leave_balances"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_au_employee_super_memberships" (
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
  "super_membership_id" text,
  "employee_id" text,
  "super_fund_id" text,
  "employee_number" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_au_employee_super_memberships" IS 'Typed xero xero_payroll_au_employee_super_memberships staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_au_employee_super_memberships_connection_watermark_idx"
  ON "source_xero"."xero_payroll_au_employee_super_memberships" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_au_employee_super_memberships" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_au_employee_super_memberships" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_au_employee_super_memberships";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_au_employee_super_memberships"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_au_employee_tax_declarations" (
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
  "employment_basis" text,
  "tfn_exemption_type" text,
  "tax_file_number" text,
  "abn" text,
  "australian_resident_for_tax_purposes" boolean,
  "residency_status" text,
  "tax_scale_type" text,
  "work_condition" text,
  "senior_marital_status" text,
  "tax_free_threshold_claimed" boolean,
  "tax_offset_estimated_amount" numeric(19,4),
  "has_help_debt" boolean,
  "has_sfss_debt" boolean,
  "has_trade_support_loan_debt" boolean,
  "upward_variation_tax_withholding_amount" numeric(19,4),
  "eligible_to_receive_leave_loading" boolean,
  "approved_withholding_variation_percentage" numeric(19,4),
  "has_student_startup_loan" boolean,
  "has_loan_or_student_debt" boolean,
  "updated_date_utc" timestamptz,
  "include_leave_loading_in_qualifying_earnings" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_au_employee_tax_declarations" IS 'Typed xero xero_payroll_au_employee_tax_declarations staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_au_employee_tax_declarations_connection_watermark_idx"
  ON "source_xero"."xero_payroll_au_employee_tax_declarations" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_au_employee_tax_declarations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_au_employee_tax_declarations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_au_employee_tax_declarations";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_au_employee_tax_declarations"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_au_employees" (
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
  "middle_names" text,
  "title" text,
  "date_of_birth" date,
  "gender" text,
  "email" text,
  "phone" text,
  "mobile" text,
  "twitter_user_name" text,
  "start_date" date,
  "termination_date" date,
  "termination_reason" text,
  "status" text,
  "job_title" text,
  "classification" text,
  "employee_group_name" text,
  "is_authorised_to_approve_leave" boolean,
  "is_authorised_to_approve_timesheets" boolean,
  "ordinary_earnings_rate_id" text,
  "payroll_calendar_id" text,
  "income_type" text,
  "employment_type" text,
  "country_of_residence" text,
  "is_stp2_qualified" boolean,
  "updated_date_utc" timestamptz,
  "validation_errors" jsonb,
  "home_address" jsonb,
  "bank_accounts" jsonb,
  "pay_template" jsonb,
  "opening_balances" jsonb,
  "tax_declaration" jsonb,
  "leave_balances" jsonb,
  "super_memberships" jsonb,
  "earnings_lines" jsonb,
  "deduction_lines" jsonb,
  "super_lines" jsonb,
  "reimbursement_lines" jsonb,
  "leave_lines" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_au_employees" IS 'Typed xero xero_payroll_au_employees staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_au_employees_connection_watermark_idx"
  ON "source_xero"."xero_payroll_au_employees" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_au_employees" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_au_employees" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_au_employees";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_au_employees"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_au_leave_applications" (
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
  "leave_application_id" text,
  "employee_id" text,
  "leave_type_id" text,
  "title" text,
  "start_date" date,
  "end_date" date,
  "description" text,
  "pay_out_type" text,
  "updated_date_utc" timestamptz,
  "validation_errors" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_au_leave_applications" IS 'Typed xero xero_payroll_au_leave_applications staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_au_leave_applications_connection_watermark_idx"
  ON "source_xero"."xero_payroll_au_leave_applications" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_au_leave_applications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_au_leave_applications" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_au_leave_applications";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_au_leave_applications"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_au_leave_periods" (
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
  "leave_application_id" text,
  "leave_periods" numeric(19,4),
  "leave_periods_pay_period_start_date" date,
  "leave_periods_pay_period_end_date" date,
  "leave_periods_number_of_units" numeric(19,4),
  "leave_periods_leave_period_status" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_au_leave_periods" IS 'Typed xero xero_payroll_au_leave_periods staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_au_leave_periods_connection_watermark_idx"
  ON "source_xero"."xero_payroll_au_leave_periods" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_au_leave_periods" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_au_leave_periods" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_au_leave_periods";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_au_leave_periods"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_au_leave_types" (
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
  "leave_type_id" text,
  "name" text,
  "type_of_units" text,
  "normal_entitlement" numeric(19,4),
  "leave_loading_rate" numeric(19,4),
  "updated_date_utc" timestamptz,
  "is_paid_leave" boolean,
  "show_on_payslip" boolean,
  "current_record" boolean,
  "leave_category_code" text,
  "sgc_exempt" boolean,
  "is_qualifying_earnings" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_au_leave_types" IS 'Typed xero xero_payroll_au_leave_types staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_au_leave_types_connection_watermark_idx"
  ON "source_xero"."xero_payroll_au_leave_types" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_au_leave_types" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_au_leave_types" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_au_leave_types";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_au_leave_types"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_au_opening_balance_deduction_lines" (
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
  "line_index" numeric(19,4),
  "deduction_type_id" text,
  "amount" numeric(19,4),
  "calculation_type" text,
  "percentage" numeric(19,4),
  "number_of_units" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_au_opening_balance_deduction_lines" IS 'Typed xero xero_payroll_au_opening_balance_deduction_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_au_opening_balance_deduction_lines_connection_watermark_idx"
  ON "source_xero"."xero_payroll_au_opening_balance_deduction_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_au_opening_balance_deduction_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_au_opening_balance_deduction_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_au_opening_balance_deduction_lines";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_au_opening_balance_deduction_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_au_opening_balance_earnings_lines" (
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
  "line_index" numeric(19,4),
  "earnings_rate_id" text,
  "amount" numeric(19,4),
  "calculation_type" text,
  "annual_salary" numeric(19,4),
  "number_of_units_per_week" numeric(19,4),
  "rate_per_unit" numeric(19,4),
  "normal_number_of_units" numeric(19,4),
  "number_of_units" numeric(19,4),
  "fixed_amount" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_au_opening_balance_earnings_lines" IS 'Typed xero xero_payroll_au_opening_balance_earnings_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_au_opening_balance_earnings_lines_connection_watermark_idx"
  ON "source_xero"."xero_payroll_au_opening_balance_earnings_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_au_opening_balance_earnings_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_au_opening_balance_earnings_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_au_opening_balance_earnings_lines";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_au_opening_balance_earnings_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_au_opening_balance_leave_lines" (
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
  "line_index" numeric(19,4),
  "leave_type_id" text,
  "number_of_units" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_au_opening_balance_leave_lines" IS 'Typed xero xero_payroll_au_opening_balance_leave_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_au_opening_balance_leave_lines_connection_watermark_idx"
  ON "source_xero"."xero_payroll_au_opening_balance_leave_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_au_opening_balance_leave_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_au_opening_balance_leave_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_au_opening_balance_leave_lines";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_au_opening_balance_leave_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_au_opening_balance_paid_leave_lines" (
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
  "line_index" numeric(19,4),
  "leave_type_id" text,
  "amount" numeric(19,4),
  "sgc_applied_leave_loading_amount" numeric(19,4),
  "sgc_exempted_leave_loading_amount" numeric(19,4),
  "reset_stp_categorisation" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_au_opening_balance_paid_leave_lines" IS 'Typed xero xero_payroll_au_opening_balance_paid_leave_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_au_opening_balance_paid_leave_lines_connection_watermark_idx"
  ON "source_xero"."xero_payroll_au_opening_balance_paid_leave_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_au_opening_balance_paid_leave_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_au_opening_balance_paid_leave_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_au_opening_balance_paid_leave_lines";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_au_opening_balance_paid_leave_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_au_opening_balance_reimbursement_lines" (
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
  "line_index" numeric(19,4),
  "reimbursement_type_id" text,
  "amount" numeric(19,4),
  "description" text,
  "expense_account" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_au_opening_balance_reimbursement_lines" IS 'Typed xero xero_payroll_au_opening_balance_reimbursement_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_au_opening_balance_reimbursement_lines_connection_watermark_idx"
  ON "source_xero"."xero_payroll_au_opening_balance_reimbursement_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_au_opening_balance_reimbursement_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_au_opening_balance_reimbursement_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_au_opening_balance_reimbursement_lines";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_au_opening_balance_reimbursement_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_au_opening_balance_super_lines" (
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
  "line_index" numeric(19,4),
  "super_membership_id" text,
  "contribution_type" text,
  "amount" numeric(19,4),
  "calculation_type" text,
  "minimum_monthly_earnings" numeric(19,4),
  "expense_account_code" text,
  "liability_account_code" text,
  "percentage" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_au_opening_balance_super_lines" IS 'Typed xero xero_payroll_au_opening_balance_super_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_au_opening_balance_super_lines_connection_watermark_idx"
  ON "source_xero"."xero_payroll_au_opening_balance_super_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_au_opening_balance_super_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_au_opening_balance_super_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_au_opening_balance_super_lines";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_au_opening_balance_super_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_au_opening_balances" (
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
  "opening_balance_date" date,
  "tax" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_au_opening_balances" IS 'Typed xero xero_payroll_au_opening_balances staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_au_opening_balances_connection_watermark_idx"
  ON "source_xero"."xero_payroll_au_opening_balances" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_au_opening_balances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_au_opening_balances" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_au_opening_balances";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_au_opening_balances"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_au_pay_runs" (
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
  "pay_run_id" text,
  "payroll_calendar_id" text,
  "pay_run_period_start_date" date,
  "pay_run_period_end_date" date,
  "pay_run_status" text,
  "payment_date" date,
  "payslip_message" text,
  "wages" numeric(19,4),
  "deductions" numeric(19,4),
  "tax" numeric(19,4),
  "super" numeric(19,4),
  "reimbursement" numeric(19,4),
  "net_pay" numeric(19,4),
  "updated_date_utc" timestamptz,
  "payslips" jsonb,
  "validation_errors" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_au_pay_runs" IS 'Typed xero xero_payroll_au_pay_runs staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_au_pay_runs_connection_watermark_idx"
  ON "source_xero"."xero_payroll_au_pay_runs" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_au_pay_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_au_pay_runs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_au_pay_runs";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_au_pay_runs"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_au_pay_template_deduction_lines" (
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
  "line_index" numeric(19,4),
  "deduction_type_id" text,
  "calculation_type" text,
  "amount" numeric(19,4),
  "percentage" numeric(19,4),
  "number_of_units" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_au_pay_template_deduction_lines" IS 'Typed xero xero_payroll_au_pay_template_deduction_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_au_pay_template_deduction_lines_connection_watermark_idx"
  ON "source_xero"."xero_payroll_au_pay_template_deduction_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_au_pay_template_deduction_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_au_pay_template_deduction_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_au_pay_template_deduction_lines";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_au_pay_template_deduction_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_au_pay_template_earnings_lines" (
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
  "line_index" numeric(19,4),
  "earnings_rate_id" text,
  "calculation_type" text,
  "annual_salary" numeric(19,4),
  "number_of_units_per_week" numeric(19,4),
  "rate_per_unit" numeric(19,4),
  "normal_number_of_units" numeric(19,4),
  "amount" numeric(19,4),
  "number_of_units" numeric(19,4),
  "fixed_amount" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_au_pay_template_earnings_lines" IS 'Typed xero xero_payroll_au_pay_template_earnings_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_au_pay_template_earnings_lines_connection_watermark_idx"
  ON "source_xero"."xero_payroll_au_pay_template_earnings_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_au_pay_template_earnings_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_au_pay_template_earnings_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_au_pay_template_earnings_lines";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_au_pay_template_earnings_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_au_pay_template_leave_lines" (
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
  "line_index" numeric(19,4),
  "leave_type_id" text,
  "calculation_type" text,
  "entitlement_final_pay_payout_type" text,
  "employment_termination_payment_type" text,
  "include_superannuation_guarantee_contribution" boolean,
  "is_qualifying_earnings" boolean,
  "number_of_units" numeric(19,4),
  "annual_number_of_units" numeric(19,4),
  "full_time_number_of_units_per_period" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_au_pay_template_leave_lines" IS 'Typed xero xero_payroll_au_pay_template_leave_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_au_pay_template_leave_lines_connection_watermark_idx"
  ON "source_xero"."xero_payroll_au_pay_template_leave_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_au_pay_template_leave_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_au_pay_template_leave_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_au_pay_template_leave_lines";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_au_pay_template_leave_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_au_pay_template_reimbursement_lines" (
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
  "line_index" numeric(19,4),
  "reimbursement_type_id" text,
  "amount" numeric(19,4),
  "description" text,
  "expense_account" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_au_pay_template_reimbursement_lines" IS 'Typed xero xero_payroll_au_pay_template_reimbursement_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_au_pay_template_reimbursement_lines_connection_watermark_idx"
  ON "source_xero"."xero_payroll_au_pay_template_reimbursement_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_au_pay_template_reimbursement_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_au_pay_template_reimbursement_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_au_pay_template_reimbursement_lines";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_au_pay_template_reimbursement_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_au_pay_template_super_lines" (
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
  "line_index" numeric(19,4),
  "super_membership_id" text,
  "contribution_type" text,
  "calculation_type" text,
  "minimum_monthly_earnings" numeric(19,4),
  "expense_account_code" text,
  "liability_account_code" text,
  "percentage" numeric(19,4),
  "amount" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_au_pay_template_super_lines" IS 'Typed xero xero_payroll_au_pay_template_super_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_au_pay_template_super_lines_connection_watermark_idx"
  ON "source_xero"."xero_payroll_au_pay_template_super_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_au_pay_template_super_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_au_pay_template_super_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_au_pay_template_super_lines";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_au_pay_template_super_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_au_payroll_calendars" (
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
  "payroll_calendar_id" text,
  "name" text,
  "calendar_type" text,
  "start_date" date,
  "payment_date" date,
  "reference_date" date,
  "updated_date_utc" timestamptz,
  "validation_errors" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_au_payroll_calendars" IS 'Typed xero xero_payroll_au_payroll_calendars staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_au_payroll_calendars_connection_watermark_idx"
  ON "source_xero"."xero_payroll_au_payroll_calendars" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_au_payroll_calendars" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_au_payroll_calendars" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_au_payroll_calendars";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_au_payroll_calendars"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_au_payslip_deduction_lines" (
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
  "payslip_id" text,
  "deduction_lines" numeric(19,4),
  "deduction_type_id" text,
  "calculation_type" text,
  "amount" numeric(19,4),
  "percentage" numeric(19,4),
  "number_of_units" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_au_payslip_deduction_lines" IS 'Typed xero xero_payroll_au_payslip_deduction_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_au_payslip_deduction_lines_connection_watermark_idx"
  ON "source_xero"."xero_payroll_au_payslip_deduction_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_au_payslip_deduction_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_au_payslip_deduction_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_au_payslip_deduction_lines";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_au_payslip_deduction_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_au_payslip_earnings_lines" (
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
  "payslip_id" text,
  "earnings_lines" numeric(19,4),
  "earnings_rate_id" text,
  "calculation_type" text,
  "annual_salary" numeric(19,4),
  "rate_per_unit" numeric(19,4),
  "normal_number_of_units" numeric(19,4),
  "number_of_units" numeric(19,4),
  "amount" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_au_payslip_earnings_lines" IS 'Typed xero xero_payroll_au_payslip_earnings_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_au_payslip_earnings_lines_connection_watermark_idx"
  ON "source_xero"."xero_payroll_au_payslip_earnings_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_au_payslip_earnings_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_au_payslip_earnings_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_au_payslip_earnings_lines";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_au_payslip_earnings_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_au_payslip_leave_accrual_lines" (
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
  "payslip_id" text,
  "leave_accrual_lines" numeric(19,4),
  "leave_accrual_lines_leave_type_id" text,
  "leave_accrual_lines_number_of_units" numeric(19,4),
  "leave_accrual_lines_auto_calculate" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_au_payslip_leave_accrual_lines" IS 'Typed xero xero_payroll_au_payslip_leave_accrual_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_au_payslip_leave_accrual_lines_connection_watermark_idx"
  ON "source_xero"."xero_payroll_au_payslip_leave_accrual_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_au_payslip_leave_accrual_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_au_payslip_leave_accrual_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_au_payslip_leave_accrual_lines";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_au_payslip_leave_accrual_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_au_payslip_leave_earnings_lines" (
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
  "payslip_id" text,
  "leave_earnings_lines" numeric(19,4),
  "leave_earnings_lines_earnings_rate_id" text,
  "leave_earnings_lines_rate_per_unit" numeric(19,4),
  "leave_earnings_lines_number_of_units" numeric(19,4),
  "leave_earnings_lines_pay_out_type" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_au_payslip_leave_earnings_lines" IS 'Typed xero xero_payroll_au_payslip_leave_earnings_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_au_payslip_leave_earnings_lines_connection_watermark_idx"
  ON "source_xero"."xero_payroll_au_payslip_leave_earnings_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_au_payslip_leave_earnings_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_au_payslip_leave_earnings_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_au_payslip_leave_earnings_lines";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_au_payslip_leave_earnings_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_au_payslip_reimbursement_lines" (
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
  "payslip_id" text,
  "reimbursement_lines" numeric(19,4),
  "reimbursement_type_id" text,
  "description" text,
  "expense_account" text,
  "amount" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_au_payslip_reimbursement_lines" IS 'Typed xero xero_payroll_au_payslip_reimbursement_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_au_payslip_reimbursement_lines_connection_watermark_idx"
  ON "source_xero"."xero_payroll_au_payslip_reimbursement_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_au_payslip_reimbursement_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_au_payslip_reimbursement_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_au_payslip_reimbursement_lines";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_au_payslip_reimbursement_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_au_payslip_superannuation_lines" (
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
  "payslip_id" text,
  "superannuation_lines" numeric(19,4),
  "superannuation_lines_super_membership_id" text,
  "superannuation_lines_contribution_type" text,
  "superannuation_lines_calculation_type" text,
  "superannuation_lines_minimum_monthly_earnings" numeric(19,4),
  "superannuation_lines_expense_account_code" text,
  "superannuation_lines_liability_account_code" text,
  "superannuation_lines_payment_date_for_this_period" date,
  "superannuation_lines_percentage" numeric(19,4),
  "superannuation_lines_amount" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_au_payslip_superannuation_lines" IS 'Typed xero xero_payroll_au_payslip_superannuation_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_au_payslip_superannuation_lines_connection_watermark_idx"
  ON "source_xero"."xero_payroll_au_payslip_superannuation_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_au_payslip_superannuation_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_au_payslip_superannuation_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_au_payslip_superannuation_lines";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_au_payslip_superannuation_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_au_payslip_tax_lines" (
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
  "payslip_id" text,
  "tax_lines" numeric(19,4),
  "tax_lines_payslip_tax_line_id" text,
  "tax_lines_amount" numeric(19,4),
  "tax_lines_tax_type_name" text,
  "tax_lines_description" text,
  "tax_lines_manual_tax_type" text,
  "tax_lines_liability_account" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_au_payslip_tax_lines" IS 'Typed xero xero_payroll_au_payslip_tax_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_au_payslip_tax_lines_connection_watermark_idx"
  ON "source_xero"."xero_payroll_au_payslip_tax_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_au_payslip_tax_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_au_payslip_tax_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_au_payslip_tax_lines";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_au_payslip_tax_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_au_payslip_timesheet_earnings_lines" (
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
  "payslip_id" text,
  "timesheet_earnings_lines" numeric(19,4),
  "earnings_rate_id" text,
  "calculation_type" text,
  "annual_salary" numeric(19,4),
  "rate_per_unit" numeric(19,4),
  "normal_number_of_units" numeric(19,4),
  "number_of_units" numeric(19,4),
  "amount" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_au_payslip_timesheet_earnings_lines" IS 'Typed xero xero_payroll_au_payslip_timesheet_earnings_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_au_payslip_timesheet_earnings_lines_connection_watermark_idx"
  ON "source_xero"."xero_payroll_au_payslip_timesheet_earnings_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_au_payslip_timesheet_earnings_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_au_payslip_timesheet_earnings_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_au_payslip_timesheet_earnings_lines";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_au_payslip_timesheet_earnings_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_au_payslips" (
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
  "payslip_id" text,
  "pay_run_id" text,
  "employee_id" text,
  "first_name" text,
  "last_name" text,
  "payslips_employee_group" text,
  "wages" numeric(19,4),
  "deductions" numeric(19,4),
  "tax" numeric(19,4),
  "super" numeric(19,4),
  "reimbursements" numeric(19,4),
  "net_pay" numeric(19,4),
  "updated_date_utc" timestamptz,
  "earnings_lines" jsonb,
  "timesheet_earnings_lines" jsonb,
  "deduction_lines" jsonb,
  "reimbursement_lines" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_au_payslips" IS 'Typed xero xero_payroll_au_payslips staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_au_payslips_connection_watermark_idx"
  ON "source_xero"."xero_payroll_au_payslips" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_au_payslips" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_au_payslips" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_au_payslips";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_au_payslips"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_au_reimbursement_types" (
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
  "reimbursement_type_id" text,
  "name" text,
  "account_code" text,
  "updated_date_utc" timestamptz,
  "current_record" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_au_reimbursement_types" IS 'Typed xero xero_payroll_au_reimbursement_types staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_au_reimbursement_types_connection_watermark_idx"
  ON "source_xero"."xero_payroll_au_reimbursement_types" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_au_reimbursement_types" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_au_reimbursement_types" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_au_reimbursement_types";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_au_reimbursement_types"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_au_settings" (
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
  "settings_scope" text,
  "days_in_payroll_year" numeric(19,4),
  "employees_are_stp2" boolean,
  "tracking_categories" jsonb,
  "accounts" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_au_settings" IS 'Typed xero xero_payroll_au_settings staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_au_settings_connection_watermark_idx"
  ON "source_xero"."xero_payroll_au_settings" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_au_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_au_settings" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_au_settings";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_au_settings"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_au_settings_accounts" (
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
  "settings_scope" text,
  "account_id" text,
  "type" text,
  "code" text,
  "name" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_au_settings_accounts" IS 'Typed xero xero_payroll_au_settings_accounts staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_au_settings_accounts_connection_watermark_idx"
  ON "source_xero"."xero_payroll_au_settings_accounts" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_au_settings_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_au_settings_accounts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_au_settings_accounts";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_au_settings_accounts"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_au_super_fund_products" (
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
  "abn" text,
  "usi" text,
  "spin" text,
  "product_name" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_au_super_fund_products" IS 'Typed xero xero_payroll_au_super_fund_products staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_au_super_fund_products_connection_watermark_idx"
  ON "source_xero"."xero_payroll_au_super_fund_products" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_au_super_fund_products" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_au_super_fund_products" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_au_super_fund_products";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_au_super_fund_products"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_au_super_funds" (
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
  "super_fund_id" text,
  "type" text,
  "name" text,
  "abn" text,
  "bsb" text,
  "account_number" text,
  "account_name" text,
  "electronic_service_address" text,
  "employer_number" text,
  "spin" text,
  "usi" text,
  "updated_date_utc" timestamptz,
  "validation_errors" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_au_super_funds" IS 'Typed xero xero_payroll_au_super_funds staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_au_super_funds_connection_watermark_idx"
  ON "source_xero"."xero_payroll_au_super_funds" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_au_super_funds" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_au_super_funds" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_au_super_funds";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_au_super_funds"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_au_timesheet_lines" (
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
  "timesheet_id" text,
  "timesheet_lines" numeric(19,4),
  "earnings_rate_id" text,
  "tracking_item_id" text,
  "number_of_units" jsonb,
  "updated_date_utc" timestamptz,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_au_timesheet_lines" IS 'Typed xero xero_payroll_au_timesheet_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_au_timesheet_lines_connection_watermark_idx"
  ON "source_xero"."xero_payroll_au_timesheet_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_au_timesheet_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_au_timesheet_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_au_timesheet_lines";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_au_timesheet_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_au_timesheets" (
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
  "timesheet_id" text,
  "employee_id" text,
  "start_date" date,
  "end_date" date,
  "status" text,
  "hours" numeric(19,4),
  "updated_date_utc" timestamptz,
  "validation_errors" jsonb,
  "timesheet_lines" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_au_timesheets" IS 'Typed xero xero_payroll_au_timesheets staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_au_timesheets_connection_watermark_idx"
  ON "source_xero"."xero_payroll_au_timesheets" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_au_timesheets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_au_timesheets" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_au_timesheets";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_au_timesheets"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_nz_deductions" (
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
  "deduction_id" text,
  "deduction_name" text,
  "deduction_category" text,
  "liability_account_id" text,
  "current_record" boolean,
  "standard_amount" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_nz_deductions" IS 'Typed xero xero_payroll_nz_deductions staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_nz_deductions_connection_watermark_idx"
  ON "source_xero"."xero_payroll_nz_deductions" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_nz_deductions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_nz_deductions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_nz_deductions";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_nz_deductions"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_nz_earnings_rates" (
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
  "earnings_rate_id" text,
  "name" text,
  "earnings_type" text,
  "rate_type" text,
  "type_of_units" text,
  "current_record" boolean,
  "expense_account_id" text,
  "rate_per_unit" numeric(19,4),
  "multiple_of_ordinary_earnings_rate" numeric(19,4),
  "fixed_amount" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_nz_earnings_rates" IS 'Typed xero xero_payroll_nz_earnings_rates staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_nz_earnings_rates_connection_watermark_idx"
  ON "source_xero"."xero_payroll_nz_earnings_rates" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_nz_earnings_rates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_nz_earnings_rates" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_nz_earnings_rates";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_nz_earnings_rates"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_nz_employee_bank_accounts" (
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
  "bank_accounts" numeric(19,4),
  "account_name" text,
  "account_number" text,
  "sort_code" text,
  "particulars" text,
  "code" text,
  "dollar_amount" numeric(19,4),
  "reference" text,
  "calculation_type" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_nz_employee_bank_accounts" IS 'Typed xero xero_payroll_nz_employee_bank_accounts staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_nz_employee_bank_accounts_connection_watermark_idx"
  ON "source_xero"."xero_payroll_nz_employee_bank_accounts" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_nz_employee_bank_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_nz_employee_bank_accounts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_nz_employee_bank_accounts";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_nz_employee_bank_accounts"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_nz_employee_leave" (
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
  "leave_id" text,
  "employee_id" text,
  "leave_type_id" text,
  "description" text,
  "start_date" date,
  "end_date" date,
  "updated_date_utc" timestamptz,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_nz_employee_leave" IS 'Typed xero xero_payroll_nz_employee_leave staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_nz_employee_leave_connection_watermark_idx"
  ON "source_xero"."xero_payroll_nz_employee_leave" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_nz_employee_leave" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_nz_employee_leave" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_nz_employee_leave";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_nz_employee_leave"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_nz_employee_leave_balances" (
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
  "leave_type_id" text,
  "name" text,
  "balance" numeric(19,4),
  "type_of_units" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_nz_employee_leave_balances" IS 'Typed xero xero_payroll_nz_employee_leave_balances staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_nz_employee_leave_balances_connection_watermark_idx"
  ON "source_xero"."xero_payroll_nz_employee_leave_balances" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_nz_employee_leave_balances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_nz_employee_leave_balances" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_nz_employee_leave_balances";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_nz_employee_leave_balances"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_nz_employee_leave_periods" (
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
  "leave_id" text,
  "periods" numeric(19,4),
  "employee_id" text,
  "period_start_date" date,
  "period_end_date" date,
  "number_of_units" numeric(19,4),
  "number_of_units_taken" numeric(19,4),
  "type_of_units" text,
  "type_of_units_taken" text,
  "period_status" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_nz_employee_leave_periods" IS 'Typed xero xero_payroll_nz_employee_leave_periods staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_nz_employee_leave_periods_connection_watermark_idx"
  ON "source_xero"."xero_payroll_nz_employee_leave_periods" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_nz_employee_leave_periods" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_nz_employee_leave_periods" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_nz_employee_leave_periods";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_nz_employee_leave_periods"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_nz_employee_leave_types" (
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
  "leave_type_id" text,
  "schedule_of_accrual" text,
  "units_accrued_annually" numeric(19,4),
  "type_of_units_to_accrue" text,
  "maximum_to_accrue" numeric(19,4),
  "opening_balance" numeric(19,4),
  "opening_balance_type_of_units" text,
  "rate_accrued_hourly" numeric(19,4),
  "percentage_of_gross_earnings" numeric(19,4),
  "include_holiday_pay_every_pay" boolean,
  "show_annual_leave_in_advance" boolean,
  "annual_leave_total_amount_paid" numeric(19,4),
  "schedule_of_accrual_date" date,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_nz_employee_leave_types" IS 'Typed xero xero_payroll_nz_employee_leave_types staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_nz_employee_leave_types_connection_watermark_idx"
  ON "source_xero"."xero_payroll_nz_employee_leave_types" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_nz_employee_leave_types" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_nz_employee_leave_types" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_nz_employee_leave_types";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_nz_employee_leave_types"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_nz_employee_opening_balances" (
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
  "balance_ordinal" numeric(19,4),
  "period_end_date" date,
  "days_paid" numeric(19,4),
  "unpaid_weeks" numeric(19,4),
  "gross_earnings" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_nz_employee_opening_balances" IS 'Typed xero xero_payroll_nz_employee_opening_balances staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_nz_employee_opening_balances_connection_watermark_idx"
  ON "source_xero"."xero_payroll_nz_employee_opening_balances" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_nz_employee_opening_balances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_nz_employee_opening_balances" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_nz_employee_opening_balances";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_nz_employee_opening_balances"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_nz_employee_pay_template_earnings" (
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
  "pay_template_earning_id" text,
  "earning_templates" numeric(19,4),
  "earnings_rate_id" text,
  "rate_per_unit" numeric(19,4),
  "number_of_units" numeric(19,4),
  "fixed_amount" numeric(19,4),
  "name" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_nz_employee_pay_template_earnings" IS 'Typed xero xero_payroll_nz_employee_pay_template_earnings staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_nz_employee_pay_template_earnings_connection_watermark_idx"
  ON "source_xero"."xero_payroll_nz_employee_pay_template_earnings" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_nz_employee_pay_template_earnings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_nz_employee_pay_template_earnings" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_nz_employee_pay_template_earnings";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_nz_employee_pay_template_earnings"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_nz_employee_payment_methods" (
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
  "payment_method" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_nz_employee_payment_methods" IS 'Typed xero xero_payroll_nz_employee_payment_methods staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_nz_employee_payment_methods_connection_watermark_idx"
  ON "source_xero"."xero_payroll_nz_employee_payment_methods" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_nz_employee_payment_methods" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_nz_employee_payment_methods" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_nz_employee_payment_methods";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_nz_employee_payment_methods"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_nz_employee_tax" (
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
  "ird_number" text,
  "tax_code" text,
  "special_tax_rate_percentage" numeric(19,4),
  "has_special_student_loan_rate" boolean,
  "special_student_loan_rate_percentage" numeric(19,4),
  "is_eligible_for_kiwi_saver" boolean,
  "esct_rate_percentage" numeric(19,4),
  "kiwi_saver_contributions" text,
  "kiwi_saver_employee_contribution_rate_percentage" numeric(19,4),
  "kiwi_saver_employer_contribution_rate_percentage" numeric(19,4),
  "kiwi_saver_employer_salary_sacrifice_contribution_rate_percentage" numeric(19,4),
  "kiwi_saver_opt_out_date" date,
  "kiwi_saver_contribution_holiday_end_date" date,
  "has_student_loan_balance" boolean,
  "student_loan_balance" numeric(19,4),
  "student_loan_as_at" date,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_nz_employee_tax" IS 'Typed xero xero_payroll_nz_employee_tax staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_nz_employee_tax_connection_watermark_idx"
  ON "source_xero"."xero_payroll_nz_employee_tax" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_nz_employee_tax" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_nz_employee_tax" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_nz_employee_tax";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_nz_employee_tax"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_nz_employee_working_patterns" (
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
  "payee_working_pattern_id" text,
  "employee_id" text,
  "effective_from" date,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_nz_employee_working_patterns" IS 'Typed xero xero_payroll_nz_employee_working_patterns staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_nz_employee_working_patterns_connection_watermark_idx"
  ON "source_xero"."xero_payroll_nz_employee_working_patterns" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_nz_employee_working_patterns" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_nz_employee_working_patterns" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_nz_employee_working_patterns";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_nz_employee_working_patterns"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_nz_employee_working_weeks" (
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
  "payee_working_pattern_id" text,
  "working_weeks" numeric(19,4),
  "effective_from" date,
  "monday" numeric(19,4),
  "tuesday" numeric(19,4),
  "wednesday" numeric(19,4),
  "thursday" numeric(19,4),
  "friday" numeric(19,4),
  "saturday" numeric(19,4),
  "sunday" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_nz_employee_working_weeks" IS 'Typed xero xero_payroll_nz_employee_working_weeks staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_nz_employee_working_weeks_connection_watermark_idx"
  ON "source_xero"."xero_payroll_nz_employee_working_weeks" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_nz_employee_working_weeks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_nz_employee_working_weeks" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_nz_employee_working_weeks";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_nz_employee_working_weeks"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_nz_employees" (
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
  "title" text,
  "first_name" text,
  "last_name" text,
  "date_of_birth" date,
  "address_address_line1" text,
  "address_address_line2" text,
  "address_city" text,
  "address_suburb" text,
  "address_post_code" text,
  "address_country_name" text,
  "email" text,
  "gender" text,
  "phone_number" text,
  "start_date" date,
  "end_date" date,
  "payroll_calendar_id" text,
  "updated_date_utc" timestamptz,
  "created_date_utc" timestamptz,
  "job_title" text,
  "engagement_type" text,
  "fixed_term_end_date" date,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_nz_employees" IS 'Typed xero xero_payroll_nz_employees staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_nz_employees_connection_watermark_idx"
  ON "source_xero"."xero_payroll_nz_employees" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_nz_employees" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_nz_employees" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_nz_employees";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_nz_employees"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_nz_leave_types" (
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
  "leave_type_id" text,
  "name" text,
  "is_paid_leave" boolean,
  "show_on_payslip" boolean,
  "updated_date_utc" timestamptz,
  "is_active" boolean,
  "type_of_units" text,
  "type_of_units_to_accrue" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_nz_leave_types" IS 'Typed xero xero_payroll_nz_leave_types staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_nz_leave_types_connection_watermark_idx"
  ON "source_xero"."xero_payroll_nz_leave_types" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_nz_leave_types" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_nz_leave_types" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_nz_leave_types";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_nz_leave_types"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_nz_pay_run_calendars" (
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
  "payroll_calendar_id" text,
  "name" text,
  "calendar_type" text,
  "period_start_date" date,
  "period_end_date" date,
  "payment_date" date,
  "updated_date_utc" timestamptz,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_nz_pay_run_calendars" IS 'Typed xero xero_payroll_nz_pay_run_calendars staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_nz_pay_run_calendars_connection_watermark_idx"
  ON "source_xero"."xero_payroll_nz_pay_run_calendars" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_nz_pay_run_calendars" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_nz_pay_run_calendars" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_nz_pay_run_calendars";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_nz_pay_run_calendars"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_nz_pay_runs" (
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
  "pay_run_id" text,
  "payroll_calendar_id" text,
  "period_start_date" date,
  "period_end_date" date,
  "payment_date" date,
  "total_cost" numeric(19,4),
  "total_pay" numeric(19,4),
  "pay_run_status" text,
  "pay_run_type" text,
  "calendar_type" text,
  "posted_date_time" timestamptz,
  "pay_slips" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_nz_pay_runs" IS 'Typed xero xero_payroll_nz_pay_runs staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_nz_pay_runs_connection_watermark_idx"
  ON "source_xero"."xero_payroll_nz_pay_runs" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_nz_pay_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_nz_pay_runs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_nz_pay_runs";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_nz_pay_runs"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_nz_payslip_deduction_lines" (
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
  "pay_slip_id" text,
  "line_index" numeric(19,4),
  "deduction_type_id" text,
  "display_name" text,
  "amount" numeric(19,4),
  "subject_to_tax" boolean,
  "percentage" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_nz_payslip_deduction_lines" IS 'Typed xero xero_payroll_nz_payslip_deduction_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_nz_payslip_deduction_lines_connection_watermark_idx"
  ON "source_xero"."xero_payroll_nz_payslip_deduction_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_nz_payslip_deduction_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_nz_payslip_deduction_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_nz_payslip_deduction_lines";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_nz_payslip_deduction_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_nz_payslip_earnings_lines" (
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
  "pay_slip_id" text,
  "line_index" numeric(19,4),
  "earnings_line_id" text,
  "earnings_rate_id" text,
  "display_name" text,
  "rate_per_unit" numeric(19,4),
  "number_of_units" numeric(19,4),
  "fixed_amount" numeric(19,4),
  "amount" numeric(19,4),
  "is_linked_to_timesheet" boolean,
  "is_average_daily_pay_rate" boolean,
  "is_system_generated" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_nz_payslip_earnings_lines" IS 'Typed xero xero_payroll_nz_payslip_earnings_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_nz_payslip_earnings_lines_connection_watermark_idx"
  ON "source_xero"."xero_payroll_nz_payslip_earnings_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_nz_payslip_earnings_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_nz_payslip_earnings_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_nz_payslip_earnings_lines";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_nz_payslip_earnings_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_nz_payslip_employee_tax_lines" (
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
  "pay_slip_id" text,
  "line_index" numeric(19,4),
  "tax_line_id" text,
  "description" text,
  "amount" numeric(19,4),
  "global_tax_type_id" text,
  "manual_adjustment" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_nz_payslip_employee_tax_lines" IS 'Typed xero xero_payroll_nz_payslip_employee_tax_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_nz_payslip_employee_tax_lines_connection_watermark_idx"
  ON "source_xero"."xero_payroll_nz_payslip_employee_tax_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_nz_payslip_employee_tax_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_nz_payslip_employee_tax_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_nz_payslip_employee_tax_lines";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_nz_payslip_employee_tax_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_nz_payslip_employer_tax_lines" (
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
  "pay_slip_id" text,
  "line_index" numeric(19,4),
  "tax_line_id" text,
  "description" text,
  "amount" numeric(19,4),
  "global_tax_type_id" text,
  "manual_adjustment" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_nz_payslip_employer_tax_lines" IS 'Typed xero xero_payroll_nz_payslip_employer_tax_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_nz_payslip_employer_tax_lines_connection_watermark_idx"
  ON "source_xero"."xero_payroll_nz_payslip_employer_tax_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_nz_payslip_employer_tax_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_nz_payslip_employer_tax_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_nz_payslip_employer_tax_lines";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_nz_payslip_employer_tax_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_nz_payslip_leave_accrual_lines" (
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
  "pay_slip_id" text,
  "line_index" numeric(19,4),
  "leave_type_id" text,
  "number_of_units" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_nz_payslip_leave_accrual_lines" IS 'Typed xero xero_payroll_nz_payslip_leave_accrual_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_nz_payslip_leave_accrual_lines_connection_watermark_idx"
  ON "source_xero"."xero_payroll_nz_payslip_leave_accrual_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_nz_payslip_leave_accrual_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_nz_payslip_leave_accrual_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_nz_payslip_leave_accrual_lines";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_nz_payslip_leave_accrual_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_nz_payslip_leave_earnings_lines" (
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
  "pay_slip_id" text,
  "line_index" numeric(19,4),
  "earnings_line_id" text,
  "earnings_rate_id" text,
  "display_name" text,
  "rate_per_unit" numeric(19,4),
  "number_of_units" numeric(19,4),
  "fixed_amount" numeric(19,4),
  "amount" numeric(19,4),
  "is_linked_to_timesheet" boolean,
  "is_average_daily_pay_rate" boolean,
  "is_system_generated" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_nz_payslip_leave_earnings_lines" IS 'Typed xero xero_payroll_nz_payslip_leave_earnings_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_nz_payslip_leave_earnings_lines_connection_watermark_idx"
  ON "source_xero"."xero_payroll_nz_payslip_leave_earnings_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_nz_payslip_leave_earnings_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_nz_payslip_leave_earnings_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_nz_payslip_leave_earnings_lines";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_nz_payslip_leave_earnings_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_nz_payslip_payment_lines" (
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
  "pay_slip_id" text,
  "line_index" numeric(19,4),
  "payment_line_id" text,
  "amount" numeric(19,4),
  "account_number" text,
  "sort_code" text,
  "account_name" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_nz_payslip_payment_lines" IS 'Typed xero xero_payroll_nz_payslip_payment_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_nz_payslip_payment_lines_connection_watermark_idx"
  ON "source_xero"."xero_payroll_nz_payslip_payment_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_nz_payslip_payment_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_nz_payslip_payment_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_nz_payslip_payment_lines";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_nz_payslip_payment_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_nz_payslip_reimbursement_lines" (
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
  "pay_slip_id" text,
  "line_index" numeric(19,4),
  "reimbursement_type_id" text,
  "description" text,
  "amount" numeric(19,4),
  "rate_per_unit" numeric(19,4),
  "number_of_units" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_nz_payslip_reimbursement_lines" IS 'Typed xero xero_payroll_nz_payslip_reimbursement_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_nz_payslip_reimbursement_lines_connection_watermark_idx"
  ON "source_xero"."xero_payroll_nz_payslip_reimbursement_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_nz_payslip_reimbursement_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_nz_payslip_reimbursement_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_nz_payslip_reimbursement_lines";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_nz_payslip_reimbursement_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_nz_payslip_statutory_deduction_lines" (
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
  "pay_slip_id" text,
  "line_index" numeric(19,4),
  "statutory_deduction_type_id" text,
  "amount" numeric(19,4),
  "fixed_amount" numeric(19,4),
  "manual_adjustment" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_nz_payslip_statutory_deduction_lines" IS 'Typed xero xero_payroll_nz_payslip_statutory_deduction_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_nz_payslip_statutory_deduction_lines_connection_watermark_idx"
  ON "source_xero"."xero_payroll_nz_payslip_statutory_deduction_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_nz_payslip_statutory_deduction_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_nz_payslip_statutory_deduction_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_nz_payslip_statutory_deduction_lines";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_nz_payslip_statutory_deduction_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_nz_payslip_superannuation_lines" (
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
  "pay_slip_id" text,
  "line_index" numeric(19,4),
  "superannuation_type_id" text,
  "display_name" text,
  "amount" numeric(19,4),
  "fixed_amount" numeric(19,4),
  "percentage" numeric(19,4),
  "manual_adjustment" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_nz_payslip_superannuation_lines" IS 'Typed xero xero_payroll_nz_payslip_superannuation_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_nz_payslip_superannuation_lines_connection_watermark_idx"
  ON "source_xero"."xero_payroll_nz_payslip_superannuation_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_nz_payslip_superannuation_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_nz_payslip_superannuation_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_nz_payslip_superannuation_lines";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_nz_payslip_superannuation_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_nz_payslip_timesheet_earnings_lines" (
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
  "pay_slip_id" text,
  "line_index" numeric(19,4),
  "earnings_line_id" text,
  "earnings_rate_id" text,
  "display_name" text,
  "rate_per_unit" numeric(19,4),
  "number_of_units" numeric(19,4),
  "fixed_amount" numeric(19,4),
  "amount" numeric(19,4),
  "is_linked_to_timesheet" boolean,
  "is_average_daily_pay_rate" boolean,
  "is_system_generated" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_nz_payslip_timesheet_earnings_lines" IS 'Typed xero xero_payroll_nz_payslip_timesheet_earnings_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_nz_payslip_timesheet_earnings_lines_connection_watermark_idx"
  ON "source_xero"."xero_payroll_nz_payslip_timesheet_earnings_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_nz_payslip_timesheet_earnings_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_nz_payslip_timesheet_earnings_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_nz_payslip_timesheet_earnings_lines";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_nz_payslip_timesheet_earnings_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_nz_payslips" (
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
  "pay_slip_id" text,
  "employee_id" text,
  "pay_run_id" text,
  "last_edited" timestamptz,
  "first_name" text,
  "last_name" text,
  "total_earnings" numeric(19,4),
  "gross_earnings" numeric(19,4),
  "total_pay" numeric(19,4),
  "total_employer_taxes" numeric(19,4),
  "total_employee_taxes" numeric(19,4),
  "total_deductions" numeric(19,4),
  "total_reimbursements" numeric(19,4),
  "total_statutory_deductions" numeric(19,4),
  "total_superannuation" numeric(19,4),
  "bacs_hash" text,
  "payment_method" text,
  "tax_settings_period_units" numeric(19,4),
  "tax_settings_period_type" text,
  "tax_settings_tax_code" text,
  "tax_settings_special_tax_rate" text,
  "tax_settings_lump_sum_tax_code" text,
  "tax_settings_lump_sum_amount" text,
  "gross_earnings_history_days_paid" numeric(19,4),
  "gross_earnings_history_unpaid_weeks" numeric(19,4),
  "earnings_lines" jsonb,
  "leave_earnings_lines" jsonb,
  "timesheet_earnings_lines" jsonb,
  "deduction_lines" jsonb,
  "reimbursement_lines" jsonb,
  "leave_accrual_lines" jsonb,
  "superannuation_lines" jsonb,
  "payment_lines" jsonb,
  "employee_tax_lines" jsonb,
  "employer_tax_lines" jsonb,
  "statutory_deduction_lines" jsonb,
  "tax_settings" jsonb,
  "gross_earnings_history" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_nz_payslips" IS 'Typed xero xero_payroll_nz_payslips staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_nz_payslips_connection_watermark_idx"
  ON "source_xero"."xero_payroll_nz_payslips" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_nz_payslips" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_nz_payslips" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_nz_payslips";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_nz_payslips"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_nz_reimbursements" (
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
  "reimbursement_id" text,
  "name" text,
  "account_id" text,
  "current_record" boolean,
  "reimbursement_category" text,
  "calculation_type" text,
  "standard_amount" numeric(19,4),
  "standard_type_of_units" text,
  "standard_rate_per_unit" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_nz_reimbursements" IS 'Typed xero xero_payroll_nz_reimbursements staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_nz_reimbursements_connection_watermark_idx"
  ON "source_xero"."xero_payroll_nz_reimbursements" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_nz_reimbursements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_nz_reimbursements" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_nz_reimbursements";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_nz_reimbursements"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_nz_salary_and_wages" (
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
  "salary_and_wages_id" text,
  "employee_id" text,
  "earnings_rate_id" text,
  "number_of_units_per_week" numeric(19,4),
  "rate_per_unit" numeric(19,4),
  "number_of_units_per_day" numeric(19,4),
  "days_per_week" numeric(19,4),
  "effective_from" date,
  "annual_salary" numeric(19,4),
  "status" text,
  "payment_type" text,
  "work_pattern_type" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_nz_salary_and_wages" IS 'Typed xero xero_payroll_nz_salary_and_wages staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_nz_salary_and_wages_connection_watermark_idx"
  ON "source_xero"."xero_payroll_nz_salary_and_wages" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_nz_salary_and_wages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_nz_salary_and_wages" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_nz_salary_and_wages";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_nz_salary_and_wages"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_nz_settings_accounts" (
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
  "type" text,
  "code" text,
  "name" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_nz_settings_accounts" IS 'Typed xero xero_payroll_nz_settings_accounts staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_nz_settings_accounts_connection_watermark_idx"
  ON "source_xero"."xero_payroll_nz_settings_accounts" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_nz_settings_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_nz_settings_accounts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_nz_settings_accounts";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_nz_settings_accounts"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_nz_statutory_deductions" (
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
  "statutory_deduction_category" text,
  "liability_account_id" text,
  "current_record" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_nz_statutory_deductions" IS 'Typed xero xero_payroll_nz_statutory_deductions staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_nz_statutory_deductions_connection_watermark_idx"
  ON "source_xero"."xero_payroll_nz_statutory_deductions" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_nz_statutory_deductions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_nz_statutory_deductions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_nz_statutory_deductions";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_nz_statutory_deductions"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_nz_superannuations" (
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
  "category" text,
  "liability_account_id" text,
  "expense_account_id" text,
  "calculation_type_nz" text,
  "standard_amount" numeric(19,4),
  "percentage" numeric(19,4),
  "company_max" numeric(19,4),
  "current_record" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_nz_superannuations" IS 'Typed xero xero_payroll_nz_superannuations staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_nz_superannuations_connection_watermark_idx"
  ON "source_xero"."xero_payroll_nz_superannuations" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_nz_superannuations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_nz_superannuations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_nz_superannuations";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_nz_superannuations"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_nz_timesheet_lines" (
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
  "timesheet_line_id" text,
  "timesheet_id" text,
  "timesheet_lines" numeric(19,4),
  "employee_id" text,
  "date" date,
  "earnings_rate_id" text,
  "tracking_item_id" text,
  "number_of_units" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_nz_timesheet_lines" IS 'Typed xero xero_payroll_nz_timesheet_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_nz_timesheet_lines_connection_watermark_idx"
  ON "source_xero"."xero_payroll_nz_timesheet_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_nz_timesheet_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_nz_timesheet_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_nz_timesheet_lines";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_nz_timesheet_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_nz_timesheets" (
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
  "timesheet_id" text,
  "payroll_calendar_id" text,
  "employee_id" text,
  "start_date" date,
  "end_date" date,
  "status" text,
  "total_hours" numeric(19,4),
  "updated_date_utc" timestamptz,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_nz_timesheets" IS 'Typed xero xero_payroll_nz_timesheets staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_nz_timesheets_connection_watermark_idx"
  ON "source_xero"."xero_payroll_nz_timesheets" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_nz_timesheets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_nz_timesheets" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_nz_timesheets";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_nz_timesheets"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_nz_tracking_categories" (
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
  "settings_key" text,
  "employee_groups_tracking_category_id" text,
  "timesheet_tracking_category_id" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_nz_tracking_categories" IS 'Typed xero xero_payroll_nz_tracking_categories staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_nz_tracking_categories_connection_watermark_idx"
  ON "source_xero"."xero_payroll_nz_tracking_categories" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_nz_tracking_categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_nz_tracking_categories" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_nz_tracking_categories";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_nz_tracking_categories"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_uk_benefits" (
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
  "category" text,
  "liability_account_id" text,
  "expense_account_id" text,
  "standard_amount" numeric(19,4),
  "percentage" numeric(19,4),
  "calculation_type" text,
  "current_record" boolean,
  "subject_to_nic" boolean,
  "subject_to_pension" boolean,
  "subject_to_tax" boolean,
  "is_calculating_on_qualifying_earnings" boolean,
  "show_balance_to_employee" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_uk_benefits" IS 'Typed xero xero_payroll_uk_benefits staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_uk_benefits_connection_watermark_idx"
  ON "source_xero"."xero_payroll_uk_benefits" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_uk_benefits" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_uk_benefits" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_uk_benefits";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_uk_benefits"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_uk_deductions" (
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
  "deduction_id" text,
  "deduction_name" text,
  "deduction_category" text,
  "liability_account_id" text,
  "current_record" boolean,
  "standard_amount" numeric(19,4),
  "reduces_super_liability" boolean,
  "reduces_tax_liability" boolean,
  "calculation_type" text,
  "percentage" numeric(19,4),
  "subject_to_nic" boolean,
  "subject_to_tax" boolean,
  "is_reduced_by_basic_rate" boolean,
  "apply_to_pension_calculations" boolean,
  "is_calculating_on_qualifying_earnings" boolean,
  "is_pension" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_uk_deductions" IS 'Typed xero xero_payroll_uk_deductions staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_uk_deductions_connection_watermark_idx"
  ON "source_xero"."xero_payroll_uk_deductions" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_uk_deductions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_uk_deductions" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_uk_deductions";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_uk_deductions"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_uk_earnings_orders" (
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
  "statutory_deduction_category" text,
  "liability_account_id" text,
  "current_record" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_uk_earnings_orders" IS 'Typed xero xero_payroll_uk_earnings_orders staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_uk_earnings_orders_connection_watermark_idx"
  ON "source_xero"."xero_payroll_uk_earnings_orders" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_uk_earnings_orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_uk_earnings_orders" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_uk_earnings_orders";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_uk_earnings_orders"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_uk_earnings_rates" (
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
  "earnings_rate_id" text,
  "name" text,
  "earnings_type" text,
  "rate_type" text,
  "type_of_units" text,
  "current_record" boolean,
  "expense_account_id" text,
  "rate_per_unit" numeric(19,4),
  "multiple_of_ordinary_earnings_rate" numeric(19,4),
  "fixed_amount" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_uk_earnings_rates" IS 'Typed xero xero_payroll_uk_earnings_rates staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_uk_earnings_rates_connection_watermark_idx"
  ON "source_xero"."xero_payroll_uk_earnings_rates" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_uk_earnings_rates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_uk_earnings_rates" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_uk_earnings_rates";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_uk_earnings_rates"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_uk_employee_bank_accounts" (
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
  "ordinal" numeric(19,4),
  "account_name" text,
  "account_number" text,
  "sort_code" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_uk_employee_bank_accounts" IS 'Typed xero xero_payroll_uk_employee_bank_accounts staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_uk_employee_bank_accounts_connection_watermark_idx"
  ON "source_xero"."xero_payroll_uk_employee_bank_accounts" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_uk_employee_bank_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_uk_employee_bank_accounts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_uk_employee_bank_accounts";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_uk_employee_bank_accounts"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_uk_employee_contracts" (
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
  "ordinal" numeric(19,4),
  "public_key" text,
  "start_date" date,
  "employment_status" text,
  "contract_type" text,
  "is_fixed_term" boolean,
  "fixed_term_end_date" date,
  "developmental_role_details_start_date" date,
  "developmental_role_details_end_date" date,
  "developmental_role_details_developmental_role" text,
  "developmental_role_details_public_key" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_uk_employee_contracts" IS 'Typed xero xero_payroll_uk_employee_contracts staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_uk_employee_contracts_connection_watermark_idx"
  ON "source_xero"."xero_payroll_uk_employee_contracts" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_uk_employee_contracts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_uk_employee_contracts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_uk_employee_contracts";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_uk_employee_contracts"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_uk_employee_leave" (
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
  "leave_id" text,
  "employee_id" text,
  "leave_type_id" text,
  "description" text,
  "start_date" date,
  "end_date" date,
  "updated_date_utc" timestamptz,
  "periods" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_uk_employee_leave" IS 'Typed xero xero_payroll_uk_employee_leave staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_uk_employee_leave_connection_watermark_idx"
  ON "source_xero"."xero_payroll_uk_employee_leave" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_uk_employee_leave" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_uk_employee_leave" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_uk_employee_leave";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_uk_employee_leave"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_uk_employee_leave_balances" (
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
  "leave_type_id" text,
  "name" text,
  "balance" numeric(19,4),
  "type_of_units" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_uk_employee_leave_balances" IS 'Typed xero xero_payroll_uk_employee_leave_balances staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_uk_employee_leave_balances_connection_watermark_idx"
  ON "source_xero"."xero_payroll_uk_employee_leave_balances" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_uk_employee_leave_balances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_uk_employee_leave_balances" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_uk_employee_leave_balances";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_uk_employee_leave_balances"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_uk_employee_leave_periods" (
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
  "leave_id" text,
  "ordinal" numeric(19,4),
  "period_start_date" date,
  "period_end_date" date,
  "number_of_units" numeric(19,4),
  "period_status" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_uk_employee_leave_periods" IS 'Typed xero xero_payroll_uk_employee_leave_periods staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_uk_employee_leave_periods_connection_watermark_idx"
  ON "source_xero"."xero_payroll_uk_employee_leave_periods" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_uk_employee_leave_periods" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_uk_employee_leave_periods" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_uk_employee_leave_periods";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_uk_employee_leave_periods"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_uk_employee_leave_types" (
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
  "leave_type_id" text,
  "schedule_of_accrual" text,
  "hours_accrued_annually" numeric(19,4),
  "maximum_to_accrue" numeric(19,4),
  "opening_balance" numeric(19,4),
  "rate_accrued_hourly" numeric(19,4),
  "schedule_of_accrual_date" date,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_uk_employee_leave_types" IS 'Typed xero xero_payroll_uk_employee_leave_types staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_uk_employee_leave_types_connection_watermark_idx"
  ON "source_xero"."xero_payroll_uk_employee_leave_types" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_uk_employee_leave_types" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_uk_employee_leave_types" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_uk_employee_leave_types";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_uk_employee_leave_types"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_uk_employee_ni_categories" (
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
  "ordinal" numeric(19,4),
  "ni_category_id" numeric(19,4),
  "start_date" date,
  "ni_category" text,
  "date_first_employed_as_civilian" date,
  "workplace_postcode" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_uk_employee_ni_categories" IS 'Typed xero xero_payroll_uk_employee_ni_categories staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_uk_employee_ni_categories_connection_watermark_idx"
  ON "source_xero"."xero_payroll_uk_employee_ni_categories" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_uk_employee_ni_categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_uk_employee_ni_categories" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_uk_employee_ni_categories";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_uk_employee_ni_categories"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_uk_employee_opening_balances" (
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
  "statutory_adoption_pay" numeric(19,4),
  "statutory_maternity_pay" numeric(19,4),
  "statutory_paternity_pay" numeric(19,4),
  "statutory_shared_parental_pay" numeric(19,4),
  "statutory_sick_pay" numeric(19,4),
  "prior_employee_number" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_uk_employee_opening_balances" IS 'Typed xero xero_payroll_uk_employee_opening_balances staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_uk_employee_opening_balances_connection_watermark_idx"
  ON "source_xero"."xero_payroll_uk_employee_opening_balances" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_uk_employee_opening_balances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_uk_employee_opening_balances" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_uk_employee_opening_balances";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_uk_employee_opening_balances"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_uk_employee_pay_template_earnings" (
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
  "pay_template_earning_id" text,
  "employee_id" text,
  "earnings_rate_id" text,
  "rate_per_unit" numeric(19,4),
  "number_of_units" numeric(19,4),
  "fixed_amount" numeric(19,4),
  "name" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_uk_employee_pay_template_earnings" IS 'Typed xero xero_payroll_uk_employee_pay_template_earnings staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_uk_employee_pay_template_earnings_connection_watermark_idx"
  ON "source_xero"."xero_payroll_uk_employee_pay_template_earnings" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_uk_employee_pay_template_earnings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_uk_employee_pay_template_earnings" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_uk_employee_pay_template_earnings";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_uk_employee_pay_template_earnings"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_uk_employee_payment_methods" (
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
  "payment_method" text,
  "bank_accounts" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_uk_employee_payment_methods" IS 'Typed xero xero_payroll_uk_employee_payment_methods staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_uk_employee_payment_methods_connection_watermark_idx"
  ON "source_xero"."xero_payroll_uk_employee_payment_methods" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_uk_employee_payment_methods" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_uk_employee_payment_methods" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_uk_employee_payment_methods";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_uk_employee_payment_methods"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_uk_employee_salary_and_wages" (
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
  "salary_and_wages_id" text,
  "employee_id" text,
  "earnings_rate_id" text,
  "number_of_units_per_week" numeric(19,4),
  "rate_per_unit" numeric(19,4),
  "number_of_units_per_day" numeric(19,4),
  "effective_from" date,
  "annual_salary" numeric(19,4),
  "status" text,
  "payment_type" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_uk_employee_salary_and_wages" IS 'Typed xero xero_payroll_uk_employee_salary_and_wages staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_uk_employee_salary_and_wages_connection_watermark_idx"
  ON "source_xero"."xero_payroll_uk_employee_salary_and_wages" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_uk_employee_salary_and_wages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_uk_employee_salary_and_wages" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_uk_employee_salary_and_wages";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_uk_employee_salary_and_wages"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_uk_employee_statutory_leave_balances" (
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
  "leave_type" text,
  "as_of_date" date,
  "balance_remaining" numeric(19,4),
  "units" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_uk_employee_statutory_leave_balances" IS 'Typed xero xero_payroll_uk_employee_statutory_leave_balances staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_uk_employee_statutory_leave_balances_connection_watermark_idx"
  ON "source_xero"."xero_payroll_uk_employee_statutory_leave_balances" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_uk_employee_statutory_leave_balances" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_uk_employee_statutory_leave_balances" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_uk_employee_statutory_leave_balances";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_uk_employee_statutory_leave_balances"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_uk_employee_tax" (
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
  "starter_type" text,
  "starter_declaration" text,
  "tax_code" text,
  "w1_m1" boolean,
  "previous_taxable_pay" numeric(19,4),
  "previous_tax_paid" numeric(19,4),
  "student_loan_deduction" text,
  "has_post_graduate_loans" boolean,
  "is_director" boolean,
  "directorship_start_date" date,
  "nic_calculation_method" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_uk_employee_tax" IS 'Typed xero xero_payroll_uk_employee_tax staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_uk_employee_tax_connection_watermark_idx"
  ON "source_xero"."xero_payroll_uk_employee_tax" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_uk_employee_tax" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_uk_employee_tax" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_uk_employee_tax";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_uk_employee_tax"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_uk_employees" (
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
  "title" text,
  "first_name" text,
  "last_name" text,
  "date_of_birth" date,
  "address_address_line1" text,
  "address_address_line2" text,
  "address_city" text,
  "address_post_code" text,
  "address_country_name" text,
  "email" text,
  "gender" text,
  "phone_number" text,
  "start_date" date,
  "end_date" date,
  "payroll_calendar_id" text,
  "updated_date_utc" timestamptz,
  "created_date_utc" timestamptz,
  "ni_category" text,
  "national_insurance_number" text,
  "is_off_payroll_worker" boolean,
  "ni_categories" jsonb,
  "contracts" jsonb,
  "earning_templates" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_uk_employees" IS 'Typed xero xero_payroll_uk_employees staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_uk_employees_connection_watermark_idx"
  ON "source_xero"."xero_payroll_uk_employees" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_uk_employees" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_uk_employees" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_uk_employees";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_uk_employees"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_uk_leave_types" (
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
  "leave_type_id" text,
  "leave_id" text,
  "name" text,
  "is_paid_leave" boolean,
  "show_on_payslip" boolean,
  "updated_date_utc" timestamptz,
  "is_active" boolean,
  "is_statutory_leave" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_uk_leave_types" IS 'Typed xero xero_payroll_uk_leave_types staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_uk_leave_types_connection_watermark_idx"
  ON "source_xero"."xero_payroll_uk_leave_types" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_uk_leave_types" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_uk_leave_types" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_uk_leave_types";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_uk_leave_types"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_uk_pay_run_calendars" (
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
  "payroll_calendar_id" text,
  "name" text,
  "calendar_type" text,
  "period_start_date" date,
  "period_end_date" date,
  "payment_date" date,
  "updated_date_utc" timestamptz,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_uk_pay_run_calendars" IS 'Typed xero xero_payroll_uk_pay_run_calendars staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_uk_pay_run_calendars_connection_watermark_idx"
  ON "source_xero"."xero_payroll_uk_pay_run_calendars" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_uk_pay_run_calendars" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_uk_pay_run_calendars" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_uk_pay_run_calendars";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_uk_pay_run_calendars"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_uk_pay_runs" (
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
  "pay_run_id" text,
  "payroll_calendar_id" text,
  "period_start_date" date,
  "period_end_date" date,
  "payment_date" date,
  "total_cost" numeric(19,4),
  "total_pay" numeric(19,4),
  "pay_run_status" text,
  "pay_run_type" text,
  "calendar_type" text,
  "posted_date_time" timestamptz,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_uk_pay_runs" IS 'Typed xero xero_payroll_uk_pay_runs staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_uk_pay_runs_connection_watermark_idx"
  ON "source_xero"."xero_payroll_uk_pay_runs" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_uk_pay_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_uk_pay_runs" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_uk_pay_runs";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_uk_pay_runs"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_uk_payslip_benefit_lines" (
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
  "pay_slip_id" text,
  "benefit_lines" numeric(19,4),
  "benefit_type_id" text,
  "display_name" text,
  "amount" numeric(19,4),
  "fixed_amount" numeric(19,4),
  "percentage" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_uk_payslip_benefit_lines" IS 'Typed xero xero_payroll_uk_payslip_benefit_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_uk_payslip_benefit_lines_connection_watermark_idx"
  ON "source_xero"."xero_payroll_uk_payslip_benefit_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_uk_payslip_benefit_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_uk_payslip_benefit_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_uk_payslip_benefit_lines";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_uk_payslip_benefit_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_uk_payslip_court_order_lines" (
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
  "pay_slip_id" text,
  "court_order_lines" numeric(19,4),
  "court_order_type_id" text,
  "amount" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_uk_payslip_court_order_lines" IS 'Typed xero xero_payroll_uk_payslip_court_order_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_uk_payslip_court_order_lines_connection_watermark_idx"
  ON "source_xero"."xero_payroll_uk_payslip_court_order_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_uk_payslip_court_order_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_uk_payslip_court_order_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_uk_payslip_court_order_lines";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_uk_payslip_court_order_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_uk_payslip_deduction_lines" (
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
  "pay_slip_id" text,
  "deduction_lines" numeric(19,4),
  "deduction_type_id" text,
  "amount" numeric(19,4),
  "subject_to_tax" boolean,
  "percentage" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_uk_payslip_deduction_lines" IS 'Typed xero xero_payroll_uk_payslip_deduction_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_uk_payslip_deduction_lines_connection_watermark_idx"
  ON "source_xero"."xero_payroll_uk_payslip_deduction_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_uk_payslip_deduction_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_uk_payslip_deduction_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_uk_payslip_deduction_lines";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_uk_payslip_deduction_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_uk_payslip_earnings_lines" (
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
  "pay_slip_id" text,
  "earnings_lines" numeric(19,4),
  "earnings_line_id" text,
  "earnings_rate_id" text,
  "display_name" text,
  "rate_per_unit" numeric(19,4),
  "number_of_units" numeric(19,4),
  "fixed_amount" numeric(19,4),
  "amount" numeric(19,4),
  "is_linked_to_timesheet" boolean,
  "is_average_daily_pay_rate" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_uk_payslip_earnings_lines" IS 'Typed xero xero_payroll_uk_payslip_earnings_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_uk_payslip_earnings_lines_connection_watermark_idx"
  ON "source_xero"."xero_payroll_uk_payslip_earnings_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_uk_payslip_earnings_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_uk_payslip_earnings_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_uk_payslip_earnings_lines";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_uk_payslip_earnings_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_uk_payslip_employee_tax_lines" (
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
  "pay_slip_id" text,
  "employee_tax_lines" numeric(19,4),
  "tax_line_id" text,
  "description" text,
  "is_employer_tax" boolean,
  "amount" numeric(19,4),
  "global_tax_type_id" text,
  "manual_adjustment" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_uk_payslip_employee_tax_lines" IS 'Typed xero xero_payroll_uk_payslip_employee_tax_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_uk_payslip_employee_tax_lines_connection_watermark_idx"
  ON "source_xero"."xero_payroll_uk_payslip_employee_tax_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_uk_payslip_employee_tax_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_uk_payslip_employee_tax_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_uk_payslip_employee_tax_lines";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_uk_payslip_employee_tax_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_uk_payslip_employer_tax_lines" (
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
  "pay_slip_id" text,
  "employer_tax_lines" numeric(19,4),
  "tax_line_id" text,
  "description" text,
  "is_employer_tax" boolean,
  "amount" numeric(19,4),
  "global_tax_type_id" text,
  "manual_adjustment" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_uk_payslip_employer_tax_lines" IS 'Typed xero xero_payroll_uk_payslip_employer_tax_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_uk_payslip_employer_tax_lines_connection_watermark_idx"
  ON "source_xero"."xero_payroll_uk_payslip_employer_tax_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_uk_payslip_employer_tax_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_uk_payslip_employer_tax_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_uk_payslip_employer_tax_lines";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_uk_payslip_employer_tax_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_uk_payslip_leave_accrual_lines" (
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
  "pay_slip_id" text,
  "leave_accrual_lines" numeric(19,4),
  "leave_type_id" text,
  "number_of_units" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_uk_payslip_leave_accrual_lines" IS 'Typed xero xero_payroll_uk_payslip_leave_accrual_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_uk_payslip_leave_accrual_lines_connection_watermark_idx"
  ON "source_xero"."xero_payroll_uk_payslip_leave_accrual_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_uk_payslip_leave_accrual_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_uk_payslip_leave_accrual_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_uk_payslip_leave_accrual_lines";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_uk_payslip_leave_accrual_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_uk_payslip_leave_earnings_lines" (
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
  "pay_slip_id" text,
  "leave_earnings_lines" numeric(19,4),
  "earnings_rate_id" text,
  "rate_per_unit" numeric(19,4),
  "number_of_units" numeric(19,4),
  "fixed_amount" numeric(19,4),
  "amount" numeric(19,4),
  "is_linked_to_timesheet" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_uk_payslip_leave_earnings_lines" IS 'Typed xero xero_payroll_uk_payslip_leave_earnings_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_uk_payslip_leave_earnings_lines_connection_watermark_idx"
  ON "source_xero"."xero_payroll_uk_payslip_leave_earnings_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_uk_payslip_leave_earnings_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_uk_payslip_leave_earnings_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_uk_payslip_leave_earnings_lines";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_uk_payslip_leave_earnings_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_uk_payslip_payment_lines" (
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
  "pay_slip_id" text,
  "payment_lines" numeric(19,4),
  "payment_line_id" text,
  "amount" numeric(19,4),
  "account_number" text,
  "sort_code" text,
  "account_name" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_uk_payslip_payment_lines" IS 'Typed xero xero_payroll_uk_payslip_payment_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_uk_payslip_payment_lines_connection_watermark_idx"
  ON "source_xero"."xero_payroll_uk_payslip_payment_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_uk_payslip_payment_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_uk_payslip_payment_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_uk_payslip_payment_lines";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_uk_payslip_payment_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_uk_payslip_reimbursement_lines" (
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
  "pay_slip_id" text,
  "reimbursement_lines" numeric(19,4),
  "reimbursement_type_id" text,
  "description" text,
  "amount" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_uk_payslip_reimbursement_lines" IS 'Typed xero xero_payroll_uk_payslip_reimbursement_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_uk_payslip_reimbursement_lines_connection_watermark_idx"
  ON "source_xero"."xero_payroll_uk_payslip_reimbursement_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_uk_payslip_reimbursement_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_uk_payslip_reimbursement_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_uk_payslip_reimbursement_lines";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_uk_payslip_reimbursement_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_uk_payslip_timesheet_earnings_lines" (
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
  "pay_slip_id" text,
  "timesheet_earnings_lines" numeric(19,4),
  "earnings_rate_id" text,
  "rate_per_unit" numeric(19,4),
  "number_of_units" numeric(19,4),
  "fixed_amount" numeric(19,4),
  "amount" numeric(19,4),
  "is_linked_to_timesheet" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_uk_payslip_timesheet_earnings_lines" IS 'Typed xero xero_payroll_uk_payslip_timesheet_earnings_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_uk_payslip_timesheet_earnings_lines_connection_watermark_idx"
  ON "source_xero"."xero_payroll_uk_payslip_timesheet_earnings_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_uk_payslip_timesheet_earnings_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_uk_payslip_timesheet_earnings_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_uk_payslip_timesheet_earnings_lines";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_uk_payslip_timesheet_earnings_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_uk_payslips" (
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
  "pay_slip_id" text,
  "employee_id" text,
  "pay_run_id" text,
  "last_edited" timestamptz,
  "first_name" text,
  "last_name" text,
  "total_earnings" numeric(19,4),
  "gross_earnings" numeric(19,4),
  "total_pay" numeric(19,4),
  "total_employer_taxes" numeric(19,4),
  "total_employee_taxes" numeric(19,4),
  "total_deductions" numeric(19,4),
  "total_reimbursements" numeric(19,4),
  "total_court_orders" numeric(19,4),
  "total_benefits" numeric(19,4),
  "bacs_hash" text,
  "payment_method" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_uk_payslips" IS 'Typed xero xero_payroll_uk_payslips staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_uk_payslips_connection_watermark_idx"
  ON "source_xero"."xero_payroll_uk_payslips" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_uk_payslips" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_uk_payslips" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_uk_payslips";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_uk_payslips"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_uk_reimbursements" (
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
  "reimbursement_id" text,
  "name" text,
  "account_id" text,
  "current_record" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_uk_reimbursements" IS 'Typed xero xero_payroll_uk_reimbursements staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_uk_reimbursements_connection_watermark_idx"
  ON "source_xero"."xero_payroll_uk_reimbursements" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_uk_reimbursements" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_uk_reimbursements" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_uk_reimbursements";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_uk_reimbursements"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_uk_settings_accounts" (
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
  "type" text,
  "code" text,
  "name" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_uk_settings_accounts" IS 'Typed xero xero_payroll_uk_settings_accounts staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_uk_settings_accounts_connection_watermark_idx"
  ON "source_xero"."xero_payroll_uk_settings_accounts" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_uk_settings_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_uk_settings_accounts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_uk_settings_accounts";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_uk_settings_accounts"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_uk_statutory_leave_summaries" (
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
  "statutory_leave_id" text,
  "employee_id" text,
  "type" text,
  "start_date" date,
  "end_date" date,
  "is_entitled" boolean,
  "status" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_uk_statutory_leave_summaries" IS 'Typed xero xero_payroll_uk_statutory_leave_summaries staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_uk_statutory_leave_summaries_connection_watermark_idx"
  ON "source_xero"."xero_payroll_uk_statutory_leave_summaries" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_uk_statutory_leave_summaries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_uk_statutory_leave_summaries" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_uk_statutory_leave_summaries";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_uk_statutory_leave_summaries"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_uk_statutory_sick_leaves" (
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
  "statutory_leave_id" text,
  "employee_id" text,
  "leave_type_id" text,
  "start_date" date,
  "end_date" date,
  "type" text,
  "status" text,
  "work_pattern" jsonb,
  "is_pregnancy_related" boolean,
  "sufficient_notice" boolean,
  "is_entitled" boolean,
  "entitlement_weeks_requested" numeric(19,4),
  "entitlement_weeks_qualified" numeric(19,4),
  "entitlement_weeks_remaining" numeric(19,4),
  "overlaps_with_other_leave" boolean,
  "entitlement_failure_reasons" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_uk_statutory_sick_leaves" IS 'Typed xero xero_payroll_uk_statutory_sick_leaves staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_uk_statutory_sick_leaves_connection_watermark_idx"
  ON "source_xero"."xero_payroll_uk_statutory_sick_leaves" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_uk_statutory_sick_leaves" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_uk_statutory_sick_leaves" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_uk_statutory_sick_leaves";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_uk_statutory_sick_leaves"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_uk_timesheet_lines" (
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
  "timesheet_line_id" text,
  "timesheet_id" text,
  "date" date,
  "earnings_rate_id" text,
  "tracking_item_id" text,
  "number_of_units" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_uk_timesheet_lines" IS 'Typed xero xero_payroll_uk_timesheet_lines staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_uk_timesheet_lines_connection_watermark_idx"
  ON "source_xero"."xero_payroll_uk_timesheet_lines" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_uk_timesheet_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_uk_timesheet_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_uk_timesheet_lines";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_uk_timesheet_lines"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_uk_timesheets" (
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
  "timesheet_id" text,
  "payroll_calendar_id" text,
  "employee_id" text,
  "start_date" date,
  "end_date" date,
  "status" text,
  "total_hours" numeric(19,4),
  "updated_date_utc" timestamptz,
  "timesheet_lines" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_uk_timesheets" IS 'Typed xero xero_payroll_uk_timesheets staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_uk_timesheets_connection_watermark_idx"
  ON "source_xero"."xero_payroll_uk_timesheets" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_uk_timesheets" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_uk_timesheets" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_uk_timesheets";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_uk_timesheets"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_payroll_uk_tracking_categories" (
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
  "record_key" text,
  "employee_groups_tracking_category_id" text,
  "timesheet_tracking_category_id" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_payroll_uk_tracking_categories" IS 'Typed xero xero_payroll_uk_tracking_categories staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_payroll_uk_tracking_categories_connection_watermark_idx"
  ON "source_xero"."xero_payroll_uk_tracking_categories" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_payroll_uk_tracking_categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_payroll_uk_tracking_categories" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_payroll_uk_tracking_categories";
CREATE POLICY tenant_scope ON "source_xero"."xero_payroll_uk_tracking_categories"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_prepayment_allocations" (
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
  "prepayment_prepayment_id" text,
  "allocation_ordinal" numeric(19,4),
  "allocation_id" text,
  "invoice_invoice_id" text,
  "amount" numeric(19,4),
  "date" date,
  "is_deleted" boolean,
  "credit_note_credit_note_id" text,
  "status_attribute_string" text,
  "validation_errors" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_prepayment_allocations" IS 'Typed xero xero_prepayment_allocations staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_prepayment_allocations_connection_watermark_idx"
  ON "source_xero"."xero_prepayment_allocations" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_prepayment_allocations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_prepayment_allocations" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_prepayment_allocations";
CREATE POLICY tenant_scope ON "source_xero"."xero_prepayment_allocations"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_prepayments" (
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
  "prepayment_id" text,
  "type" text,
  "contact_contact_id" text,
  "date" date,
  "status" text,
  "line_amount_types" text,
  "line_items" jsonb,
  "sub_total" numeric(19,4),
  "total_tax" numeric(19,4),
  "total" numeric(19,4),
  "reference" text,
  "invoice_number" text,
  "currency_code" text,
  "branding_theme_id" text,
  "currency_rate" numeric(19,4),
  "remaining_credit" numeric(19,4),
  "applied_amount" numeric(19,4),
  "allocations" jsonb,
  "payments" jsonb,
  "has_attachments" boolean,
  "attachments" jsonb,
  "updated_date_utc" timestamptz,
  "updated_date_utc_string" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_prepayments" IS 'Typed xero xero_prepayments staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_prepayments_connection_watermark_idx"
  ON "source_xero"."xero_prepayments" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_prepayments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_prepayments" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_prepayments";
CREATE POLICY tenant_scope ON "source_xero"."xero_prepayments"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_project_tasks" (
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
  "task_id" text,
  "project_id" text,
  "name" text,
  "charge_type" text,
  "rate_value" numeric(19,4),
  "rate_currency" text,
  "estimate_minutes" numeric(19,4),
  "total_minutes" numeric(19,4),
  "minutes_invoiced" numeric(19,4),
  "minutes_to_be_invoiced" numeric(19,4),
  "fixed_minutes" numeric(19,4),
  "non_chargeable_minutes" numeric(19,4),
  "total_amount_value" numeric(19,4),
  "amount_to_be_invoiced_value" numeric(19,4),
  "amount_invoiced_value" numeric(19,4),
  "status" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_project_tasks" IS 'Typed xero xero_project_tasks staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_project_tasks_connection_watermark_idx"
  ON "source_xero"."xero_project_tasks" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_project_tasks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_project_tasks" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_project_tasks";
CREATE POLICY tenant_scope ON "source_xero"."xero_project_tasks"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_project_time_entries" (
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
  "time_entry_id" text,
  "user_id" text,
  "project_id" text,
  "task_id" text,
  "date_utc" timestamptz,
  "date_entered_utc" timestamptz,
  "duration" numeric(19,4),
  "description" text,
  "status" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_project_time_entries" IS 'Typed xero xero_project_time_entries staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_project_time_entries_connection_watermark_idx"
  ON "source_xero"."xero_project_time_entries" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_project_time_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_project_time_entries" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_project_time_entries";
CREATE POLICY tenant_scope ON "source_xero"."xero_project_time_entries"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_project_users" (
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
  "user_id" text,
  "name" text,
  "email" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_project_users" IS 'Typed xero xero_project_users staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_project_users_connection_watermark_idx"
  ON "source_xero"."xero_project_users" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_project_users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_project_users" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_project_users";
CREATE POLICY tenant_scope ON "source_xero"."xero_project_users"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_projects" (
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
  "project_id" text,
  "contact_id" text,
  "name" text,
  "status" text,
  "currency_code" text,
  "deadline_utc" timestamptz,
  "minutes_logged" numeric(19,4),
  "minutes_to_be_invoiced" numeric(19,4),
  "total_task_amount_value" numeric(19,4),
  "total_expense_amount_value" numeric(19,4),
  "estimate_value" numeric(19,4),
  "estimate_currency" text,
  "estimate_amount_value" numeric(19,4),
  "task_amount_to_be_invoiced_value" numeric(19,4),
  "task_amount_invoiced_value" numeric(19,4),
  "expense_amount_to_be_invoiced_value" numeric(19,4),
  "expense_amount_invoiced_value" numeric(19,4),
  "project_amount_invoiced_value" numeric(19,4),
  "deposit_value" numeric(19,4),
  "deposit_currency" text,
  "deposit_applied_value" numeric(19,4),
  "credit_note_amount_value" numeric(19,4),
  "total_invoiced_value" numeric(19,4),
  "total_to_be_invoiced_value" numeric(19,4),
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_projects" IS 'Typed xero xero_projects staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_projects_connection_watermark_idx"
  ON "source_xero"."xero_projects" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_projects" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_projects" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_projects";
CREATE POLICY tenant_scope ON "source_xero"."xero_projects"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_purchase_order_line_items" (
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
  "line_item_id" text,
  "purchase_order_id" text,
  "line_ordinal" numeric(19,4),
  "description" text,
  "quantity" numeric(19,4),
  "unit_amount" numeric(19,4),
  "item_code" text,
  "account_code" text,
  "account_id" text,
  "tax_type" text,
  "tax_amount" numeric(19,4),
  "line_amount" numeric(19,4),
  "discount_rate" numeric(19,4),
  "discount_amount" numeric(19,4),
  "tracking" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_purchase_order_line_items" IS 'Typed xero xero_purchase_order_line_items staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_purchase_order_line_items_connection_watermark_idx"
  ON "source_xero"."xero_purchase_order_line_items" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_purchase_order_line_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_purchase_order_line_items" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_purchase_order_line_items";
CREATE POLICY tenant_scope ON "source_xero"."xero_purchase_order_line_items"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_purchase_orders" (
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
  "purchase_order_id" text,
  "purchase_order_number" text,
  "contact_contact_id" text,
  "contact_name" text,
  "status" text,
  "date" date,
  "delivery_date" date,
  "expected_arrival_date" date,
  "reference" text,
  "line_amount_types" text,
  "currency_code" text,
  "currency_rate" numeric(19,4),
  "sub_total" numeric(19,4),
  "total_tax" numeric(19,4),
  "total" numeric(19,4),
  "total_discount" numeric(19,4),
  "sent_to_contact" boolean,
  "delivery_address" text,
  "attention_to" text,
  "telephone" text,
  "delivery_instructions" text,
  "branding_theme_id" text,
  "has_attachments" boolean,
  "status_attribute_string" text,
  "updated_date_utc" timestamptz,
  "validation_errors" jsonb,
  "warnings" jsonb,
  "attachments" jsonb,
  "line_items" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_purchase_orders" IS 'Typed xero xero_purchase_orders staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_purchase_orders_connection_watermark_idx"
  ON "source_xero"."xero_purchase_orders" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_purchase_orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_purchase_orders" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_purchase_orders";
CREATE POLICY tenant_scope ON "source_xero"."xero_purchase_orders"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_quote_line_items" (
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
  "line_items_line_item_id" text,
  "quote_id" text,
  "line_items" numeric(19,4),
  "line_items_description" text,
  "line_items_quantity" numeric(19,4),
  "line_items_unit_amount" numeric(19,4),
  "line_items_line_amount" numeric(19,4),
  "line_items_tax_type" text,
  "line_items_tax_amount" numeric(19,4),
  "line_items_account_code" text,
  "line_items_account_id" text,
  "line_items_item_code" text,
  "line_items_item_item_id" text,
  "line_items_item" jsonb,
  "line_items_tracking" jsonb,
  "line_items_discount_rate" numeric(19,4),
  "line_items_discount_amount" numeric(19,4),
  "line_items_repeating_invoice_id" text,
  "line_items_taxability" text,
  "line_items_sales_tax_code_id" numeric(19,4),
  "line_items_tax_breakdown" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_quote_line_items" IS 'Typed xero xero_quote_line_items staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_quote_line_items_connection_watermark_idx"
  ON "source_xero"."xero_quote_line_items" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_quote_line_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_quote_line_items" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_quote_line_items";
CREATE POLICY tenant_scope ON "source_xero"."xero_quote_line_items"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_quotes" (
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
  "quote_id" text,
  "quote_number" text,
  "status" text,
  "contact_contact_id" text,
  "contact_name" text,
  "reference" text,
  "terms" text,
  "title" text,
  "summary" text,
  "date" date,
  "date_string" text,
  "expiry_date" date,
  "expiry_date_string" text,
  "currency_code" text,
  "currency_rate" numeric(19,4),
  "line_amount_types" text,
  "sub_total" numeric(19,4),
  "total_tax" numeric(19,4),
  "total" numeric(19,4),
  "total_discount" numeric(19,4),
  "branding_theme_id" text,
  "updated_date_utc" timestamptz,
  "status_attribute_string" text,
  "validation_errors" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_quotes" IS 'Typed xero xero_quotes staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_quotes_connection_watermark_idx"
  ON "source_xero"."xero_quotes" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_quotes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_quotes" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_quotes";
CREATE POLICY tenant_scope ON "source_xero"."xero_quotes"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_receipt_line_items" (
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
  "line_item_id" text,
  "receipt_id" text,
  "line_ordinal" numeric(19,4),
  "description" text,
  "quantity" numeric(19,4),
  "unit_amount" numeric(19,4),
  "item_code" text,
  "account_code" text,
  "account_id" text,
  "tax_type" text,
  "tax_amount" numeric(19,4),
  "line_amount" numeric(19,4),
  "tracking" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_receipt_line_items" IS 'Typed xero xero_receipt_line_items staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_receipt_line_items_connection_watermark_idx"
  ON "source_xero"."xero_receipt_line_items" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_receipt_line_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_receipt_line_items" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_receipt_line_items";
CREATE POLICY tenant_scope ON "source_xero"."xero_receipt_line_items"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_receipts" (
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
  "receipt_id" text,
  "receipt_number" text,
  "date" date,
  "contact_contact_id" text,
  "contact_name" text,
  "user_user_id" text,
  "reference" text,
  "line_amount_types" text,
  "sub_total" numeric(19,4),
  "total_tax" numeric(19,4),
  "total" numeric(19,4),
  "status" text,
  "url" text,
  "has_attachments" boolean,
  "updated_date_utc" timestamptz,
  "validation_errors" jsonb,
  "warnings" jsonb,
  "attachments" jsonb,
  "line_items" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_receipts" IS 'Typed xero xero_receipts staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_receipts_connection_watermark_idx"
  ON "source_xero"."xero_receipts" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_receipts" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_receipts";
CREATE POLICY tenant_scope ON "source_xero"."xero_receipts"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_repeating_invoice_line_items" (
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
  "line_items_line_item_id" text,
  "repeating_invoice_id" text,
  "line_items" numeric(19,4),
  "line_items_description" text,
  "line_items_quantity" numeric(19,4),
  "line_items_unit_amount" numeric(19,4),
  "line_items_line_amount" numeric(19,4),
  "line_items_tax_type" text,
  "line_items_tax_amount" numeric(19,4),
  "line_items_account_code" text,
  "line_items_account_id" text,
  "line_items_item_code" text,
  "line_items_item_item_id" text,
  "line_items_item" jsonb,
  "line_items_tracking" jsonb,
  "line_items_discount_rate" numeric(19,4),
  "line_items_discount_amount" numeric(19,4),
  "line_items_taxability" text,
  "line_items_sales_tax_code_id" numeric(19,4),
  "line_items_tax_breakdown" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_repeating_invoice_line_items" IS 'Typed xero xero_repeating_invoice_line_items staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_repeating_invoice_line_items_connection_watermark_idx"
  ON "source_xero"."xero_repeating_invoice_line_items" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_repeating_invoice_line_items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_repeating_invoice_line_items" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_repeating_invoice_line_items";
CREATE POLICY tenant_scope ON "source_xero"."xero_repeating_invoice_line_items"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_repeating_invoices" (
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
  "repeating_invoice_id" text,
  "id" text,
  "type" text,
  "status" text,
  "contact_contact_id" text,
  "contact_name" text,
  "reference" text,
  "line_amount_types" text,
  "currency_code" text,
  "sub_total" numeric(19,4),
  "total_tax" numeric(19,4),
  "total" numeric(19,4),
  "schedule_period" numeric(19,4),
  "schedule_unit" text,
  "schedule_due_date" numeric(19,4),
  "schedule_due_date_type" text,
  "schedule_start_date" date,
  "schedule_next_scheduled_date" date,
  "schedule_end_date" date,
  "branding_theme_id" text,
  "approved_for_sending" boolean,
  "send_copy" boolean,
  "mark_as_sent" boolean,
  "include_pdf" boolean,
  "has_attachments" boolean,
  "attachments" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_repeating_invoices" IS 'Typed xero xero_repeating_invoices staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_repeating_invoices_connection_watermark_idx"
  ON "source_xero"."xero_repeating_invoices" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_repeating_invoices" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_repeating_invoices" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_repeating_invoices";
CREATE POLICY tenant_scope ON "source_xero"."xero_repeating_invoices"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_tax_rate_components" (
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
  "tax_components" numeric(19,4),
  "name" text,
  "rate" numeric(19,4),
  "is_compound" boolean,
  "is_non_recoverable" boolean,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_tax_rate_components" IS 'Typed xero xero_tax_rate_components staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_tax_rate_components_connection_watermark_idx"
  ON "source_xero"."xero_tax_rate_components" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_tax_rate_components" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_tax_rate_components" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_tax_rate_components";
CREATE POLICY tenant_scope ON "source_xero"."xero_tax_rate_components"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_tax_rates" (
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
  "report_tax_type" text,
  "can_apply_to_assets" boolean,
  "can_apply_to_equity" boolean,
  "can_apply_to_expenses" boolean,
  "can_apply_to_liabilities" boolean,
  "can_apply_to_revenue" boolean,
  "display_tax_rate" numeric(19,4),
  "effective_rate" numeric(19,4),
  "tax_components" jsonb,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_tax_rates" IS 'Typed xero xero_tax_rates staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_tax_rates_connection_watermark_idx"
  ON "source_xero"."xero_tax_rates" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_tax_rates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_tax_rates" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_tax_rates";
CREATE POLICY tenant_scope ON "source_xero"."xero_tax_rates"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_tracking_categories" (
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
  "tracking_option_id" text,
  "option" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_tracking_categories" IS 'Typed xero xero_tracking_categories staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_tracking_categories_connection_watermark_idx"
  ON "source_xero"."xero_tracking_categories" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_tracking_categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_tracking_categories" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_tracking_categories";
CREATE POLICY tenant_scope ON "source_xero"."xero_tracking_categories"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_tracking_options" (
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
  "tracking_option_id" text,
  "tracking_category_id" text,
  "options" numeric(19,4),
  "name" text,
  "status" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_tracking_options" IS 'Typed xero xero_tracking_options staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_tracking_options_connection_watermark_idx"
  ON "source_xero"."xero_tracking_options" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_tracking_options" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_tracking_options" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_tracking_options";
CREATE POLICY tenant_scope ON "source_xero"."xero_tracking_options"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

CREATE TABLE IF NOT EXISTS "source_xero"."xero_users" (
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
  "user_id" text,
  "email_address" text,
  "first_name" text,
  "last_name" text,
  "updated_date_utc" timestamptz,
  "is_subscriber" boolean,
  "organisation_role" text,
  first_ingested_at timestamptz NOT NULL DEFAULT now(),
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, namespaced_source_key),
  FOREIGN KEY (tenant_id, payload_batch_id)
    REFERENCES ingestion.batch_manifests(tenant_id, batch_id) ON DELETE RESTRICT
);
COMMENT ON TABLE "source_xero"."xero_users" IS 'Typed xero xero_users staging generated from the versioned field manifest.';
CREATE INDEX IF NOT EXISTS "xero_users_connection_watermark_idx"
  ON "source_xero"."xero_users" (tenant_id, connection_id, source_updated_at DESC);
ALTER TABLE "source_xero"."xero_users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "source_xero"."xero_users" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_scope ON "source_xero"."xero_users";
CREATE POLICY tenant_scope ON "source_xero"."xero_users"
  USING (tenant_id = (SELECT ingestion.current_tenant_id()))
  WITH CHECK (tenant_id = (SELECT ingestion.current_tenant_id()));

GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA "source_xero" TO ingest_rw;
GRANT SELECT ON ALL TABLES IN SCHEMA "source_xero" TO transform_rw, diagnostic_ro, semantic_ro;

COMMIT;
