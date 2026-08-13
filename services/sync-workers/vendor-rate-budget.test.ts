import assert from "node:assert/strict";
import test from "node:test";

import { lightspeedRManifest } from "../../connectors/lightspeed-r/manifest.js";
import { lightspeedXManifest } from "../../connectors/lightspeed-x/manifest.js";
import { xeroManifest } from "../../connectors/xero/manifest.js";
import {
  ConnectorError,
  fetchWithRetry,
  withVendorRateBudget,
} from "../../packages/connector-sdk/src/index.js";
import type { TransactionalPostgres } from "./src/database.js";
import { PostgresVendorRateBudget } from "./src/vendor-rate-budget.js";

function transactionalStub(
  query: (sql: string, values?: readonly unknown[]) => Promise<Readonly<{ rows: readonly Record<string, unknown>[] }>>,
): TransactionalPostgres {
  const typedQuery: TransactionalPostgres["query"] = async <
    Row extends Record<string, unknown> = Record<string, unknown>,
  >(sql: string, values: readonly unknown[] = []) => {
    const result = await query(sql, values);
    return { rows: result.rows as readonly Row[] };
  };
  return {
    query: typedQuery,
    async transaction(work) {
      return work({ query: typedQuery });
    },
  };
}

test("durable vendor budgets turn a denied shared reservation into retryable capacity", async () => {
  const calls: readonly unknown[][] = [];
  const mutableCalls = calls as unknown as unknown[][];
  const db = transactionalStub(
    async (_sql: string, values: readonly unknown[] = []) => {
      mutableCalls.push([...values]);
      return { rows: [{ allowed: false, retry_after_ms: "3600000" }] };
    },
  );
  const budget = new PostgresVendorRateBudget(db, "tenant", "connection", xeroManifest);

  await assert.rejects(
    budget.beforeRequest(),
    (error) =>
      error instanceof ConnectorError &&
      error.code === "RATE_LIMITED" &&
      error.retryable &&
      error.retryAfterMs === 3_600_000,
  );
  assert.deepEqual(calls[0], ["tenant", "connection", "xero.api-minute", 1_000, 5]);
});

test("Retry-After observations create a shared database cooldown", async () => {
  const calls: Array<Readonly<{ sql: string; values: readonly unknown[] }>> = [];
  const db = transactionalStub(
    async (sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql, values: [...values] });
      return { rows: [] };
    },
  );
  const budget = new PostgresVendorRateBudget(db, "tenant", "connection", xeroManifest);

  await budget.observeResponse(new Response(null, {
    status: 429,
    headers: { "retry-after": "3600", "x-daylimit-remaining": "0", "authorization": "secret" },
  }));

  assert.match(calls[0]?.sql ?? "", /observe_vendor_api_response/u);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.values[2]), ["xero.api-minute", "xero.api-day"]);
  assert.equal(calls[0]?.values[3], 3_600_000);
  const observed = JSON.parse(String(calls[0]?.values[4])) as Record<string, string>;
  assert.deepEqual(observed, { "retry-after": "3600", "x-daylimit-remaining": "0" });
});

test("Xero reserves both its minute gate and configured daily tier budget", async () => {
  const calls: unknown[][] = [];
  const db = transactionalStub(
    async (_sql: string, values: readonly unknown[] = []) => {
      calls.push([...values]);
      return { rows: [{ allowed: true, retry_after_ms: 0 }] };
    },
  );
  const budget = new PostgresVendorRateBudget(
    db,
    "tenant",
    "connection",
    xeroManifest,
    { dailyRequestLimit: 5000 },
  );

  await budget.beforeRequest();

  assert.deepEqual(calls, [
    ["tenant", "connection", "xero.api-minute", 1_000, 5],
    ["tenant", "connection", "xero.api-day", 17_280, 60],
  ]);
});

test("Lightspeed X reserves below the discovered five-minute allowance with explicit headroom", async () => {
  const calls: unknown[][] = [];
  const db = transactionalStub(async (_sql, values = []) => {
    calls.push([...values]);
    return { rows: [{ allowed: true, retry_after_ms: 0 }] };
  });
  const budget = new PostgresVendorRateBudget(
    db,
    "tenant",
    "connection",
    lightspeedXManifest,
    { retailerWindowLimit: 650 },
  );

  await budget.beforeRequest();

  // Two registers permit 650 requests/300s. Ten remain unused, so the durable
  // GCRA reservation executes at 640/300s with a bounded two-request burst.
  assert.deepEqual(calls, [["tenant", "connection", "lightspeed-x.api", 469, 2]]);
});

