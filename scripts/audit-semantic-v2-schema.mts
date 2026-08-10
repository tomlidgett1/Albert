import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import pg from "pg";

import {
  createSemanticPublicationV2,
  semanticRegistryDocumentV2Schema,
} from "../packages/semantic-registry/src/v2.js";
import {
  auditSemanticV2Schema,
  bindSemanticV2LiveProject,
  type LiveStagingColumn,
  type SemanticV2LiveProjectBinding,
} from "./lib/semantic-v2-schema-audit.js";
import { normalizePostgresDataType } from "./lib/staging-schema-contract.js";

try {
  process.loadEnvFile?.(".env.local");
} catch {
  /* Explicit process environment remains authoritative. */
}

const registry = semanticRegistryDocumentV2Schema.parse(
  JSON.parse(
    readFileSync(
      "packages/semantic-registry/registry/registry.v2.json",
      "utf8",
    ),
  ),
);
const publication = createSemanticPublicationV2(registry);
const expectedPublication = process.argv
  .find((argument) => argument.startsWith("--publication="))
  ?.slice("--publication=".length);
if (
  expectedPublication &&
  expectedPublication !== publication.publicationHash
)
  throw new Error(
    "The requested publication does not match the canonical registry artifact.",
  );

let liveColumns: LiveStagingColumn[] | undefined;
let liveProject: SemanticV2LiveProjectBinding | undefined;
if (process.argv.includes("--live")) {
  const connectionString =
    process.env.OPERATOR_DIAGNOSTIC_ANALYTICAL_DATABASE_URL?.trim() ||
    process.env.ANALYTICAL_ADMIN_DATABASE_URL?.trim();
  if (!connectionString)
    throw new Error(
      "OPERATOR_DIAGNOSTIC_ANALYTICAL_DATABASE_URL or ANALYTICAL_ADMIN_DATABASE_URL is required for --live.",
    );
  const expectedProjectRef =
    process.env.ALBERT_ANALYTICAL_PROJECT_REF?.trim();
  if (process.argv.includes("--require-project-ref") && !expectedProjectRef)
    throw new Error(
      "ALBERT_ANALYTICAL_PROJECT_REF is required for a release-bound live audit.",
    );
  if (expectedProjectRef)
    liveProject = bindSemanticV2LiveProject(
      connectionString,
      expectedProjectRef,
    );
  const client = new pg.Client({
    connectionString,
    application_name: "albert-semantic-v2-schema-audit",
  });
  await client.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query("SELECT set_config('statement_timeout','15000ms',true)");
    const schemas = [
      ...new Set(registry.views.map(({ physicalTable }) => physicalTable.split(".")[0])),
    ].filter((schema): schema is string => Boolean(schema));
    const result = await client.query(
      `SELECT table_schema,table_name,column_name,data_type,is_nullable
         FROM information_schema.columns
        WHERE table_schema=ANY($1::text[])
        ORDER BY table_schema,table_name,ordinal_position`,
      [schemas],
    );
    liveColumns = result.rows.map((row) => ({
      schema: String(row.table_schema),
      table: String(row.table_name),
      name: String(row.column_name),
      dataType: normalizePostgresDataType(String(row.data_type)),
      nullable: String(row.is_nullable) === "YES",
    }));
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

const audit = auditSemanticV2Schema({
  registry,
  migrationsDirectory: resolve("infra/migrations/analytical"),
  ...(liveColumns ? { liveColumns } : {}),
});
const receipt = {
  schemaVersion: 1,
  publicationHash: publication.publicationHash,
  ...(liveProject ? { liveProject } : {}),
  ...audit,
};
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
if (audit.status !== "passed") process.exitCode = 1;
