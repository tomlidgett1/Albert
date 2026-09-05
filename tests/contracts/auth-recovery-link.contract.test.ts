import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const callback = readFileSync(resolve("app/auth/callback/route.ts"), "utf8");
const recoverForm = readFileSync(resolve("app/auth/recover/recover-form.tsx"), "utf8");
const recoverPage = readFileSync(resolve("app/auth/recover/page.tsx"), "utf8");

test("email recovery does not consume the one-time token on GET", () => {
  assert.match(callback, /token_hash/);
  assert.match(callback, /\/auth\/recover/);
  assert.doesNotMatch(callback, /verifyOtp/);
  assert.match(recoverForm, /verifyOtp/);
  assert.match(recoverForm, /type="button"/);
  assert.doesNotMatch(recoverPage, /verifyOtp/);
  assert.doesNotMatch(recoverForm, /useEffect\([\s\S]*verifyOtp/u);
});
