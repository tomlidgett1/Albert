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
import { normalizeOmniCubeQuery } from "../../packages/albert-omni/src/query-normalize.js";
import { ALBERT_OMNI_MODEL_IDS, omniServiceTurnSchema } from "../../packages/albert-omni/src/contracts.js";
import {
  CLAUDE_HAIKU_4_5_MODEL_ID,
  CLAUDE_SONNET_5_MODEL_ID,
  normalizeAgentPreferences,
} from "../../packages/shared/src/agent-runtime.js";
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
  assert.equal(config.omniAnthropic, undefined);
});

test("Omni runtime config carries Anthropic Messages credentials when the key is present", () => {
  const config = loadCodexRuntimeConfig({
    NODE_ENV: "test",
    ALBERT_CODEX_RUNTIME_SIGNING_SECRET: signingSecret,
    CUBE_API_URL: "https://cube.example.test",
    OPENAI_API_KEY: "sk-test",
    OPENAI_BASE_URL: "https://au.api.openai.com/v1",
    ANTHROPIC_API_KEY: "sk-ant-test",
  });
  assert.deepEqual(config.omniAnthropic, {
    apiKey: "sk-ant-test",
    baseUrl: "https://api.anthropic.com",
  });
});

test("Production Omni runtime honours Anthropic credentials only with APP 8 and ZDR approval", () => {
  const productionEnvironment = {
    NODE_ENV: "production",
    ALBERT_CODEX_RUNTIME_SIGNING_SECRET: signingSecret,
    ALBERT_SERVICE_VERSION: "a".repeat(40),
    CUBE_API_URL: "https://cube.example.test",
    OPENAI_API_KEY: "sk-test",
    OPENAI_BASE_URL: "https://au.api.openai.com/v1",
    ANTHROPIC_API_KEY: "sk-ant-test",
  } as const;
  assert.equal(loadCodexRuntimeConfig(productionEnvironment).omniAnthropic, undefined);
  assert.equal(loadCodexRuntimeConfig({
    ...productionEnvironment,
    ALBERT_ANTHROPIC_APP8_APPROVED: "true",
  }).omniAnthropic, undefined);
  assert.deepEqual(loadCodexRuntimeConfig({
    ...productionEnvironment,
    ALBERT_ANTHROPIC_APP8_APPROVED: "true",
    ALBERT_ANTHROPIC_ZDR_APPROVED: "true",
  }).omniAnthropic, {
    apiKey: "sk-ant-test",
    baseUrl: "https://api.anthropic.com",
  });
});

function omniHandler(credentials: Readonly<{ openai?: boolean; anthropic?: boolean }>): CodexRuntimeHttpHandler {
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
    ...(credentials.openai ? {
      omniOpenAi: Object.freeze({ apiKey: "sk-fixture", baseUrl: "https://au.api.openai.com/v1" }),
    } : {}),
    ...(credentials.anthropic ? {
      omniAnthropic: Object.freeze({ apiKey: "sk-ant-fixture", baseUrl: "https://api.anthropic.com" }),
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
  const handler = omniHandler({ openai: true });
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
  const handler = omniHandler({});
  const response = await handler.handle(await signedOmniRequest(JSON.stringify(fixtureOmniTurn())));
  assert.equal(response.status, 503);
  const payload = await response.json() as { error?: { code?: string } };
  assert.equal(payload.error?.code, "omni_unavailable");
});

test("Omni jobs endpoint requires the credentials of the selected model's provider", async () => {
  for (const model of [CLAUDE_HAIKU_4_5_MODEL_ID, CLAUDE_SONNET_5_MODEL_ID]) {
    const claudeTurn = { ...fixtureOmniTurn(), model };

    // Anthropic model without Anthropic credentials fails closed even though
    // the OpenAI side is fully configured — and vice versa.
    const openaiOnly = await omniHandler({ openai: true })
      .handle(await signedOmniRequest(JSON.stringify(claudeTurn)));
    assert.equal(openaiOnly.status, 503, model);

    const anthropicOnly = omniHandler({ anthropic: true });
    const gptRejected = await anthropicOnly.handle(await signedOmniRequest(JSON.stringify(fixtureOmniTurn())));
    assert.equal(gptRejected.status, 503, model);

    const accepted = await anthropicOnly.handle(await signedOmniRequest(JSON.stringify({
      ...claudeTurn,
      requestId: ulid(),
    })));
    assert.equal(accepted.status, 202, model);
    const payload = await accepted.json() as { jobId?: string };
    assert.equal(typeof payload.jobId, "string", model);
  }
});

test("Omni allowlists the Anthropic models with fast mode clamped off and every effort intact", () => {
  for (const model of [CLAUDE_HAIKU_4_5_MODEL_ID, CLAUDE_SONNET_5_MODEL_ID]) {
    assert.ok((ALBERT_OMNI_MODEL_IDS as readonly string[]).includes(model));
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      const preferences = normalizeAgentPreferences({
        model,
        reasoningEffort: effort,
        fastMode: true,
      });
      assert.equal(preferences.model, model);
      assert.equal(preferences.reasoningEffort, effort);
      assert.equal(preferences.fastMode, false);
    }
  }
});

