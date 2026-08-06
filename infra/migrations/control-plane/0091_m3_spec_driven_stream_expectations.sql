-- The protected M3 inventory follows the spec-driven connector manifests. The
-- reviewed change is the Lightspeed R-Series widening from 13 hand-written
-- streams to 90 spec-generated ls_* streams, alongside the spec-driven Xero
-- pack, so this migration supersedes 0062's release-owned seed wholesale: the
-- M3 stream plan, the M4 quality set, and the hardened acceptance collector
-- are re-pinned here as one gate. The seed below is generated from the
-- TypeScript manifests and the static contract test compares it back to them.
BEGIN;

ALTER TABLE control_plane.pipeline_stats
  ADD COLUMN IF NOT EXISTS quality_run_id text,
  ADD COLUMN IF NOT EXISTS quality_checked_at timestamptz,
  ADD COLUMN IF NOT EXISTS snapshot_table_count integer,
  ADD COLUMN IF NOT EXISTS snapshot_inventory_hash text;
ALTER TABLE control_plane.pipeline_stats
  DROP CONSTRAINT IF EXISTS pipeline_stats_quality_attestation_valid;
ALTER TABLE control_plane.pipeline_stats
  ADD CONSTRAINT pipeline_stats_quality_attestation_valid CHECK (
    (quality_run_id IS NULL AND quality_checked_at IS NULL
      AND snapshot_table_count IS NULL AND snapshot_inventory_hash IS NULL)
    OR
    (quality_run_id IS NOT NULL
      AND control_plane.is_ulid(quality_run_id)
      AND quality_checked_at IS NOT NULL
      AND snapshot_table_count IS NOT NULL AND snapshot_table_count>0
      AND snapshot_inventory_hash IS NOT NULL
      AND snapshot_inventory_hash ~ '^[0-9a-f]{64}$')
  ) NOT VALID;
ALTER TABLE control_plane.pipeline_stats
  VALIDATE CONSTRAINT pipeline_stats_quality_attestation_valid;

-- The M3 inventory is release-owned: the reviewed plan is exactly the current
-- connector manifests, so retired hand-written stream rows must not linger as
-- phantom expectations the gate would keep demanding.
DELETE FROM control_plane.protected_dogfood_stream_expectation;

