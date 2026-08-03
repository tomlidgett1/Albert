import assert from "node:assert/strict";
import test from "node:test";

import { ConnectorError } from "../../packages/connector-sdk/src/index.js";
import type { TransactionalPostgres } from "./src/database.js";
import { PostgresVendorRateBudget } from "./src/vendor-rate-budget.js";

test("durable vendor budgets turn a denied shared reservation into retryable capacity", async () => {
  const calls: readonly unknown[][] = [];
  const mutableCalls = calls as unknown as unknown[][];
  const db = {
    async query(_sql: string, values: readonly unknown[] = []) {
      mutableCalls.push([...values]);
      return { rows: [{ allowed: false, retry_after_ms: "2500" }] };
    },
  } as unknown as TransactionalPostgres;
  const budget = new PostgresVendorRateBudget(db, "tenant", "connection", "xero");

  await assert.rejects(
    budget.beforeRequest(),
    (error) =>
      error instanceof ConnectorError &&
      error.code === "RATE_LIMITED" &&
      error.retryable &&
      error.retryAfterMs === 2_500,
  );
  assert.deepEqual(calls[0], ["tenant", "connection", "xero.api-minute", 1_000, 5]);
});

test("Retry-After observations create a shared database cooldown", async () => {
  const calls: Array<Readonly<{ sql: string; values: readonly unknown[] }>> = [];
  const db = {
    async query(sql: string, values: readonly unknown[] = []) {
      calls.push({ sql, values: [...values] });
      return { rows: [] };
    },
  } as unknown as TransactionalPostgres;
  const budget = new PostgresVendorRateBudget(db, "tenant", "connection", "deputy");

  await budget.observeResponse(new Response(null, {
    status: 429,
    headers: { "retry-after": "3600", "x-ratelimit-remaining": "0", "authorization": "secret" },
  }));

  assert.match(calls[0]?.sql ?? "", /observe_vendor_api_response/u);
  assert.equal(calls[0]?.values[3], 3_600_000);
  const observed = JSON.parse(String(calls[0]?.values[4])) as Record<string, string>;
  assert.deepEqual(observed, { "retry-after": "3600", "x-ratelimit-remaining": "0" });
});

test("Xero reserves both its minute gate and configured daily tier budget", async () => {
  const calls: unknown[][] = [];
  const db = {
    async query(_sql: string, values: readonly unknown[] = []) {
      calls.push([...values]);
      return { rows: [{ allowed: true, retry_after_ms: 0 }] };
    },
  } as unknown as TransactionalPostgres;
  const budget = new PostgresVendorRateBudget(
    db,
    "tenant",
    "connection",
    "xero",
    { xeroDailyRequestLimit: 5000 },
  );

  await budget.beforeRequest();

  assert.deepEqual(calls, [
    ["tenant", "connection", "xero.api-minute", 1_000, 5],
    ["tenant", "connection", "xero.api-day", 17_280, 60],
  ]);
});
