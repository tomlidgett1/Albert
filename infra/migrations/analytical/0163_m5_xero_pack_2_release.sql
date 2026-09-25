-- Register Xero pack 2.0.0 as the activation candidate.
--
-- The Xero manifest moved to packVersion 2.0.0 on 2026-08-06 (the 197-table
-- spec-driven stream set) but no release row followed, so the first real
-- Xero backfill through the connector worker was refused by name at the
-- capability/source-field publication guard (connector_pack_unregistered:
-- xero:2.0.0), which in turn left every affected batch un-landed and cascaded
-- into 'canonical transform batch is not durably landed'.
--
-- Same shape as the Lightspeed 2.0.0 registration (0126): candidate lets the
-- worker's evidence writes route into the versioned shadow snapshots while
-- 1.0.0 stays the nominal active pointer. V3 answers from source_xero directly
-- through Cube, so the active pointer has no read-side effect today;
-- activation remains an explicit operator step once the candidate's snapshots
-- cover the predecessor's.

BEGIN;

INSERT INTO semantic_internal.connector_pack_release (
  connector_id,pack_version,release_sequence,predecessor_version,state,
  registered_by_migration,activated_at
) VALUES
  ('xero','2.0.0',2,'1.0.0','candidate',
   '0163_m5_xero_pack_2_release.sql',NULL)
ON CONFLICT (connector_id,pack_version) DO NOTHING;

INSERT INTO semantic_internal.connector_pack_release_requirement (
  connector_id,pack_version,requirement_kind,requirement_value
) VALUES
  ('xero','2.0.0','source_table','xero_accounts'),
  ('xero','2.0.0','source_table','xero_contacts'),
  ('xero','2.0.0','source_table','xero_invoices'),
  ('xero','2.0.0','source_table','xero_invoice_line_items'),
  ('xero','2.0.0','source_table','xero_payments'),
  ('xero','2.0.0','source_table','xero_bank_transactions'),
  ('xero','2.0.0','source_table','xero_manual_journals')
ON CONFLICT DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM semantic_internal.connector_pack_release
     WHERE connector_id='xero' AND pack_version='2.0.0' AND state IN ('candidate','active')
  ) THEN
    RAISE EXCEPTION 'xero pack 2.0.0 was not registered';
  END IF;
END $$;

COMMIT;
