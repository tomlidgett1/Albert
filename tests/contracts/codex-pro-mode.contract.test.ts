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
  assert.match(planner, /proMode: options\.proMode/u);
  assert.match(appServer, /startCodexProModeProxy/u);
});
