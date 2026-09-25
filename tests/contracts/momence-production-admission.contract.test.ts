import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

test("Momence is admitted through every durable analytical runtime boundary", async () => {
  const migration = await readFile(
    new URL("infra/migrations/analytical/0145_m3_momence_production_admission.sql", root),
    "utf8",
  );

  for (const relation of [
    "quality.connector_check_observation",
    "quality.connector_stream_state",
    "quality.reconciliation_snapshot",
    "ingestion.canonical_staging_batch_records",
    "semantic_internal.canonical_transform_commits",
    "semantic_internal.connector_pack_release",
  ]) {
    assert.match(migration, new RegExp(`ALTER TABLE ${relation.replaceAll(".", "\\.")}`, "u"));
  }
  assert.match(
    migration,
    /CHECK \(connector_id IN \('lightspeed-r','xero','deputy','momence'\)\)/u,
  );
  assert.match(migration, /'momence','1\.0\.0',1,NULL,'active'/u);
  assert.match(migration, /0145_m3_momence_production_admission\.sql/u);

  for (const runtimeFunction of [
    "register_connector_streams",
    "record_reconciliation_snapshot_page",
    "publish_connector_quality_results",
    "publish_connector_capability_observations",
  ]) {
    assert.match(migration, new RegExp(runtimeFunction, "u"));
  }
  assert.match(migration, /CREATE OR REPLACE preserves each function's owner, grants/u);
  assert.match(migration, /patched_count<>4/u);
});
