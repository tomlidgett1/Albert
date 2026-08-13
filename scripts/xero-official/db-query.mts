/**
 * Ad-hoc read-only query runner against the analytical database, for
 * inspecting the XER_OFFICIAL landing schema during the Xero ingest build.
 * Reads the connection URL from .env.local; never prints credentials.
 *
 * Usage: npx tsx scripts/xero-official/db-query.mts "select ..."
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";

function loadEnv(): Record<string, string> {
  const output = { ...process.env } as Record<string, string>;
  let contents = "";
  try { contents = readFileSync(resolve(".env.local"), "utf8"); } catch { return output; }
  for (const line of contents.split("\n")) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (!match) continue;
    let value = match[2]!;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    output[match[1]!] ??= value;
  }
  return output;
}

const sql = process.argv[2];
if (!sql) throw new Error("Provide a SQL string argument");

const env = loadEnv();
const url = env.ANALYTICAL_ADMIN_DATABASE_URL?.trim().replace(/^"|"$/gu, "");
if (!url) throw new Error("Missing ANALYTICAL_ADMIN_DATABASE_URL");

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const result = await client.query(sql);
  const results = Array.isArray(result) ? result : [result];
  for (const r of results) {
    if (r.rows?.length) console.log(JSON.stringify(r.rows, null, 2));
  }
} finally {
  await client.end();
}
