import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationPath = "infra/migrations/analytical/0080_m5_executable_quality_gates.sql";

test("mandatory V1 quality checks are registered and missing or stale evidence fails closed", async () => {
  const sql = await readFile(migrationPath, "utf8");
  const required = [
    "cursor_completeness",
    "scope_available",
    "retention_limit_recorded",
    "webhook_gap_recovered",
    "delete_handling",
    "schema_drift",
    "enum_drift",
    "pk_unique",
    "orphan_rate",
    "status_mapping_total",
    "tz_validity",
    "tax_consistency",
    "field_coverage_vs_manifest",
    "observation_coverage",
    "no_orphan_observations",
    "line_maths",
    "tender_reconciles",
    "stock_continuity",
    "journal_balances",
    "shift_timesheet_coverage",
    "pos_ledger_tolerance",
    "no_fanout",
    "grain_compatible_ratios",
    "snapshot_not_summed",
    "authority_respected",
    "golden_fixture_match",
  ];

  for (const check of required.slice(0, 21)) {
    assert.match(sql, new RegExp(`'${check}'`), `${check} is absent from the durable expectation registry`);
  }
  assert.match(sql, /required_check_missing/);
  assert.match(sql, /required_check_stale/);
  assert.match(sql, /tenant_primary_grain_duplicates/);
  assert.match(sql, /explicit_tenant_scoped_reference_scan/);
  assert.doesNotMatch(sql, /enforced_by/);

  // Semantic invariants are per-query evidence and belong in the immutable
  // query audit rather than in a tenant-wide scheduled snapshot.
  const service = await readFile("services/semantic-query/src/service.ts", "utf8");
  for (const check of required.slice(21)) {
    assert.match(service, new RegExp(check), `${check} is absent from per-query validation`);
  }
});

test("semantic health reads the expected-result join and CI executes the SQL harness", async () => {
  const adapter = await readFile("services/semantic-query/src/postgres-adapters.ts", "utf8");
  const workflow = await readFile(".github/workflows/ci.yml", "utf8");
  assert.match(adapter, /quality\.current_health\(\$1,\$2::text\[\]\)/);
  assert.match(adapter, /\["connector","canonical"\]/);
  assert.match(workflow, /tests\/sql\/analytical-quality-gates\.sql/);
});
