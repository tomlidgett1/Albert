/**
 * Count live Bike Stripe objects so we know what Fivetran's ALL_TIME
 * backfill should land. Does not print secrets.
 *
 * Run: node --import tsx scripts/count-bike-stripe-objects.mts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { isStripeLiveFivetranSecret } from "../connectors/stripe/index.js";

const BIKE_ENV_CANDIDATES = [
  resolve("/Users/user/Bike/bike-dashboard/.env.vercel.tmp"),
  resolve("/Users/user/Bike/bike-dashboard/.env.local"),
];

function loadEnvFile(path: string): Record<string, string> {
  const vals: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const raw = line.trim();
    if (!raw || raw.startsWith("#") || !raw.includes("=")) continue;
    const i = raw.indexOf("=");
    vals[raw.slice(0, i).trim()] = raw.slice(i + 1).trim().replace(/^['"]|['"]$/g, "");
  }
  return vals;
}

function loadSecret(): string {
  for (const path of BIKE_ENV_CANDIDATES) {
    try {
      const secret = loadEnvFile(path).STRIPE_SECRET_KEY?.trim() ?? "";
      if (isStripeLiveFivetranSecret(secret)) return secret;
    } catch {
      /* next */
    }
  }
  throw new Error("bike-dashboard has no live Stripe secret.");
}

async function countList(secret: string, path: string, maxPages = 20): Promise<{ count: number; truncated: boolean }> {
  let count = 0;
  let startingAfter: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(`https://api.stripe.com${path}`);
    url.searchParams.set("limit", "100");
    if (startingAfter) url.searchParams.set("starting_after", startingAfter);
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${secret}` },
    });
    if (!response.ok) {
      throw new Error(`${path} ${response.status}`);
    }
    const payload = await response.json() as {
      data?: Array<{ id?: string }>;
      has_more?: boolean;
    };
    const rows = payload.data ?? [];
    count += rows.length;
    const lastId = rows.at(-1)?.id;
    if (!payload.has_more || !lastId) return { count, truncated: false };
    startingAfter = lastId;
  }
  return { count, truncated: true };
}

async function main(): Promise<void> {
  const secret = loadSecret();
  const endpoints = [
    ["/v1/customers", "customers"],
    ["/v1/charges", "charges"],
    ["/v1/invoices", "invoices"],
    ["/v1/subscriptions", "subscriptions"],
    ["/v1/payment_intents", "payment_intents"],
    ["/v1/checkout/sessions", "checkout_sessions"],
    ["/v1/products", "products"],
    ["/v1/payouts", "payouts"],
    ["/v1/balance_transactions", "balance_transactions"],
  ] as const;
  const counts: Record<string, { count: number; truncated: boolean }> = {};
  for (const [path, name] of endpoints) {
    counts[name] = await countList(secret, path);
  }
  console.log(JSON.stringify({ counts }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
