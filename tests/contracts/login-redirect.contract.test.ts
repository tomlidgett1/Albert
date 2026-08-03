import assert from "node:assert/strict";
import test from "node:test";

import { safeDashboardRedirect } from "../../app/login/safe-redirect.js";

const origin = "https://app.albert.example";

test("post-auth redirects allow only canonical dashboard destinations", () => {
  assert.equal(safeDashboardRedirect(null, origin), "/dash");
  assert.equal(safeDashboardRedirect("/dash", origin), "/dash");
  assert.equal(
    safeDashboardRedirect("/dash?view=Connections", origin),
    "/dash?view=Connections",
  );
});

test("post-auth redirects reject browser-normalized and cross-origin inputs", () => {
  const decodedBackslashAttack = new URLSearchParams("?next=/%5C%5Cevil.example").get("next");
  assert.equal(decodedBackslashAttack, "/\\\\evil.example");

  for (const hostile of [
    "//evil.example",
    "/\\\\evil.example",
    "/%5C%5Cevil.example",
    "https://evil.example/dash",
    "https://user:password@app.albert.example/dash",
    "/login",
    "/dash/../login",
    "/dash?view=Admin",
    "/dash?view=Connections&view=Connections",
    "/dash?view=Connections&next=https%3A%2F%2Fevil.example",
    "/dash#https://evil.example",
    "/dash\u0000",
  ]) {
    assert.equal(safeDashboardRedirect(hostile, origin), "/dash", hostile);
  }
});
