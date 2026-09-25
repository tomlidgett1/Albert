/**
 * Poll the live Stripe Fivetran connection and dest row counts.
 * Does not print secrets.
 *
 * Run: node --env-file=.env.local --import tsx scripts/poll-stripe-fivetran.mts
 */
import pg from "pg";

const CONNECTION_ID = "running_substratum";
const DEST_SCHEMA = "stripe_01m0pkk041vs507kd00vc6f2p9";

async function main(): Promise<void> {
  const apiKey = process.env.FIVETRAN_API_KEY?.trim();
  const apiSecret = process.env.FIVETRAN_API_SECRET?.trim();
  if (!apiKey || !apiSecret) throw new Error("Fivetran API credentials are missing.");
  const auth = `Basic ${Buffer.from(`${apiKey}:${apiSecret}`).toString("base64")}`;
  const res = await fetch(`https://api.fivetran.com/v1/connections/${CONNECTION_ID}`, {
    headers: { accept: "application/json;version=2", authorization: auth },
  });
  const data = ((await res.json()) as { data?: Record<string, unknown> }).data ?? {};
  const status = (data.status ?? {}) as Record<string, unknown>;

  const client = new pg.Client({
    connectionString: process.env.ANALYTICAL_DATABASE_URL,
    application_name: "albert-stripe-fivetran-poll",
  });
  await client.connect();
  const dest = await client.query(
    `
      select
        coalesce(sum(s.n_tup_ins), 0)::bigint as tup_ins,
        count(*) filter (where coalesce(s.n_live_tup, 0) > 0)::int as tables_with_rows,
        (select count(*)::int from ${DEST_SCHEMA}.charge) as charge_rows,
        (select count(*)::int from ${DEST_SCHEMA}.customer) as customer_rows,
        (select count(*)::int from ${DEST_SCHEMA}.payment_intent) as payment_intent_rows,
        (select count(*)::int from ${DEST_SCHEMA}.payout) as payout_rows,
        (select count(*)::int from ${DEST_SCHEMA}.balance_transaction) as balance_rows,
        (select count(*)::int from ${DEST_SCHEMA}.refund) as refund_rows,
        (select count(*)::int from ${DEST_SCHEMA}.invoice) as invoice_rows,
        (select count(*)::int from ${DEST_SCHEMA}.product) as product_rows
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_stat_all_tables s on s.relid = c.oid
      where n.nspname = $1 and c.relkind = $2
    `,
    [DEST_SCHEMA, "r"],
  );
  const writes = await client.query(
    `
      select usename, state, wait_event_type, wait_event, left(query, 180) as query
      from pg_stat_activity
      where usename = $1
      order by state, query_start
    `,
    ["fivetran_user"],
  );
  const latestLogs = await client.query(
    `
      select event, message_event, time_stamp, sync_id,
             left(coalesce(message_data::text, 'null'), 400) as data
      from fivetran_metadata.log
      where connection_id = $1
      order by time_stamp desc
      limit 12
    `,
    [CONNECTION_ID],
  );
  const varchar = await client.query(
    `
      select count(*)::int as n
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = $1
        and c.relkind = $2
        and a.attnum > 0
        and not a.attisdropped
        and format_type(a.atttypid, a.atttypmod) like $3
    `,
    [DEST_SCHEMA, "r", "character varying%"],
  );
  await client.end();

  console.log(JSON.stringify({
    now: new Date().toISOString(),
    sync: status.sync_state ?? null,
    historical: status.is_historical_sync ?? null,
    setup: status.setup_state ?? null,
    paused: data.paused ?? null,
    failedAt: data.failed_at ?? null,
    succeededAt: data.succeeded_at ?? null,
    dest: dest.rows[0],
    varcharColumns: varchar.rows[0]?.n ?? 0,
    writes: writes.rows,
    latestLogs: latestLogs.rows,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
