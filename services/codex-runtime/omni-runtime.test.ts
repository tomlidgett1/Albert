import assert from "node:assert/strict";
import test from "node:test";
import { ulid } from "ulid";
import { signInternalRequest } from "../../packages/security/src/internal-request.js";
import {
  lookupTopicModel,
  renderTopicIndex,
  searchModelFields,
} from "../../packages/albert-omni/src/semantic-model.js";
import { extractOmniFollowUps } from "../../packages/albert-omni/src/runtime.js";
import { omniServiceTurnSchema } from "../../packages/albert-omni/src/contracts.js";
import type { CubeCatalogue } from "../../packages/albert-v3/src/cube/types.js";
import { loadCodexRuntimeConfig } from "./src/config.js";
import { CodexRuntimeHttpHandler } from "./src/http.js";

const signingSecret = "h".repeat(48);

const fixtureCatalogue: CubeCatalogue = {
  fetchedAt: new Date("2026-08-29T00:00:00Z").toISOString(),
  views: [
    {
      name: "sales_analytics",
      title: "Sales Analytics",
      description: "Completed POS sales by store, register and day.",
      members: [
        {
          name: "sales_analytics.gross_takings",
          kind: "measure",
          title: "Gross takings",
          shortTitle: "Gross takings",
          description: "Total completed sale value including tax.",
          type: "number",
        },
        {
          name: "sales_analytics.store_name",
          kind: "dimension",
          title: "Store name",
          shortTitle: "Store",
          type: "string",
          folder: "Store",
        },
        {
          name: "sales_analytics.completed_at",
          kind: "dimension",
          title: "Completed at",
          shortTitle: "Completed",
          type: "time",
        },
        {
          name: "sales_analytics.hidden_probe",
          kind: "dimension",
          title: "Hidden probe",
          shortTitle: "Hidden",
          type: "string",
          aiHidden: true,
        },
      ],
    },
    {
      name: "refunds_analytics",
      title: "Refunds Analytics",
      description: "Refunded sales and their reasons.",
      members: [
        {
          name: "refunds_analytics.refund_total",
          kind: "measure",
          title: "Refund total",
          shortTitle: "Refund total",
          description: "Total refunded value.",
          type: "number",
        },
      ],
    },
  ],
};

