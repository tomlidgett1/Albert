import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { connectorManifests } from "../connectors/registry.js";
import {
  buildStagingContracts,
  renderTypedStagingMigration,
  type ConnectorManifest,
} from "../packages/connector-sdk/src/index.js";

const DEFAULT_MIGRATIONS_DIRECTORY = resolve("infra/migrations/analytical");
const MIGRATION_FILE = /^(\d{4})_[a-z0-9_]+\.sql$/u;
const SAFE_MIGRATION_NAME = /^[a-z][a-z0-9_]{0,62}$/u;

export type ConnectorStagingMigrationOptions = Readonly<{
  connector: string;
  stream: string;
  name: string;
  migrationsDirectory?: string;
}>;

export type ConnectorStagingBatchOptions = Readonly<{
  connector: string;
  name: string;
  migrationsDirectory?: string;
}>;

export type ConnectorStagingBatchResult = Readonly<{
  migrationPath: string;
  createdStreams: readonly string[];
  skippedStreams: readonly string[];
}>;

export type ParsedConnectorStagingOptions = Readonly<{
  connector: string;
  name: string;
  stream: string | null;
  allNew: boolean;
}>;

type LoadedMigrations = Readonly<{
  names: readonly string[];
  sqlByName: ReadonlyMap<string, string>;
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
  assertSafeMigrationName(options.name);
  const manifest = requireManifest(options.connector);
  const migrationManifest = singleStreamManifest(manifest, options.stream);
  const [contract] = buildStagingContracts([migrationManifest]);
  if (!contract) throw new Error(`${manifest.id}.${options.stream} has no typed staging contract.`);

  const migrationsDirectory = resolve(options.migrationsDirectory ?? DEFAULT_MIGRATIONS_DIRECTORY);
  const migrations = await loadMigrations(migrationsDirectory);
  const existing = existingStreamTableMigration(migrations, contract.schema, contract.table);
  if (existing) {
    throw new Error(
      `${contract.schema}.${contract.table} already exists in ${existing}. Create a new additive ALTER migration; never rewrite or regenerate an applied migration.`,
    );
  }

  const migrationPath = allocateMigrationPath(migrationsDirectory, migrations.names, options.name);
  await writeFile(migrationPath, renderTypedStagingMigration([migrationManifest]), {
    encoding: "utf8",
    flag: "wx",
  });
  return migrationPath;
}

/**
 * Creates ONE migration containing a CREATE TABLE for every stream of the
 * connector whose staging table does not yet appear in any migration. Streams
 * whose tables already exist are skipped, never regenerated: applied
 * migrations are immutable, so an existing table only changes via a
 * separately reviewed additive ALTER migration. A run that would create
 * nothing refuses to allocate an empty migration.
 */
export async function createConnectorStagingBatchMigration(
  options: ConnectorStagingBatchOptions,
): Promise<ConnectorStagingBatchResult> {
  assertSafeMigrationName(options.name);
  const manifest = requireManifest(options.connector);
  const contracts = buildStagingContracts([manifest]);

  const migrationsDirectory = resolve(options.migrationsDirectory ?? DEFAULT_MIGRATIONS_DIRECTORY);
  const migrations = await loadMigrations(migrationsDirectory);
  const createdStreams: string[] = [];
  const skippedStreams: string[] = [];
  for (const contract of contracts) {
    if (existingStreamTableMigration(migrations, contract.schema, contract.table)) {
      skippedStreams.push(contract.stream);
    } else {
      createdStreams.push(contract.stream);
    }
  }
  if (createdStreams.length === 0) {
    throw new Error(
      `Every ${manifest.id} stream table already exists in an applied migration; refusing to write an empty migration.`,
    );
  }

  const newStreams = new Set(createdStreams);
  const batchManifest: ConnectorManifest = {
    ...manifest,
    streams: manifest.streams.filter((stream) => newStreams.has(stream.id)),
    fieldCoverage: manifest.fieldCoverage.filter((field) => newStreams.has(field.stream)),
  };
  const migrationPath = allocateMigrationPath(migrationsDirectory, migrations.names, options.name);
  await writeFile(migrationPath, renderTypedStagingMigration([batchManifest]), {
    encoding: "utf8",
    flag: "wx",
  });
  return { migrationPath, createdStreams, skippedStreams };
}

