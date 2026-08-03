import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationUrl = new URL(
  "../../infra/migrations/analytical/0100_m4_durable_reconciliation_findings.sql",
  import.meta.url,
);

test("reconciliation findings are per day/location and stable across runs", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(
    sql,
    /'reconciliation-finding\|'\|\|p_tenant_id\|\|'\|'\|\|p_check_id\|\|'\|'\|\|p_entity_id/u,
  );
  assert.doesNotMatch(
    sql,
    /reconciliation-finding[^\n]*p_run_id/u,
    "run id must not create a new identity for the same daily variance",
  );
  assert.match(sql, /'businessDate',p_business_date/u);
  assert.match(sql, /'locationId',p_location_id/u);
  assert.match(sql, /'variance',p_variance/u);
  assert.match(sql, /p_check_id,'reconciliation_day_location',p_entity_id/u);
});

test("both governed reconciliation marts open findings at their policy tolerance", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /\('pos_ledger_tolerance',1\.0000,/u);
  assert.match(sql, /\('pos_bank_tolerance',0\.0500,/u);
  assert.match(
    sql,
    /FROM mart\.reconciliation_aligned aligned[\s\S]*?abs\(aligned\.pos_net_sales_ex_gst-aligned\.ledger_accrued_revenue\)>policy\.tolerance/u,
  );
  assert.match(
    sql,
    /FROM mart\.settlement_reconciliation_aligned aligned[\s\S]*?abs\(aligned\.settlement_variance\)>policy\.tolerance/u,
  );
  assert.match(
    sql,
    /PERFORM quality\.materialise_reconciliation_findings\(p_tenant_id,p_run_id,p_check_id\)/u,
  );
});

test("finding lifecycle is lookup-backed, resolvable, and mutation-fenced", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS quality\.finding_status_lookup/u);
  assert.match(sql, /FOREIGN KEY\(status\) REFERENCES quality\.finding_status_lookup\(value\) NOT VALID/u);
  assert.match(sql, /ALTER TABLE quality\.finding VALIDATE CONSTRAINT quality_finding_status_fk/u);
  assert.match(sql, /SET status='resolved',resolved_at=now\(\),resolution_run_id=p_run_id/u);
  assert.match(sql, /status='open'[\s\S]*?resolved_at=NULL,[\s\S]*?resolution_run_id=NULL/u);
  assert.match(sql, /REVOKE INSERT,UPDATE,DELETE ON quality\.finding FROM transform_rw/u);
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION[\s\S]*?quality\.materialise_reconciliation_findings\(text,text,text\),[\s\S]*?quality\.record_check/u,
  );
  assert.doesNotMatch(
    sql.match(/GRANT EXECUTE ON FUNCTION[\s\S]*?TO transform_rw;/u)?.[0] ?? "",
    /upsert_reconciliation_finding|resolve_reconciliation_findings/u,
  );
});

test("record_check preserves the hardened stock-continuity computation", async () => {
  const sql = await readFile(migrationUrl, "utf8");
  assert.match(sql, /DECLARE stock record;/u);
  assert.match(
    sql,
    /IF p_check_id='stock_continuity' AND p_domain='inventory' THEN[\s\S]*?SELECT \* INTO STRICT stock FROM quality\.compute_stock_continuity\(p_tenant_id\);[\s\S]*?p_details:=stock\.details;/u,
    "replacing record_check must retain migration 0085's complete inventory continuity check",
  );
});

test("the SQL integration proof covers idempotency, resolution, reopening and exact thresholds", async () => {
  const proof = await readFile(
    new URL("../../tests/sql/analytical-durable-reconciliation-findings.sql", import.meta.url),
    "utf8",
  );
  for (const phrase of [
    "same day/location/check identity",
    "disappeared daily variance",
    "recurring variance",
    "at-threshold value",
    "governed finding materialiser",
    "legacy negative-only stock result",
  ]) assert.ok(proof.includes(phrase), `missing integration proof: ${phrase}`);
});
