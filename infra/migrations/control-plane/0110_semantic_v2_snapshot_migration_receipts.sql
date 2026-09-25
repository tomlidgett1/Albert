BEGIN;

-- A production-shaped analytical snapshot is release evidence, not a runtime
-- query artifact. Keep its content-addressed receipt in the control plane so
-- qualification can prove the exact source cell, target cell, tenant remap,
-- row counts, registry manifest and implementation commit without storing a
-- database dump or OAuth material.
CREATE TABLE control_plane.semantic_v2_snapshot_migration_receipts (
  receipt_digest text PRIMARY KEY CHECK (receipt_digest~'^[a-f0-9]{64}$'),
  semantic_manifest_hash text NOT NULL CHECK (semantic_manifest_hash~'^[a-f0-9]{64}$'),
  commit_sha text NOT NULL CHECK (commit_sha~'^[a-f0-9]{40}$'),
  analytical_project_ref text NOT NULL CHECK (analytical_project_ref~'^[a-z0-9]{20}$'),
  artifact jsonb NOT NULL CHECK (jsonb_typeof(artifact)='object'),
  registered_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (artifact->>'receiptDigest'=receipt_digest),
  CHECK (artifact->>'targetProjectRef'=analytical_project_ref),
  CHECK (artifact->>'kind'='albert.semantic-v2-analytical-snapshot-migration'),
  CHECK (artifact->>'status'='passed')
);

ALTER TABLE control_plane.semantic_v2_snapshot_migration_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE control_plane.semantic_v2_snapshot_migration_receipts FORCE ROW LEVEL SECURITY;

CREATE POLICY semantic_v2_snapshot_receipts_release_read
  ON control_plane.semantic_v2_snapshot_migration_receipts
  FOR SELECT TO albert_control_migration_owner
  USING (true);
CREATE POLICY semantic_v2_snapshot_receipts_release_append
  ON control_plane.semantic_v2_snapshot_migration_receipts
  FOR INSERT TO albert_control_migration_owner
  WITH CHECK (true);

CREATE TRIGGER semantic_v2_snapshot_receipts_immutable
BEFORE UPDATE OR DELETE ON control_plane.semantic_v2_snapshot_migration_receipts
FOR EACH ROW EXECUTE FUNCTION control_plane.prevent_semantic_v2_immutable_mutation();

REVOKE ALL ON control_plane.semantic_v2_snapshot_migration_receipts
  FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT ON control_plane.semantic_v2_snapshot_migration_receipts
  TO albert_control_migration_owner;

COMMIT;