export function parseConnectorStagingMigrationOptions(
  args: readonly string[],
): ParsedConnectorStagingOptions {
  const values = new Map<string, string>();
  let allNew = false;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--all-new") {
      if (allNew) throw new Error(`Duplicate option --all-new.\n${generatorUsage()}`);
      allNew = true;
      continue;
    }
    if (!flag || !["--connector", "--stream", "--name"].includes(flag)) {
      throw new Error(generatorUsage());
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(generatorUsage());
    if (values.has(flag)) throw new Error(`Duplicate option ${flag}.\n${generatorUsage()}`);
    values.set(flag, value);
    index += 1;
  }
  const connector = values.get("--connector");
  const name = values.get("--name");
  const stream = values.get("--stream") ?? null;
  if (!connector || !name) throw new Error(generatorUsage());
  // Exactly one mode: --stream creates one new table, --all-new sweeps them all.
  if (allNew === (stream !== null)) throw new Error(generatorUsage());
  return { connector, name, stream, allNew };
}

export function nextMigrationNumber(migrationNames: readonly string[]): number {
  const current = migrationNames.reduce((maximum, name) => {
    const match = MIGRATION_FILE.exec(name);
    return match ? Math.max(maximum, Number(match[1])) : maximum;
  }, 0);
  if (current >= 9_999) throw new Error("Analytical migration sequence is exhausted.");
  return current + 1;
}

function assertSafeMigrationName(name: string): void {
  if (!SAFE_MIGRATION_NAME.test(name)) {
    throw new Error(
      "--name must begin with a letter and contain only lowercase letters, numbers, or underscores (maximum 63 characters).",
    );
  }
}

function requireManifest(connector: string): ConnectorManifest {
  const manifest = connectorManifests.find((candidate) => candidate.id === connector);
  if (!manifest) {
    throw new Error(
      `Unknown connector ${connector}. Expected one of: ${connectorManifests.map((candidate) => candidate.id).join(", ")}.`,
    );
  }
  return manifest;
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

async function loadMigrations(migrationsDirectory: string): Promise<LoadedMigrations> {
  const names = (await readdir(migrationsDirectory))
    .filter((name) => MIGRATION_FILE.test(name))
    .sort();
  const sqlByName = new Map<string, string>();
  for (const name of names) {
    sqlByName.set(name, await readFile(resolve(migrationsDirectory, name), "utf8"));
  }
  return { names, sqlByName };
}

/** The migration that already creates this stream table, or null when it is new. */
function existingStreamTableMigration(
  migrations: LoadedMigrations,
  schema: string,
  table: string,
): string | null {
  const tableCreation = new RegExp(
    `\\bCREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?"${schema}"\\."${table}"(?=\\s|\\()`,
    "iu",
  );
  for (const [migrationName, sql] of migrations.sqlByName) {
    if (tableCreation.test(sql)) return migrationName;
  }
  return null;
}

function allocateMigrationPath(
  migrationsDirectory: string,
  migrationNames: readonly string[],
  name: string,
): string {
  const nextNumber = nextMigrationNumber(migrationNames);
  return resolve(migrationsDirectory, `${String(nextNumber).padStart(4, "0")}_m3_${name}.sql`);
}

function generatorUsage(): string {
  return [
    "Usage: npm run generate:connector-staging -- --connector <id> --stream <new-stream> --name <migration_name>",
    "   or: npm run generate:connector-staging -- --connector <id> --all-new --name <migration_name>",
    "--stream creates one genuinely new stream table; --all-new creates every stream table the connector is missing in one migration, skipping tables that already exist.",
    "This create-only generator never rewrites an applied migration. Use an additive ALTER migration for an existing stream.",
  ].join("\n");
}

const entryPath = process.argv[1];
if (entryPath && import.meta.url === pathToFileURL(resolve(entryPath)).href) {
  try {
    const options = parseConnectorStagingMigrationOptions(process.argv.slice(2));
    if (options.stream === null) {
      const result = await createConnectorStagingBatchMigration({
        connector: options.connector,
        name: options.name,
      });
      process.stdout.write(`${result.migrationPath}\n`);
      if (result.skippedStreams.length > 0) {
        process.stdout.write(
          `Skipped existing stream tables: ${result.skippedStreams.join(", ")}\n`,
        );
      }
    } else {
      const migrationPath = await createConnectorStagingMigration({
        connector: options.connector,
        stream: options.stream,
        name: options.name,
      });
      process.stdout.write(`${migrationPath}\n`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  }
}
