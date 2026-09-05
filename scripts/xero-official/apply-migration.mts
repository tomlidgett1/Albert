/** Applies one analytical SQL file in a single transaction, loading the
 * admin URL from .env.local. Usage:
 *   npx tsx scripts/xero-official/apply-migration.mts <path-to-sql>
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

const file = process.argv[2];
if (!file) throw new Error("Provide the SQL file path");

let url = "";
for (const line of readFileSync(resolve(".env.local"), "utf8").split("\n")) {
  const match = /^ANALYTICAL_ADMIN_DATABASE_URL=(.*)$/u.exec(line);
  if (match) url = match[1]!.replace(/^"|"$/gu, "");
}
if (!url) throw new Error("Missing ANALYTICAL_ADMIN_DATABASE_URL");

const sql = readFileSync(resolve(file), "utf8");
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query("BEGIN");
  await client.query(sql);
  await client.query("COMMIT");
  console.log(`applied: ${file}`);
} catch (error) {
  await client.query("ROLLBACK");
  console.error("FAILED:", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await client.end();
}
