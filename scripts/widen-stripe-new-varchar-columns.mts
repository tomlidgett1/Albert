/**
 * Widen any new Fivetran varchar columns on the live Stripe dest, then
 * rebuild unions. Does not trigger a Fivetran sync.
 *
 * Run: node --env-file=.env.local --import tsx scripts/widen-stripe-new-varchar-columns.mts
 */
import pg from "pg";

const DEST = "stripe_01m0pkk041vs507kd00vc6f2p9";

function ident(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error("invalid identifier");
  return `"${value}"`;
}

async function main(): Promise<void> {
  const url = process.env.ANALYTICAL_ADMIN_DATABASE_URL ?? process.env.ANALYTICAL_DATABASE_URL;
  if (!url) throw new Error("ANALYTICAL_ADMIN_DATABASE_URL is required.");
  const client = new pg.Client({ connectionString: url, application_name: "albert-widen-stripe-newcols" });
  await client.connect();
  try {
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
    const columns = await client.query<{ table_name: string; column_name: string }>(
      `select class.relname as table_name, attribute.attname as column_name
         from pg_catalog.pg_attribute as attribute
         join pg_catalog.pg_class as class on class.oid = attribute.attrelid
         join pg_catalog.pg_namespace as namespace on namespace.oid = class.relnamespace
        where namespace.nspname = $1
          and class.relkind = 'r'
          and attribute.attnum > 0
          and not attribute.attisdropped
          and format_type(attribute.atttypid, attribute.atttypmod) like 'character varying%'
        order by class.relname, attribute.attname`,
      [DEST],
    );
    let widened = 0;
    for (const column of columns.rows) {
      await client.query(
        `ALTER TABLE ${ident(DEST)}.${ident(column.table_name)} ALTER COLUMN ${ident(column.column_name)} TYPE text`,
      );
      widened += 1;
    }
    const unions = await client.query<{ n: number }>(
      "select ingestion.rebuild_fivetran_source_views('stripe') as n",
    );
    await client.query("select ingestion.rebuild_stripe_official_views()");
    console.log(JSON.stringify({
      dest: DEST,
      found: columns.rows,
      widened,
      unions: Number(unions.rows[0]?.n ?? 0),
    }));
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
