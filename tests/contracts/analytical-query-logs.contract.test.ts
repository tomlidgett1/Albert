import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { CubeClient } from "../../packages/albert-v3/src/cube/client.ts";
import {
  sanitizeQueryFailureMessage,
  type AnalyticalQueryAttemptOutcome,
  type AnalyticalQueryAttemptStart,
} from "../../packages/shared/src/query-audit.ts";

function read(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
}

const migration = read("infra/migrations/control-plane/0170_m8_analytical_query_attempt_ledger.sql");

test("query attempts and outcomes are separate immutable control-plane records", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS control_plane\.analytical_query_attempts/u);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS control_plane\.analytical_query_outcomes/u);
  assert.match(migration, /analytical_query_attempts_append_only[\s\S]*BEFORE UPDATE OR DELETE/u);
  assert.match(migration, /analytical_query_outcomes_append_only[\s\S]*BEFORE UPDATE OR DELETE/u);
  assert.match(migration, /control_plane\.deletion_mutation_authorized\(\)/u);
  assert.match(migration, /FOREIGN KEY \(tenant_id, turn_id\)[\s\S]*ON DELETE CASCADE/u);
  assert.match(migration, /NOT control_plane\.trace_event_has_forbidden_key\(query_document\)/u);
  assert.match(migration, /query_document::text\) <= 65536/u);
});

test("the database derives bounded question context and only Tom can read the cross-tenant log", () => {
  assert.match(migration, /'question', left\(selected_turn\.user_message, 8000\)/u);
  assert.match(migration, /'recentTurns'[\s\S]*LIMIT 6/u);
  assert.match(migration, /'assistantAnswer', recent\.assistant_answer/u);
  assert.match(migration, /extensions\.albert_auth_confirmed_user_by_email\('tom@lidgett\.net'\)/u);
  assert.match(migration, /extensions\.albert_auth_users_by_ids\(ARRAY\[attempt\.actor_user_id\]\)/u);
  assert.doesNotMatch(migration, /auth\.users/u);
  assert.match(migration, /operator\.query_logs_read/u);
  assert.match(migration, /REVOKE ALL ON TABLE[\s\S]*FROM PUBLIC, anon, authenticated, service_role/u);
  assert.doesNotMatch(migration, /GRANT SELECT ON (?:TABLE )?control_plane\.analytical_query/u);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.albert_analytical_query_logs[\s\S]*TO authenticated/u);
});

test("both chat runtimes and the Tom-only sidebar use the shared durable recorder", () => {
  const v3 = read("app/api/v3-conversation/route.ts");
  const codex = read("app/api/codex-conversation/route.ts");
  const session = read("app/api/session/route.ts");
  const dash = read("app/dash/page.tsx");
  const api = read("app/api/query-logs/route.ts");
  const codexHttp = read("services/codex-runtime/src/http.ts");

  assert.match(v3, /createSupabaseAnalyticalQueryRecorder/u);
  assert.match(v3, /runAlbertV3Turn\([\s\S]*queryRecorder/u);
  assert.match(codex, /createSupabaseAnalyticalQueryRecorder/u);
  assert.match(codex, /client\.runTurn\([\s\S]*queryRecorder\.start[\s\S]*queryRecorder\.finish/u);
  assert.match(codexHttp, /type: "query_audit"[\s\S]*phase: "start"/u);
  assert.match(codexHttp, /type: "query_audit"[\s\S]*phase: "finish"/u);
  assert.match(session, /queryLogsViewer/u);
  assert.match(dash, /\{canViewQueryLogs \? \([\s\S]*aria-label="Logs"/u);
  assert.match(dash, /activeItem === "Logs" && canViewQueryLogs/u);
  assert.match(api, /loadAnalyticalQueryLogs/u);
});

test("the operator workspace defaults to failures and follows dash theme/motion contracts", () => {
  const component = read("app/dash/components/QueryLogsWorkspace.tsx");
  const css = read("app/dash/components/query-logs.module.css");
  assert.match(component, /useState<AnalyticalQueryLogFilter>\("failures"\)/u);
  assert.match(component, /Search question, tenant, topic or error/u);
  assert.match(component, /QUESTION CONTEXT/u);
  assert.match(component, /GOVERNED QUERY/u);
  assert.match(css, /height: var\(--dash-control-height\)/u);
  assert.match(css, /border-radius: 10px/u);
  assert.match(css, /var\(--dash-danger-surface\)/u);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/u);
});

test("Cube writes a start and terminal outcome for success and semantic rejection", async () => {
  const starts: AnalyticalQueryAttemptStart[] = [];
  const outcomes: AnalyticalQueryAttemptOutcome[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    if (url.pathname.endsWith("/meta")) {
      return Response.json({
        cubes: [{
          name: "sales_analytics",
          public: true,
          measures: [{
            name: "sales_analytics.sales",
            title: "Sales",
            shortTitle: "Sales",
            type: "number",
            aliasMember: "sales.sales",
          }],
          dimensions: [],
          segments: [],
        }],
      });
    }
    return Response.json({
      data: [{ "sales_analytics.sales": 42 }],
      annotation: { measures: { "sales_analytics.sales": { title: "Sales", shortTitle: "Sales", type: "number" } } },
    });
  };
  const client = new CubeClient({
    apiUrl: "https://cube.example.test",
    apiSecret: "query-audit-contract-secret-that-is-long-enough",
    securityContext: {
      tenant_id: "01J00000000000000000000001",
      conversation_id: "01J00000000000000000000002",
      turn_id: "01J00000000000000000000003",
    },
    fetcher,
    queryRecorder: {
      start: async (attempt) => { starts.push(attempt); },
      finish: async (outcome) => { outcomes.push(outcome); },
    },
  });

  const success = await client.loadQuery({ measures: ["sales_analytics.sales"] }, {
    audit: { operation: "run_cube_query", topic: "Sales today" },
  });
  assert.equal(success.result.ok, true);
  const rejected = await client.loadQuery({ measures: ["missing_view.sales"] });
  assert.equal(rejected.result.ok, false);
  assert.equal(starts.length, 2);
  assert.equal(outcomes.length, 2);
  assert.equal(starts[0]?.topic, "Sales today");
  assert.equal(outcomes[0]?.status, "succeeded");
  assert.equal(outcomes[0]?.rowCount, 1);
  assert.equal(outcomes[1]?.status, "rejected");
  assert.equal(outcomes[1]?.queryAttemptId, starts[1]?.queryAttemptId);
});

test("an unavailable audit start fails closed before Cube is contacted", async () => {
  let requests = 0;
  const client = new CubeClient({
    apiUrl: "https://cube.example.test",
    apiSecret: "query-audit-contract-secret-that-is-long-enough",
    securityContext: {
      tenant_id: "01J00000000000000000000001",
      conversation_id: "01J00000000000000000000002",
      turn_id: "01J00000000000000000000003",
    },
    fetcher: async () => {
      requests += 1;
      return Response.json({ cubes: [] });
    },
    queryRecorder: {
      start: async () => { throw new Error("control plane unavailable"); },
      finish: async () => undefined,
    },
  });
  await assert.rejects(client.loadQuery({ measures: ["sales_analytics.sales"] }), /control plane unavailable/u);
  assert.equal(requests, 0);
});

test("failure messages redact credentials, tokens and URL query strings", () => {
  const sanitized = sanitizeQueryFailureMessage(
    "authorization=Bearer-secret sk-live_secret https://cube.test/load?token=hello payload",
  );
  assert.doesNotMatch(sanitized, /Bearer-secret|sk-live_secret|token=hello/u);
  assert.match(sanitized, /\[redacted/u);
});
