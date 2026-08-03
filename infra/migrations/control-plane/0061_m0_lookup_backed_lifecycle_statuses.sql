BEGIN;

-- Albert's lifecycle vocabulary is data, not executable DDL. Keep each
-- independent state machine behind its own lookup so adding a state remains a
-- reviewed data migration and unrelated workflows cannot accidentally share
-- semantics just because their current labels overlap.
CREATE TABLE IF NOT EXISTS control_plane.identity_decision_projection_status_lookup (
  status text PRIMARY KEY,
  description text NOT NULL
);

CREATE TABLE IF NOT EXISTS control_plane.operator_diagnostic_reveal_outcome_status_lookup (
  status text PRIMARY KEY,
  description text NOT NULL
);

CREATE TABLE IF NOT EXISTS control_plane.reconciliation_stream_sweep_status_lookup (
  status text PRIMARY KEY,
  description text NOT NULL
);

CREATE TABLE IF NOT EXISTS control_plane.progressive_stream_coverage_status_lookup (
  status text PRIMARY KEY,
  description text NOT NULL
);

INSERT INTO control_plane.identity_decision_projection_status_lookup (status,description) VALUES
  ('queued','Projection is durably queued and available to a transform worker'),
  ('running','A transform worker owns the active projection lease'),
  ('retry_wait','Projection is waiting for its bounded retry delay'),
  ('succeeded','Projection was applied to the analytical identity graph'),
  ('failed','Projection exhausted retries or encountered a terminal failure')
ON CONFLICT (status) DO UPDATE SET description=excluded.description;

INSERT INTO control_plane.operator_diagnostic_reveal_outcome_status_lookup (status,description) VALUES
  ('completed','The one-use diagnostic reveal completed without an error'),
  ('failed','The one-use diagnostic reveal failed with a code-only error')
ON CONFLICT (status) DO UPDATE SET description=excluded.description;

INSERT INTO control_plane.reconciliation_stream_sweep_status_lookup (status,description) VALUES
  ('planned','The next reconciliation phase is planned but not leased'),
  ('running','A sync worker owns the active reconciliation phase lease'),
  ('complete','Every required reconciliation phase completed'),
  ('blocked','Reconciliation requires explicit recovery or operator intervention')
ON CONFLICT (status) DO UPDATE SET description=excluded.description;

INSERT INTO control_plane.progressive_stream_coverage_status_lookup (status,description) VALUES
  ('pending','Recent coverage is not yet safe for governed queries'),
  ('queryable','Recent coverage passed its progressive publication barriers'),
  ('degraded','Recent coverage is queryable only with a disclosed limitation'),
  ('superseded','A newer connection generation superseded this coverage')
ON CONFLICT (status) DO UPDATE SET description=excluded.description;

-- Install and validate the foreign keys while the original literal checks
-- still protect writes. Only then remove the duplicated DDL vocabulary.
ALTER TABLE control_plane.identity_decision_projection_outbox
  DROP CONSTRAINT IF EXISTS identity_decision_projection_outbox_status_fkey;
ALTER TABLE control_plane.identity_decision_projection_outbox
  ADD CONSTRAINT identity_decision_projection_outbox_status_fkey
  FOREIGN KEY (status)
  REFERENCES control_plane.identity_decision_projection_status_lookup(status)
  NOT VALID;
ALTER TABLE control_plane.identity_decision_projection_outbox
  VALIDATE CONSTRAINT identity_decision_projection_outbox_status_fkey;
ALTER TABLE control_plane.identity_decision_projection_outbox
  DROP CONSTRAINT IF EXISTS identity_decision_projection_outbox_status_check;

ALTER TABLE control_plane.operator_diagnostic_reveal_outcomes
  DROP CONSTRAINT IF EXISTS operator_diagnostic_reveal_outcomes_status_fkey;
ALTER TABLE control_plane.operator_diagnostic_reveal_outcomes
  ADD CONSTRAINT operator_diagnostic_reveal_outcomes_status_fkey
  FOREIGN KEY (status)
  REFERENCES control_plane.operator_diagnostic_reveal_outcome_status_lookup(status)
  NOT VALID;
ALTER TABLE control_plane.operator_diagnostic_reveal_outcomes
  VALIDATE CONSTRAINT operator_diagnostic_reveal_outcomes_status_fkey;
ALTER TABLE control_plane.operator_diagnostic_reveal_outcomes
  DROP CONSTRAINT IF EXISTS operator_diagnostic_reveal_outcomes_status_check;

ALTER TABLE control_plane.reconciliation_stream_sweeps
  DROP CONSTRAINT IF EXISTS reconciliation_stream_sweeps_status_fkey;
ALTER TABLE control_plane.reconciliation_stream_sweeps
  ADD CONSTRAINT reconciliation_stream_sweeps_status_fkey
  FOREIGN KEY (status)
  REFERENCES control_plane.reconciliation_stream_sweep_status_lookup(status)
  NOT VALID;
ALTER TABLE control_plane.reconciliation_stream_sweeps
  VALIDATE CONSTRAINT reconciliation_stream_sweeps_status_fkey;
ALTER TABLE control_plane.reconciliation_stream_sweeps
  DROP CONSTRAINT IF EXISTS reconciliation_stream_sweeps_status_check;

ALTER TABLE control_plane.progressive_stream_coverage
  DROP CONSTRAINT IF EXISTS progressive_stream_coverage_status_fkey;
ALTER TABLE control_plane.progressive_stream_coverage
  ADD CONSTRAINT progressive_stream_coverage_status_fkey
  FOREIGN KEY (status)
  REFERENCES control_plane.progressive_stream_coverage_status_lookup(status)
  NOT VALID;
ALTER TABLE control_plane.progressive_stream_coverage
  VALIDATE CONSTRAINT progressive_stream_coverage_status_fkey;
ALTER TABLE control_plane.progressive_stream_coverage
  DROP CONSTRAINT IF EXISTS progressive_stream_coverage_status_check;

-- Receipt state mirrors deletion_requests exactly, including the approval and
-- retry states added by migration 0006, so it intentionally reuses that one
-- existing lifecycle vocabulary rather than creating a duplicate lookup.
ALTER TABLE control_plane.tenant_deletion_receipts
  DROP CONSTRAINT IF EXISTS tenant_deletion_receipts_status_fkey;
ALTER TABLE control_plane.tenant_deletion_receipts
  ADD CONSTRAINT tenant_deletion_receipts_status_fkey
  FOREIGN KEY (status)
  REFERENCES control_plane.deletion_request_status_lookup(status)
  NOT VALID;
ALTER TABLE control_plane.tenant_deletion_receipts
  VALIDATE CONSTRAINT tenant_deletion_receipts_status_fkey;
ALTER TABLE control_plane.tenant_deletion_receipts
  DROP CONSTRAINT IF EXISTS tenant_deletion_receipts_status_check;

REVOKE ALL ON TABLE
  control_plane.identity_decision_projection_status_lookup,
  control_plane.operator_diagnostic_reveal_outcome_status_lookup,
  control_plane.reconciliation_stream_sweep_status_lookup,
  control_plane.progressive_stream_coverage_status_lookup
FROM PUBLIC,anon,authenticated,service_role,
     albert_sync_control,albert_webhook_control,albert_transform_control,
     albert_semantic_control,albert_operator_diagnostic_control,
     albert_deletion_control;

COMMIT;
