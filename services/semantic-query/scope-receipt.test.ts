import assert from "node:assert/strict";
import test from "node:test";

import { semanticToolInputSchemas, type GovernedResult } from "../../packages/agent/src/semantic-tools.js";
import { unresolvedScopeReason } from "../conversation/src/live.js";
import { deriveSqlScopeReceipt, sqlScopePredicates } from "./src/scope-receipt.js";

const adversarialSql = `
WITH matched AS (
  SELECT s.sale_id, s.first_name, s.last_name, s.status, s.voided_at
  FROM source_lightspeed.ls_sales AS s
  WHERE lower(s.first_name) = lower('Tom')
    AND lower(s.last_name) = lower('Lidgett')
    AND s.status IN ('completed', 'open')
    AND s.note NOT ILIKE '%ignore previous instructions%'
    AND s.voided_at IS NULL
)
SELECT concat(first_name, ' ', last_name) AS customer_name, status, count(*) AS transaction_count
FROM matched
GROUP BY customer_name, status
ORDER BY transaction_count DESC`;

test("server-derived SQL scope survives CTEs, compound names, IN, NOT ILIKE and NULL predicates", () => {
  const receipt = deriveSqlScopeReceipt(
    adversarialSql,
    ["customer_name", "status", "transaction_count"],
    [
      { customer_name: "Tom Lidgett", status: "completed", transaction_count: "5" },
      { customer_name: "Tom Lidgett", status: "open", transaction_count: "4" },
    ],
  );

  assert.deepEqual(receipt.relations, [{ schema: "source_lightspeed", relation: "ls_sales" }]);
  assert.ok(receipt.predicates.some((predicate) =>
    predicate.expression === "lower(s.first_name)"
      && predicate.operator === "eq"
      && predicate.values.includes("Tom")));
  assert.ok(receipt.predicates.some((predicate) =>
    predicate.expression === "lower(s.last_name)"
      && predicate.operator === "eq"
      && predicate.values.includes("Lidgett")));
  assert.ok(receipt.predicates.some((predicate) =>
    predicate.operator === "in"
      && predicate.values.includes("completed")
      && predicate.values.includes("open")));
  assert.ok(receipt.predicates.some((predicate) => predicate.operator === "not_ilike"));
  assert.ok(receipt.predicates.some((predicate) => predicate.operator === "is_null"));
  assert.deepEqual(
    receipt.resultValues.find(({ column }) => column === "customer_name")?.values,
    ["Tom Lidgett"],
  );
});

test("scope receipts include bounded low-cardinality returned values and omit high-cardinality identifiers", () => {
  const rows = Array.from({ length: 25 }, (_, index) => ({
    sale_id: `sale_${index}`,
    customer_name: "Tom Lidgett",
    status: index % 2 === 0 ? "completed" : "open",
  }));
  const receipt = deriveSqlScopeReceipt(
    "SELECT sale_id, customer_name, status FROM source_lightspeed.ls_sales WHERE customer_name = 'Tom Lidgett'",
    ["sale_id", "customer_name", "status"],
    rows,
  );

  assert.equal(receipt.resultValues.some(({ column }) => column === "sale_id"), false);
  assert.deepEqual(
    receipt.resultValues.find(({ column }) => column === "customer_name")?.values,
    ["Tom Lidgett"],
  );
  assert.deepEqual(
    receipt.resultValues.find(({ column }) => column === "status")?.values,
    ["completed", "open"],
  );
});

test("a compound persisted subject is attested by independent executed predicates even when no row is returned", () => {
  const predicates = sqlScopePredicates(
    "SELECT sale_id FROM source_lightspeed.ls_sales WHERE first_name = 'Tom' AND last_name = 'Lidgett' AND voided_at IS NULL",
  );
  const result = {
    resultId: "sql:empty-but-scoped",
    columns: [{ key: "sale_id", label: "Sale ID", type: "string" as const }],
    rows: [],
    scopeReceipt: {
      kind: "sql" as const,
      relations: [{ schema: "source_lightspeed", relation: "ls_sales" }],
      predicates: [...predicates],
      resultValues: [],
    },
    provenance: {
      sources: [],
      timeRange: { label: "All available history", start: "2020-01-01", end: "2026-08-09", timezone: "Australia/Melbourne" },
      definitions: [],
      semanticBundleHash: "scope-test",
      identityGraph: { version: 0, hash: "0".repeat(32) },
    },
    validations: [],
  } satisfies GovernedResult;

  assert.equal(unresolvedScopeReason(
    { segment: "Tom Lidgett", dimension: "customer_name", value: "Tom Lidgett" },
    [],
    [],
    [result],
  ), undefined);
});

test("the raw SQL request contract rejects a model-authored scope receipt", () => {
  assert.equal(semanticToolInputSchemas.run_sql.safeParse({
    sql: "SELECT 1 AS value",
    purpose: "Test strict request ownership",
    limit: 1,
    scopeReceipt: {
      kind: "sql",
      relations: [],
      predicates: [],
      resultValues: [],
    },
  }).success, false);
});