test("a denied policy rolls back reservations made for earlier policies", async () => {
  const calls: string[] = [];
  let committedReservations = 0;
  const db = {
    async query() { throw new Error("budget queries must run in one transaction"); },
    async transaction<T>(work: Parameters<TransactionalPostgres["transaction"]>[0]) {
      let stagedReservations = 0;
      try {
        const query: TransactionalPostgres["query"] = async <
          Row extends Record<string, unknown> = Record<string, unknown>,
        >(_sql: string, values: readonly unknown[] = []) => {
            const key = String(values[2]);
            calls.push(key);
            if (key === "xero.api-day") {
              return {
                rows: [{ allowed: false, retry_after_ms: 3_600_000 }] as unknown as readonly Row[],
              };
            }
            stagedReservations += 1;
            return {
              rows: [{ allowed: true, retry_after_ms: 0 }] as unknown as readonly Row[],
            };
          };
        const result = await work({ query });
        committedReservations += stagedReservations;
        return result as T;
      } catch (error) {
        throw error;
      }
    },
  } as TransactionalPostgres;
  const budget = new PostgresVendorRateBudget(db, "tenant", "connection", xeroManifest);

  await assert.rejects(
    budget.beforeRequest(),
    (error) =>
      error instanceof ConnectorError &&
      error.code === "RATE_LIMITED" &&
      error.retryAfterMs === 3_600_000 &&
      error.details?.budgetKey === "xero.api-day",
  );

  assert.deepEqual(calls, ["xero.api-minute", "xero.api-day"]);
  assert.equal(committedReservations, 0);
});

test("a shared Xero cooldown prevents the outbound HTTP request", async () => {
  let fetchCalls = 0;
  const db = transactionalStub(async (_sql, values = []) => ({
    rows: [{
      allowed: String(values[2]) !== "xero.api-day",
      retry_after_ms: String(values[2]) === "xero.api-day" ? 3_600_000 : 0,
    }],
  }));
  const budget = new PostgresVendorRateBudget(db, "tenant", "connection", xeroManifest);

  await assert.rejects(
    fetchWithRetry(
      async () => {
        fetchCalls += 1;
        return Response.json({ ok: true });
      },
      "https://api.xero.com/api.xro/2.0/Invoices",
      { method: "GET" },
      withVendorRateBudget(undefined, budget),
    ),
    (error) =>
      error instanceof ConnectorError &&
      error.code === "RATE_LIMITED" &&
      error.retryAfterMs === 3_600_000,
  );

  assert.equal(fetchCalls, 0);
});

test("pack-declared token-bucket headers create provider cooldowns", async () => {
  const calls: Array<Readonly<{ sql: string; values: readonly unknown[] }>> = [];
  const db = transactionalStub(
    async (sql: string, values: readonly unknown[] = []) => {
      calls.push({ sql, values: [...values] });
      return { rows: [] };
    },
  );
  const budget = new PostgresVendorRateBudget(
    db,
    "tenant",
    "connection",
    lightspeedRManifest,
  );

  await budget.observeResponse(new Response(null, {
    headers: {
      "x-ls-api-bucket-level": "89/90",
      "x-ls-api-drip-rate": "1",
    },
  }));

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.values[3], 1_000);
  assert.deepEqual(JSON.parse(String(calls[0]?.values[4])), {
    "x-ls-api-bucket-level": "89/90",
    "x-ls-api-drip-rate": "1",
  });
});

test("window-budget overrides fail closed outside the pack allowlist", () => {
  const db = transactionalStub(async () => ({ rows: [] }));
  assert.throws(
    () => new PostgresVendorRateBudget(
      db,
      "tenant",
      "connection",
      xeroManifest,
      { dailyRequestLimit: 2_000 },
    ),
    /vendor_rate_budget_option_invalid:xero:dailyRequestLimit/u,
  );
});
