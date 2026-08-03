BEGIN;

-- Reconciliation snapshots are an independent analytical lifecycle. A
-- dedicated lookup keeps the vocabulary extensible without coupling it to
-- quality-check outcomes, which have materially different semantics.
CREATE TABLE IF NOT EXISTS quality.reconciliation_snapshot_status_lookup (
  value text PRIMARY KEY,
  description text NOT NULL
);

INSERT INTO quality.reconciliation_snapshot_status_lookup (value,description) VALUES
  ('running','The snapshot identity scan is still accepting pages'),
  ('complete','The snapshot scan completed with its terminal evidence'),
  ('failed','The snapshot scan terminated without complete evidence')
ON CONFLICT (value) DO UPDATE SET description=excluded.description;

-- Validate existing rows under the lookup while the original literal check
-- remains active, then remove that duplicated DDL vocabulary.
ALTER TABLE quality.reconciliation_snapshot
  DROP CONSTRAINT IF EXISTS reconciliation_snapshot_status_fkey;
ALTER TABLE quality.reconciliation_snapshot
  ADD CONSTRAINT reconciliation_snapshot_status_fkey
  FOREIGN KEY (status)
  REFERENCES quality.reconciliation_snapshot_status_lookup(value)
  NOT VALID;
ALTER TABLE quality.reconciliation_snapshot
  VALIDATE CONSTRAINT reconciliation_snapshot_status_fkey;
ALTER TABLE quality.reconciliation_snapshot
  DROP CONSTRAINT IF EXISTS reconciliation_snapshot_status_check;

REVOKE ALL ON TABLE quality.reconciliation_snapshot_status_lookup
  FROM PUBLIC,ingest_rw,semantic_ro,semantic_meta_rw,deletion_rw;
GRANT SELECT ON TABLE quality.reconciliation_snapshot_status_lookup
  TO transform_rw,diagnostic_ro;

COMMIT;
