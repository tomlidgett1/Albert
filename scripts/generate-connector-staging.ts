import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { deputyManifest } from "../connectors/deputy/manifest.js";
import { lightspeedRManifest } from "../connectors/lightspeed-r/manifest.js";
import { xeroManifest } from "../connectors/xero/manifest.js";
import {
  buildStagingContracts,
  renderTypedStagingMigration,
  type ConnectorManifest,
} from "../packages/connector-sdk/src/index.js";

const DEFAULT_MIGRATIONS_DIRECTORY = resolve("infra/migrations/analytical");
const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/u;
const SAFE_MIGRATION_NAME = /^[a-z][a-z0-9_]{0,62}$/u;

export const connectorManifests = Object.freeze([
  lightspeedRManifest,
  xeroManifest,
  deputyManifest,
]);

export type ConnectorStagingMigrationOptions = Readonly<{
  connector: string;
  stream: string;
  name: string;
  migrationsDirectory?: string;
}>;

/**
 * Creates a migration for a genuinely new connector stream. Applied migration
 * files are never regenerated: the next number is allocated from the directory
 * and the destination is opened with `wx` (create-only) semantics. Existing
 * stream tables require a separately reviewed additive ALTER migration.
 */
export async function createConnectorStagingMigration(
  options: ConnectorStagingMigrationOptions,
): Promise<string> {
  if (!SAFE_MIGRATION_NAME.test(options.name)) {
    throw new Error(
      "--name must begin with a letter and contain only lowercase letters, numbers, or underscores (maximum 63 characters).",
    );
  }

  const manifest = connectorManifests.find((candidate) => candidate.id === options.connector);
  if (!manifest) {
    throw new Error(
      `Unknown connector ${options.connector}. Expected one of: ${connectorManifests.map((candidate) => candidate.id).join(", ")}.`,
    );
  }
  const migrationManifest = singleStreamManifest(manifest, options.stream);
  const [contract] = buildStagingContracts([migrationManifest]);
  if (!contract) throw new Error(`${manifest.id}.${options.stream} has no typed staging contract.`);

  const migrationsDirectory = resolve(options.migrationsDirectory ?? DEFAULT_MIGRATIONS_DIRECTORY);
  const migrationNames = (await readdir(migrationsDirectory))
    .filter((name) => MIGRATION_FILE.test(name))
    .sort();
  await assertStreamTableIsNew(migrationsDirectory, migrationNames, contract.schema, contract.table);

  const nextNumber = nextMigrationNumber(migrationNames);
  const migrationPath = resolve(
    migrationsDirectory,
    `${String(nextNumber).padStart(4, "0")}_m3_${options.name}.sql`,
  );
  await writeFile(migrationPath, renderTypedStagingMigration([migrationManifest]), {
    encoding: "utf8",
    flag: "wx",
  });
  return migrationPath;
}

export function parseConnectorStagingMigrationOptions(
  args: readonly string[],
): ConnectorStagingMigrationOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag || !["--connector", "--stream", "--name"].includes(flag) || !value) {
      throw new Error(generatorUsage());
    }
    if (values.has(flag)) throw new Error(`Duplicate option ${flag}.\n${generatorUsage()}`);
    values.set(flag, value);
  }
  if (values.size !== 3) throw new Error(generatorUsage());
  return {
    connector: values.get("--connector") ?? "",
    stream: values.get("--stream") ?? "",
    name: values.get("--name") ?? "",
  };
}

export function nextMigrationNumber(migrationNames: readonly string[]): number {
  const current = migrationNames.reduce((maximum, name) => {
    const match = MIGRATION_FILE.exec(name);
    return match ? Math.max(maximum, Number(match[1])) : maximum;
  }, 0);
  if (current >= 9_999) throw new Error("Analytical migration sequence is exhausted.");
  return current + 1;
}

function singleStreamManifest(
  manifest: ConnectorManifest,
  streamId: string,
): ConnectorManifest {
  const streams = manifest.streams.filter((stream) => stream.id === streamId);
  const fieldCoverage = manifest.fieldCoverage.filter((field) => field.stream === streamId);
  if (streams.length !== 1 || fieldCoverage.length === 0) {
    throw new Error(`${manifest.id}.${streamId} is not a complete manifest stream.`);
  }
  return { ...manifest, streams, fieldCoverage };
}

async function assertStreamTableIsNew(
  migrationsDirectory: string,
  migrationNames: readonly string[],
  schema: string,
  table: string,
): Promise<void> {
  const tableCreation = new RegExp(
    `\\bCREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?"${schema}"\\."${table}"(?=\\s|\\()`,
    "iu",
  );
  for (const migrationName of migrationNames) {
    const sql = await readFile(resolve(migrationsDirectory, migrationName), "utf8");
    if (tableCreation.test(sql)) {
      throw new Error(
        `${schema}.${table} already exists in ${migrationName}. Create a new additive ALTER migration; never rewrite or regenerate an applied migration.`,
      );
    }
  }
}

function generatorUsage(): string {
  return [
    "Usage: npm run generate:connector-staging -- --connector <id> --stream <new-stream> --name <migration_name>",
    "This create-only generator is for new stream tables. Use an additive ALTER migration for an existing stream.",
  ].join("\n");
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  try {
    const options = parseConnectorStagingMigrationOptions(process.argv.slice(2));
    const migrationPath = await createConnectorStagingMigration(options);
    process.stdout.write(`${migrationPath}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
