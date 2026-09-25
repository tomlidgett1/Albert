/**
 * Pause the live Stripe connector, historically resync the incomplete
 * money tables, then unpause. Does not force a second overlapping sync.
 * Does not print secrets.
 *
 * Run: node --env-file=.env.local --import tsx scripts/resync-stripe-core-tables.mts
 */
import { FivetranClient } from "../packages/fivetran/src/index.js";

const CONNECTION_ID = "running_substratum";
const SCHEMA = "stripe_01m0pkk041vs507kd00vc6f2p9";
const TABLES = ["charge", "customer", "payment_intent"];

async function main(): Promise<void> {
  const apiKey = process.env.FIVETRAN_API_KEY?.trim();
  const apiSecret = process.env.FIVETRAN_API_SECRET?.trim();
  if (!apiKey || !apiSecret) throw new Error("Fivetran API credentials are missing.");
  const client = new FivetranClient({ apiKey, apiSecret });
  const auth = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`;

  const before = await client.getConnection(CONNECTION_ID);
  await client.pause(CONNECTION_ID);
  await new Promise((resolve) => setTimeout(resolve, 5000));

  const scoped = await fetch(`https://api.fivetran.com/v1/connections/${CONNECTION_ID}/resync`, {
    method: "POST",
    headers: { accept: "application/json;version=2", authorization: auth, "content-type": "application/json" },
    body: JSON.stringify({ scope: { [SCHEMA]: TABLES } }),
  });
  const scopedBody = await scoped.json().catch(() => ({}));
  let resync: Record<string, unknown> = {
    via: "connection-scope",
    status: scoped.status,
    code: (scopedBody as { code?: string }).code ?? null,
    message: typeof (scopedBody as { message?: string }).message === "string"
      ? (scopedBody as { message: string }).message.slice(0, 200)
      : null,
  };

  if (!scoped.ok) {
    const tables = await fetch(`https://api.fivetran.com/v1/connections/${CONNECTION_ID}/schemas/tables/resync`, {
      method: "POST",
      headers: { accept: "application/json;version=2", authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({ [SCHEMA]: TABLES }),
    });
    const tablesBody = await tables.json().catch(() => ({}));
    resync = {
      via: "schemas-tables",
      status: tables.status,
      code: (tablesBody as { code?: string }).code ?? null,
      message: typeof (tablesBody as { message?: string }).message === "string"
        ? (tablesBody as { message: string }).message.slice(0, 200)
        : null,
    };
  }

  // Resync already starts one job. Unpausing on top of it orphans that job.
  const midway = await client.getConnection(CONNECTION_ID);
  if (midway.paused && midway.status.syncState !== "syncing") {
    await client.unpause(CONNECTION_ID);
  }
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const after = await client.getConnection(CONNECTION_ID);
  console.log(JSON.stringify({
    before: { setup: before.status.setupState, sync: before.status.syncState, paused: before.paused },
    resync,
    after: {
      setup: after.status.setupState,
      sync: after.status.syncState,
      paused: after.paused,
      historical: after.status.isHistoricalSync,
    },
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
