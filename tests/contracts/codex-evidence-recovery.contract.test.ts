import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCodexSemanticTurn } from "../../packages/albert-codex/src/semantic-runtime.ts";
import { signCubeJwt } from "../../packages/albert-v3/src/cube/jwt.ts";

const failingAfterEvidenceSource = `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.148.0\\n");
  process.exit(0);
}
if (process.argv.includes("login")) {
  process.stdin.resume();
  process.stdin.on("end", () => process.exit(0));
  return;
}
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
const threadId = "thr_late_failure";
const turnId = "turn_late_failure";
let resultId = "";
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") return send({ id: message.id, result: {} });
  if (message.method === "thread/start") return send({ id: message.id, result: { thread: { id: threadId } } });
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: turnId } } });
    return setImmediate(() => send({
      method: "item/tool/call",
      id: 60,
      params: {
        threadId,
        turnId,
        callId: "workshop_query",
        namespace: "albert",
        tool: "run_semantic_query",
        arguments: {
          topic: "Recent monthly workshop intake",
          query: {
            measures: ["workshop_analytics.workorder_count"],
            timeDimensions: [{
              dimension: "workshop_analytics.checked_in_at",
              granularity: "month",
              dateRange: ["2026-02-01", "2026-07-31"]
            }],
            order: { "workshop_analytics.checked_in_at": "asc" },
            limit: 12
          }
        }
      }
    }));
  }
  if (message.id === 60 && message.result) {
    resultId = JSON.parse(message.result.contentItems[0].text).resultId;
    return send({
      method: "item/tool/call",
      id: 61,
      params: {
        threadId,
        turnId,
        callId: "workshop_update",
        namespace: "albert",
        tool: "report_evidence_update",
        arguments: {
          message: "Workshop intake fell from 196 workorders to 127 workorders.",
          evidenceResultIds: [resultId]
        }
      }
    });
  }
  if (message.id === 61 && message.result) setImmediate(() => process.exit(12));
});
`;

test("a late Codex process failure cannot discard successful governed evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "albert-codex-evidence-recovery-"));
  const binary = join(directory, "codex-late-failure-fixture");
  await writeFile(binary, failingAfterEvidenceSource, "utf8");
  await chmod(binary, 0o755);

  const cube = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url?.startsWith("/cubejs-api/v1/meta")) {
      response.end(JSON.stringify({ cubes: [{
        name: "workshop_analytics",
        title: "Workshop analytics",
        description: "Synthetic governed workshop intake.",
        public: true,
        measures: [{
          name: "workshop_analytics.workorder_count",
          title: "Workorders",
          shortTitle: "Workorders",
          description: "Count of workshop jobs.",
          type: "number",
        }],
        dimensions: [{
          name: "workshop_analytics.checked_in_at",
          title: "Checked in at",
          shortTitle: "Checked in at",
          description: "Workshop intake date.",
          type: "time",
        }],
        segments: [],
      }] }));
      return;
    }
    response.end(JSON.stringify({
      data: [
        { "workshop_analytics.checked_in_at.month": "2026-02-01T00:00:00.000", "workshop_analytics.workorder_count": 196 },
        { "workshop_analytics.checked_in_at.month": "2026-07-01T00:00:00.000", "workshop_analytics.workorder_count": 127 },
      ],
      annotation: {
        measures: {
          "workshop_analytics.workorder_count": { title: "Workorders", shortTitle: "Workorders", type: "number" },
        },
        dimensions: {
          "workshop_analytics.checked_in_at.month": { title: "Checked in at", shortTitle: "Checked in at", type: "time" },
        },
      },
    }));
  });
  cube.listen(0, "127.0.0.1");
  await once(cube, "listening");
  const address = cube.address();
  assert.ok(address && typeof address === "object");

  const tenantId = "01J00000000000000000000101";
  const conversationId = "01J00000000000000000000102";
  const turnId = "01J00000000000000000000103";
  const cubeBearer = signCubeJwt({
    secret: "s".repeat(48),
    expiresInSeconds: 900,
    securityContext: {
      tenant_id: tenantId,
      role: "owner",
      specialist_agent_id: "general",
      specialist_agent_version: 1,
      conversation_id: conversationId,
      turn_id: turnId,
    },
  });
  const events: Array<{ type: string; [key: string]: unknown }> = [];
  try {
    const result = await runCodexSemanticTurn({
      turn: {
        protocolVersion: 1,
        requestId: "01J00000000000000000000104",
        tenantId,
        actorId: "11111111-1111-4111-8111-111111111111",
        role: "owner",
        conversationId,
        turnId,
        message: "Find one high-confidence opportunity I could test this month",
        priorConversation: [],
        priorResults: [],
        activeConnectors: ["lightspeed-r"],
        connectorFreshness: [{ connector: "lightspeed", domain: "workshop", dataThrough: "2026-08-20" }],
        cubeBearer,
        model: "gpt-5.6-luna",
        effort: "max",
        fastMode: true,
      },
      cubeApiUrl: `http://127.0.0.1:${address.port}`,
      authentication: {
        mode: "api",
        apiKey: "sk-fixture",
        baseUrl: "https://au.api.openai.com/v1",
      },
      codexBinaryPath: binary,
      emit: (event) => events.push(event),
    });

    assert.equal(result.answerState, "Qualified");
    assert.equal(result.codexThreadId, "evidence-recovery");
    assert.equal(result.queriesExecuted, 1);
    const answer = events.findLast((event) => event.type === "answer");
    assert.match(String(answer?.text), /workshop-demand test/iu);
    assert.match(String(answer?.text), /196 workorders/iu);
    assert.equal(events.some((event) => event.type === "error"), false);
    assert.equal(events.some((event) => event.type === "validation" && event.name === "Codex evidence recovery"), true);
  } finally {
    cube.close();
    await once(cube, "close");
    await rm(directory, { recursive: true, force: true });
  }
});
