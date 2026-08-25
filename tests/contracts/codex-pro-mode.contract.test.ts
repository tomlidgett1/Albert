import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test from "node:test";
import {
  codexAppServerArguments,
  runCodexAppServerTurn,
} from "../../packages/albert-codex/src/app-server.ts";
import { codexConversationRequestSchema } from "../../packages/albert-codex/src/contracts.ts";
import {
  startCodexProModeProxy,
  withCodexProReasoningMode,
} from "../../packages/albert-codex/src/pro-mode-proxy.ts";

const read = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

test("Pro mode preserves reasoning effort and adds the independent Responses mode", () => {
  assert.deepEqual(withCodexProReasoningMode({
    model: "gpt-5.6-terra",
    reasoning: { effort: "xhigh", summary: "concise" },
    input: "question",
  }), {
    model: "gpt-5.6-terra",
    reasoning: { effort: "xhigh", summary: "concise", mode: "pro" },
    input: "question",
  });
});

test("the loopback adapter injects Pro into the exact outgoing Responses request", async () => {
  let received: unknown;
  let receivedAuthorization: string | undefined;
  const upstream = createServer((request, response) => {
    receivedAuthorization = request.headers.authorization;
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    request.on("end", () => {
      received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.statusCode = 200;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ok: true }));
    });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const proxy = await startCodexProModeProxy(
    `http://127.0.0.1:${address.port}/v1`,
    "sk-fixture",
  );
  try {
    const response = await fetch(`${proxy.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-luna",
        reasoning: { effort: "max" },
        input: "fixture",
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(receivedAuthorization, "Bearer sk-fixture");
    assert.deepEqual(received, {
      model: "gpt-5.6-luna",
      reasoning: { effort: "max", mode: "pro" },
      input: "fixture",
    });
    assert.deepEqual(proxy.receipt(), {
      injectedRequests: 1,
      acceptedResponses: 1,
      verified: true,
    });
  } finally {
    await proxy.close();
    await new Promise<void>((resolveClose) => upstream.close(() => resolveClose()));
  }
});

test("the Pro receipt does not verify a provider-rejected Responses request", async () => {
  const upstream = createServer((_request, response) => {
    response.statusCode = 400;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ error: { message: "rejected fixture" } }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const proxy = await startCodexProModeProxy(
    `http://127.0.0.1:${address.port}/v1`,
    "sk-fixture",
  );
  try {
    const response = await fetch(`${proxy.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-luna", input: "fixture" }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(proxy.receipt(), {
      injectedRequests: 1,
      acceptedResponses: 0,
      verified: false,
    });
  } finally {
    await proxy.close();
    await new Promise<void>((resolveClose) => upstream.close(() => resolveClose()));
  }
});

test("the Pro adapter forwards documented reasoning-summary deltas without exposing reasoning text", async () => {
  const events: unknown[] = [];
  const upstream = createServer((_request, response) => {
    response.statusCode = 200;
    response.setHeader("content-type", "text/event-stream");
    response.write(`data: ${JSON.stringify({
      type: "response.reasoning_summary_text.delta",
      item_id: "rs_fixture",
      summary_index: 0,
      delta: "I’ll compare the strongest explanations. ",
    })}\n\n`);
    response.write(`data: ${JSON.stringify({
      type: "response.reasoning_text.delta",
      item_id: "rs_fixture",
      content_index: 0,
      delta: "private reasoning must not be surfaced",
    })}\n\n`);
    response.end(`data: ${JSON.stringify({
      type: "response.reasoning_summary_text.done",
      item_id: "rs_fixture",
      summary_index: 0,
      text: "I’ll compare the strongest explanations.",
    })}\n\n`);
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const proxy = await startCodexProModeProxy(
    `http://127.0.0.1:${address.port}/v1`,
    "sk-fixture",
    (event) => events.push(event),
  );
  try {
    const response = await fetch(`${proxy.baseUrl}/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gpt-5.6-luna", stream: true, input: "fixture" }),
    });
    assert.match(await response.text(), /private reasoning must not be surfaced/u);
    assert.deepEqual(events, [
      {
        kind: "delta",
        itemId: "rs_fixture",
        summaryIndex: 0,
        text: "I’ll compare the strongest explanations. ",
      },
      {
        kind: "done",
        itemId: "rs_fixture",
        summaryIndex: 0,
        text: "I’ll compare the strongest explanations.",
      },
    ]);
  } finally {
    await proxy.close();
    await new Promise<void>((resolveClose) => upstream.close(() => resolveClose()));
  }
});

test("Pro mode is API-authenticated and wired only into the Codex request path", async () => {
  const proxyArguments = codexAppServerArguments({
    mode: "api",
    apiKey: "must-not-render",
    baseUrl: "https://au.api.openai.com/v1",
  }, false, undefined, "http://127.0.0.1:9876/capability/v1").join(" ");
  assert.match(proxyArguments, /openai_base_url="http:\/\/127\.0\.0\.1:9876\/capability\/v1"/u);
  assert.doesNotMatch(proxyArguments, /must-not-render|au\.api\.openai/u);

  await assert.rejects(() => runCodexAppServerTurn({
    authentication: { mode: "chatgpt", codexHome: "/tmp/albert-codex-pro-test" },
    model: "gpt-5.6-sol",
    effort: "max",
    fastMode: false,
    proMode: true,
    input: "fixture",
    baseInstructions: "fixture",
    developerInstructions: "fixture",
    onToolCall: async () => ({ success: false, text: "No tool expected." }),
  }), /Pro reasoning mode requires API authentication/u);

  assert.deepEqual(codexConversationRequestSchema.parse({
    message: "Review the hardest risks",
    proMode: true,
  }), {
    message: "Review the hardest risks",
    proMode: true,
  });

  const [controls, dash, route, runtime, planner, appServer] = await Promise.all([
    read("app/dash/components/ModelRunControls.tsx"),
    read("app/dash/page.tsx"),
    read("app/api/codex-conversation/route.ts"),
    read("packages/albert-codex/src/semantic-runtime.ts"),
    read("packages/albert-codex/src/sol-planner.ts"),
    read("packages/albert-codex/src/app-server.ts"),
  ]);
  assert.match(controls, /Pro reasoning/u);
  assert.match(dash, /proMode: runProMode/u);
  assert.match(route, /reasoningMode/u);
  assert.match(runtime, /proMode: turn\.reasoningMode === "pro"/u);
  assert.match(runtime, /name: "OpenAI Pro reasoning mode"/u);
  assert.match(planner, /proMode: options\.proMode/u);
  assert.match(appServer, /startCodexProModeProxy/u);
  assert.match(appServer, /proModeProxy\?\.receipt\(\)\.verified/u);
});