test("Omni topic lookup renders the whole topic as YAML grouped by view", () => {
  const result = lookupTopicModel(fixtureCatalogue, "Sales Analytics");
  assert.equal(result.viewCount, 1);
  assert.equal(result.fieldCount, 3, "aiHidden members never reach the model surface");
  assert.match(result.document, /## Field Definitions/u);
  assert.match(result.document, /```yaml/u);
  assert.match(result.document, /- view_name: sales_analytics/u);
  assert.match(result.document, /label: Sales Analytics/u);
  assert.match(result.document, /dimensions:/u);
  assert.match(result.document, /measures:/u);
  assert.match(result.document, /name: sales_analytics\.gross_takings/u);
  assert.match(result.document, /data_type: NUMBER/u);
  assert.match(result.document, /data_type: TIMESTAMP/u);
  assert.doesNotMatch(result.document, /hidden_probe/u);
  assert.equal(result.summary, "Looked up topic Sales Analytics");
});

test("Omni field search matches across views and reports the count", () => {
  const result = searchModelFields(fixtureCatalogue, "refund");
  assert.equal(result.fieldCount, 1);
  assert.match(result.summary, /^1 field found matching "refund"$/u);
  assert.match(result.document, /- view_name: refunds_analytics/u);

  const missing = searchModelFields(fixtureCatalogue, "unicorn dust");
  assert.equal(missing.fieldCount, 0);
  assert.match(missing.summary, /No fields found matching/u);
  assert.match(missing.document, /\[\]/u);
  assert.match(missing.document, /No matches found\. Try different or related terms\./u);
});

test("Omni topic index lists one line per topic", () => {
  const index = renderTopicIndex(fixtureCatalogue);
  const lines = index.split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^- sales_analytics \("Sales Analytics"\): 1 measures, 2 dimensions\./u);
});

test("Omni follow-up extraction pulls ai-query links and strips the trailing block", () => {
  const answer = [
    "Revenue was $12,400 this week, up 8% on last week.",
    "",
    "The rise came from the Fitzroy store.",
    "",
    "[How does this compare to last year?](?ai-query=How%20does%20this%20compare%20to%20last%20year%3F)",
    "[Which products drove the rise?](?ai-query=Which%20products%20drove%20the%20rise%3F)",
  ].join("\n");
  const extracted = extractOmniFollowUps(answer);
  assert.deepEqual(extracted.followUps, [
    "How does this compare to last year?",
    "Which products drove the rise?",
  ]);
  assert.doesNotMatch(extracted.text, /ai-query/u);
  assert.match(extracted.text, /Fitzroy store\.$/u);
});

test("Omni follow-up extraction removes an orphaned lead-in line with its block", () => {
  const answer = [
    "Here is the tour of your connected data.",
    "",
    "I can next run any of these:",
    "",
    "[Rank my categories by profit](?ai-query=Rank%20my%20categories%20by%20profit)",
    "[Compare wages to sales](?ai-query=Compare%20wages%20to%20sales)",
  ].join("\n");
  const extracted = extractOmniFollowUps(answer);
  assert.equal(extracted.followUps.length, 2);
  assert.match(extracted.text, /connected data\.$/u);
  assert.doesNotMatch(extracted.text, /run any of these:/u);
});

test("Omni runtime config carries direct Responses credentials in api mode", () => {
  const config = loadCodexRuntimeConfig({
    NODE_ENV: "test",
    ALBERT_CODEX_RUNTIME_SIGNING_SECRET: signingSecret,
    CUBE_API_URL: "https://cube.example.test",
    OPENAI_API_KEY: "sk-test",
    OPENAI_BASE_URL: "https://au.api.openai.com/v1",
  });
  assert.deepEqual(config.omniOpenAi, {
    apiKey: "sk-test",
    baseUrl: "https://au.api.openai.com/v1",
  });
});

function omniHandler(withCredentials: boolean): CodexRuntimeHttpHandler {
  return new CodexRuntimeHttpHandler(Object.freeze({
    port: 8792,
    listenHost: "127.0.0.1" as const,
    signingSecret,
    cubeApiUrl: "https://cube.example.test",
    authentication: {
      mode: "api" as const,
      apiKey: "sk-fixture",
      baseUrl: "https://au.api.openai.com/v1",
    },
    maxConcurrentTurns: 2,
    pinnedCliVersion: "0.148.0",
    releaseSha: "development",
    deploymentId: "test",
    ...(withCredentials ? {
      omniOpenAi: Object.freeze({ apiKey: "sk-fixture", baseUrl: "https://au.api.openai.com/v1" }),
    } : {}),
  }));
}

async function signedOmniRequest(body: string): Promise<Request> {
  const signed = await signInternalRequest({
    method: "POST",
    path: "/v1/omni/jobs",
    body,
    secret: signingSecret,
  });
  return new Request("http://127.0.0.1:8792/v1/omni/jobs", {
    method: "POST",
    headers: { "content-type": "application/json", ...signed },
    body,
  });
}

function fixtureOmniTurn(): Record<string, unknown> {
  return {
    protocolVersion: 1,
    requestId: ulid(),
    tenantId: ulid(),
    actorId: "b3b7f9a8-8f11-4f76-9f3f-6a2b6f1d9c01",
    role: "owner",
    conversationId: ulid(),
    turnId: ulid(),
    message: "How were sales last week?",
    priorConversation: [],
    activeConnectors: ["lightspeed"],
    connectorFreshness: [],
    cubeBearer: "aaa.bbb.ccc",
    model: "gpt-5.6-luna",
    effort: "max",
    fastMode: false,
  };
}

test("Omni turn schema admits long messages the codex contract would reject", () => {
  const turn = { ...fixtureOmniTurn(), message: "x".repeat(20_000) };
  assert.equal(omniServiceTurnSchema.safeParse(turn).success, true);
});

test("Omni jobs endpoint rejects unsigned and malformed requests", async () => {
  const handler = omniHandler(true);
  const unsigned = await handler.handle(new Request("http://127.0.0.1:8792/v1/omni/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(fixtureOmniTurn()),
  }));
  assert.equal(unsigned.status, 401);

  const malformed = await handler.handle(await signedOmniRequest(JSON.stringify({ nope: true })));
  assert.equal(malformed.status, 400);
});

test("Omni jobs endpoint fails closed when Responses credentials are missing", async () => {
  const handler = omniHandler(false);
  const response = await handler.handle(await signedOmniRequest(JSON.stringify(fixtureOmniTurn())));
  assert.equal(response.status, 503);
  const payload = await response.json() as { error?: { code?: string } };
  assert.equal(payload.error?.code, "omni_unavailable");
});
