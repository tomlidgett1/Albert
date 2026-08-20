import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { validateCubeQuery } from "../../packages/albert-v3/src/cube/client.ts";
import type { CubeCatalogue, CubeCatalogueMember } from "../../packages/albert-v3/src/cube/types.ts";

function member(input: Readonly<{
  name: string;
  kind: CubeCatalogueMember["kind"];
  type?: CubeCatalogueMember["type"];
}>): CubeCatalogueMember {
  const title = input.name.split(".")[1] ?? input.name;
  return Object.freeze({ title, shortTitle: title, description: title, ...input });
}

const CATALOGUE: CubeCatalogue = Object.freeze({
  views: Object.freeze([
    Object.freeze({
      name: "sales_analytics",
      title: "Sales",
      description: "Completed sales.",
      members: Object.freeze([
        member({ name: "sales_analytics.gross_takings", kind: "measure", type: "number" }),
        member({ name: "sales_analytics.shop_name", kind: "dimension", type: "string" }),
        member({ name: "sales_analytics.completed_at", kind: "dimension", type: "time" }),
      ]),
    }),
  ]),
}) as CubeCatalogue;

function errorOf(result: ReturnType<typeof validateCubeQuery>): string {
  return "error" in result ? result.error : "";
}

test("a bucketed time dimension repeated as a plain dimension is refused before it reaches Cube", () => {
  // Seen in production on 2026-08-19: Cube GROUP BYs the raw timestamp as
  // well as the month, so "monthly, limit 12" returned twelve arbitrary sales.
  const rejected = validateCubeQuery({
    measures: ["sales_analytics.gross_takings"],
    dimensions: ["sales_analytics.completed_at"],
    timeDimensions: [{
      dimension: "sales_analytics.completed_at",
      granularity: "month",
      compareDateRange: [["2026-01-01", "2026-08-19"], ["2025-01-01", "2025-08-19"]],
    }],
    limit: 12,
  }, CATALOGUE);
  assert.match(errorOf(rejected), /already a time dimension with granularity month/u);
  assert.match(errorOf(rejected), /remove it from dimensions/u);

  const accepted = validateCubeQuery({
    measures: ["sales_analytics.gross_takings"],
    dimensions: ["sales_analytics.shop_name"],
    timeDimensions: [{
      dimension: "sales_analytics.completed_at",
      granularity: "month",
      compareDateRange: [["2026-01-01", "2026-08-19"], ["2025-01-01", "2025-08-19"]],
    }],
    limit: 12,
  }, CATALOGUE);
  assert.ok(!("error" in accepted), errorOf(accepted));

  // Without a granularity the time dimension only filters, so listing the raw
  // timestamp as a dimension is a deliberate, valid request.
  const rawTimestamps = validateCubeQuery({
    measures: ["sales_analytics.gross_takings"],
    dimensions: ["sales_analytics.completed_at"],
    timeDimensions: [{ dimension: "sales_analytics.completed_at", dateRange: "last 7 days" }],
    limit: 20,
  }, CATALOGUE);
  assert.ok(!("error" in rawTimestamps), errorOf(rawTimestamps));
});

test("the Cube config keeps orchestrator creation idempotent for per-turn orchestrators", () => {
  // Cube's getOrchestratorApi is check-then-set across awaits; a compareDateRange
  // request calls it once per sub-query in the same tick and, for a brand-new
  // per-turn orchestrator id, built two queue instances whose colliding
  // processing ids dropped the finished result ("Orphaned execution result").
  // The guard in cube.js is the fix; it must stay installed while orchestrators
  // are keyed by turn.
  const source = readFileSync(path.join(process.cwd(), "cube-playground", "cube.js"), "utf8");
  assert.match(source, /require\('@cubejs-backend\/server-core'\)/u);
  assert.match(source, /function installIdempotentOrchestratorCreation\(/u);
  assert.match(source, /Function\.prototype\.toString\.call\(original\)/u, "the guard must refuse to start when Cube's internals move");
  const install = source.indexOf("installIdempotentOrchestratorCreation(CubejsServerCore);");
  const exportsAt = source.indexOf("module.exports = {");
  assert.ok(install > 0 && exportsAt > install, "the guard is installed before the config is exported");
  assert.match(source, /contextToOrchestratorId: \(\{ securityContext \}\) =>/u);
  assert.match(source, /\$\{turnId \|\| dashboardRefreshLeaseId \|\| 'no-execution'\}/u, "orchestrators stay per turn, which is why the guard exists");
});
