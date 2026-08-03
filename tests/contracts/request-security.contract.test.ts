import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assertSameOriginMutation,
  assertSameOriginNavigation,
  readBoundedJsonBody,
} from "../../services/control-plane/src/request-security";
import { ControlPlaneError } from "../../services/control-plane/src/web-repository";

function status(error: unknown): number | undefined {
  return error instanceof ControlPlaneError ? error.status : undefined;
}

const mutableEnvironment = process.env as Record<string, string | undefined>;

test("malformed Origin and Referer headers fail closed as forbidden requests", () => {
  const mutation = new Request("https://albert.example/api/example", {
    method: "POST",
    headers: { origin: "not a URL", "content-type": "application/json" },
  });
  assert.throws(() => assertSameOriginMutation(mutation), (error) => status(error) === 403);

  const navigation = new Request("https://albert.example/api/oauth/xero/start", {
    headers: { referer: "::invalid::", "sec-fetch-site": "same-origin" },
  });
  assert.throws(() => assertSameOriginNavigation(navigation), (error) => status(error) === 403);
});

test("same-origin checks accept the configured production origin", () => {
  const previous = process.env.ALBERT_PUBLIC_ORIGIN;
  const previousNodeEnvironment = process.env.NODE_ENV;
  mutableEnvironment.ALBERT_PUBLIC_ORIGIN = "https://albert.example";
  mutableEnvironment.NODE_ENV = "production";
  try {
    assert.doesNotThrow(() => assertSameOriginMutation(new Request(
      "https://internal.invalid/api/example",
      {
        method: "POST",
        headers: { origin: "https://albert.example", "content-type": "application/json" },
      },
    )));
    assert.doesNotThrow(() => assertSameOriginNavigation(new Request(
      "https://internal.invalid/api/oauth/xero/start",
      { headers: { referer: "https://albert.example/dash", "sec-fetch-site": "same-origin" } },
    )));
  } finally {
    if (previous === undefined) delete mutableEnvironment.ALBERT_PUBLIC_ORIGIN;
    else mutableEnvironment.ALBERT_PUBLIC_ORIGIN = previous;
    if (previousNodeEnvironment === undefined) delete mutableEnvironment.NODE_ENV;
    else mutableEnvironment.NODE_ENV = previousNodeEnvironment;
  }
});

test("configured origins reject unsafe schemes, credentials, paths, and production localhost", () => {
  const previous = process.env.ALBERT_PUBLIC_ORIGIN;
  const previousNodeEnvironment = process.env.NODE_ENV;
  mutableEnvironment.NODE_ENV = "production";
  try {
    for (const configured of [
      "javascript:alert(1)",
      "http://localhost:3000",
      "https://user:secret@albert.example",
      "https://albert.example/not-an-origin",
    ]) {
      mutableEnvironment.ALBERT_PUBLIC_ORIGIN = configured;
      const request = new Request("https://internal.invalid/api/example", {
        method: "POST",
        headers: { origin: "https://albert.example", "content-type": "application/json" },
      });
      assert.throws(() => assertSameOriginMutation(request), (error) => status(error) === 503);
    }
  } finally {
    if (previous === undefined) delete mutableEnvironment.ALBERT_PUBLIC_ORIGIN;
    else mutableEnvironment.ALBERT_PUBLIC_ORIGIN = previous;
    if (previousNodeEnvironment === undefined) delete mutableEnvironment.NODE_ENV;
    else mutableEnvironment.NODE_ENV = previousNodeEnvironment;
  }
});

test("cookie-authenticated JSON bodies are bounded by observed bytes, not Content-Length", async () => {
  const dishonestLength = new Request("https://albert.example/api/conversation", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": "2" },
    body: JSON.stringify({ message: "x".repeat(128) }),
  });
  await assert.rejects(
    () => readBoundedJsonBody(dishonestLength, 32),
    (error) => status(error) === 413,
  );

  const chunkedMultibyte = new Request("https://albert.example/api/conversation", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "💥".repeat(12) }),
  });
  await assert.rejects(
    () => readBoundedJsonBody(chunkedMultibyte, 32),
    (error) => status(error) === 413,
  );

  const valid = new Request("https://albert.example/api/example", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accepted: true }),
  });
  assert.deepEqual(await readBoundedJsonBody(valid, 64), { accepted: true });
});

test("every cookie-authenticated JSON mutation route uses the bounded reader", () => {
  const mutationRoutes = [
    "app/api/admin/pipeline/[tenantId]/sample/route.ts",
    "app/api/connections/review/route.ts",
    "app/api/conversation/route.ts",
    "app/api/oauth/disconnect/route.ts",
    "app/api/oauth/select/route.ts",
    "app/api/organisations/members/route.ts",
    "app/api/organisations/route.ts",
    "app/api/organisations/select/route.ts",
    "app/api/session/route.ts",
    "app/api/tenant/deletion/approve/route.ts",
    "app/api/tenant/deletion/cancel/route.ts",
    "app/api/tenant/deletion/route.ts",
  ];
  for (const route of mutationRoutes) {
    const source = readFileSync(route, "utf8");
    assert.match(
      source,
      /readBoundedJsonBody\(request(?:,\s*[\d_]+)?\)/u,
      `${route} bypasses the bounded reader`,
    );
    assert.doesNotMatch(source, /request\.json\(\)/u, `${route} buffers JSON without a byte limit`);
  }
});
