import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { deputyManifest } from "../connectors/deputy/manifest.js";
import { lightspeedRManifest } from "../connectors/lightspeed-r/manifest.js";
import { xeroManifest } from "../connectors/xero/manifest.js";
import { renderTypedStagingMigration } from "../packages/connector-sdk/src/index.js";

export const TYPED_STAGING_MIGRATION_PATH = resolve(
  "infra/migrations/analytical/0005_m3_typed_connector_staging.sql",
);

export const connectorManifests = Object.freeze([
  lightspeedRManifest,
  xeroManifest,
  deputyManifest,
]);

export function renderCurrentTypedStagingMigration(): string {
  return renderTypedStagingMigration(connectorManifests);
}

await writeFile(TYPED_STAGING_MIGRATION_PATH, renderCurrentTypedStagingMigration(), "utf8");
