import assert from "node:assert/strict";
import test from "node:test";
import {
  correlationIdFromHeader,
  createServiceLogger,
  safeErrorEvidence,
  sanitizeLogMetadata,
} from "../../packages/observability/src/index.js";

test("structured logger emits stable JSON and redacts secret-shaped fields", () => {
  const lines: string[] = [];
  const logger = createServiceLogger("sync-worker", {
    serviceVersion: "abc123",
    deploymentId: "release-7",
    now: () => new Date("2026-08-03T00:00:00.000Z"),
    sink: (line) => lines.push(line),
  });
  const record = logger.error("vendor_request_failed", {
    connectionId: "01K1",
    accessToken: "must-not-appear",
    nested: { clientSecret: "also-hidden", status: 429 },
  }, "request-9");

  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]!), record);
  assert.equal(lines[0]!.includes("must-not-appear"), false);
  assert.equal(lines[0]!.includes("also-hidden"), false);
  assert.equal(record.metadata?.accessToken, "[redacted]");
  assert.deepEqual(record.metadata?.nested, { clientSecret: "[redacted]", status: 429 });
});

test("log sanitization bounds attacker-controlled values", () => {
  const sanitized = sanitizeLogMetadata({
    message: `hello\n${"x".repeat(800)}`,
    values: Array.from({ length: 100 }, (_, index) => index),
    raw_payload: { customer: "never" },
  });
  assert.equal(String(sanitized.message).includes("\n"), false);
  assert.equal(String(sanitized.message).length, 500);
  assert.equal((sanitized.values as unknown[]).length, 40);
  assert.equal(sanitized.raw_payload, "[redacted]");
});

test("error evidence and correlation IDs never echo arbitrary exception text", () => {
  assert.deepEqual(safeErrorEvidence(new Error("vendor_timeout: bearer top-secret")), {
    errorClass: "Error",
    code: "vendor_timeout",
  });
  assert.deepEqual(safeErrorEvidence(new Error("Customer John Smith failed")), {
    errorClass: "Error",
    code: "unknown_error",
  });
  assert.equal(correlationIdFromHeader("valid-request:3"), "valid-request:3");
  assert.match(correlationIdFromHeader("bad request with spaces"), /^[0-9a-f-]{36}$/);
});
