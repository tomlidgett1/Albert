import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  describeLoopbackWebBackends,
  inspectRuntimeEnvironment,
  loopbackWebBackendUrls,
} from "../../packages/config/src/env.ts";

const read = (path: string) => readFileSync(resolve(path), "utf8");

test("localhost web iteration rejects loopback Fly/Cube/Anthropic URLs", () => {
  const names = loopbackWebBackendUrls({
    CUBE_API_URL: "http://127.0.0.1:4000",
    ANTHROPIC_ANALYTICS_SERVICE_URL: "http://127.0.0.1:8791",
    SEMANTIC_QUERY_SERVICE_URL: "https://albert-prod-semantic.fly.dev",
    ALBERT_PUBLIC_ORIGIN: "http://localhost:3000",
  });
  assert.deepEqual(names, ["ANTHROPIC_ANALYTICS_SERVICE_URL", "CUBE_API_URL"]);
  assert.match(describeLoopbackWebBackends(names), /Do not start Docker/u);

  const ready = inspectRuntimeEnvironment("web", {
    NEXT_PUBLIC_SUPABASE_URL: "https://control.example",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "publishable",
    ALBERT_OAUTH_STATE_SECRET: "s".repeat(32),
    ALBERT_OAUTH_WORKER_SIGNING_SECRET: "o".repeat(32),
    ALBERT_SHOPIFYQL_SIGNING_SECRET: "q".repeat(32),
    ALBERT_SHOPIFY_ADMIN_SIGNING_SECRET: "h".repeat(32),
    ALBERT_SEMANTIC_SIGNING_SECRET: "m".repeat(32),
    ALBERT_SEMANTIC_PROFILE_SIGNING_SECRET: "p".repeat(32),
    ALBERT_ANTHROPIC_SIGNING_SECRET: "a".repeat(32),
    ALBERT_OPERATOR_DIAGNOSTIC_SIGNING_SECRET: "d".repeat(32),
    ALBERT_CODEX_RUNTIME_SIGNING_SECRET: "c".repeat(32),
    ALBERT_USER_HASH_SECRET: "u".repeat(32),
    ALBERT_PUBLIC_ORIGIN: "http://localhost:3000",
    SYNC_WORKER_INTERNAL_URL: "https://sync.example",
    SEMANTIC_QUERY_SERVICE_URL: "https://semantic.example",
    ANTHROPIC_ANALYTICS_SERVICE_URL: "https://anthropic.example",
    OPERATOR_DIAGNOSTIC_SERVICE_URL: "https://diagnostic.example",
    CODEX_RUNTIME_SERVICE_URL: "https://codex.example",
    CUBE_API_URL: "https://cube.example",
    CUBEJS_API_SECRET: "cube-api-secret-for-runtime-tests",
    OPENAI_API_KEY: "test-only",
    OPENAI_BASE_URL: "https://au.api.openai.com/v1",
    LIGHTSPEED_CLIENT_ID: "lightspeed",
    XERO_CLIENT_ID: "xero",
    SQUARE_CLIENT_ID: "square",
    SHOPIFY_CLIENT_ID: "shopify",
    SHOPIFY_CLIENT_SECRET: "shopify-client-secret-for-runtime-tests",
    DEPUTY_CLIENT_ID: "deputy",
    ALBERT_ANALYTICAL_RUNTIME: "v1",
    NODE_ENV: "development",
  });
  assert.equal(ready.ready, true);
});

test("Cubecore no longer defaults to a local Docker bridge", () => {
  const sales = read("services/conversation/src/cube-v1-sales.ts");
  const warehouse = read("services/conversation/src/cube-v1-warehouse.ts");
  const cube = read("services/conversation/src/cube-v1.ts");
  const example = read(".env.example");
  const readme = read("README.md");

  assert.match(cube, /cubecoreBridgeUrl/u);
  assert.doesNotMatch(sales, /127\.0\.0\.1:4010/u);
  assert.doesNotMatch(warehouse, /127\.0\.0\.1:4010/u);
  assert.doesNotMatch(cube, /localhost:4010/u);
  assert.match(example, /Do not point them at Docker/u);
  assert.match(readme, /Do not start Docker/u);
});
