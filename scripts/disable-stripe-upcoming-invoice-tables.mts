/**
 * Pause the live Stripe connector, disable computed upcoming-invoice tables
 * that hang the historical extract, then unpause once. Does not resync,
 * force-sync, or print secrets.
 *
 * Run: node --env-file=.env.local --import tsx scripts/disable-stripe-upcoming-invoice-tables.mts
 */
import { FivetranClient } from "../packages/fivetran/src/index.js";

const CONNECTION_ID = "running_substratum";
const SCHEMA = "stripe_01m0pkk041vs507kd00vc6f2p9";
const DISABLE = [
  "upcoming_invoice",
  "upcoming_invoice_account_tax_id",
  "upcoming_invoice_custom_field",
  "upcoming_invoice_line_item",
  "upcoming_invoice_line_item_proration_details_credited_item",
  "upcoming_invoice_line_item_tax_rate",
  "upcoming_invoice_tax_rate",
  "billing_meter_event_summary",
] as const;

async function main(): Promise<void> {
  const apiKey = process.env.FIVETRAN_API_KEY?.trim();
  const apiSecret = process.env.FIVETRAN_API_SECRET?.trim();
  if (!apiKey || !apiSecret) throw new Error("Fivetran API credentials are missing.");
  const client = new FivetranClient({ apiKey, apiSecret });
  const auth = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`;

  const before = await client.getConnection(CONNECTION_ID);
  await client.pause(CONNECTION_ID);
  let paused = await client.getConnection(CONNECTION_ID);
  for (let attempt = 0; attempt < 12 && paused.status.syncState === "syncing"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    paused = await client.getConnection(CONNECTION_ID);
  }

  const disabled: Array<{ table: string; status: number; code: string | null }> = [];
  for (const table of DISABLE) {
    const res = await fetch(
      `https://api.fivetran.com/v1/connections/${CONNECTION_ID}/schemas/${SCHEMA}/tables/${table}`,
      {
        method: "PATCH",
        headers: { accept: "application/json;version=2", authorization: auth, "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      },
    );
    const body = await res.json().catch(() => ({})) as { code?: string };
    disabled.push({ table, status: res.status, code: body.code ?? null });
  }

  if (paused.paused) {
    await client.unpause(CONNECTION_ID);
  }
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const after = await client.getConnection(CONNECTION_ID);
  console.log(JSON.stringify({
    before: { sync: before.status.syncState, paused: before.paused, historical: before.status.isHistoricalSync },
    paused: { sync: paused.status.syncState, paused: paused.paused },
    disabled,
    after: {
      sync: after.status.syncState,
      paused: after.paused,
      historical: after.status.isHistoricalSync,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
