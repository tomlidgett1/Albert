import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  "infra/migrations/control-plane/0069_m8_local_oauth_redirect_compatibility.sql",
  "utf8",
);

test("OAuth redirects permit HTTPS globally and HTTP only on loopback hosts", () => {
  assert.match(migration, /redirect_uri ~ '\^https:\/\/'/u);
  assert.ok(
    migration.includes("redirect_uri ~ '^http://(localhost|127[.]0[.]0[.]1)"),
  );
  assert.doesNotMatch(migration, /http:\/\/\[\^/u);
});
