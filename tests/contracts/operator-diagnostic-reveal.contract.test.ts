import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  PostgresOperatorDiagnosticReadStore,
  type DiagnosticPgClient,
  type DiagnosticPgPool,
} from "../../services/operator-diagnostic/src/database.js";
import {
  createOperatorDiagnosticHttpHandler,
  signOperatorDiagnosticRequest,
} from "../../services/operator-diagnostic/src/http.js";
import type { OperatorDiagnosticGrant } from "../../services/operator-diagnostic/src/contracts.js";

const revealId = "01K1ZZZZZZ0000000000000200";
const tenantId = "01K1ZZZZZZ0000000000000201";
const secret = "operator-diagnostic-test-secret-that-is-more-than-32-bytes";
const grant: OperatorDiagnosticGrant = Object.freeze({
  reveal_id: revealId,
  tenant_id: tenantId,
  pipeline_stage: "staging",
  schema_name: "source_xero",
  table_name: "xero_invoices",
  row_limit: 3,
  expires_at: "2030-01-01T00:00:00.000Z",
  analytical_capability: JSON.stringify({
    payload: { nonce: "01K1ZZZZZZ0000000000000202" },
    signature: "a".repeat(64),
    padding: "x".repeat(100),
  }),
});

test("signed diagnostic transport consumes one grant and audits completion before returning rows", async () => {
  const calls: string[] = [];
  const handler = createOperatorDiagnosticHttpHandler({
    signingSecret: secret,
    clock: () => 1_800_000_000_000,
    controlStore: {
      async claim(id) { calls.push(`claim:${id}`); return grant; },
      async complete(input) { calls.push(`complete:${input.status}:${input.rowCount}`); },
    },
    readStore: {
      async sample(input) {
        calls.push(`sample:${input.schema_name}.${input.table_name}`);
        return {
          revealId,
          stage: "staging",
          schemaName: "source_xero",
          tableName: "xero_invoices",
          columns: ["invoice_id", "total"],
          rows: [{ invoice_id: "invoice-1", total: "110.0000" }],
          rowCount: 1,
          excludedColumnCount: 2,
          cellCharacterLimit: 500,
        };
      },
    },
  });
  const body = JSON.stringify({ revealId });
  const headers = await signOperatorDiagnosticRequest(body, secret, 1_800_000_000_000);
  const response = await handler(new Request("https://diagnostic.example/v1/row-samples", {
    method: "POST",
    headers,
    body,
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [
    `claim:${revealId}`,
    "sample:source_xero.xero_invoices",
    "complete:completed:1",
  ]);
  const payload = await response.json() as { sample: { rows: unknown[] } };
  assert.equal(payload.sample.rows.length, 1);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
});

test("diagnostic endpoint rejects unsigned requests without claiming a grant", async () => {
  let claimed = false;
  const handler = createOperatorDiagnosticHttpHandler({
    signingSecret: secret,
    controlStore: {
      async claim() { claimed = true; return grant; },
      async complete() {},
    },
    readStore: { async sample() { throw new Error("must not execute"); } },
  });
  const response = await handler(new Request("https://diagnostic.example/v1/row-samples", {
    method: "POST",
    body: JSON.stringify({ revealId }),
  }));
  assert.equal(response.status, 401);
  assert.equal(claimed, false);
});

test("a transient completed-outcome failure is terminally recorded as failed before rows are discarded", async () => {
  const calls: string[] = [];
  const handler = createOperatorDiagnosticHttpHandler({
    signingSecret: secret,
    clock: () => 1_800_000_000_000,
    controlStore: {
      async claim() { calls.push("claim"); return grant; },
      async complete(input) {
        calls.push(`complete:${input.status}`);
        if (input.status === "completed") {
          const error = new Error("transient completion write failure") as Error & { code: string };
          error.code = "CONTROL_PLANE_UNAVAILABLE";
          throw error;
        }
      },
    },
    readStore: {
      async sample() {
        calls.push("sample");
        return {
          revealId,
          stage: "staging",
          schemaName: "source_xero",
          tableName: "xero_invoices",
          columns: ["invoice_id"],
          rows: [{ invoice_id: "invoice-1" }],
          rowCount: 1,
          excludedColumnCount: 0,
          cellCharacterLimit: 500,
        };
      },
    },
  });
  const body = JSON.stringify({ revealId });
  const headers = await signOperatorDiagnosticRequest(body, secret, 1_800_000_000_000);
  const response = await handler(new Request("https://diagnostic.example/v1/row-samples", {
    method: "POST", headers, body,
  }));
  assert.equal(response.status, 503);
  assert.deepEqual(calls, ["claim", "sample", "complete:completed", "complete:failed"]);
});

test("diagnostic SQL is fixed, tenant-parameterised, bounded, and omits secret-bearing structured columns", async () => {
  const statements: Array<Readonly<{ sql: string; parameters?: readonly unknown[] }>> = [];
  const client: DiagnosticPgClient = {
    async query(sql, parameters) {
      statements.push({ sql, parameters });
      if (sql.includes("session_user='albert_operator_diagnostic_analytical_runtime'")) return { rows: [{ ready: true }] };
      if (sql.includes("information_schema.columns")) return { rows: [
        { column_name: "tenant_id", data_type: "text" },
        { column_name: "invoice_id", data_type: "text" },
        { column_name: "total", data_type: "numeric" },
        { column_name: "oauth_token", data_type: "text" },
        { column_name: "contact", data_type: "jsonb" },
      ] };
      if (sql.startsWith("SELECT CASE")) return { rows: [{ invoice_id: "invoice-1", total: "110.0000" }] };
      return { rows: [] };
    },
    release() { statements.push({ sql: "RELEASE" }); },
  };
  const pool: DiagnosticPgPool = { async connect() { return client; } };
  const sample = await new PostgresOperatorDiagnosticReadStore(pool).sample(grant);
  assert.deepEqual(sample.columns, ["invoice_id", "total"]);
  assert.equal(sample.excludedColumnCount, 2);
  const select = statements.find(({ sql }) => sql.startsWith("SELECT CASE"));
  assert.ok(select);
  assert.match(select.sql, /FROM "source_xero"\."xero_invoices" WHERE tenant_id=\$1 LIMIT \$2/u);
  assert.doesNotMatch(select.sql, /oauth_token|contact|tenant_id AS/u);
  assert.deepEqual(select.parameters, [tenantId, 3]);
  assert.ok(statements.some(({ sql }) => sql === "SET LOCAL ROLE diagnostic_ro"));
  assert.ok(statements.some(({ sql }) => sql.includes("statement_timeout','2000ms")));
  assert.ok(statements.some(({ sql }) => sql.includes("pg_advisory_xact_lock_shared")));
});

test("operator reveal architecture keeps browser, model, and arbitrary SQL outside the diagnostic boundary", async () => {
  const [migration, route, repository, service, main, ui, css, runtime, workflow] = await Promise.all([
    readFile("infra/migrations/control-plane/0030_m2_operator_diagnostic_reveals.sql", "utf8"),
    readFile("app/api/admin/pipeline/[tenantId]/sample/route.ts", "utf8"),
    readFile("services/control-plane/src/operator-repository.ts", "utf8"),
    readFile("services/operator-diagnostic/src/database.ts", "utf8"),
    readFile("services/operator-diagnostic/src/main.ts", "utf8"),
    readFile("app/dash/components/AdminWorkspace.tsx", "utf8"),
    readFile("app/dash/dash.module.css", "utf8"),
    readFile("deploy/runtime-contract.json", "utf8"),
    readFile(".github/workflows/release-authority.yml", "utf8"),
  ]);
  assert.match(migration, /control_plane\.pipeline_stats/u);
  assert.match(migration, /operator\.row_sample_reveal_requested/u);
  assert.match(migration, /operator\.row_sample_reveal_completed/u);
  assert.match(migration, /row_limit BETWEEN 1 AND 5/u);
  assert.match(migration, /operator_diagnostic_reveal_claims/u);
  assert.match(route, /assertSameOriginMutation/u);
  assert.match(route, /readBoundedJsonBody\(request, 1_024\)/u);
  assert.match(repository, /ALBERT_OPERATOR_DIAGNOSTIC_SIGNING_SECRET/u);
  assert.match(repository, /redirect: "error"/u);
  assert.match(service, /SET LOCAL ROLE diagnostic_ro/u);
  assert.match(service, /WHERE tenant_id=\$1 LIMIT \$2/u);
  assert.match(service, /to_regclass\('ingestion.fivetran_destination_bindings'\)/u);
  assert.match(main, /uselibpqcompat/u);
  assert.match(main, /rejectUnauthorized: false/u);
  assert.doesNotMatch(service, /semantic_ro|OPENAI|run_semantic_query/u);
  assert.match(ui, /EXPLICIT DATA ACCESS/u);
  assert.match(ui, /Reveal 3 rows/u);
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*\.opsRevealPanel/u);
  const contract = JSON.parse(runtime) as { runtimes: Record<string, { requiredSecretNames: string[] }> };
  assert.deepEqual(contract.runtimes["operator-diagnostic"].requiredSecretNames.sort(), [
    "ALBERT_CONTROL_PLANE_PROJECT_REF",
    "ALBERT_OPERATOR_DIAGNOSTIC_SIGNING_SECRET",
    "OPERATOR_DIAGNOSTIC_ANALYTICAL_DATABASE_URL",
    "OPERATOR_DIAGNOSTIC_CONTROL_PLANE_DATABASE_URL",
  ].sort());
  assert.match(workflow, /OPERATOR_DIAGNOSTIC_SERVICE_URL[\s\S]*verify-release-readiness/u);
});

test("diagnostic pools keep libpq-compatible TLS for Supabase certificate chains", async () => {
  const main = await readFile("services/operator-diagnostic/src/main.ts", "utf8");
  assert.match(main, /function compatiblePostgresUrl/u);
  assert.match(main, /uselibpqcompat/u);
  assert.match(main, /rejectUnauthorized: false/u);
});
