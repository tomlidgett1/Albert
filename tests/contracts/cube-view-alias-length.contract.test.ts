import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { load } from "js-yaml";

/**
 * Cube aliases every view member as `<view>__<member>` in the SQL it sends
 * to Postgres, and Postgres silently truncates identifiers at 63 bytes. A
 * member whose alias is longer fails every query that selects it with
 * "Member name not found for alias" (three Xero P&L members did exactly that
 * in production on 2026-08-31). This test keeps the connected-tenant views
 * under the limit; the other connector packs still carry long aliases and
 * are listed in KNOWN_LONG_PACKS until they are shortened.
 */
const VIEWS_DIR = path.resolve("cube-playground/model/views");
const POSTGRES_IDENTIFIER_LIMIT = 63;
const KNOWN_LONG_PACKS = ["lightspeed_x_", "square_", "stripe_", "shopify_", "momence_"];

type Include = string | { name: string; alias?: string };
type CubeRef = { join_path?: string; prefix?: boolean; includes?: Include[] | "*" };
type View = { name: string; cubes?: CubeRef[] };

function memberAliases(view: View): string[] {
  const aliases: string[] = [];
  for (const ref of view.cubes ?? []) {
    if (!Array.isArray(ref.includes)) continue;
    const cube = (ref.join_path ?? "").split(".").at(-1) ?? "";
    for (const include of ref.includes) {
      const name = typeof include === "string" ? include : include.name;
      const explicit = typeof include === "string" ? undefined : include.alias;
      aliases.push(explicit ?? (ref.prefix && cube ? `${cube}_${name}` : name));
    }
  }
  return aliases;
}

test("every connected-tenant view member alias fits the Postgres identifier limit", () => {
  const offenders: string[] = [];
  for (const file of readdirSync(VIEWS_DIR).filter((name) => name.endsWith(".yml"))) {
    if (KNOWN_LONG_PACKS.some((pack) => file.startsWith(pack))) continue;
    const document = load(readFileSync(path.join(VIEWS_DIR, file), "utf8")) as { views?: View[] };
    for (const view of document.views ?? []) {
      for (const alias of memberAliases(view)) {
        const identifier = `${view.name}__${alias}`;
        if (identifier.length > POSTGRES_IDENTIFIER_LIMIT) offenders.push(`${identifier} (${identifier.length})`);
      }
    }
  }
  assert.deepEqual(offenders, [], `aliases over ${POSTGRES_IDENTIFIER_LIMIT} chars:\n${offenders.join("\n")}`);
});
