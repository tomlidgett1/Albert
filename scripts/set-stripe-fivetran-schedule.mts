/**
 * Change the live Stripe Fivetran schedule only. Does not pause, unpause,
 * or start a sync. Does not print secrets.
 *
 * Run: node --env-file=.env.local --import tsx scripts/set-stripe-fivetran-schedule.mts
 */
import { FivetranClient } from "../packages/fivetran/src/index.js";

const CONNECTION_ID = "running_substratum";

async function main(): Promise<void> {
  const apiKey = process.env.FIVETRAN_API_KEY?.trim();
  const apiSecret = process.env.FIVETRAN_API_SECRET?.trim();
  if (!apiKey || !apiSecret) throw new Error("Fivetran API credentials are missing.");
  const auth = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`;
  const beforeRes = await fetch(`https://api.fivetran.com/v1/connections/${CONNECTION_ID}`, {
    headers: { accept: "application/json;version=2", authorization: auth },
  });
  const before = ((await beforeRes.json()) as { data?: Record<string, unknown> }).data ?? {};
  const beforeStatus = (before.status ?? {}) as Record<string, unknown>;

  const client = new FivetranClient({ apiKey, apiSecret });
  await client.updateSchedule(CONNECTION_ID, {
    syncFrequencyMinutes: 1440,
    dailySyncTimeUtc: "08:00",
    scheduleType: "manual",
  });

  const afterRes = await fetch(`https://api.fivetran.com/v1/connections/${CONNECTION_ID}`, {
    headers: { accept: "application/json;version=2", authorization: auth },
  });
  const after = ((await afterRes.json()) as { data?: Record<string, unknown> }).data ?? {};
  const afterStatus = (after.status ?? {}) as Record<string, unknown>;
  console.log(JSON.stringify({
    before: {
      syncFrequency: before.sync_frequency ?? null,
      scheduleType: before.schedule_type ?? null,
      dailySyncTime: before.daily_sync_time ?? null,
      paused: before.paused ?? null,
      sync: beforeStatus.sync_state ?? null,
      historical: beforeStatus.is_historical_sync ?? null,
    },
    after: {
      syncFrequency: after.sync_frequency ?? null,
      scheduleType: after.schedule_type ?? null,
      dailySyncTime: after.daily_sync_time ?? null,
      paused: after.paused ?? null,
      sync: afterStatus.sync_state ?? null,
      historical: afterStatus.is_historical_sync ?? null,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
