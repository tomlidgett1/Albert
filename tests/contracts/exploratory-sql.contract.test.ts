import assert from "node:assert/strict";
import { test } from "node:test";

import {
  compileExploratorySql,
  sqlScanSurface,
  EXPLORATORY_SQL_MAX_ROWS,
  EXPLORATORY_SQL_TIMEOUT_MS,
} from "../../services/semantic-query/src/exploratory-sql.js";

/**
 * The escape hatch that answers questions no governed metric expresses.
 * Isolation is structural — READ ONLY transaction, semantic_ro, forced row
 * level security through security_invoker views — so these tests cover the
 * defence-in-depth layer and, more importantly, prove the wrapper always binds
 * the tenant parameter and always bounds the row count.
 */

const MEDIAN = `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY signed_net_amount_inc_tax) AS median
FROM mart.commerce_sales_event
WHERE business_date >= DATE '2024-03-01' AND business_date < DATE '2024-04-01'`;

test("a median query compiles, because that is the whole point", () => {
  const compiled = compileExploratorySql(MEDIAN);
  assert.match(compiled.sql, /percentile_cont/u);
  assert.equal(compiled.parameterCount, 1);
});

test("the wrapper always binds the tenant parameter", () => {
  // queryAsSemanticRole asserts parameters[0] is the trusted tenant id, so the
  // statement must reference $1 whether or not the author did.
  const compiled = compileExploratorySql("SELECT 1 AS one");
  assert.match(compiled.sql, /\$1::text/u);
  assert.equal(compiled.parameterCount, 1);
});

test("the wrapper always bounds the row count", () => {
  assert.match(compileExploratorySql("SELECT 1", 10).sql, /LIMIT 10$/u);
  assert.match(compileExploratorySql("SELECT 1", 10_000).sql, new RegExp(`LIMIT ${EXPLORATORY_SQL_MAX_ROWS}$`, "u"));
  assert.match(compileExploratorySql("SELECT 1", 0).sql, /LIMIT 1$/u);
});

test("writes are refused before they reach the database", () => {
  for (const sql of [
    "UPDATE core.product_variant SET name='x'",
    "DELETE FROM mart.commerce_sales_event",
    "DROP TABLE core.product_variant",
    "INSERT INTO core.product_variant (name) VALUES ('x')",
    "TRUNCATE core.product_variant",
    "GRANT SELECT ON core.product_variant TO PUBLIC",
  ]) {
    assert.throws(() => compileExploratorySql(sql), /read-only|single SELECT/iu, sql);
  }
});

test("a second statement cannot be smuggled in", () => {
  assert.throws(
    () => compileExploratorySql("SELECT 1; DROP TABLE core.product_variant"),
    /single statement/iu,
  );
});

test("a trailing semicolon is fine, because it is not a second statement", () => {
  assert.match(compileExploratorySql("SELECT 1 AS one;").sql, /SELECT 1 AS one/u);
});

test("a comment cannot hide a forbidden verb from the scan", () => {
  // The scan strips comments precisely so they cannot be used to smuggle, and
  // so that a comment mentioning a verb is not a false positive.
  assert.equal(sqlScanSurface("SELECT 1 -- drop table x").includes("drop"), false);
  assert.throws(
    () => compileExploratorySql("SELECT 1 /* x */; DROP TABLE core.product_variant"),
    /single statement/iu,
  );
});

test("a product name containing a verb is not mistaken for one", () => {
  // 'Deleted' inside a string literal must not trip the DELETE check.
  const compiled = compileExploratorySql("SELECT name FROM core.product_variant WHERE name = 'Deleted Stock'");
  assert.match(compiled.sql, /Deleted Stock/u);
});

test("server-side file and session functions are refused", () => {
  for (const sql of [
    "SELECT pg_read_file('/etc/passwd')",
    "SELECT current_setting('albert.tenant_capability')",
    "SELECT set_config('albert.tenant_id','other',true)",
    "SELECT pg_sleep(60)",
  ]) {
    assert.throws(() => compileExploratorySql(sql), /cannot call/iu, sql);
  }
});

test("schemas outside the analytical grant are refused", () => {
  for (const sql of [
    "SELECT * FROM control_plane.connection",
    "SELECT * FROM auth.users",
    "SELECT * FROM pg_catalog.pg_authid",
    "SELECT * FROM information_schema.tables",
  ]) {
    assert.throws(() => compileExploratorySql(sql), /cannot read/iu, sql);
  }
});

test("the analytical schemas are readable", () => {
  for (const sql of [
    "SELECT * FROM mart.commerce_sales_event",
    "SELECT * FROM core.product_variant",
    "SELECT * FROM quality.pipeline_stats",
    "WITH x AS (SELECT 1) SELECT * FROM x",
  ]) {
    assert.doesNotThrow(() => compileExploratorySql(sql), sql);
  }
});

test("a table alias is not mistaken for a forbidden schema", () => {
  assert.doesNotThrow(() =>
    compileExploratorySql("SELECT line.tenant_id FROM mart.commerce_sales_event AS line"));
});

test("author-supplied bind parameters are refused", () => {
  // $1 is reserved for the trusted tenant id; a second placeholder would shift it.
  assert.throws(() => compileExploratorySql("SELECT * FROM core.product_variant WHERE id = $1"), /bind parameters/iu);
});

test("empty and oversized statements are refused", () => {
  assert.throws(() => compileExploratorySql("   "), /empty/iu);
  assert.throws(() => compileExploratorySql(`SELECT '${"x".repeat(8_100)}'`), /8,000 characters/u);
});

test("the timeout is bounded well inside the pool's patience", () => {
  assert.ok(EXPLORATORY_SQL_TIMEOUT_MS > 0 && EXPLORATORY_SQL_TIMEOUT_MS <= 30_000);
});
