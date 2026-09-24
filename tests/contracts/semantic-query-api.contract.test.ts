import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { signCubeJwt } from "../../packages/albert-v3/src/cube/jwt.ts";
import type { CubeCatalogue } from "../../packages/albert-v3/src/cube/types.ts";
import { ALBERT_RATE_LIMIT_POLICIES } from "../../services/control-plane/src/web-repository.ts";
import { semanticBatchSchema, semanticQuerySchema, validateBatch } from "../../services/dashboard/src/semantic-api.ts";

const migration = readFileSync("infra/migrations/control-plane/0196_m6_semantic_query_leases.sql", "utf8");
const cubeConfig = readFileSync("cube-playground/cube.js", "utf8");
const queryRoute = readFileSync("app/api/semantic/query/route.ts", "utf8");
const metaRoute = readFileSync("app/api/semantic/meta/route.ts", "utf8");
const TENANT = "01KZN20VTX2EWW1TQ2AA3MCPW6";

test("the lease migration keeps the table private and the issuer to Cube's control role", () => {
  assert.doesNotMatch(migration, /auth\.users|auth\.uid\(|auth\.jwt\(/u, "control-plane migrations may not name auth internals");
  assert.match(migration, /FORCE ROW LEVEL SECURITY/u);
  assert.match(migration, /REVOKE ALL ON TABLE control_plane\.semantic_query_leases\s+FROM PUBLIC, anon, authenticated, service_role;/u);
  assert.match(migration, /FOR ALL TO albert_control_migration_owner/u);
  assert.match(migration, /expires_at <= issued_at \+ interval '3 minutes'/u);
  assert.match(migration, /claimed_at \+ interval '75 seconds'/u, "a live lease is reused while it has 75 seconds left");
  assert.match(migration, /open_leases >= 6/u);
  assert.match(migration, /selected_tenant <> p_expected_tenant_id/u, "a session bound to another organisation fails closed");
  assert.match(migration, /member_role NOT IN \('owner', 'manager'\)/u);
  assert.match(
    migration,
    /GRANT EXECUTE ON FUNCTION control_plane\.issue_semantic_query_analytical_capability\(text, text, text\)\s+TO albert_semantic_control;/u,
  );
  assert.match(migration, /require_exact_runtime_login\(\s*'albert_semantic_control_runtime', 'albert_semantic_control'\s*\)/u);
  const policy = /VALUES \('semantic\.query', (\d+), (\d+), false\)/u.exec(migration);
  assert.ok(policy, "the migration seeds the semantic.query rate policy");
  assert.equal(Number(policy[1]), ALBERT_RATE_LIMIT_POLICIES["semantic.query"].limit);
  assert.equal(Number(policy[2]), ALBERT_RATE_LIMIT_POLICIES["semantic.query"].windowSeconds);
});

test("Cube accepts exactly one execution claim and trades a semantic lease for a capability", () => {
  assert.match(cubeConfig, /function executionKind\(/u);
  assert.match(cubeConfig, /return kinds\.length === 1 \? kinds\[0\] : null;/u, "a token with two claims has no execution");
  assert.match(cubeConfig, /control_plane\.issue_semantic_query_analytical_capability\(\s*\$1::text, \$2::text, 'semantic_read'::text\s*\)/u);
  assert.match(cubeConfig, /semantic_query_lease_id === 'string'\) return \['meta', 'data'\]/u);
  assert.match(cubeConfig, /turnId \|\| dashboardRefreshLeaseId \|\| semanticQueryLeaseId \|\| 'no-execution'/u);
  assert.match(cubeConfig, /if \(!tenantId \|\| !executionKind\(albertContext\)\)/u);
});

test("a semantic lease token carries only the lease claim", () => {
  const token = signCubeJwt({
    secret: "s".repeat(32),
    securityContext: { tenant_id: TENANT, role: "owner", semantic_query_lease_id: "01KZN20VTX2EWW1TQ2AA3MCPW7" },
  });
  const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as Record<string, unknown>;
  assert.equal(payload.semantic_query_lease_id, "01KZN20VTX2EWW1TQ2AA3MCPW7");
  assert.equal(payload.tenant_id, TENANT);
  for (const claim of ["conversation_id", "turn_id", "dashboard_tile_id", "dashboard_refresh_lease_id"]) {
    assert.equal(payload[claim], undefined, `${claim} must be absent`);
  }
});

test("the query schema is strict and bounded", () => {
  assert.equal(semanticQuerySchema.safeParse({ measures: ["sales_analytics.gross_takings"], renewQuery: true }).success, false);
  assert.equal(semanticQuerySchema.safeParse({ measures: ["sales_analytics.gross_takings"], limit: 2001 }).success, false);
  assert.equal(semanticQuerySchema.safeParse({ measures: ["sales_analytics.gross_takings; drop"] }).success, false);
  assert.equal(semanticQuerySchema.safeParse({ dimensions: Array.from({ length: 50 }, (_, index) => `sales_analytics.d${index}`), ungrouped: true }).success, true);
  assert.equal(semanticQuerySchema.safeParse({ dimensions: Array.from({ length: 51 }, (_, index) => `sales_analytics.d${index}`) }).success, false);
  assert.equal(semanticQuerySchema.safeParse({
    measures: ["sales_analytics.gross_takings"],
    timeDimensions: [{ dimension: "sales_analytics.completed_at", granularity: "month", dateRange: ["2025-10-01", "2026-09-30"] }],
    filters: [{ or: [{ member: "sales_analytics.shops_name", operator: "equals", values: ["Ashburton"] }] }],
    order: { "sales_analytics.completed_at": "asc" },
    limit: 500,
    timezone: "Australia/Melbourne",
  }).success, true);
  assert.equal(semanticBatchSchema.safeParse({ expectedTenantId: TENANT, queries: [] }).success, false);
  assert.equal(semanticBatchSchema.safeParse({
    expectedTenantId: TENANT,
    queries: Array.from({ length: 13 }, () => ({ measures: ["sales_analytics.transactions"] })),
  }).success, false);
});

test("a batch validates each query on its own and refuses row listings on aggregate-only views", () => {
  const catalogue: CubeCatalogue = {
    fetchedAt: new Date(0).toISOString(),
    views: [
      {
        name: "sales_analytics",
        title: "Sales",
        members: [
          { name: "sales_analytics.gross_takings", kind: "measure", title: "Gross takings", shortTitle: "Gross takings", type: "number" },
          { name: "sales_analytics.shops_name", kind: "dimension", title: "Shop", shortTitle: "Shop", type: "string" },
        ],
      },
      {
        name: "shopify_sales_analytics",
        title: "Shopify sales",
        queryPolicy: "aggregate_only",
        members: [
          { name: "shopify_sales_analytics.order_name", kind: "dimension", title: "Order", shortTitle: "Order", type: "string" },
        ],
      },
    ],
  };
  const checked = validateBatch([
    { measures: ["sales_analytics.gross_takings"], dimensions: ["sales_analytics.shops_name"] },
    { measures: ["sales_analytics.unknown_member"] },
    { dimensions: ["shopify_sales_analytics.order_name"], ungrouped: true },
  ], catalogue);
  assert.ok("query" in checked[0]!);
  assert.match(("error" in checked[1]! && checked[1].error) || "", /Unknown member/u);
  assert.match(("error" in checked[2]! && checked[2].error) || "", /aggregate-only|row listings are not available/u);
});

test("both routes are partner bearer only, bind the tenant and rate limit", () => {
  for (const route of [queryRoute, metaRoute]) {
    assert.match(route, /if \(!\(await requestBearerAccessToken\(\)\)\)/u);
    assert.match(route, /tenant\.tenant_id !== /u);
    assert.match(route, /consumeAlbertRateLimit\("semantic\.query"\)/u);
    assert.match(route, /"Cache-Control": "private, no-store"/u);
  }
  assert.match(queryRoute, /assertSameOriginMutation\(request\)/u);
  assert.match(queryRoute, /claimSemanticQueryLease\(tenant\.tenant_id, PURPOSE\)/u);
});
