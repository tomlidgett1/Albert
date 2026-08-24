import assert from "node:assert/strict";
import test from "node:test";
import { verifyInternalRequest } from "../../packages/security/src/internal-request.ts";
import { CodexRuntimeServiceClient } from "../../packages/albert-codex/src/service-client.ts";
import type { CodexServiceTurn } from "../../packages/albert-codex/src/contracts.ts";

const secret = "c".repeat(48);
const turn: CodexServiceTurn = {
  protocolVersion: 1,
  requestId: "01J00000000000000000000051",
  tenantId: "01J00000000000000000000052",
  actorId: "11111111-1111-4111-8111-111111111111",
  role: "owner",
  conversationId: "01J00000000000000000000053",
  turnId: "01J00000000000000000000054",
  message: "Review sales",
  priorConversation: [],
  priorResults: [],
  activeConnectors: ["lightspeed"],
  connectorFreshness: [],
  cubeBearer: "a.b.c",
  model: "gpt-5.6-sol",
  effort: "high",
  fastMode: true,
};

test("production HTTPS uses the same signed background-job protocol", async () => {
  const originalFetch = globalThis.fetch;
  let authenticated = false;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    const body = String(init?.body ?? "");
    const headers = new Headers(init?.headers);
    authenticated = await verifyInternalRequest({
      method: init?.method ?? "GET",
      path: url.pathname,
      body,
      secret,
      timestamp: headers.get("x-albert-timestamp"),
      signature: headers.get("x-albert-signature"),
    });
    if (url.pathname === "/v1/codex/jobs") {
      return Response.json({ jobId: turn.requestId }, { status: 202 });
    }
    return Response.json({
      jobId: turn.requestId,
      cursor: 1,
      events: [{ type: "progress", status: "running", stage: "planning", label: "Planning" }],
      result: {
        answerState: "Verified",
        queriesExecuted: 1,
        codexThreadId: "thr_fixture",
        codexTurnId: "turn_fixture",
        durationMs: 12,
      },
    });
  }) as typeof fetch;
  try {
    const events: unknown[] = [];
    const client = new CodexRuntimeServiceClient("https://codex.example.test", secret);
    const result = await client.runTurn(turn, (event) => events.push(event));
    assert.equal(authenticated, true);
    assert.equal(events.length, 1);
    assert.equal(result.answerState, "Verified");
    assert.equal(result.queriesExecuted, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("localhost uses short signed background-job polls instead of one long fetch", async () => {
  const originalFetch = globalThis.fetch;
  const paths: string[] = [];
  globalThis.fetch = (async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    const body = String(init?.body ?? "");
    const headers = new Headers(init?.headers);
    assert.equal(await verifyInternalRequest({
      method: init?.method ?? "GET",
      path: url.pathname,
      body,
      secret,
      timestamp: headers.get("x-albert-timestamp"),
      signature: headers.get("x-albert-signature"),
    }), true);
    paths.push(url.pathname);
    if (url.pathname === "/v1/codex/jobs") {
      return Response.json({ jobId: turn.requestId }, { status: 202 });
    }
    assert.equal(url.pathname, `/v1/codex/jobs/${turn.requestId}/poll`);
    if (paths.filter((path) => path.endsWith("/poll")).length === 1) {
      return Response.json({
        jobId: turn.requestId,
        cursor: 1,
        events: [{ type: "progress", status: "running", stage: "planning", label: "Planning" }],
      });
    }
    return Response.json({
      jobId: turn.requestId,
      cursor: 1,
      events: [],
      result: {
        answerState: "Verified",
        queriesExecuted: 7,
        codexThreadId: "thr_job_fixture",
        codexTurnId: "turn_job_fixture",
        durationMs: 70_000,
      },
    });
  }) as typeof fetch;
  try {
    const events: unknown[] = [];
    const client = new CodexRuntimeServiceClient("http://127.0.0.1:8792", secret);
    const result = await client.runTurn(turn, (event) => events.push(event));
    assert.deepEqual(paths, [
      "/v1/codex/jobs",
      `/v1/codex/jobs/${turn.requestId}/poll`,
      `/v1/codex/jobs/${turn.requestId}/poll`,
    ]);
    assert.equal(events.length, 1);
    assert.equal(result.durationMs, 70_000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Codex query-audit wire events reach the durable sink and never enter the owner trace", async () => {
  const originalFetch = globalThis.fetch;
  const attemptId = "01J00000000000000000000055";
  globalThis.fetch = (async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    if (url.pathname === "/v1/codex/jobs") {
      return Response.json({ jobId: turn.requestId }, { status: 202 });
    }
    return Response.json({
      jobId: turn.requestId,
      cursor: 3,
      events: [
        {
          type: "query_audit",
          phase: "start",
          attempt: {
            queryAttemptId: attemptId,
            runtime: "codex-app-server",
            source: "cube",
            operation: "codex_semantic_query",
            topic: "Sales review",
            queryDocument: { measures: ["sales_analytics.sales"] },
          },
        },
        { type: "progress", status: "running", stage: "query", label: "Querying sales" },
        {
          type: "query_audit",
          phase: "finish",
          outcome: {
            queryAttemptId: attemptId,
            status: "succeeded",
            executionMs: 12,
            rowCount: 1,
            resultMetadata: { view: "sales_analytics" },
          },
        },
      ],
      result: {
        answerState: "Verified",
        queriesExecuted: 1,
        codexThreadId: "thr_audit_fixture",
        codexTurnId: "turn_audit_fixture",
        durationMs: 20,
      },
    });
  }) as typeof fetch;
  try {
    const traceEvents: unknown[] = [];
    const auditEvents: unknown[] = [];
    const client = new CodexRuntimeServiceClient("https://codex.example.test", secret);
    await client.runTurn(
      turn,
      (event) => traceEvents.push(event),
      undefined,
      async (event) => { auditEvents.push(event); },
    );
    assert.equal(traceEvents.length, 1);
    assert.equal((traceEvents[0] as { type: string }).type, "progress");
    assert.equal(auditEvents.length, 2);
    assert.deepEqual(auditEvents.map((event) => (event as { phase: string }).phase), ["start", "finish"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
