/** Ad-hoc query runner against the control-plane database (admin URL from
 * .env.local). Usage: npx tsx scripts/xero-official/control-query.mts "select ..."
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

const sql = process.argv[2];
if (!sql) throw new Error("Provide a SQL string argument");

const envVar = process.env.CONTROL_QUERY_ENV ?? "CONTROL_PLANE_ADMIN_DATABASE_URL";
let url = "";
for (const line of readFileSync(resolve(".env.local"), "utf8").split("\n")) {
  const match = new RegExp(`^${envVar}=(.*)$`, "u").exec(line);
  if (match) url = match[1]!.replace(/^"|"$/gu, "");
}
if (!url) throw new Error(`Missing ${envVar}`);

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const result = await client.query(sql);
  const results = Array.isArray(result) ? result : [result];
  for (const r of results) {
    if (r.rows?.length) console.log(JSON.stringify(r.rows, null, 2));
    else console.log(`(${r.command}: ${r.rowCount ?? 0} rows)`);
  }
} finally {
  await client.end();
}
