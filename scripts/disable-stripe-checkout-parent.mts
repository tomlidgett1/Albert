/**
 * Pause the live Stripe connector, disable checkout_session (parent of the
 * non-selectable custom-field children that MAR-resync then hang), then start
 * exactly one historical sync. Dest already has the checkout rows. Does not
 * print secrets.
 *
 * Run: node --env-file=.env.local --import tsx scripts/disable-stripe-checkout-parent.mts
 */
import { FivetranClient } from "../packages/fivetran/src/index.js";

const CONNECTION_ID = "running_substratum";
const SCHEMA = "stripe_01m0pkk041vs507kd00vc6f2p9";
const DISABLE = ["checkout_session"] as const;

type FivetranTableConfig = Readonly<{ enabled?: boolean }>;

function schemaTables(payload: unknown): Record<string, FivetranTableConfig> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const data = (payload as { data?: unknown }).data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return {};
  const schemas = (data as { schemas?: unknown }).schemas;
  if (!schemas || typeof schemas !== "object" || Array.isArray(schemas)) return {};
  const schema = (schemas as Record<string, unknown>)[SCHEMA];
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return {};
  const tables = (schema as { tables?: unknown }).tables;
  return tables && typeof tables === "object" && !Array.isArray(tables)
    ? tables as Record<string, FivetranTableConfig>
    : {};
}

async function main(): Promise<void> {
  const apiKey = process.env.FIVETRAN_API_KEY?.trim();
  const apiSecret = process.env.FIVETRAN_API_SECRET?.trim();
  if (!apiKey || !apiSecret) throw new Error("Fivetran API credentials are missing.");
  const client = new FivetranClient({ apiKey, apiSecret });
  const auth = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`;

  const before = await client.getConnection(CONNECTION_ID);
  await client.pause(CONNECTION_ID);
  let paused = await client.getConnection(CONNECTION_ID);
  for (let attempt = 0; attempt < 18 && paused.status.syncState === "syncing"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    paused = await client.getConnection(CONNECTION_ID);
  }
  if (paused.status.syncState === "syncing") {
    throw new Error("Fivetran is still syncing after pause. Do not schema-PATCH.");
  }

  const disabled: Array<{ table: string; status: number; enabled: boolean | null }> = [];
  for (const table of DISABLE) {
    const res = await fetch(
      `https://api.fivetran.com/v1/connections/${CONNECTION_ID}/schemas/${SCHEMA}/tables/${table}`,
      {
        method: "PATCH",
        headers: { accept: "application/json;version=2", authorization: auth, "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      },
    );
    const body = await res.json().catch(() => ({})) as { data?: { enabled?: boolean } };
    disabled.push({ table, status: res.status, enabled: body.data?.enabled ?? null });
  }

  const schemaRes = await fetch(
    `https://api.fivetran.com/v1/connections/${CONNECTION_ID}/schemas`,
    { headers: { accept: "application/json;version=2", authorization: auth } },
  );
  const tables = schemaTables(await schemaRes.json());
  const checkout = Object.keys(tables)
    .filter((name) => name.startsWith("checkout_session"))
    .sort()
    .map((name) => ({ table: name, enabled: tables[name]?.enabled ?? null }));

  if (paused.paused) await client.unpause(CONNECTION_ID);
  let midway = await client.getConnection(CONNECTION_ID);
  for (let attempt = 0; attempt < 8 && midway.status.syncState !== "syncing"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    midway = await client.getConnection(CONNECTION_ID);
  }
  if (midway.status.syncState !== "syncing") {
    await client.sync(CONNECTION_ID);
  }
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const after = await client.getConnection(CONNECTION_ID);
  console.log(JSON.stringify({
    before: { sync: before.status.syncState, paused: before.paused, historical: before.status.isHistoricalSync },
    paused: { sync: paused.status.syncState, paused: paused.paused },
    disabled,
    checkout,
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