INSERT INTO control_plane.protected_dogfood_stream_expectation(
  connector_key,pack_version,api_version,stream,required,backfill_strategy,
  domains,dependencies,late_edit_strategy,deletion_strategy,source_total_strategy
) VALUES
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_sales',true,'time_windowed',ARRAY['sales']::text[],ARRAY[]::text[],'modified_field','soft_delete','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_sale_lines',true,'time_windowed',ARRAY['sales']::text[],ARRAY['ls_sales']::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_sale_payments',true,'snapshot',ARRAY['sales']::text[],ARRAY['ls_sales']::text[],'append_only','soft_delete','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_sale_accounts',true,'snapshot',ARRAY['sales']::text[],ARRAY['ls_sales']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_sale_payment_signatures',true,'snapshot',ARRAY['sales']::text[],ARRAY['ls_sales']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_sale_line_inventory_allocations',true,'snapshot',ARRAY['sales']::text[],ARRAY['ls_sales']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_sale_voids',true,'snapshot',ARRAY['sales']::text[],ARRAY[]::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_cc_charges',true,'time_windowed',ARRAY['sales']::text[],ARRAY[]::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_processing_fees',true,'snapshot',ARRAY['sales']::text[],ARRAY[]::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_quotes',true,'snapshot',ARRAY['sales']::text[],ARRAY[]::text[],'append_only','soft_delete','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_discounts',true,'snapshot',ARRAY['sales']::text[],ARRAY[]::text[],'modified_field','soft_delete','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_items',true,'time_windowed',ARRAY['products']::text[],ARRAY[]::text[],'modified_field','soft_delete','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_item_shops',true,'snapshot',ARRAY['products']::text[],ARRAY['ls_items']::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_item_prices',true,'snapshot',ARRAY['products']::text[],ARRAY['ls_items']::text[],'append_only','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_item_components',true,'snapshot',ARRAY['products']::text[],ARRAY['ls_items']::text[],'append_only','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_item_vendor_nums',true,'snapshot',ARRAY['products']::text[],ARRAY['ls_items']::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_item_matrices',true,'snapshot',ARRAY['products']::text[],ARRAY[]::text[],'modified_field','soft_delete','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_item_attribute_sets',true,'snapshot',ARRAY['products']::text[],ARRAY[]::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_item_fees',true,'snapshot',ARRAY['products']::text[],ARRAY[]::text[],'full_snapshot','soft_delete','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_images',true,'snapshot',ARRAY['products']::text[],ARRAY[]::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_serialized',true,'snapshot',ARRAY['products']::text[],ARRAY[]::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_tags',true,'snapshot',ARRAY['products']::text[],ARRAY[]::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_tag_groups',true,'snapshot',ARRAY['products']::text[],ARRAY[]::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_seasons',true,'snapshot',ARRAY['products']::text[],ARRAY[]::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_manufacturers',true,'snapshot',ARRAY['products']::text[],ARRAY[]::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_categories',true,'snapshot',ARRAY['products']::text[],ARRAY[]::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_options',true,'snapshot',ARRAY['products']::text[],ARRAY[]::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_price_levels',true,'snapshot',ARRAY['products']::text[],ARRAY[]::text[],'full_snapshot','soft_delete','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_catalog_vendor_items',true,'snapshot',ARRAY['products']::text[],ARRAY[]::text[],'append_only','soft_delete','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_inventory_logs',true,'time_windowed',ARRAY['inventory']::text[],ARRAY[]::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_inventory_count_calcs',true,'snapshot',ARRAY['inventory']::text[],ARRAY[]::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_inventory_count_items',true,'snapshot',ARRAY['inventory']::text[],ARRAY[]::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_inventory_count_reconciles',true,'snapshot',ARRAY['inventory']::text[],ARRAY[]::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_transfers',true,'time_windowed',ARRAY['inventory']::text[],ARRAY[]::text[],'modified_field','soft_delete','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_transfer_items',true,'time_windowed',ARRAY['inventory']::text[],ARRAY['ls_transfers']::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_special_orders',true,'snapshot',ARRAY['inventory']::text[],ARRAY[]::text[],'append_only','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_transfer_from',true,'snapshot',ARRAY['inventory']::text[],ARRAY['ls_transfers']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_transfer_to',true,'snapshot',ARRAY['inventory']::text[],ARRAY['ls_transfers']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_purchase_orders',true,'time_windowed',ARRAY['inventory']::text[],ARRAY[]::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_purchase_order_lines',true,'time_windowed',ARRAY['inventory']::text[],ARRAY['ls_purchase_orders']::text[],'modified_field','soft_delete','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_order_shipments',true,'time_windowed',ARRAY['inventory']::text[],ARRAY[]::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_order_shipment_items',true,'time_windowed',ARRAY['inventory']::text[],ARRAY[]::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_vendors',true,'time_windowed',ARRAY['inventory']::text[],ARRAY[]::text[],'modified_field','soft_delete','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_vendor_returns',true,'time_windowed',ARRAY['inventory']::text[],ARRAY[]::text[],'modified_field','soft_delete','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_customers',true,'time_windowed',ARRAY['customers']::text[],ARRAY[]::text[],'modified_field','soft_delete','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_contacts',true,'snapshot',ARRAY['customers']::text[],ARRAY['ls_credit_accounts']::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_contact_emails',true,'snapshot',ARRAY['customers']::text[],ARRAY['ls_customers']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_contact_phones',true,'snapshot',ARRAY['customers']::text[],ARRAY['ls_customers']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_contact_websites',true,'snapshot',ARRAY['customers']::text[],ARRAY['ls_customers']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_customer_types',true,'snapshot',ARRAY['customers']::text[],ARRAY[]::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_credit_accounts',true,'snapshot',ARRAY['customers']::text[],ARRAY[]::text[],'modified_field','soft_delete','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_ship_tos',true,'time_windowed',ARRAY['customers']::text[],ARRAY[]::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_custom_fields',true,'snapshot',ARRAY['customers']::text[],ARRAY[]::text[],'full_snapshot','soft_delete','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_custom_field_choices',false,'snapshot',ARRAY['customers']::text[],ARRAY['ls_custom_fields']::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_customer_custom_field_values',true,'snapshot',ARRAY['customers']::text[],ARRAY['ls_customers']::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_customer_notes',true,'snapshot',ARRAY['customers']::text[],ARRAY['ls_customers']::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_workorders',true,'time_windowed',ARRAY['sales']::text[],ARRAY[]::text[],'modified_field','soft_delete','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_workorder_lines',true,'snapshot',ARRAY['sales']::text[],ARRAY['ls_workorders']::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_workorder_items',true,'snapshot',ARRAY['sales']::text[],ARRAY['ls_workorders']::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_workorder_statuses',true,'snapshot',ARRAY['sales']::text[],ARRAY[]::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_workorder_images',false,'snapshot',ARRAY['sales']::text[],ARRAY['ls_workorders']::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_shops',true,'snapshot',ARRAY['workforce']::text[],ARRAY[]::text[],'full_snapshot','soft_delete','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_registers',true,'snapshot',ARRAY['workforce']::text[],ARRAY[]::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_employees',true,'time_windowed',ARRAY['workforce']::text[],ARRAY[]::text[],'modified_field','soft_delete','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_employee_roles',true,'snapshot',ARRAY['workforce']::text[],ARRAY['ls_employees']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_employee_role_rights',true,'snapshot',ARRAY['workforce']::text[],ARRAY['ls_employees']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_employee_rights',true,'snapshot',ARRAY['workforce']::text[],ARRAY['ls_employees']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_employee_hours',true,'snapshot',ARRAY['workforce']::text[],ARRAY[]::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_session',true,'snapshot',ARRAY['workforce']::text[],ARRAY[]::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_account',true,'snapshot',ARRAY['workforce']::text[],ARRAY[]::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_account_purchasing_currencies',true,'snapshot',ARRAY['workforce']::text[],ARRAY['ls_account']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_locales',true,'snapshot',ARRAY['workforce']::text[],ARRAY[]::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_industries',true,'snapshot',ARRAY['workforce']::text[],ARRAY[]::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_cc_gateways',true,'snapshot',ARRAY['workforce']::text[],ARRAY['ls_shops']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_receipt_setups',true,'snapshot',ARRAY['workforce']::text[],ARRAY['ls_shops']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_currency_rates',true,'snapshot',ARRAY['workforce']::text[],ARRAY[]::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_currency_denominations',true,'snapshot',ARRAY['workforce']::text[],ARRAY['ls_locales']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_register_counts',true,'snapshot',ARRAY['sales']::text[],ARRAY[]::text[],'append_only','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_register_count_amounts',true,'snapshot',ARRAY['sales']::text[],ARRAY['ls_register_counts']::text[],'append_only','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_register_withdraws',true,'snapshot',ARRAY['sales']::text[],ARRAY[]::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_register_calculated',false,'snapshot',ARRAY['sales']::text[],ARRAY['ls_registers']::text[],'append_only','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_tax_categories',true,'snapshot',ARRAY['accounting']::text[],ARRAY[]::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_tax_category_classes',true,'snapshot',ARRAY['accounting']::text[],ARRAY['ls_tax_categories']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_tax_classes',true,'snapshot',ARRAY['accounting']::text[],ARRAY[]::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_payment_types',true,'snapshot',ARRAY['accounting']::text[],ARRAY[]::text[],'full_snapshot','soft_delete','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_report_payments_by_day',true,'time_windowed',ARRAY['accounting']::text[],ARRAY[]::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_report_taxes_by_day',true,'time_windowed',ARRAY['accounting']::text[],ARRAY[]::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_report_discounts_by_day',true,'time_windowed',ARRAY['accounting']::text[],ARRAY[]::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_report_tax_class_sales_by_day',true,'time_windowed',ARRAY['accounting']::text[],ARRAY[]::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('lightspeed-r','2.0.0','R-Series API V3; documentation build 2026-07-27T19:51:56Z','ls_report_orders_by_tax_class',true,'time_windowed',ARRAY['accounting']::text[],ARRAY[]::text[],'append_only','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_1099_contacts',false,'snapshot',ARRAY['accounting']::text[],ARRAY['xero_1099_reports']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_1099_reports',false,'snapshot',ARRAY['accounting']::text[],ARRAY[]::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_accounts',true,'snapshot',ARRAY['accounting']::text[],ARRAY[]::text[],'modified_field','soft_delete','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_asset_settings',false,'snapshot',ARRAY['accounting']::text[],ARRAY[]::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_asset_types',false,'snapshot',ARRAY['accounting']::text[],ARRAY[]::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_assets',false,'snapshot',ARRAY['accounting']::text[],ARRAY[]::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_attachments',false,'snapshot',ARRAY['accounting']::text[],ARRAY[]::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_bank_transaction_line_item_tracking',true,'snapshot',ARRAY['accounting']::text[],ARRAY['xero_bank_transactions']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_bank_transaction_line_items',true,'snapshot',ARRAY['accounting']::text[],ARRAY['xero_bank_transactions']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_bank_transactions',true,'time_windowed',ARRAY['accounting']::text[],ARRAY[]::text[],'modified_field','soft_delete','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_bank_transfers',true,'snapshot',ARRAY['accounting']::text[],ARRAY[]::text[],'modified_field','soft_delete','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_batch_payments',true,'snapshot',ARRAY['accounting']::text[],ARRAY[]::text[],'modified_field','soft_delete','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_branding_themes',true,'snapshot',ARRAY['accounting']::text[],ARRAY[]::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_budget_balances',true,'snapshot',ARRAY['accounting']::text[],ARRAY['xero_budget_lines']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_budget_lines',true,'snapshot',ARRAY['accounting']::text[],ARRAY['xero_budgets']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_budget_tracking',true,'snapshot',ARRAY['accounting']::text[],ARRAY['xero_budgets']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_budgets',true,'snapshot',ARRAY['accounting']::text[],ARRAY[]::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_connections',true,'snapshot',ARRAY['accounting']::text[],ARRAY[]::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_contact_addresses',true,'snapshot',ARRAY['customers']::text[],ARRAY['xero_contacts']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_contact_balances',true,'snapshot',ARRAY['customers']::text[],ARRAY['xero_contacts']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_contact_cis_settings',false,'snapshot',ARRAY['customers']::text[],ARRAY['xero_contacts']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_contact_group_members',false,'snapshot',ARRAY['customers']::text[],ARRAY['xero_contact_groups']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_contact_groups',true,'snapshot',ARRAY['customers']::text[],ARRAY[]::text[],'full_snapshot','soft_delete','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_contact_persons',true,'snapshot',ARRAY['customers']::text[],ARRAY['xero_contacts']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_contact_phones',true,'snapshot',ARRAY['customers']::text[],ARRAY['xero_contacts']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_contacts',true,'snapshot',ARRAY['customers']::text[],ARRAY[]::text[],'modified_field','soft_delete','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_credit_note_allocations',true,'snapshot',ARRAY['accounting']::text[],ARRAY['xero_credit_notes']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_credit_note_line_items',true,'snapshot',ARRAY['accounting']::text[],ARRAY['xero_credit_notes']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_credit_notes',true,'time_windowed',ARRAY['accounting']::text[],ARRAY[]::text[],'modified_field','soft_delete','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_currencies',true,'snapshot',ARRAY['accounting']::text[],ARRAY[]::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_expense_claim_payments',true,'snapshot',ARRAY['accounting']::text[],ARRAY['xero_expense_claims']::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_expense_claim_receipts',true,'snapshot',ARRAY['accounting']::text[],ARRAY['xero_expense_claims']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_expense_claims',true,'snapshot',ARRAY['accounting']::text[],ARRAY[]::text[],'modified_field','soft_delete','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_file_associations',false,'snapshot',ARRAY['accounting']::text[],ARRAY['xero_files']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_files',false,'snapshot',ARRAY['accounting']::text[],ARRAY[]::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_folders',false,'snapshot',ARRAY['accounting']::text[],ARRAY[]::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_history_records',false,'snapshot',ARRAY['accounting']::text[],ARRAY[]::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_invoice_line_items',true,'snapshot',ARRAY['accounting']::text[],ARRAY['xero_invoices']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_invoice_reminders',true,'snapshot',ARRAY['accounting']::text[],ARRAY[]::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_invoices',true,'time_windowed',ARRAY['accounting']::text[],ARRAY[]::text[],'modified_field','soft_delete','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_items',true,'snapshot',ARRAY['accounting']::text[],ARRAY[]::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_journal_line_tracking',false,'snapshot',ARRAY['accounting']::text[],ARRAY['xero_journals']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_journal_lines',false,'snapshot',ARRAY['accounting']::text[],ARRAY['xero_journals']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_journals',false,'exhaustive_offset',ARRAY['accounting']::text[],ARRAY[]::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_linked_transactions',true,'snapshot',ARRAY['accounting']::text[],ARRAY[]::text[],'modified_field','soft_delete','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_manual_journal_line_tracking',true,'snapshot',ARRAY['accounting']::text[],ARRAY['xero_manual_journals']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_manual_journal_lines',true,'snapshot',ARRAY['accounting']::text[],ARRAY['xero_manual_journals']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_manual_journals',true,'time_windowed',ARRAY['accounting']::text[],ARRAY[]::text[],'modified_field','soft_delete','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_online_invoices',false,'snapshot',ARRAY['accounting']::text[],ARRAY['xero_invoices']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_organisation_actions',true,'snapshot',ARRAY['accounting']::text[],ARRAY[]::text[],'full_snapshot','soft_delete','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_organisation_addresses',true,'snapshot',ARRAY['accounting']::text[],ARRAY['xero_organisations']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_organisation_cis_settings',false,'snapshot',ARRAY['accounting']::text[],ARRAY['xero_organisations']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_organisation_external_links',true,'snapshot',ARRAY['accounting']::text[],ARRAY['xero_organisations']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_organisation_payment_terms',true,'snapshot',ARRAY['accounting']::text[],ARRAY['xero_organisations']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_organisation_phones',true,'snapshot',ARRAY['accounting']::text[],ARRAY['xero_organisations']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_organisations',true,'snapshot',ARRAY['accounting']::text[],ARRAY[]::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_overpayment_allocations',true,'snapshot',ARRAY['accounting']::text[],ARRAY['xero_overpayments']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_overpayments',true,'time_windowed',ARRAY['accounting']::text[],ARRAY[]::text[],'modified_field','soft_delete','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payment_services',true,'snapshot',ARRAY['accounting']::text[],ARRAY[]::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payments',true,'time_windowed',ARRAY['accounting']::text[],ARRAY[]::text[],'modified_field','soft_delete','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_au_deduction_types',false,'snapshot',ARRAY['workforce']::text[],ARRAY[]::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_au_earnings_rates',false,'snapshot',ARRAY['workforce']::text[],ARRAY[]::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_au_employee_bank_accounts',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_au_employees']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_au_employee_home_addresses',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_au_employees']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_au_employee_leave_balances',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_au_employees']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_au_employee_super_memberships',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_au_employees']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_au_employee_tax_declarations',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_au_employees']::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_au_employees',false,'snapshot',ARRAY['workforce']::text[],ARRAY[]::text[],'modified_field','soft_delete','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_au_leave_applications',false,'snapshot',ARRAY['workforce']::text[],ARRAY[]::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_au_leave_periods',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_au_leave_applications']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_au_leave_types',false,'snapshot',ARRAY['workforce']::text[],ARRAY[]::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_au_opening_balance_deduction_lines',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_au_opening_balances']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_au_opening_balance_earnings_lines',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_au_opening_balances']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_au_opening_balance_leave_lines',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_au_opening_balances']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_au_opening_balance_paid_leave_lines',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_au_opening_balances']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_au_opening_balance_reimbursement_lines',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_au_opening_balances']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_au_opening_balance_super_lines',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_au_opening_balances']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_au_opening_balances',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_au_employees']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_au_pay_runs',false,'time_windowed',ARRAY['workforce']::text[],ARRAY[]::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_au_pay_template_deduction_lines',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_au_employees']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_au_pay_template_earnings_lines',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_au_employees']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_au_pay_template_leave_lines',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_au_employees']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_au_pay_template_reimbursement_lines',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_au_employees']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_au_pay_template_super_lines',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_au_employees']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_au_payroll_calendars',false,'time_windowed',ARRAY['workforce']::text[],ARRAY[]::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_au_payslip_deduction_lines',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_au_payslips']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_au_payslip_earnings_lines',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_au_payslips']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_au_payslip_leave_accrual_lines',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_au_payslips']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_au_payslip_leave_earnings_lines',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_au_payslips']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_au_payslip_reimbursement_lines',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_au_payslips']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_au_payslip_superannuation_lines',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_au_payslips']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_au_payslip_tax_lines',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_au_payslips']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_au_payslip_timesheet_earnings_lines',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_au_payslips']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_au_payslips',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_au_pay_runs']::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_au_reimbursement_types',false,'snapshot',ARRAY['workforce']::text[],ARRAY[]::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_au_settings',false,'snapshot',ARRAY['workforce']::text[],ARRAY[]::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_au_settings_accounts',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_au_settings']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_au_super_fund_products',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_au_super_funds']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_au_super_funds',false,'snapshot',ARRAY['workforce']::text[],ARRAY[]::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_au_timesheet_lines',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_au_timesheets']::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_au_timesheets',false,'snapshot',ARRAY['workforce']::text[],ARRAY[]::text[],'modified_field','soft_delete','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_nz_deductions',false,'snapshot',ARRAY['workforce']::text[],ARRAY[]::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_nz_earnings_rates',false,'snapshot',ARRAY['workforce']::text[],ARRAY[]::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_nz_employee_bank_accounts',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_nz_employee_payment_methods']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_nz_employee_leave',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_nz_employees']::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_nz_employee_leave_balances',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_nz_employees']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_nz_employee_leave_periods',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_nz_employee_leave']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_nz_employee_leave_types',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_nz_employees']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_nz_employee_opening_balances',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_nz_employees']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_nz_employee_pay_template_earnings',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_nz_employees']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_nz_employee_payment_methods',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_nz_employees']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_nz_employee_tax',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_nz_employees']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_nz_employee_working_patterns',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_nz_employees']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_nz_employee_working_weeks',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_nz_employee_working_patterns']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_nz_employees',false,'snapshot',ARRAY['workforce']::text[],ARRAY[]::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_nz_leave_types',false,'snapshot',ARRAY['workforce']::text[],ARRAY[]::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_nz_pay_run_calendars',false,'snapshot',ARRAY['workforce']::text[],ARRAY[]::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_nz_pay_runs',false,'snapshot',ARRAY['workforce']::text[],ARRAY[]::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_nz_payslip_deduction_lines',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_nz_payslips']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_nz_payslip_earnings_lines',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_nz_payslips']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_nz_payslip_employee_tax_lines',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_nz_payslips']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_nz_payslip_employer_tax_lines',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_nz_payslips']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_nz_payslip_leave_accrual_lines',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_nz_payslips']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_nz_payslip_leave_earnings_lines',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_nz_payslips']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_nz_payslip_payment_lines',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_nz_payslips']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_nz_payslip_reimbursement_lines',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_nz_payslips']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_nz_payslip_statutory_deduction_lines',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_nz_payslips']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_nz_payslip_superannuation_lines',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_nz_payslips']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_nz_payslip_timesheet_earnings_lines',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_nz_payslips']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_nz_payslips',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_nz_pay_runs']::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_nz_reimbursements',false,'snapshot',ARRAY['workforce']::text[],ARRAY[]::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_nz_salary_and_wages',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_nz_employees']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_nz_settings_accounts',false,'snapshot',ARRAY['workforce']::text[],ARRAY[]::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_nz_statutory_deductions',false,'snapshot',ARRAY['workforce']::text[],ARRAY[]::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_nz_superannuations',false,'snapshot',ARRAY['workforce']::text[],ARRAY[]::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_nz_timesheet_lines',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_nz_timesheets']::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_nz_timesheets',false,'snapshot',ARRAY['workforce']::text[],ARRAY[]::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_nz_tracking_categories',false,'snapshot',ARRAY['workforce']::text[],ARRAY[]::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_uk_benefits',false,'snapshot',ARRAY['workforce']::text[],ARRAY[]::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_uk_deductions',false,'snapshot',ARRAY['workforce']::text[],ARRAY[]::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_uk_earnings_orders',false,'snapshot',ARRAY['workforce']::text[],ARRAY[]::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_uk_earnings_rates',false,'snapshot',ARRAY['workforce']::text[],ARRAY[]::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_uk_employee_bank_accounts',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_uk_employee_payment_methods']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_uk_employee_contracts',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_uk_employees']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_uk_employee_leave',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_uk_employees']::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_uk_employee_leave_balances',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_uk_employees']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_uk_employee_leave_periods',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_uk_employee_leave']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_uk_employee_leave_types',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_uk_employees']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_uk_employee_ni_categories',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_uk_employees']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_uk_employee_opening_balances',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_uk_employees']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_uk_employee_pay_template_earnings',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_uk_employees']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_uk_employee_payment_methods',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_uk_employees']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_uk_employee_salary_and_wages',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_uk_employees']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_uk_employee_statutory_leave_balances',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_uk_employees']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_uk_employee_tax',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_uk_employees']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_uk_employees',false,'snapshot',ARRAY['workforce']::text[],ARRAY[]::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_uk_leave_types',false,'snapshot',ARRAY['workforce']::text[],ARRAY[]::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_uk_pay_run_calendars',false,'snapshot',ARRAY['workforce']::text[],ARRAY[]::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_uk_pay_runs',false,'snapshot',ARRAY['workforce']::text[],ARRAY[]::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_uk_payslip_benefit_lines',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_uk_payslips']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_uk_payslip_court_order_lines',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_uk_payslips']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_uk_payslip_deduction_lines',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_uk_payslips']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_uk_payslip_earnings_lines',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_uk_payslips']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_uk_payslip_employee_tax_lines',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_uk_payslips']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_uk_payslip_employer_tax_lines',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_uk_payslips']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_uk_payslip_leave_accrual_lines',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_uk_payslips']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_uk_payslip_leave_earnings_lines',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_uk_payslips']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_uk_payslip_payment_lines',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_uk_payslips']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_uk_payslip_reimbursement_lines',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_uk_payslips']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_uk_payslip_timesheet_earnings_lines',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_uk_payslips']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_uk_payslips',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_uk_pay_runs']::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_uk_reimbursements',false,'snapshot',ARRAY['workforce']::text[],ARRAY[]::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_uk_settings_accounts',false,'snapshot',ARRAY['workforce']::text[],ARRAY[]::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_uk_statutory_leave_summaries',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_uk_employees']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_uk_statutory_sick_leaves',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_uk_statutory_leave_summaries']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_uk_timesheet_lines',false,'snapshot',ARRAY['workforce']::text[],ARRAY['xero_payroll_uk_timesheets']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_uk_timesheets',false,'snapshot',ARRAY['workforce']::text[],ARRAY[]::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_payroll_uk_tracking_categories',false,'snapshot',ARRAY['workforce']::text[],ARRAY[]::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_prepayment_allocations',true,'snapshot',ARRAY['accounting']::text[],ARRAY['xero_prepayments']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_prepayments',true,'time_windowed',ARRAY['accounting']::text[],ARRAY[]::text[],'modified_field','soft_delete','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_project_tasks',false,'snapshot',ARRAY['accounting']::text[],ARRAY['xero_projects']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_project_time_entries',false,'snapshot',ARRAY['accounting']::text[],ARRAY['xero_projects']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_project_users',false,'snapshot',ARRAY['accounting']::text[],ARRAY[]::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_projects',false,'snapshot',ARRAY['accounting']::text[],ARRAY[]::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_purchase_order_line_items',true,'snapshot',ARRAY['accounting']::text[],ARRAY['xero_purchase_orders']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_purchase_orders',true,'snapshot',ARRAY['accounting']::text[],ARRAY[]::text[],'modified_field','soft_delete','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_quote_line_items',true,'snapshot',ARRAY['accounting']::text[],ARRAY['xero_quotes']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_quotes',true,'snapshot',ARRAY['accounting']::text[],ARRAY[]::text[],'modified_field','soft_delete','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_receipt_line_items',true,'snapshot',ARRAY['accounting']::text[],ARRAY['xero_receipts']::text[],'append_only','immutable_append_only','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_receipts',true,'snapshot',ARRAY['accounting']::text[],ARRAY[]::text[],'modified_field','soft_delete','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_repeating_invoice_line_items',true,'snapshot',ARRAY['accounting']::text[],ARRAY['xero_repeating_invoices']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_repeating_invoices',true,'snapshot',ARRAY['accounting']::text[],ARRAY[]::text[],'full_snapshot','soft_delete','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_tax_rate_components',true,'snapshot',ARRAY['accounting']::text[],ARRAY['xero_tax_rates']::text[],'full_snapshot','authoritative_identity_scan','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_tax_rates',true,'snapshot',ARRAY['accounting']::text[],ARRAY[]::text[],'full_snapshot','soft_delete','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_tracking_categories',true,'snapshot',ARRAY['accounting']::text[],ARRAY[]::text[],'full_snapshot','soft_delete','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_tracking_options',true,'snapshot',ARRAY['accounting']::text[],ARRAY['xero_tracking_categories']::text[],'full_snapshot','soft_delete','count_distinct_complete_scan'),
  ('xero','2.0.0','Accounting API 2.0 + Assets 1.0 + Projects 2.0 + Files 1.0 + Payroll AU/UK/NZ; OpenAPI 45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f; granular OAuth scopes (March 2026); 197-table semantic spec','xero_users',true,'snapshot',ARRAY['accounting']::text[],ARRAY[]::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('deputy','1.0.0','Public API /api/v1 Resource API','companies',true,'snapshot',ARRAY['workforce']::text[],ARRAY[]::text[],'modified_field','soft_delete','count_distinct_complete_scan'),
  ('deputy','1.0.0','Public API /api/v1 Resource API','operational_units',true,'snapshot',ARRAY['workforce']::text[],ARRAY['companies']::text[],'modified_field','soft_delete','count_distinct_complete_scan'),
  ('deputy','1.0.0','Public API /api/v1 Resource API','employees',true,'snapshot',ARRAY['workforce']::text[],ARRAY['companies','operational_units']::text[],'modified_field','soft_delete','count_distinct_complete_scan'),
  ('deputy','1.0.0','Public API /api/v1 Resource API','rosters',true,'time_windowed',ARRAY['workforce']::text[],ARRAY['companies','employees','operational_units']::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('deputy','1.0.0','Public API /api/v1 Resource API','timesheets',true,'time_windowed',ARRAY['workforce']::text[],ARRAY['companies','employees','operational_units']::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('deputy','1.0.0','Public API /api/v1 Resource API','leave',true,'time_windowed',ARRAY['workforce']::text[],ARRAY['companies','employees','operational_units']::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan'),
  ('deputy','1.0.0','Public API /api/v1 Resource API','contacts',false,'snapshot',ARRAY['workforce']::text[],ARRAY[]::text[],'modified_field','authoritative_identity_scan','count_distinct_complete_scan')
ON CONFLICT (connector_key,stream) DO UPDATE SET
  pack_version=excluded.pack_version,
  api_version=excluded.api_version,
  required=excluded.required,
  backfill_strategy=excluded.backfill_strategy,
  domains=excluded.domains,
  dependencies=excluded.dependencies,
  late_edit_strategy=excluded.late_edit_strategy,
  deletion_strategy=excluded.deletion_strategy,
  source_total_strategy=excluded.source_total_strategy;

-- The reviewed M4 quality set is unchanged from 0062. It is reasserted here so
-- this migration owns the complete protected expectation state.
DELETE FROM control_plane.protected_dogfood_quality_expectation
 WHERE check_id NOT IN (
  'canonical_mapping_total',
  'cost_coverage',
  'currency_consistency',
  'cursor_completeness',
  'delete_handling',
  'enum_drift',
  'field_coverage_vs_manifest',
  'journal_balances',
  'labour_cost_coverage',
  'line_maths',
  'no_orphan_observations',
  'observation_coverage',
  'orphan_rate',
  'pk_unique',
  'pos_bank_tolerance',
  'pos_ledger_tolerance',
  'posting_bridge_coverage',
  'retention_limit_recorded',
  'schema_drift',
  'scope_available',
  'settlement_bridge_coverage',
  'shift_timesheet_coverage',
  'status_mapping_total',
  'stock_continuity',
  'tax_consistency',
  'tender_reconciles',
  'tz_validity',
  'webhook_gap_recovered'
 );

INSERT INTO control_plane.protected_dogfood_quality_expectation(check_id) VALUES
  ('canonical_mapping_total'),
  ('cost_coverage'),
  ('currency_consistency'),
  ('cursor_completeness'),
  ('delete_handling'),
  ('enum_drift'),
  ('field_coverage_vs_manifest'),
  ('journal_balances'),
  ('labour_cost_coverage'),
  ('line_maths'),
  ('no_orphan_observations'),
  ('observation_coverage'),
  ('orphan_rate'),
  ('pk_unique'),
  ('pos_bank_tolerance'),
  ('pos_ledger_tolerance'),
  ('posting_bridge_coverage'),
  ('retention_limit_recorded'),
  ('schema_drift'),
  ('scope_available'),
  ('settlement_bridge_coverage'),
  ('shift_timesheet_coverage'),
  ('status_mapping_total'),
  ('stock_continuity'),
  ('tax_consistency'),
  ('tender_reconciles'),
  ('tz_validity'),
  ('webhook_gap_recovered')
ON CONFLICT(check_id) DO NOTHING;

CREATE OR REPLACE FUNCTION control_plane.assert_protected_dogfood_manifest_and_quality(
  p_tenant_id text,
  p_connections jsonb,
  p_barrier_at timestamptz
) RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE latest_snapshot timestamptz;
DECLARE required_quality jsonb;
DECLARE quality_run_min text;
DECLARE quality_run_max text;
DECLARE quality_checked_min timestamptz;
DECLARE quality_checked_max timestamptz;
DECLARE declared_table_count_min integer;
DECLARE declared_table_count_max integer;
DECLARE declared_inventory_hash_min text;
DECLARE declared_inventory_hash_max text;
DECLARE actual_table_count integer;
DECLARE actual_inventory_hash text;
DECLARE candidate_evidence_at timestamptz;
BEGIN
  IF p_tenant_id IS NULL
     OR NOT control_plane.is_ulid(p_tenant_id)
     OR p_barrier_at IS NULL
     OR p_barrier_at>clock_timestamp()
     OR jsonb_typeof(p_connections) IS DISTINCT FROM 'object'
     OR NOT (p_connections ?& ARRAY['lightspeed-r','xero','deputy'])
     OR p_connections-ARRAY['lightspeed-r','xero','deputy']<>'{}'::jsonb
     OR EXISTS (
       SELECT 1 FROM jsonb_each_text(p_connections) item
        WHERE control_plane.is_ulid(item.value) IS DISTINCT FROM true
     ) THEN
    RAISE EXCEPTION 'protected dogfood manifest gate input is invalid' USING ERRCODE='22023';
  END IF;

  -- The selectors must still identify the current generation of each exact
  -- connector. This also prevents a stale plan from another authorization
  -- epoch satisfying the inventory checks below.
  IF (SELECT count(*)
        FROM jsonb_each_text(p_connections) selected(connector_key,connection_id)
        JOIN control_plane.connections connection
          ON connection.tenant_id=p_tenant_id
         AND connection.connection_id=selected.connection_id
         AND connection.connector_key=selected.connector_key
         AND connection.connection_generation>0)<>3 THEN
    RAISE EXCEPTION 'protected dogfood connector generations are incomplete' USING ERRCODE='55000';
  END IF;

  -- Reject both missing and unreviewed extra streams for the selected current
  -- generations. An attacker cannot turn a one-stream sync into M3 evidence.
  IF EXISTS (
    WITH selected AS (
      SELECT item.key AS connector_key,item.value AS connection_id,
             connection.connection_generation
        FROM jsonb_each_text(p_connections) item
        JOIN control_plane.connections connection
          ON connection.tenant_id=p_tenant_id
         AND connection.connection_id=item.value
         AND connection.connector_key=item.key
    )
    SELECT 1
      FROM control_plane.sync_stream_phases phase
      JOIN selected USING(connection_id,connection_generation)
      LEFT JOIN control_plane.protected_dogfood_stream_expectation expected
        ON expected.connector_key=selected.connector_key
       AND expected.stream=phase.stream
     WHERE phase.tenant_id=p_tenant_id
       AND expected.stream IS NULL
  ) OR EXISTS (
    WITH selected AS (
      SELECT item.key AS connector_key,item.value AS connection_id,
             connection.connection_generation
        FROM jsonb_each_text(p_connections) item
        JOIN control_plane.connections connection
          ON connection.tenant_id=p_tenant_id
         AND connection.connection_id=item.value
         AND connection.connector_key=item.key
    )
    SELECT 1
      FROM selected
      JOIN control_plane.protected_dogfood_stream_expectation expected
        ON expected.connector_key=selected.connector_key
      LEFT JOIN LATERAL (
        SELECT count(*) AS phase_count,
               array_agg(phase.phase ORDER BY phase.phase_ordinal) AS phases,
               array_agg(phase.phase_ordinal ORDER BY phase.phase_ordinal) AS ordinals,
               array_agg(phase.range_from ORDER BY phase.phase_ordinal) AS range_froms,
               array_agg(phase.range_to ORDER BY phase.phase_ordinal) AS range_tos,
               bool_and(phase.required=expected.required) AS requirement_matches,
               bool_and(phase.backfill_strategy=expected.backfill_strategy) AS strategy_matches,
               bool_and(phase.domains=expected.domains) AS domains_match,
               bool_and(phase.dependencies=expected.dependencies) AS dependencies_match,
               bool_and(phase.dependency_plan_sealed) AS dependency_plan_is_sealed,
               bool_and(
                 phase.predecessor_phase IS NOT DISTINCT FROM CASE phase.phase
                   WHEN 'recent' THEN NULL
                   WHEN 'thirteen_months' THEN 'recent'
                   ELSE 'thirteen_months'
                 END
               ) AS predecessor_matches,
               bool_and(
                 phase.plan_mode=CASE
                   WHEN expected.backfill_strategy='time_windowed' THEN 'progressive'
                   ELSE 'single_pass'
                 END
               ) AS mode_matches
          FROM control_plane.sync_stream_phases phase
         WHERE phase.tenant_id=p_tenant_id
           AND phase.connection_id=selected.connection_id
           AND phase.connection_generation=selected.connection_generation
           AND phase.stream=expected.stream
      ) plan ON true
     WHERE NOT coalesce(plan.requirement_matches,false)
        OR NOT coalesce(plan.strategy_matches,false)
        OR NOT coalesce(plan.domains_match,false)
        OR NOT coalesce(plan.dependencies_match,false)
        OR NOT coalesce(plan.dependency_plan_is_sealed,false)
        OR NOT coalesce(plan.predecessor_matches,false)
        OR NOT coalesce(plan.mode_matches,false)
        OR CASE WHEN expected.backfill_strategy='time_windowed'
             THEN plan.phase_count<>3
               OR plan.phases<>ARRAY['recent','thirteen_months','full_history']::text[]
               OR plan.ordinals<>ARRAY[1,2,3]::smallint[]
               OR plan.range_froms[1]<>plan.range_tos[2]
               OR plan.range_froms[2]<>plan.range_tos[3]
             ELSE plan.phase_count<>1
               OR plan.phases<>ARRAY['recent']::text[]
               OR plan.ordinals<>ARRAY[1]::smallint[]
           END
  ) THEN
    RAISE EXCEPTION 'dogfood stream plan does not match the exact reviewed connector manifests'
      USING ERRCODE='55000';
  END IF;

  -- Immutable raw evidence from the selected current generations must itself
  -- be release-exact. Requiring one matching batch is insufficient when an
  -- additional batch proves that unreviewed connector/API/stream code also ran.
  IF EXISTS (
    WITH selected AS (
      SELECT item.key AS connector_key,item.value AS connection_id,
             connection.connection_generation
        FROM jsonb_each_text(p_connections) item
        JOIN control_plane.connections connection
          ON connection.tenant_id=p_tenant_id
         AND connection.connection_id=item.value
         AND connection.connector_key=item.key
    )
    SELECT 1
      FROM selected
      JOIN control_plane.raw_batch_manifests manifest
        ON manifest.tenant_id=p_tenant_id
       AND manifest.connection_id=selected.connection_id
      JOIN control_plane.sync_runs run
        ON run.tenant_id=manifest.tenant_id
       AND run.sync_run_id=manifest.sync_run_id
       AND run.connection_generation=selected.connection_generation
      LEFT JOIN control_plane.protected_dogfood_stream_expectation expected
        ON expected.connector_key=selected.connector_key
       AND expected.stream=manifest.stream
     WHERE (manifest.created_at>=p_barrier_at OR manifest.extracted_at>=p_barrier_at)
       AND (
         expected.stream IS NULL
         OR manifest.connector_key IS DISTINCT FROM selected.connector_key
         OR manifest.connector_version IS DISTINCT FROM expected.pack_version
         OR manifest.api_version IS DISTINCT FROM expected.api_version
         OR run.connection_id IS DISTINCT FROM selected.connection_id
         OR run.stream IS DISTINCT FROM manifest.stream
       )
  ) THEN
    RAISE EXCEPTION 'dogfood raw manifests do not match the exact reviewed connector release'
      USING ERRCODE='55000';
  END IF;

  -- Required streams must all succeed on the candidate. Optional streams may
  -- be explicitly unavailable, but only with durable capability evidence and
  -- no failed/in-flight phase hidden behind that outcome.
  IF EXISTS (
    WITH selected AS (
      SELECT item.key AS connector_key,item.value AS connection_id,
             connection.connection_generation
        FROM jsonb_each_text(p_connections) item
        JOIN control_plane.connections connection
          ON connection.tenant_id=p_tenant_id
         AND connection.connection_id=item.value
         AND connection.connector_key=item.key
    )
    SELECT 1
      FROM selected
      JOIN control_plane.protected_dogfood_stream_expectation expected
        ON expected.connector_key=selected.connector_key
      JOIN LATERAL (
        SELECT bool_and(phase.status='succeeded' AND phase.completed_at>=p_barrier_at)
                 AS all_succeeded,
               bool_or(
                 phase.status='unavailable'
                 AND phase.completed_at>=p_barrier_at
                 AND phase.last_error->>'code'='capability_unavailable'
               ) AS has_evidenced_unavailable,
               bool_and(
                 phase.status IN ('succeeded','unavailable','planned')
                 AND CASE WHEN phase.status IN ('succeeded','unavailable')
                      THEN phase.completed_at>=p_barrier_at ELSE true END
               ) AS optional_terminal
          FROM control_plane.sync_stream_phases phase
         WHERE phase.tenant_id=p_tenant_id
           AND phase.connection_id=selected.connection_id
           AND phase.connection_generation=selected.connection_generation
           AND phase.stream=expected.stream
      ) state ON true
     WHERE CASE WHEN expected.required
            THEN NOT coalesce(state.all_succeeded,false)
            ELSE NOT (
              coalesce(state.all_succeeded,false)
              OR (
                coalesce(state.has_evidenced_unavailable,false)
                AND coalesce(state.optional_terminal,false)
              )
            )
          END
  ) THEN
    RAISE EXCEPTION 'dogfood stream phases are not terminal under the reviewed availability policy'
      USING ERRCODE='55000';
  END IF;

  -- Every fully available stream must have candidate-era raw, cursor and
  -- reconciliation evidence. Optional streams stopped by an explicit
  -- capability_unavailable result are the only exception.
  IF EXISTS (
    WITH selected AS (
      SELECT item.key AS connector_key,item.value AS connection_id,
             connection.connection_generation
        FROM jsonb_each_text(p_connections) item
        JOIN control_plane.connections connection
          ON connection.tenant_id=p_tenant_id
         AND connection.connection_id=item.value
         AND connection.connector_key=item.key
    )
    SELECT 1
      FROM selected
      JOIN control_plane.protected_dogfood_stream_expectation expected
        ON expected.connector_key=selected.connector_key
     WHERE NOT EXISTS (
       SELECT 1
         FROM control_plane.sync_stream_phases unavailable
        WHERE unavailable.tenant_id=p_tenant_id
          AND unavailable.connection_id=selected.connection_id
          AND unavailable.connection_generation=selected.connection_generation
          AND unavailable.stream=expected.stream
          AND unavailable.status='unavailable'
          AND unavailable.completed_at>=p_barrier_at
          AND unavailable.last_error->>'code'='capability_unavailable'
     )
       AND (
         NOT EXISTS (
           SELECT 1
             FROM control_plane.raw_batch_manifests manifest
             JOIN control_plane.raw_batch_landings landing
               ON landing.tenant_id=manifest.tenant_id
              AND landing.batch_id=manifest.batch_id
             JOIN control_plane.sync_runs run
               ON run.tenant_id=manifest.tenant_id
              AND run.sync_run_id=manifest.sync_run_id
            WHERE manifest.tenant_id=p_tenant_id
              AND manifest.connection_id=selected.connection_id
              AND manifest.connector_key=selected.connector_key
              AND manifest.connector_version=expected.pack_version
              AND manifest.api_version=expected.api_version
              AND manifest.stream=expected.stream
              AND manifest.created_at>=p_barrier_at
              AND manifest.extracted_at>=p_barrier_at
              AND run.connection_id=selected.connection_id
              AND run.stream=expected.stream
              AND run.connection_generation=selected.connection_generation
              AND run.status='succeeded'
              AND run.finished_at>=p_barrier_at
              AND landing.status='landed'
              AND landing.analytical_committed_at>=p_barrier_at
         )
         OR NOT EXISTS (
           SELECT 1
             FROM control_plane.stream_cursors cursor_row
            WHERE cursor_row.tenant_id=p_tenant_id
              AND cursor_row.connection_id=selected.connection_id
              AND cursor_row.connection_generation=selected.connection_generation
              AND cursor_row.stream=expected.stream
              AND cursor_row.backfill_complete
              AND cursor_row.last_successful_sync_at>=p_barrier_at
         )
         OR NOT EXISTS (
           SELECT 1
             FROM control_plane.reconciliation_stream_sweeps sweep
            WHERE sweep.tenant_id=p_tenant_id
              AND sweep.connection_id=selected.connection_id
              AND sweep.connection_generation=selected.connection_generation
              AND sweep.stream=expected.stream
              AND sweep.required=expected.required
              AND sweep.connector_id=selected.connector_key
              AND cardinality(sweep.domains)=cardinality(expected.domains)
              AND ARRAY(
                SELECT domain_name.value
                  FROM unnest(sweep.domains) AS domain_name(value)
                 ORDER BY domain_name.value
              )=expected.domains
              AND sweep.late_edit_strategy=expected.late_edit_strategy
              AND sweep.deletion_strategy=expected.deletion_strategy
              AND sweep.source_total_strategy=expected.source_total_strategy
              AND sweep.status='complete'
              AND sweep.completed_at>=p_barrier_at
              AND NOT EXISTS (
                SELECT 1
                  FROM control_plane.reconciliation_stream_sweeps newer
                 WHERE newer.tenant_id=sweep.tenant_id
                   AND newer.connection_id=sweep.connection_id
                   AND newer.connection_generation=sweep.connection_generation
                   AND newer.stream=sweep.stream
                   AND (newer.created_at,newer.reconciliation_sweep_id)>
                       (sweep.created_at,sweep.reconciliation_sweep_id)
              )
         )
       )
  ) THEN
    RAISE EXCEPTION 'dogfood manifest streams lack candidate raw, cursor or reconciliation evidence'
      USING ERRCODE='55000';
  END IF;

  -- A complete quality map is only candidate evidence when its oldest check
  -- and its snapshot were produced after the final terminal/raw/cursor/sweep
  -- observation for the full reviewed inventory. An explicitly unavailable
  -- optional stream contributes its terminal phase time but, by policy, no
  -- fabricated raw/cursor/reconciliation evidence.
  WITH selected AS (
    SELECT item.key AS connector_key,item.value AS connection_id,
           connection.connection_generation
      FROM jsonb_each_text(p_connections) item
      JOIN control_plane.connections connection
        ON connection.tenant_id=p_tenant_id
       AND connection.connection_id=item.value
       AND connection.connector_key=item.key
  ), available AS (
    SELECT selected.*,expected.stream,expected.pack_version,expected.api_version,
           expected.required,expected.domains,expected.late_edit_strategy,
           expected.deletion_strategy,expected.source_total_strategy
      FROM selected
      JOIN control_plane.protected_dogfood_stream_expectation expected
        ON expected.connector_key=selected.connector_key
     WHERE NOT EXISTS (
       SELECT 1
         FROM control_plane.sync_stream_phases unavailable
        WHERE unavailable.tenant_id=p_tenant_id
          AND unavailable.connection_id=selected.connection_id
          AND unavailable.connection_generation=selected.connection_generation
          AND unavailable.stream=expected.stream
          AND unavailable.status='unavailable'
          AND unavailable.completed_at>=p_barrier_at
          AND unavailable.last_error->>'code'='capability_unavailable'
     )
  ), evidence(evidence_at) AS (
    SELECT phase.completed_at
      FROM selected
      JOIN control_plane.protected_dogfood_stream_expectation expected
        ON expected.connector_key=selected.connector_key
      JOIN control_plane.sync_stream_phases phase
        ON phase.tenant_id=p_tenant_id
       AND phase.connection_id=selected.connection_id
       AND phase.connection_generation=selected.connection_generation
       AND phase.stream=expected.stream
     WHERE phase.status IN ('succeeded','unavailable')
       AND phase.completed_at>=p_barrier_at
    UNION ALL
    SELECT greatest(
             manifest.created_at,manifest.extracted_at,run.finished_at,
             landing.analytical_committed_at
           )
      FROM available
      JOIN control_plane.raw_batch_manifests manifest
        ON manifest.tenant_id=p_tenant_id
       AND manifest.connection_id=available.connection_id
       AND manifest.connector_key=available.connector_key
       AND manifest.connector_version=available.pack_version
       AND manifest.api_version=available.api_version
       AND manifest.stream=available.stream
      JOIN control_plane.raw_batch_landings landing
        ON landing.tenant_id=manifest.tenant_id
       AND landing.batch_id=manifest.batch_id
      JOIN control_plane.sync_runs run
        ON run.tenant_id=manifest.tenant_id
       AND run.sync_run_id=manifest.sync_run_id
       AND run.connection_id=available.connection_id
       AND run.connection_generation=available.connection_generation
       AND run.stream=available.stream
     WHERE manifest.created_at>=p_barrier_at
       AND manifest.extracted_at>=p_barrier_at
       AND run.status='succeeded'
       AND run.finished_at>=p_barrier_at
       AND landing.status='landed'
       AND landing.analytical_committed_at>=p_barrier_at
    UNION ALL
    SELECT cursor_row.last_successful_sync_at
      FROM available
      JOIN control_plane.stream_cursors cursor_row
        ON cursor_row.tenant_id=p_tenant_id
       AND cursor_row.connection_id=available.connection_id
       AND cursor_row.connection_generation=available.connection_generation
       AND cursor_row.stream=available.stream
     WHERE cursor_row.backfill_complete
       AND cursor_row.last_successful_sync_at>=p_barrier_at
    UNION ALL
    SELECT greatest(sweep.created_at,sweep.completed_at)
      FROM available
      JOIN control_plane.reconciliation_stream_sweeps sweep
        ON sweep.tenant_id=p_tenant_id
       AND sweep.connection_id=available.connection_id
       AND sweep.connection_generation=available.connection_generation
       AND sweep.stream=available.stream
       AND sweep.required=available.required
       AND sweep.connector_id=available.connector_key
       AND cardinality(sweep.domains)=cardinality(available.domains)
       AND ARRAY(
         SELECT domain_name.value
           FROM unnest(sweep.domains) AS domain_name(value)
          ORDER BY domain_name.value
       )=available.domains
       AND sweep.late_edit_strategy=available.late_edit_strategy
       AND sweep.deletion_strategy=available.deletion_strategy
       AND sweep.source_total_strategy=available.source_total_strategy
     WHERE sweep.status='complete'
       AND sweep.completed_at>=p_barrier_at
       AND NOT EXISTS (
         SELECT 1
           FROM control_plane.reconciliation_stream_sweeps newer
          WHERE newer.tenant_id=sweep.tenant_id
            AND newer.connection_id=sweep.connection_id
            AND newer.connection_generation=sweep.connection_generation
            AND newer.stream=sweep.stream
            AND (newer.created_at,newer.reconciliation_sweep_id)>
                (sweep.created_at,sweep.reconciliation_sweep_id)
       )
  )
  SELECT max(evidence_at) INTO candidate_evidence_at FROM evidence;

  SELECT max(stat.snapshot_at) INTO latest_snapshot
    FROM control_plane.pipeline_stats stat
   WHERE stat.tenant_id=p_tenant_id
     AND stat.snapshot_at>=p_barrier_at
     AND stat.snapshot_at<=clock_timestamp()
     AND stat.created_at>=p_barrier_at
     AND stat.created_at<=clock_timestamp();
  SELECT jsonb_object_agg(expected.check_id,'passed' ORDER BY expected.check_id)
    INTO required_quality
    FROM control_plane.protected_dogfood_quality_expectation expected;
  SELECT min(stat.quality_run_id),max(stat.quality_run_id),
         min(stat.quality_checked_at),max(stat.quality_checked_at),
         min(stat.snapshot_table_count),max(stat.snapshot_table_count),
         min(stat.snapshot_inventory_hash),max(stat.snapshot_inventory_hash)
    INTO quality_run_min,quality_run_max,quality_checked_min,quality_checked_max,
         declared_table_count_min,declared_table_count_max,
         declared_inventory_hash_min,declared_inventory_hash_max
    FROM control_plane.pipeline_stats stat
   WHERE stat.tenant_id=p_tenant_id
     AND stat.snapshot_at=latest_snapshot;

  SELECT count(*)::integer,
         encode(extensions.digest(convert_to(
           jsonb_agg(
             jsonb_build_array(stat.schema_name,stat.table_name)
             ORDER BY stat.schema_name COLLATE "C",stat.table_name COLLATE "C"
           )::text,
           'UTF8'
         ),'sha256'),'hex')
    INTO actual_table_count,actual_inventory_hash
    FROM control_plane.pipeline_stats stat
   WHERE stat.tenant_id=p_tenant_id
     AND stat.snapshot_at=latest_snapshot;

  IF latest_snapshot IS NOT NULL AND (
       declared_table_count_min IS NULL
       OR declared_table_count_min IS DISTINCT FROM declared_table_count_max
       OR declared_table_count_min IS DISTINCT FROM actual_table_count
       OR declared_inventory_hash_min IS NULL
       OR declared_inventory_hash_min IS DISTINCT FROM declared_inventory_hash_max
       OR declared_inventory_hash_min IS DISTINCT FROM actual_inventory_hash
       OR EXISTS (
         SELECT 1
           FROM control_plane.pipeline_stats stat
          WHERE stat.tenant_id=p_tenant_id
            AND stat.snapshot_at=latest_snapshot
            AND (
              stat.snapshot_table_count IS DISTINCT FROM declared_table_count_min
              OR stat.snapshot_inventory_hash IS DISTINCT FROM declared_inventory_hash_min
            )
       )
     ) THEN
    RAISE EXCEPTION 'dogfood pipeline snapshot inventory is incomplete or substituted'
      USING ERRCODE='55000';
  END IF;

  IF latest_snapshot IS NULL
     OR candidate_evidence_at IS NULL
     OR candidate_evidence_at>clock_timestamp()
     OR latest_snapshot<candidate_evidence_at
     OR required_quality IS NULL
     OR quality_run_min IS NULL
     OR quality_run_min IS DISTINCT FROM quality_run_max
     OR quality_checked_min IS NULL
     OR quality_checked_min IS DISTINCT FROM quality_checked_max
     OR quality_checked_min<p_barrier_at
     OR quality_checked_min<candidate_evidence_at
     OR quality_checked_min>clock_timestamp()
     OR latest_snapshot<quality_checked_min
     OR EXISTS (
    SELECT 1
      FROM control_plane.pipeline_stats stat
     WHERE stat.tenant_id=p_tenant_id
       AND stat.snapshot_at=latest_snapshot
       AND (
         stat.created_at<p_barrier_at
         OR stat.created_at<candidate_evidence_at
         OR stat.created_at>clock_timestamp()
         OR stat.invariant_status IS DISTINCT FROM required_quality
         OR stat.quality_run_id IS DISTINCT FROM quality_run_min
         OR stat.quality_checked_at IS DISTINCT FROM quality_checked_min
       )
  ) OR NOT EXISTS (
    SELECT 1 FROM control_plane.pipeline_stats stat
     WHERE stat.tenant_id=p_tenant_id AND stat.snapshot_at=latest_snapshot
  ) OR NOT EXISTS (
    SELECT 1
      FROM control_plane.sync_runs run
      JOIN jsonb_each_text(p_connections) selected(connector_key,connection_id)
        ON selected.connection_id=run.connection_id
      JOIN control_plane.connections connection
        ON connection.tenant_id=run.tenant_id
       AND connection.connection_id=run.connection_id
       AND connection.connector_key=selected.connector_key
       AND connection.connection_generation=run.connection_generation
      JOIN control_plane.protected_dogfood_stream_expectation expected
        ON expected.connector_key=selected.connector_key
       AND expected.stream=run.stream
      JOIN control_plane.raw_batch_manifests manifest
        ON manifest.tenant_id=run.tenant_id
       AND manifest.sync_run_id=run.sync_run_id
       AND manifest.connection_id=run.connection_id
       AND manifest.connector_key=selected.connector_key
       AND manifest.connector_version=expected.pack_version
       AND manifest.api_version=expected.api_version
       AND manifest.stream=run.stream
      JOIN control_plane.raw_batch_landings landing
        ON landing.tenant_id=manifest.tenant_id
       AND landing.batch_id=manifest.batch_id
     WHERE run.tenant_id=p_tenant_id
       AND run.sync_run_id=quality_run_min
       AND run.status='succeeded'
       AND run.finished_at>=p_barrier_at
       AND run.finished_at<=clock_timestamp()
       AND manifest.created_at>=p_barrier_at
       AND manifest.created_at<=clock_timestamp()
       AND manifest.extracted_at>=p_barrier_at
       AND manifest.extracted_at<=clock_timestamp()
       AND landing.status='landed'
       AND landing.analytical_committed_at>=p_barrier_at
       AND landing.analytical_committed_at<=clock_timestamp()
  ) THEN
    RAISE EXCEPTION 'dogfood quality snapshot is not bound to the exact candidate-era passing check set'
      USING ERRCODE='55000';
  END IF;
END;
$$;

-- Keep the original collector renamed out of public reach even on a database
-- where 0062's hardening was bypassed. On a sequentially migrated database the
-- rename already happened and this block is a no-op.
DO $rename$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc proc
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid=proc.pronamespace
     WHERE namespace.nspname='control_plane'
       AND proc.proname='capture_protected_dogfood_acceptance'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc proc
      JOIN pg_catalog.pg_namespace namespace ON namespace.oid=proc.pronamespace
     WHERE namespace.nspname='control_plane'
       AND proc.proname='capture_protected_dogfood_acceptance_v1'
  ) THEN
    ALTER FUNCTION control_plane.capture_protected_dogfood_acceptance(
      text,text,text,jsonb,text,integer,text,text,text,text,text
    ) RENAME TO capture_protected_dogfood_acceptance_v1;
  END IF;
END
$rename$;

CREATE OR REPLACE FUNCTION control_plane.capture_protected_dogfood_acceptance_v2(
  p_candidate_sha text,
  p_deployment_id text,
  p_dogfood_tenant_id text,
  p_connections jsonb,
  p_onboarding_tenant_id text,
  p_onboarding_target_minutes integer,
  p_flagship_answer_artifact_id text,
  p_category_answer_artifact_id text,
  p_category_topic text,
  p_disconnect_proof_id text,
  p_tenant_deletion_proof_id text
) RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path=pg_catalog
AS $$
DECLARE snapshot jsonb;
DECLARE barrier_at timestamptz;
BEGIN
  snapshot:=control_plane.capture_protected_dogfood_acceptance_v1(
    p_candidate_sha,p_deployment_id,p_dogfood_tenant_id,p_connections,
    p_onboarding_tenant_id,p_onboarding_target_minutes,
    p_flagship_answer_artifact_id,p_category_answer_artifact_id,p_category_topic,
    p_disconnect_proof_id,p_tenant_deletion_proof_id
  );
  barrier_at:=(snapshot->'evidence'->'deployment'->>'barrierAt')::timestamptz;
  PERFORM control_plane.assert_protected_dogfood_manifest_and_quality(
    p_dogfood_tenant_id,p_connections,barrier_at
  );
  RETURN snapshot;
END;
$$;

REVOKE ALL ON TABLE
  control_plane.protected_dogfood_stream_expectation,
  control_plane.protected_dogfood_quality_expectation
FROM PUBLIC,anon,authenticated,service_role,albert_operator_diagnostic_control;
REVOKE ALL ON TABLE
  control_plane.protected_dogfood_stream_expectation,
  control_plane.protected_dogfood_quality_expectation
FROM albert_sync_control,albert_webhook_control,albert_transform_control,
     albert_semantic_control,albert_deletion_control;
REVOKE ALL ON FUNCTION
  control_plane.assert_protected_dogfood_manifest_and_quality(text,jsonb,timestamptz),
  control_plane.capture_protected_dogfood_acceptance_v1(
    text,text,text,jsonb,text,integer,text,text,text,text,text
  ),
  control_plane.capture_protected_dogfood_acceptance_v2(
    text,text,text,jsonb,text,integer,text,text,text,text,text
  ),
  control_plane.capture_protected_dogfood_acceptance(
    text,text,text,jsonb,text,integer,text,text,text,text,text,text
  )
FROM PUBLIC,anon,authenticated,service_role,albert_sync_control,
     albert_webhook_control,albert_transform_control,albert_semantic_control,
     albert_deletion_control,albert_operator_diagnostic_control;
GRANT EXECUTE ON FUNCTION control_plane.capture_protected_dogfood_acceptance(
  text,text,text,jsonb,text,integer,text,text,text,text,text,text
) TO albert_operator_diagnostic_control;

COMMIT;
