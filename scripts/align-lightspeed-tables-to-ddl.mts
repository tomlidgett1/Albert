/**
 * Audit the Lightspeed semantic catalogue against the typed staging DDL.
 *
 * Historical versions of this script rewrote tables.json so its semantic
 * names matched legacy physical columns. Registry V2 preserves semantic names
 * and records an explicit physicalName instead, so mutating the connector
 * catalogue here would destroy that separation. The shared staging contract is
 * now authoritative for both inventory generation and prompt documentation.
 *
 * Usage: node --import tsx scripts/align-lightspeed-tables-to-ddl.mts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  parseStagingContractsFromMigrations,
  resolvePhysicalStagingColumn,
} from "./lib/staging-schema-contract.js";

type Catalogue = Readonly<{
  tables: readonly Readonly<{
    id: string;
    columns: readonly Readonly<{ name: string }>[];
  }>[];
}>;

const catalogue = JSON.parse(
  readFileSync(resolve("connectors/lightspeed-r/tables.json"), "utf8"),
) as Catalogue;
const contracts = parseStagingContractsFromMigrations(
  resolve("infra/migrations/analytical"),
);
const aliases: string[] = [];
const unsupported: string[] = [];
const missingTables: string[] = [];
const duplicatePhysicalMappings: string[] = [];

for (const table of catalogue.tables) {
  const contract = contracts.get(`source_lightspeed.${table.id}`);
  if (!contract) {
    missingTables.push(table.id);
    continue;
  }
  const owners = new Map<string, string>();
  for (const column of table.columns) {
    const physical = resolvePhysicalStagingColumn({
      connector: "lightspeed",
      table: table.id,
      semanticName: column.name,
      columns: contract.columns,
    });
    if (!physical) {
      unsupported.push(`${table.id}.${column.name}`);
      continue;
    }
    if (physical.name !== column.name)
      aliases.push(`${table.id}.${column.name}->${physical.name}`);
    const owner = owners.get(physical.name);
    if (owner)
      duplicatePhysicalMappings.push(
        `${table.id}.${physical.name}:${owner},${column.name}`,
      );
    else owners.set(physical.name, column.name);
  }
}

const report = {
  schemaVersion: 2,
  tables: catalogue.tables.length,
  aliases,
  unsupported,
  missingTables,
  duplicatePhysicalMappings,
  status:
    missingTables.length === 0 && duplicatePhysicalMappings.length === 0
      ? "passed"
      : "failed",
};
writeFileSync(
  resolve(".albert-lightspeed-schema-align-report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (report.status !== "passed") process.exitCode = 1;
