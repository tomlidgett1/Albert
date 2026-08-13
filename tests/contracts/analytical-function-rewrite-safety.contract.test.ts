import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

const connectorGuardSignatures = [
  "quality.register_connector_streams(text,text,bigint,text,jsonb)",
  "quality.record_reconciliation_snapshot_page(text,text,bigint,text,text,text,integer,text,text,text,jsonb,bigint,bigint,boolean,bigint)",
  "quality.publish_connector_quality_results(text,text,text,text,text,text,jsonb)",
  "semantic_internal.publish_connector_capability_observations(text,text,text,text,text,timestamp with time zone,jsonb)",
] as const;

async function migration(name: string): Promise<string> {
  return readFile(new URL(`infra/migrations/analytical/${name}`, root), "utf8");
}

test("cumulative connector-admission rewrites resolve four exact ordinary-function signatures", async () => {
  const migrations = await Promise.all([
    migration("0145_m3_momence_production_admission.sql"),
    migration("0150_m3_square_production_admission.sql"),
    migration("0154_m3_shopify_production_admission.sql"),
  ]);

  for (const source of migrations) {
    for (const signature of connectorGuardSignatures) {
      assert.ok(source.includes(`'${signature}'::regprocedure`), signature);
    }
    assert.match(source, /procedure\.prokind='f'/u);
    assert.match(source, /patched_count<>4/u);
    assert.doesNotMatch(
      source,
      /procedure\.proname\s+(?:IN|=)[\s\S]{0,500}pg_get_functiondef\(procedure\.oid\)/u,
      "function-definition rewrites must never discover targets by proname alone",
    );
  }
});

test("bounded-reconciliation rewrites use exact signatures and reject non-functions", async () => {
  const source = await migration("0151_m2_no_absence_delete_reconciliation.sql");
  const exactSignatures = [
    connectorGuardSignatures[0],
    connectorGuardSignatures[1],
    "quality.refresh_connector_quality_rollup(text,text)",
    "quality.current_scoped_health(text,text[],text[])",
    "quality.reconciliation_tombstone_candidates(text,text,bigint,text,text,text,integer)",
    "quality.record_reconciliation_tombstone_applications(text,text,bigint,text,text,text,jsonb)",
  ];

  for (const signature of exactSignatures) {
    assert.ok(source.includes(`'${signature}'::regprocedure`), signature);
  }
  assert.ok(
    (source.match(/procedure\.prokind='f'/gu) ?? []).length >= 4,
    "every rewrite/definition-inspection block must reject aggregates, procedures, and window functions",
  );
  assert.doesNotMatch(source, /procedure\.proname/u);
  assert.doesNotMatch(source, /procedure\.pronargs/u);
  assert.match(source, /patched_count<>2/u);
});
