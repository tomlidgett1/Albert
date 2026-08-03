import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const analyticalMigrationUrl = new URL(
  "infra/migrations/analytical/0102_m4_quality_run_bound_pipeline_snapshots.sql",
  root,
);
const controlMigrationUrl = new URL(
  "infra/migrations/control-plane/0062_m3_m4_manifest_and_quality_dogfood_gate.sql",
  root,
);

test("candidate pipeline snapshots require one exact quality run", async () => {
  const sql = await readFile(analyticalMigrationUrl, "utf8");
  assert.match(sql, /quality_run_id text/u);
  assert.match(sql, /quality_checked_at timestamptz/u);
  assert.match(sql, /snapshot_table_count integer/u);
  assert.match(sql, /snapshot_inventory_hash text/u);
  assert.match(sql, /snapshot_inventory_hash IS NOT NULL[\s\S]*?snapshot_inventory_hash ~ '\^\[0-9a-f\]\{64\}\$'/u);
  assert.match(
    sql,
    /FUNCTION semantic_internal\.pipeline_table_inventory_hash\([\s\S]*?SECURITY DEFINER[\s\S]*?extensions\.digest\([\s\S]*?'sha256'/u,
  );
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION semantic_internal\.pipeline_table_inventory_hash\(jsonb\)[\s\S]*?TO transform_rw/u,
  );
  assert.match(
    sql,
    /CREATE OR REPLACE FUNCTION quality\.snapshot_all_pipeline_stats\([\s\S]*?p_quality_run_id text[\s\S]*?\) RETURNS void/u,
  );
  assert.match(
    sql,
    /expectation\.required AND expectation\.blocks_readiness/u,
  );
  assert.match(sql, /result_count<>expected_count/u);
  assert.match(sql, /p_tenant_id IS NULL[\s\S]*?p_tenant_id IS DISTINCT FROM core\.current_tenant_id\(\)/u);
  assert.match(sql, /run_checked_max>clock_timestamp\(\)/u);
  assert.match(sql, /p_snapshot_at<run_checked_max/u);
  assert.match(sql, /refresh_connector_quality_rollup\(text,text\)[\s\S]*?TO transform_rw/u);
  assert.match(sql, /pipeline snapshot timestamp already exists/u);
  assert.match(sql, /projection\.invariant_status IS DISTINCT FROM run_status_map/u);
  assert.match(
    sql,
    /pipeline_table_inventory_hash\([\s\S]*?jsonb_agg\([\s\S]*?jsonb_build_array\(projection\.schema_name,projection\.table_name\)[\s\S]*?ORDER BY projection\.schema_name COLLATE "C",[\s\S]*?projection\.table_name COLLATE "C"/u,
  );
  assert.match(
    sql,
    /SET quality_run_id=p_quality_run_id,[\s\S]*?quality_checked_at=run_checked_at,[\s\S]*?snapshot_table_count=projected_table_count,[\s\S]*?snapshot_inventory_hash=projected_inventory_hash/u,
  );
  assert.match(
    sql,
    /pipeline_table_stats_projection_outbox[\s\S]*?NO FORCE ROW LEVEL SECURITY;[\s\S]*?VALIDATE CONSTRAINT pipeline_table_stats_quality_attestation_valid;[\s\S]*?pipeline_table_stats_projection_outbox[\s\S]*?FORCE ROW LEVEL SECURITY;/u,
  );
});

test("the worker attests transform snapshots but leaves maintenance unattested", async () => {
  const worker = await readFile(
    new URL("services/sync-workers/src/canonical-pipeline.ts", root),
    "utf8",
  );
  assert.match(
    worker,
    /snapshot_all_pipeline_stats\(\$1,\$2::timestamptz,\$3::text\[\],\$4::jsonb,\$5::text\)[\s\S]{0,240}job\.syncRunId/u,
  );
  assert.match(
    worker,
    /refresh_connector_quality_rollup\(\$1,\$2\)[\s\S]{0,320}run_all_invariants\(\$1,\$2\)[\s\S]*?record_canonical_mapping_quality\(\$1,\$2,\$3::bigint,\$4::bigint\)[\s\S]*?select clock_timestamp\(\)::text as snapshot_at[\s\S]*?const snapshotAt=snapshotClock\.rows\[0\]\?\.snapshot_at/u,
    "candidate connector checks must be refreshed after the durable sync-run commit",
  );
  assert.match(
    worker,
    /kind:"pipeline_snapshot"[\s\S]*?snapshot_all_pipeline_stats\(\$1,\$2::timestamptz,\$3::text\[\],\$4::jsonb\)/u,
    "hourly maintenance must keep using the unattested overload",
  );
  assert.match(
    worker,
    /invariant_status,quality_run_id,quality_checked_at,snapshot_table_count,snapshot_inventory_hash\) values/u,
  );
});

test("the protected M4 gate binds quality time and run to the candidate generation", async () => {
  const sql = await readFile(controlMigrationUrl, "utf8");
  assert.match(sql, /pipeline_stats_quality_attestation_valid/u);
  assert.match(sql, /quality_run_min IS DISTINCT FROM quality_run_max/u);
  assert.match(sql, /quality_checked_min IS DISTINCT FROM quality_checked_max/u);
  assert.match(sql, /quality_checked_min<p_barrier_at/u);
  assert.match(sql, /quality_checked_min<candidate_evidence_at/u);
  assert.match(sql, /latest_snapshot<candidate_evidence_at/u);
  assert.match(sql, /latest_snapshot<quality_checked_min/u);
  assert.match(sql, /declared_table_count_min IS DISTINCT FROM actual_table_count/u);
  assert.match(sql, /declared_inventory_hash_min IS DISTINCT FROM actual_inventory_hash/u);
  assert.match(sql, /dogfood pipeline snapshot inventory is incomplete or substituted/u);
  assert.match(sql, /run\.sync_run_id=quality_run_min/u);
  assert.match(sql, /connection\.connection_generation=run\.connection_generation/u);
  assert.match(sql, /run\.finished_at>=p_barrier_at/u);
});

test("SQL CI proves exact runs and the maintenance fail-closed boundary", async () => {
  const [workflow, proof] = await Promise.all([
    readFile(new URL(".github/workflows/ci.yml", root), "utf8"),
    readFile(
      new URL("tests/sql/analytical-quality-run-bound-pipeline-stats.sql", root),
      "utf8",
    ),
  ]);
  assert.match(workflow, /analytical-quality-run-bound-pipeline-stats\.sql/u);
  for (const phrase of [
    "exact quality run",
    "maintenance snapshot acquired candidate quality attestation",
    "incomplete quality run",
    "future-dated quality results",
    "snapshot predating quality run completion",
    "unreviewed extra quality result",
    "snapshot_table_count IS DISTINCT FROM projected_count",
    "has_schema_privilege",
  ]) assert.ok(proof.includes(phrase), `missing behavioral proof: ${phrase}`);
});
