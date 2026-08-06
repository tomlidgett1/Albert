-- Register Lightspeed R-Series pack 2.0.0 as the activation candidate.
--
-- Releases are migration-owned rows: a worker deployed with a pack version
-- the release table has never heard of is refused by name
-- (connector_pack_unregistered), which is exactly what stopped the first
-- 90-stream backfill. Registering 2.0.0 as candidate lets its writes route
-- into the versioned shadow snapshots while 1.1.0 remains the active read
-- surface; activation flips atomically once the candidate's capability and
-- source-field snapshots cover the predecessor's.
--
-- The requirements pin what 2.0.0 exists to deliver: the split sale walk
-- (header, lines, tenders as first-class streams) and the purchase-order
-- topology on its spec streams. An operator cannot activate after replaying
-- only part of the split.

BEGIN;

INSERT INTO semantic_internal.connector_pack_release (
  connector_id,pack_version,release_sequence,predecessor_version,state,
  registered_by_migration,activated_at
) VALUES
  ('lightspeed-r','2.0.0',3,'1.1.0','candidate',
   '0126_m5_lightspeed_pack_2_release.sql',NULL)
ON CONFLICT (connector_id,pack_version) DO NOTHING;

INSERT INTO semantic_internal.connector_pack_release_requirement (
  connector_id,pack_version,requirement_kind,requirement_value
) VALUES
  ('lightspeed-r','2.0.0','capability','commerce.order_lines'),
  ('lightspeed-r','2.0.0','capability','commerce.payments'),
  ('lightspeed-r','2.0.0','capability','inventory.purchase_orders'),
  ('lightspeed-r','2.0.0','source_table','ls_sales'),
  ('lightspeed-r','2.0.0','source_table','ls_sale_lines'),
  ('lightspeed-r','2.0.0','source_table','ls_sale_payments'),
  ('lightspeed-r','2.0.0','source_table','ls_vendors'),
  ('lightspeed-r','2.0.0','source_table','ls_purchase_order_lines')
ON CONFLICT DO NOTHING;

COMMIT;
