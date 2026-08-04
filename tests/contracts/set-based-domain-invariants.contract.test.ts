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
