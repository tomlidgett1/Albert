import assert from "node:assert/strict";
import test from "node:test";
import { signInternalRequest } from "../../packages/security/src/internal-request.js";
import { loadCodexRuntimeConfig } from "./src/config.js";
import { CodexRuntimeHttpHandler } from "./src/http.js";

const signingSecret = "h".repeat(48);
const config = Object.freeze({
  port: 8792,
  signingSecret,
  cubeApiUrl: "https://cube.example.test",
  openaiApiKey: "sk-fixture",
  openaiBaseUrl: "https://au.api.openai.com/v1",
  maxConcurrentTurns: 2,
  pinnedCliVersion: "0.148.0",
  releaseSha: "development",
  deploymentId: "test",
});

test("Codex runtime config fails closed on weak secrets and non-TLS services", () => {
  assert.throws(() => loadCodexRuntimeConfig({
    NODE_ENV: "production",
    CUBE_API_URL: "https://cube.example.test",
    OPENAI_API_KEY: "sk-test",
    OPENAI_BASE_URL: "https://au.api.openai.com/v1",
    ALBERT_SERVICE_VERSION: "a".repeat(40),
    ALBERT_DEPLOYMENT_ID: "test",
  }), /SIGNING_SECRET is required/u);
  assert.throws(() => loadCodexRuntimeConfig({
    NODE_ENV: "test",
    ALBERT_CODEX_RUNTIME_SIGNING_SECRET: "short",
    CUBE_API_URL: "https://cube.example.test",
    OPENAI_API_KEY: "sk-test",
    OPENAI_BASE_URL: "https://au.api.openai.com/v1",
  }), /32 UTF-8 bytes/u);
  assert.throws(() => loadCodexRuntimeConfig({
    NODE_ENV: "test",
    ALBERT_CODEX_RUNTIME_SIGNING_SECRET: signingSecret,
    CUBE_API_URL: "http://cube.example.test",
    OPENAI_API_KEY: "sk-test",
    OPENAI_BASE_URL: "https://au.api.openai.com/v1",
  }), /HTTPS/u);
});

test("Codex runtime authenticates the exact request body before parsing it", async () => {
  const handler = new CodexRuntimeHttpHandler(config);
  const unauthorised = await handler.handle(new Request("https://runtime.example.test/v1/codex/turn", {
    method: "POST",
    body: "{}",
  }));
  assert.equal(unauthorised.status, 401);

  const body = "not-json";
  const signed = await signInternalRequest({
    method: "POST",
    path: "/v1/codex/turn",
    body,
    secret: signingSecret,
  });
  const invalid = await handler.handle(new Request("https://runtime.example.test/v1/codex/turn", {
    method: "POST",
    headers: signed,
    body,
  }));
  assert.equal(invalid.status, 400);
});

test("Codex liveness discloses no configuration or credentials", async () => {
  const handler = new CodexRuntimeHttpHandler(config);
  const response = await handler.handle(new Request("https://runtime.example.test/livez"));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, service: "albert-codex-runtime" });
});
