import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migrationPath =
  "infra/migrations/analytical/0109_m4_set_based_domain_invariants.sql";

test("terminal domain invariants scan tenant relations as sets", async () => {
  const sql = await readFile(migrationPath, "utf8");

  for (const relation of [
    "line_totals",
    "authoritative_order_observations",
    "order_states",
    "authoritative_line_observations",
    "line_states",
    "payment_authority",
    "refund_authority",
  ]) {
    assert.match(sql, new RegExp(`${relation} AS MATERIALIZED`, "u"));
  }

  assert.doesNotMatch(sql, /LEFT JOIN LATERAL/iu);
  assert.doesNotMatch(sql, /core\.source_is_authoritative\s*\(/u);
  assert.match(sql, /count\(authority\.id\)::bigint AS authority_count/u);
  assert.match(sql, /authority_count<>1/u);
  assert.match(
    sql,
    /authoritative_connection_id[\s\S]*?IS DISTINCT FROM coverage_row\.connection_id/u,
  );
});

test("set-based replacement preserves quality evidence and least privilege", async () => {
  const sql = await readFile(migrationPath, "utf8");

  for (const evidence of [
    "line_component_failures",
    "header_failures",
    "refund_component_failures",
    "refund_reversal_link_failures",
    "total_commerce_facts",
    "orders_missing",
    "order_lines_missing",
    "payments_missing",
    "refund_lines_missing",
  ]) assert.ok(sql.includes(`'${evidence}'`), `missing quality evidence: ${evidence}`);

  assert.match(sql, /SECURITY INVOKER/u);
  assert.match(sql, /p_tenant_id IS DISTINCT FROM core\.current_tenant_id\(\)/u);
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION quality\.run_domain_invariants\(text,text\)[\s\S]*?TO transform_rw/u,
  );
});

const governedHeaderScopePath =
  "infra/migrations/analytical/0111_m4_governed_scope_header_invariant.sql";

test("the header invariant is scoped to the same governed commerce every metric reads", async () => {
  const sql = await readFile(governedHeaderScopePath, "utf8");

  // Governed commerce is completed and not voided in 0110 (tender_reconciles)
  // and 0020 (mart.commerce_sales_event); the header invariant must agree, or
  // an open layby the vendor never reconciles takes every Topic down.
  assert.match(sql, /order_row\.status='completed' AND NOT order_row\.voided AS governed/u);
  assert.match(sql, /count\(\*\) FILTER \(WHERE governed\)/u);
  assert.match(sql, /count\(\*\) FILTER \(WHERE NOT governed\)/u);

  // Excluded drift stays measured rather than disappearing.
  assert.ok(sql.includes("'non_governed_header_drift'"));
  assert.ok(sql.includes("'header_scope','completed_not_voided'"));

  // Tolerances and privilege are unchanged.
  assert.ok(sql.includes("'header_tolerance','0.0100','component_tolerance','0.0001'"));
  assert.doesNotMatch(sql, /coalesce\(lines\.gross_amount,0\)\)>0\.1/u);
  assert.match(sql, /SECURITY INVOKER/u);
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION quality\.run_domain_invariants\(text,text\)[\s\S]*?TO transform_rw/u,
  );
});

const connectorRollupPath =
  "infra/migrations/analytical/0114_m2_connector_rollup_separates_pending_from_defect.sql";

test("the durable connector rollup separates a pending sweep from a real defect", async () => {
  const sql = await readFile(connectorRollupPath, "utf8");

  // getForTopic reads quality.current_scoped_health and getForDomain reads
  // quality.current_health, which is fed by this rollup. When the two disagree
  // the agent refuses on checks the reviewed scoped path already accepts, so
  // the rollup must carry the same pending/defect split.
  assert.match(sql, /count\(\*\) FILTER \(WHERE reconciliation_gap_count>0\) AS reconciliation_defect/u);
  assert.ok(sql.includes("AS reconciliation_pending"));
  assert.ok(sql.includes("AS source_total_mismatch"));
  assert.ok(sql.includes("AS source_total_unmeasured"));

  // A mismatch is only a defect when both totals were actually measured.
  assert.match(
    sql,
    /WHERE source_total IS NOT NULL AND local_live_total IS NOT NULL\s*\n\s*AND source_total<>local_live_total/u,
  );

  // Pending degrades the answer, it does not block it.
  assert.match(sql, /WHEN reconciliation_pending>0 THEN 'warning'/u);
  assert.match(sql, /WHEN reconciliation_pending>0 OR source_total_unmeasured>0 THEN 'warning'/u);

  // enum_drift measures enum drift; quarantine stays visible but is not summed in.
  assert.match(sql, /sum\(unresolved_enum_drift_count\) AS enum_drift/u);
  assert.doesNotMatch(sql, /unresolved_enum_drift_count\+unresolved_quarantine_count/u);
  assert.ok(sql.includes("'unresolved_quarantine',quarantine"));

  // A genuine defect still blocks.
  assert.match(sql, /WHEN expected=0 OR reconciliation_defect>0 THEN 'blocked'/u);
  assert.match(sql, /WHEN expected=0 OR reconciliation_defect>0 OR source_total_mismatch>0 THEN 'blocked'/u);
});
