/**
 * Print Fivetran Stripe connection warnings and tasks. Does not print secrets.
 *
 * Run: node --env-file=.env.local --import tsx scripts/stripe-fivetran-status.mts
 */
const CONNECTION_ID = "running_substratum";

async function main(): Promise<void> {
  const apiKey = process.env.FIVETRAN_API_KEY?.trim();
  const apiSecret = process.env.FIVETRAN_API_SECRET?.trim();
  if (!apiKey || !apiSecret) throw new Error("Fivetran API credentials are missing.");
  const auth = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`;
  const res = await fetch(`https://api.fivetran.com/v1/connections/${CONNECTION_ID}`, {
    headers: { accept: "application/json;version=2", authorization: auth },
  });
  const payload = (await res.json()) as { data?: Record<string, unknown> };
  const data = payload.data ?? {};
  const status = (data.status ?? {}) as Record<string, unknown>;
  const warnings = Array.isArray(status.warnings) ? status.warnings : Array.isArray(data.warnings) ? data.warnings : [];
  const tasks = Array.isArray(status.tasks) ? status.tasks : Array.isArray(data.tasks) ? data.tasks : [];
  console.log(JSON.stringify({
    now: new Date().toISOString(),
    setup: status.setup_state ?? null,
    sync: status.sync_state ?? null,
    historical: status.is_historical_sync ?? null,
    paused: data.paused ?? null,
    failedAt: data.failed_at ?? null,
    succeededAt: data.succeeded_at ?? null,
    warnings: warnings.map((item) => summarise(item)),
    tasks: tasks.map((item) => summarise(item)),
  }, null, 2));
}

function summarise(item: unknown): Record<string, string> {
  const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
  return {
    code: String(record.code ?? ""),
    message: String(record.message ?? record.details ?? "").slice(0, 400),
  };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
