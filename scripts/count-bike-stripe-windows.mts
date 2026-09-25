/**
 * Count Bike Stripe objects inside vs outside Fivetran's priority-first
 * 30-day window. Does not print secrets or object ids.
 *
 * Run: node --import tsx scripts/count-bike-stripe-windows.mts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { isStripeLiveFivetranSecret } from "../connectors/stripe/index.js";

function loadSecret(): string {
  for (const path of [
    resolve("/Users/user/Bike/bike-dashboard/.env.vercel.tmp"),
    resolve("/Users/user/Bike/bike-dashboard/.env.local"),
  ]) {
    try {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        const raw = line.trim();
        if (!raw.startsWith("STRIPE_SECRET_KEY=")) continue;
        const secret = raw.slice("STRIPE_SECRET_KEY=".length).trim().replace(/^['"]|['"]$/g, "");
        if (isStripeLiveFivetranSecret(secret)) return secret;
      }
    } catch {
      /* next */
    }
  }
  throw new Error("bike-dashboard has no live Stripe secret.");
}

async function listAll(secret: string, path: string): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  let startingAfter: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const url = new URL(`https://api.stripe.com${path}`);
    url.searchParams.set("limit", "100");
    if (startingAfter) url.searchParams.set("starting_after", startingAfter);
    const response = await fetch(url, { headers: { authorization: `Bearer ${secret}` } });
    if (!response.ok) throw new Error(`${path} ${response.status}`);
    const payload = await response.json() as { data?: Array<Record<string, unknown>>; has_more?: boolean };
    const pageRows = payload.data ?? [];
    rows.push(...pageRows);
    const lastId = pageRows.at(-1)?.id;
    if (!payload.has_more || typeof lastId !== "string") break;
    startingAfter = lastId;
  }
  return rows;
}

function splitWindow(rows: Array<Record<string, unknown>>, cutoffUnix: number) {
  let recent = 0;
  let older = 0;
  for (const row of rows) {
    const created = Number(row.created);
    if (Number.isFinite(created) && created >= cutoffUnix) recent += 1;
    else older += 1;
  }
  return { n: rows.length, recent, older };
}

async function main(): Promise<void> {
  const secret = loadSecret();
  const cutoffUnix = Math.floor(Date.now() / 1000) - (30 * 24 * 60 * 60);
  const endpoints = [
    ["/v1/charges", "charges"],
    ["/v1/payment_intents", "payment_intents"],
    ["/v1/customers", "customers"],
    ["/v1/payouts", "payouts"],
    ["/v1/balance_transactions", "balance_transactions"],
    ["/v1/files", "files"],
    ["/v1/checkout/sessions", "checkout_sessions"],
  ] as const;
  const windows: Record<string, { n: number; recent: number; older: number }> = {};
  for (const [path, name] of endpoints) {
    windows[name] = splitWindow(await listAll(secret, path), cutoffUnix);
  }
  console.log(JSON.stringify({
    cutoff: new Date(cutoffUnix * 1000).toISOString(),
    windows,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
