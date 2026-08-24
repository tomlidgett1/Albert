/**
 * List enabled Fivetran Stripe tables. Does not print secrets.
 *
 * Run: node --env-file=.env.local --import tsx scripts/stripe-fivetran-enabled-tables.mts
 */
const CONNECTION_ID = "running_substratum";

async function main(): Promise<void> {
  const apiKey = process.env.FIVETRAN_API_KEY?.trim();
  const apiSecret = process.env.FIVETRAN_API_SECRET?.trim();
  if (!apiKey || !apiSecret) throw new Error("Fivetran API credentials are missing.");
  const auth = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`;
  const res = await fetch(`https://api.fivetran.com/v1/connections/${CONNECTION_ID}/schemas`, {
    headers: { accept: "application/json;version=2", authorization: auth },
  });
  const data = ((await res.json()) as { data?: Record<string, unknown> }).data ?? {};
  const schemas = (data.schemas ?? {}) as Record<string, { tables?: Record<string, { enabled?: boolean }> }>;
  const tables: Array<{ table: string; enabled: boolean }> = [];
  for (const schemaBody of Object.values(schemas)) {
    for (const [name, table] of Object.entries(schemaBody.tables ?? {})) {
      tables.push({ table: name, enabled: table.enabled === true });
    }
  }
  tables.sort((left, right) => left.table.localeCompare(right.table));
  console.log(JSON.stringify({
    total: tables.length,
    enabled: tables.filter((table) => table.enabled).length,
    disabled: tables.filter((table) => !table.enabled).map((table) => table.table),
    enabledNames: tables.filter((table) => table.enabled).map((table) => table.table),
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
