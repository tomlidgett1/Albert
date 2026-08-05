import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

const migrationDirectory = "infra/migrations/analytical";
const migrationPath = join(
  migrationDirectory,
  "0118_m0_initplan_tenant_capability_predicate.sql",
);

/**
 * A tenant predicate is only cheap when the verifier sits inside a scalar
 * subquery: PostgreSQL then plans it as an uncorrelated InitPlan evaluated once
 * per query, instead of re-running the SECURITY DEFINER token check for every
 * candidate row. Removing the wrapped occurrences leaves only the bare ones.
 */
function bareVerifierPredicates(sql: string): readonly string[] {
  // Rationale comments quote the old shape on purpose, so read statements only.
  const statements = sql.replace(/^\s*--[^\n]*$/gmu, "");
  const withoutWrapped = statements.replace(
    /\(\s*SELECT\s+(?:core|ingestion)\.current_tenant_id\(\)\s*\)/gu,
    "«wrapped»",
  );
  return withoutWrapped.match(
    /tenant_id\s*=\s*(?:core|ingestion)\.current_tenant_id\(\)/gu,
  ) ?? [];
}

test("0118 rewrites every tenant policy predicate into an InitPlan", async () => {
  const sql = await readFile(migrationPath, "utf8");

  const alters = sql.match(/^ALTER POLICY /gmu) ?? [];
  assert.ok(alters.length >= 100, `expected the full policy set, saw ${alters.length}`);

  const using = sql.match(/^\s*USING \(tenant_id = \(SELECT (?:core|ingestion)\.current_tenant_id\(\)\)\)$/gmu) ?? [];
  const withCheck = sql.match(/^\s*WITH CHECK \(tenant_id = \(SELECT (?:core|ingestion)\.current_tenant_id\(\)\)\);$/gmu) ?? [];
  assert.equal(using.length, alters.length, "every ALTER POLICY must restate USING");
  assert.equal(withCheck.length, alters.length, "every ALTER POLICY must restate WITH CHECK");

  // WITH CHECK is evaluated per written row on the ingest and transform paths,
  // so leaving it bare would keep the per-row cost on every write.
  assert.deepEqual(bareVerifierPredicates(sql), [], "0118 must leave no bare verifier call");

  assert.match(sql, /^BEGIN;$/mu);
  assert.match(sql, /^COMMIT;$/mu);
});

test("0118 covers both verifiers and every tenant-scoped schema", async () => {
  const sql = await readFile(migrationPath, "utf8");

  // core.current_tenant_id guards the canonical and mart relations; the
  // ingestion wrapper guards connector staging. Both were per-row before.
  assert.ok(/\(SELECT core\.current_tenant_id\(\)\)/u.test(sql));
  assert.ok(/\(SELECT ingestion\.current_tenant_id\(\)\)/u.test(sql));

  for (const schema of [
    "core", "mart", "quality", "semantic_internal",
    "ingestion", "source_lightspeed", "source_xero", "source_deputy",
  ]) {
    assert.match(
      sql,
      new RegExp(`^ALTER POLICY \\w+ ON ${schema}\\.`, "mu"),
      `no policy rewritten in ${schema}`,
    );
  }
});

test("no analytical migration after 0118 reintroduces a per-row verifier call", async () => {
  const files = (await readdir(migrationDirectory))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name))
    .filter((name) => name.slice(0, 4) >= "0118")
    .sort();

  const offenders: string[] = [];
  for (const name of files) {
    const sql = await readFile(join(migrationDirectory, name), "utf8");
    for (const bare of bareVerifierPredicates(sql)) offenders.push(`${name}: ${bare}`);
  }
  assert.deepEqual(
    offenders,
    [],
    "wrap the verifier in a scalar subquery so it stays an InitPlan; see 0118",
  );
});

test("generated connector staging emits the InitPlan predicate", async () => {
  const generator = await readFile("packages/connector-sdk/src/staging.ts", "utf8");
  assert.match(generator, /USING \(tenant_id = \(SELECT ingestion\.current_tenant_id\(\)\)\)/u);
  assert.match(generator, /WITH CHECK \(tenant_id = \(SELECT ingestion\.current_tenant_id\(\)\)\)/u);
  assert.deepEqual(bareVerifierPredicates(generator), []);
});
