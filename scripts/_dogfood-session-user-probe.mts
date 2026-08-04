
import pg from "pg";
const db = new pg.Client({ connectionString: process.env.ANALYTICAL_DATABASE_URL });
await db.connect();
const who = await db.query(`select current_user, session_user, current_setting('role') as role,
  pg_has_role(session_user, 'ingest_rw', 'member') as member_ingest`);
console.log(who.rows[0]);
await db.query("begin");
await db.query('set local role "ingest_rw"');
const who2 = await db.query(`select current_user, session_user,
  pg_has_role(session_user, 'ingest_rw', 'member') as member_ingest`);
console.log('after set role', who2.rows[0]);
try {
  const bind = await db.query("select * from capability_internal.expected_runtime_binding()");
  console.log('binding', bind.rows[0]);
} catch (e) {
  console.error('binding failed', e instanceof Error ? e.message : e);
}
await db.query("rollback");
await db.end();
