
import pg from "pg";
const db = new pg.Client({ connectionString: process.env.ANALYTICAL_DATABASE_URL });
await db.connect();
await db.query("begin");
await db.query('set local role "ingest_rw"');
const who = await db.query("select current_user, session_user");
console.log(who.rows[0]);
for (const sql of [
  "select count(*) from ingestion.batch_manifests",
  "select count(*) from ingestion.landing_commits",
  "select has_schema_privilege('ingest_rw','ingestion','USAGE') as usage",
  "select has_table_privilege('ingest_rw','ingestion.batch_manifests','INSERT') as ins",
]) {
  try {
    const r = await db.query(sql);
    console.log(sql, r.rows[0]);
  } catch (e) {
    console.error(sql, e instanceof Error ? e.message : e);
  }
}
await db.query("rollback");
await db.end();
