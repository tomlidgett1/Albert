/**
 * Cancel a hung Stripe Fivetran sync, re-run setup tests, then start a
 * clean historical sync. Does not print secrets.
 *
 * Run: node --env-file=.env.local --import tsx scripts/restart-stripe-fivetran-sync.mts
 */
import { FivetranClient } from "../packages/fivetran/src/index.js";

const CONNECTION_ID = "running_substratum";

async function main(): Promise<void> {
  const apiKey = process.env.FIVETRAN_API_KEY?.trim();
  const apiSecret = process.env.FIVETRAN_API_SECRET?.trim();
  if (!apiKey || !apiSecret) throw new Error("Fivetran API credentials are missing.");
  const client = new FivetranClient({ apiKey, apiSecret });

  const before = await client.getConnection(CONNECTION_ID);
  const afterPause = await client.pause(CONNECTION_ID);
  await new Promise((resolve) => setTimeout(resolve, 4000));
  const tested = await client.runSetupTests(CONNECTION_ID);
  // Unpause starts a sync. Do not also call sync(): two overlapping
  // historical jobs cancel each other ("orphaned donkey") and flush-fail.
  await client.unpause(CONNECTION_ID);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const after = await client.getConnection(CONNECTION_ID);
  console.log(JSON.stringify({
    before: { setup: before.status.setupState, sync: before.status.syncState, paused: before.paused },
    afterPause: { setup: afterPause.status.setupState, sync: afterPause.status.syncState, paused: afterPause.paused },
    tests: tested.setupTests,
    after: {
      setup: after.status.setupState,
      sync: after.status.syncState,
      paused: after.paused,
      historical: after.status.isHistoricalSync,
      warnings: after.status.warnings,
      tasks: after.status.tasks,
    },
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
