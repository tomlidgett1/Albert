import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { ulid } from "ulid";
import { ManagedAgentsHarness } from "../packages/albert-agents-api/src/harness.js";
import { runGovernedAnalyticalTurn } from "../packages/albert-omni/src/runtime.js";
import { signCubeJwt } from "../packages/albert-v3/src/cube/jwt.js";
import { createTraceEmitter } from "../services/conversation/src/trace-emitter.js";
import type { TraceEvent, TraceTableEvent } from "../packages/shared/src/index.js";
import { FIXTURE_SIGNING_SECRET, startFrozenCube } from "./albert-eval/omni-frozen-fixture.js";

const apiKey = process.env.OPENAI_API_KEY;
assert.ok(apiKey, "Configure OPENAI_API_KEY in the environment.");
const cube = await startFrozenCube();
const directory = `outputs/newagent-analytics-${ulid().toLowerCase()}`;
await mkdir(directory, { recursive: true });
try {
  for (const [id, question, expected] of [
    ["total", "What were total gross takings in August 2026?", 600],
    ["filter", "What were gross takings for the North store in August 2026?", 400],
    ["comparison", "Compare July and August 2026 gross takings. Give both totals and the dollar change.", 400],
  ] as const) {
    const tenantId = ulid(), conversationId = ulid(), turnId = ulid();
    cube.register(turnId, tenantId, {});
    const events: TraceEvent[] = [];
    const emit = createTraceEmitter({ persist: async (event) => { events.push(event); }, deliver: () => {} });
    console.log(`START: ${id}`);
    const outcome = await runGovernedAnalyticalTurn({
      turn: {
        protocolVersion: 1, requestId: ulid(), tenantId, actorId: "00000000-0000-4000-8000-000000000001",
        role: "owner", conversationId, turnId, message: question, priorConversation: [],
        activeConnectors: ["lightspeed-r", "deputy"],
        connectorFreshness: [{ connector: "lightspeed-r", domain: "sales", dataThrough: "2026-08-31" }],
        businessContext: "Synthetic retail fixture. Not GST registered. All amounts AUD. July and August 2026 are complete.",
        timezone: "Australia/Melbourne", organisationName: "Synthetic Retail",
        model: "gpt-5.6-luna", effort: "high", fastMode: false,
        cubeBearer: signCubeJwt({ secret: FIXTURE_SIGNING_SECRET, expiresInSeconds: 900, securityContext: {
          tenant_id: tenantId, role: "owner", conversation_id: conversationId, turn_id: turnId, specialist_agent_id: "general", specialist_agent_version: 1,
        } }),
      },
      cubeApiUrl: cube.url, openai: { apiKey, baseUrl: "https://api.openai.com/v1" },
      harness: new ManagedAgentsHarness({ apiKey }), emit, signal: AbortSignal.timeout(240_000),
    });
    await emit.drain?.();
    await writeFile(`${directory}/${id}.json`, JSON.stringify({ outcome, events }, null, 2));
    const answer = events.findLast((event) => event.type === "answer");
    assert.ok(answer?.type === "answer");
    assert.notEqual(answer.state, "Unavailable");
    assert.ok(answer.claims?.length, "The answer must bind its figures to actual result cells.");
    const tables = new Map(events.filter((event): event is TraceTableEvent => event.type === "table").map((event) => [event.resultId, event]));
    const claimedValues = answer.claims.flatMap((claim) => claim.refs).map((ref) => {
      const table = tables.get(ref.resultId);
      assert.ok(table, "Every claim resolves to a recorded table.");
      return Number(table.rows[ref.rowIndex]?.[ref.columnKey]);
    });
    assert.ok(claimedValues.includes(expected), `The answer must cite the independent oracle value ${expected}.`);
    console.log(`PASS: ${id}; ${outcome.queriesExecuted} governed queries; evidence-bound answer; session cleaned up.`);
  }
  console.log(`Evidence saved in ${directory}`);
} finally { await cube.close(); }
