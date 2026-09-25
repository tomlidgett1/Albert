/**
 * Print Bike Stripe charge and payment-intent created ranges only.
 * Does not print secrets or object ids.
 *
 * Run: node --import tsx scripts/count-bike-stripe-charge-dates.mts
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

function createdRange(rows: Array<Record<string, unknown>>): { n: number; min: string | null; max: string | null } {
  const times = rows
    .map((row) => Number(row.created))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  return {
    n: rows.length,
    min: times[0] ? new Date(times[0] * 1000).toISOString() : null,
    max: times.at(-1) ? new Date((times.at(-1) ?? 0) * 1000).toISOString() : null,
  };
}

async function main(): Promise<void> {
  const secret = loadSecret();
  console.log(JSON.stringify({
    charges: createdRange(await listAll(secret, "/v1/charges")),
    paymentIntents: createdRange(await listAll(secret, "/v1/payment_intents")),
    customers: createdRange(await listAll(secret, "/v1/customers")),
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
