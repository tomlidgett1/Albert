/**
 * Pause the hung Stripe job, disable every selectable table except the
 * missing money tables, then historically resync those three only.
 * Manual schedule: resync starts the job. Do not also call sync().
 * Does not print secrets.
 *
 * Run: node --env-file=.env.local --import tsx scripts/slim-stripe-money-tables.mts
 */
import { FivetranClient } from "../packages/fivetran/src/index.js";

const CONNECTION_ID = "running_substratum";
const SCHEMA = "stripe_01m0pkk041vs507kd00vc6f2p9";
const KEEP = new Set([
  "account",
  "charge",
  "charge_payment_method_details",
  "customer",
  "payment_intent",
]);
const RESYNC = ["charge", "customer", "payment_intent"];

type FivetranTableConfig = Readonly<{
  enabled?: boolean;
  enabled_patch_settings?: Readonly<{ allowed?: boolean }>;
}>;

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
  const headers = {
    accept: "application/json;version=2",
    authorization: auth,
    "content-type": "application/json",
  };

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

  const schemaRes = await fetch(
    `https://api.fivetran.com/v1/connections/${CONNECTION_ID}/schemas`,
    { headers: { accept: "application/json;version=2", authorization: auth } },
  );
  const tables = schemaTables(await schemaRes.json());
  const disable: Record<string, { enabled: false }> = {};
  for (const [name, table] of Object.entries(tables)) {
    if (KEEP.has(name)) continue;
    if (table.enabled !== true) continue;
    if (table.enabled_patch_settings?.allowed === false) continue;
    disable[name] = { enabled: false };
  }

  const patch = await fetch(
    `https://api.fivetran.com/v1/connections/${CONNECTION_ID}/schemas`,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        schemas: {
          [SCHEMA]: { tables: disable },
        },
      }),
    },
  );
  const patchBody = await patch.json().catch(() => ({})) as { code?: string; message?: string };

  if (paused.paused) await client.unpause(CONNECTION_ID);
  let midway = await client.getConnection(CONNECTION_ID);
  for (let attempt = 0; attempt < 6 && midway.status.syncState === "syncing"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    midway = await client.getConnection(CONNECTION_ID);
  }

  const scoped = await fetch(
    `https://api.fivetran.com/v1/connections/${CONNECTION_ID}/schemas/tables/resync`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ [SCHEMA]: RESYNC }),
    },
  );
  const scopedBody = await scoped.json().catch(() => ({})) as { code?: string; message?: string };
  let resync = {
    via: "schemas-tables",
    status: scoped.status,
    code: scopedBody.code ?? null,
    message: typeof scopedBody.message === "string" ? scopedBody.message.slice(0, 200) : null,
  };
  if (!scoped.ok) {
    const fallback = await fetch(
      `https://api.fivetran.com/v1/connections/${CONNECTION_ID}/resync`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ scope: { [SCHEMA]: RESYNC } }),
      },
    );
    const fallbackBody = await fallback.json().catch(() => ({})) as { code?: string; message?: string };
    resync = {
      via: "connection-scope",
      status: fallback.status,
      code: fallbackBody.code ?? null,
      message: typeof fallbackBody.message === "string" ? fallbackBody.message.slice(0, 200) : null,
    };
  }

  await new Promise((resolve) => setTimeout(resolve, 2500));
  const after = await client.getConnection(CONNECTION_ID);
  const afterSchema = await fetch(
    `https://api.fivetran.com/v1/connections/${CONNECTION_ID}/schemas`,
    { headers: { accept: "application/json;version=2", authorization: auth } },
  );
  const afterTables = schemaTables(await afterSchema.json());
  const stillEnabled = Object.entries(afterTables)
    .filter(([, table]) => table.enabled)
    .map(([name]) => name)
    .sort();

  console.log(JSON.stringify({
    before: { sync: before.status.syncState, paused: before.paused },
    paused: { sync: paused.status.syncState, paused: paused.paused },
    disableCount: Object.keys(disable).length,
    patch: { status: patch.status, code: patchBody.code ?? null, message: patchBody.message?.slice(0, 160) ?? null },
    resync,
    stillEnabled,
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
