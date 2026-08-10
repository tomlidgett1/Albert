import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("snapshot migration receipts are immutable release-only evidence", async () => {
  const migration = await readFile(
    new URL("../../infra/migrations/control-plane/0110_semantic_v2_snapshot_migration_receipts.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /semantic_v2_snapshot_migration_receipts/u);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/u);
  assert.match(migration, /TO albert_control_migration_owner/u);
  assert.match(migration, /prevent_semantic_v2_immutable_mutation/u);
  assert.match(migration, /artifact->>'receiptDigest'=receipt_digest/u);
  assert.doesNotMatch(migration, /GRANT[^;]+(?:authenticated|service_role)/u);
});

test("snapshot receipt registration verifies content address and exact release binding", async () => {
  const source = await readFile(
    new URL("../../scripts/register-semantic-v2-snapshot-receipt.mts", import.meta.url),
    "utf8",
  );
  assert.match(source, /--execute/u);
  assert.match(source, /snapshotReceiptDigest\(body\)/u);
  assert.match(source, /ALBERT_ANALYTICAL_PROJECT_REF/u);
  assert.match(source, /SET LOCAL ROLE albert_control_migration_owner/u);
  assert.match(source, /enabled AND revoked_at IS NULL/u);
  assert.match(source, /ON CONFLICT \(receipt_digest\) DO NOTHING/u);
});
