/**
 * Count Bike Stripe charges and payment intents by status.
 * Does not print secrets or object ids.
 *
 * Run: node --import tsx scripts/count-bike-stripe-statuses.mts
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

function tally(rows: Array<Record<string, unknown>>, key: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const value = String(row[key] ?? "unknown");
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

async function main(): Promise<void> {
  const secret = loadSecret();
  const charges = await listAll(secret, "/v1/charges");
  const intents = await listAll(secret, "/v1/payment_intents");
  const customers = await listAll(secret, "/v1/customers");
  console.log(JSON.stringify({
    charges: { n: charges.length, status: tally(charges, "status"), paid: tally(charges, "paid"), captured: tally(charges, "captured") },
    paymentIntents: { n: intents.length, status: tally(intents, "status") },
    customers: { n: customers.length, deleted: tally(customers, "deleted") },
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
