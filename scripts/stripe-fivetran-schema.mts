/**
 * Print enablement for core Stripe Fivetran tables. Does not print secrets.
 *
 * Run: node --env-file=.env.local --import tsx scripts/stripe-fivetran-schema.mts
 */
const CONNECTION_ID = "running_substratum";
const WANTED = [
  "charge", "customer", "payment_intent", "payout", "invoice",
  "subscription_history", "product", "checkout_session", "account", "person",
];

async function main(): Promise<void> {
  const apiKey = process.env.FIVETRAN_API_KEY?.trim();
  const apiSecret = process.env.FIVETRAN_API_SECRET?.trim();
  if (!apiKey || !apiSecret) throw new Error("Fivetran API credentials are missing.");
  const auth = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`;
  const res = await fetch(`https://api.fivetran.com/v1/connections/${CONNECTION_ID}/schemas`, {
    headers: { accept: "application/json;version=2", authorization: auth },
  });
  const data = ((await res.json()) as { data?: Record<string, unknown> }).data ?? {};
  const schemas = (data.schemas ?? {}) as Record<string, { tables?: Record<string, Record<string, unknown>> }>;
  const rows = [];
  for (const [schemaName, schemaBody] of Object.entries(schemas)) {
    const tables = schemaBody.tables ?? {};
    for (const name of WANTED) {
      const table = tables[name];
      if (table) {
        rows.push({
          schema: schemaName,
          table: name,
          enabled: table.enabled ?? null,
          syncMode: table.sync_mode ?? null,
        });
      }
    }
  }
  console.log(JSON.stringify({
    schemaChange: data.schema_change_handling ?? null,
    rows,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