test("Omni query normalizer repairs the common compareDateRange and phrasing mistakes", () => {
  // A one-entry comparison is a plain period: it becomes the dateRange.
  const single = normalizeOmniCubeQuery({
    measures: ["xero_profit_and_loss_analytics.net_profit"],
    timeDimensions: [{
      dimension: "xero_profit_and_loss_analytics.period_start",
      granularity: "month",
      compareDateRange: ["2026-07-01 to 2026-08-31"],
    }],
  });
  assert.equal(single.query.timeDimensions?.[0]?.compareDateRange, undefined);
  assert.deepEqual(single.query.timeDimensions?.[0]?.dateRange, "2026-07-01 to 2026-08-31");
  assert.equal(single.adjustments.length, 1);

  // Five comparison periods clamp to the governed four.
  const five = normalizeOmniCubeQuery({
    measures: ["sales_analytics.gross_takings"],
    timeDimensions: [{
      dimension: "sales_analytics.completed_at",
      compareDateRange: ["a", "b", "c", "d", "e"],
    }],
  });
  assert.equal(five.query.timeDimensions?.[0]?.compareDateRange?.length, 4);

  // "last 12 complete weeks" becomes Cube-parseable "last 12 weeks".
  const phrase = normalizeOmniCubeQuery({
    measures: ["sales_analytics.gross_takings"],
    timeDimensions: [{
      dimension: "sales_analytics.completed_at",
      granularity: "week",
      dateRange: "last 12 complete weeks",
    }],
  });
  assert.equal(phrase.query.timeDimensions?.[0]?.dateRange, "last 12 weeks");

  // A bucketed member duplicated as a plain dimension loses the duplicate.
  const duplicate = normalizeOmniCubeQuery({
    measures: ["xero_profit_and_loss_analytics.net_profit"],
    dimensions: ["xero_profit_and_loss_analytics.period_start"],
    timeDimensions: [{
      dimension: "xero_profit_and_loss_analytics.period_start",
      granularity: "month",
      dateRange: "last 6 months",
    }],
  });
  assert.equal(duplicate.query.dimensions, undefined);

  // A well-formed query passes through untouched with no adjustments.
  const clean = normalizeOmniCubeQuery({
    measures: ["sales_analytics.gross_takings"],
    dimensions: ["sales_analytics.store_name"],
    timeDimensions: [{
      dimension: "sales_analytics.completed_at",
      granularity: "week",
      dateRange: "last 12 weeks",
    }],
    limit: 100,
  });
  assert.equal(clean.adjustments.length, 0);
  assert.deepEqual(clean.query.dimensions, ["sales_analytics.store_name"]);
});

test("Omni query normalizer reclassifies misfiled members and rejects text operators on time fields", () => {
  const memberKinds = new Map([
    ["xero_profit_and_loss_analytics.net_profit", { kind: "measure", type: "number" }],
    ["xero_profit_and_loss_analytics.reconciles_to_xero", { kind: "dimension", type: "boolean" }],
    ["sales_analytics.completed_at", { kind: "dimension", type: "time" }],
  ] as const);

  const misfiled = normalizeOmniCubeQuery({
    measures: [
      "xero_profit_and_loss_analytics.net_profit",
      "xero_profit_and_loss_analytics.reconciles_to_xero",
    ],
  }, memberKinds);
  assert.deepEqual(misfiled.query.measures, ["xero_profit_and_loss_analytics.net_profit"]);
  assert.deepEqual(misfiled.query.dimensions, ["xero_profit_and_loss_analytics.reconciles_to_xero"]);
  assert.equal(misfiled.errors.length, 0);
  assert.match(misfiled.adjustments[0]!, /moved to dimensions/u);

  const timeMisuse = normalizeOmniCubeQuery({
    measures: ["xero_profit_and_loss_analytics.net_profit"],
    filters: [{ member: "sales_analytics.completed_at", operator: "contains", values: ["2026-08"] }],
  }, memberKinds);
  assert.equal(timeMisuse.errors.length, 1);
  assert.match(timeMisuse.errors[0]!, /time field/u);
  assert.match(timeMisuse.errors[0]!, /inDateRange/u);
});
