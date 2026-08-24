/**
 * Unblock the live Stripe Fivetran historical load:
 * - stop stamp from SET NOT NULL on stripe_ tables (Fivetran drops it)
 * - drop account._fivetran_deleted so Fivetran can ADD it
 * - rebuild official views
 *
 * 0178 is the ledgered copy. Apply that when the analytical deployer URL exists.
 * Does not print secrets.
 *
 * Run: node --env-file=.env.local --import tsx scripts/hotfix-stripe-fivetran-stamp.mts
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";

const DEST = "stripe_01m0pkk041vs507kd00vc6f2p9";

async function main(): Promise<void> {
  const url = process.env.ANALYTICAL_ADMIN_DATABASE_URL;
  if (!url) throw new Error("ANALYTICAL_ADMIN_DATABASE_URL is required.");
  const sql = await readFile(
    resolve("infra/migrations/analytical/0178_m2_stripe_erd_payment_link_and_intent_charge.sql"),
    "utf8",
  );
  const stamp = /CREATE OR REPLACE FUNCTION ingestion\.stamp_fivetran_destination[\s\S]*?\$\$;/.exec(sql);
  const widen = /CREATE OR REPLACE FUNCTION ingestion\.widen_fivetran_varchar_columns[\s\S]*?\$\$;/.exec(sql);
  if (!stamp || !widen) throw new Error("0178 is missing the stamp or widen function.");

  const client = new pg.Client({ connectionString: url, application_name: "albert-hotfix-stripe-stamp" });
  await client.connect();
  try {
    await client.query("set role albert_migration_owner");
    await client.query(widen[0]);
    await client.query("revoke all on function ingestion.widen_fivetran_varchar_columns(text) from public");
    await client.query("grant execute on function ingestion.widen_fivetran_varchar_columns(text) to ingest_rw");
    await client.query(stamp[0]);
    await client.query(`
      do $drop$
      declare
        target record;
      begin
        for target in
          select namespace.nspname, class.relname
            from pg_catalog.pg_class as class
            join pg_catalog.pg_namespace as namespace on namespace.oid = class.relnamespace
           where class.relkind = 'v'
             and namespace.nspname in ('source_stripe_fivetran', 'source_stripe')
        loop
          execute format('drop view if exists %I.%I cascade', target.nspname, target.relname);
        end loop;
      end
      $drop$;
    `);
    await client.query(`
      alter table "${DEST}".account drop column if exists _fivetran_deleted
    `);
    const nullable = await client.query<{ table_name: string }>(`
      select class.relname as table_name
        from pg_catalog.pg_class as class
        join pg_catalog.pg_namespace as namespace on namespace.oid = class.relnamespace
        join pg_catalog.pg_attribute as attribute on attribute.attrelid = class.oid
       where namespace.nspname = $1
         and class.relkind = 'r'
         and attribute.attname = 'tenant_id'
         and attribute.attnotnull
         and not attribute.attisdropped
    `, [DEST]);
    for (const row of nullable.rows) {
      if (!/^[a-z][a-z0-9_]*$/.test(row.table_name)) throw new Error("invalid table name");
      await client.query(`alter table "${DEST}"."${row.table_name}" alter column tenant_id drop not null`);
    }
    const unions = await client.query<{ n: number }>("select ingestion.rebuild_fivetran_source_views('stripe') as n");
    const official = await client.query<{ n: number }>("select ingestion.rebuild_stripe_official_views() as n");
    const leftover = await client.query<{ deleted: number; not_null: number }>(`
      select
        count(*) filter (where attribute.attname = '_fivetran_deleted')::int as deleted,
        count(*) filter (where attribute.attname = 'tenant_id' and attribute.attnotnull)::int as not_null
        from pg_catalog.pg_attribute as attribute
        join pg_catalog.pg_class as class on class.oid = attribute.attrelid
        join pg_catalog.pg_namespace as namespace on namespace.oid = class.relnamespace
       where namespace.nspname = $1
         and class.relkind = 'r'
         and attribute.attnum > 0
         and not attribute.attisdropped
    `, [DEST]);
    console.log(JSON.stringify({
      droppedNotNull: nullable.rows.map((row) => row.table_name),
      unions: unions.rows[0]?.n ?? 0,
      official: official.rows[0]?.n ?? 0,
      leftover: leftover.rows[0],
    }));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
