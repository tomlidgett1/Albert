import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { snapshotReceiptDigest } from "./lib/semantic-v2-snapshot-migration.js";

const { Client } = pg;
const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const PROJECT_REF = /^[a-z0-9]{20}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/u;

function argument(name: string): string {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
  if (!value) throw new Error(`${prefix}... is required.`);
  return value;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

export async function registerSemanticV2SnapshotReceipt(): Promise<void> {
  if (!process.argv.includes("--execute")) {
    throw new Error("Refusing to register a snapshot receipt without --execute.");
  }
  const receiptPath = argument("receipt");
  const semanticManifestHash = argument("semantic-manifest");
  const commit = argument("commit");
  const actorUserId = argument("actor-user-id");
  const artifact = object(JSON.parse(readFileSync(receiptPath, "utf8")), "snapshot receipt");
  const receiptDigest = String(artifact.receiptDigest ?? "");
  const body = { ...artifact };
  delete body.receiptDigest;
  const rowCounts = object(artifact.rowCounts, "snapshot receipt rowCounts");
  const expectedSchemas = ["source_lightspeed", "source_xero", "core", "mart", "ingestion"];
  if (
    artifact.schemaVersion !== 1
    || artifact.kind !== "albert.semantic-v2-analytical-snapshot-migration"
    || artifact.status !== "passed"
    || !PROJECT_REF.test(String(artifact.sourceProjectRef ?? ""))
    || !PROJECT_REF.test(String(artifact.targetProjectRef ?? ""))
    || !ULID.test(String(artifact.sourceTenantId ?? ""))
    || !ULID.test(String(artifact.targetTenantId ?? ""))
    || !Number.isSafeInteger(artifact.tableCount)
    || Number(artifact.tableCount) < 1
    || Object.keys(rowCounts).sort().join(",") !== [...expectedSchemas].sort().join(",")
    || Object.values(rowCounts).some((value) => !Number.isSafeInteger(value) || Number(value) < 0)
    || !SHA256.test(receiptDigest)
    || snapshotReceiptDigest(body) !== receiptDigest
    || !SHA256.test(semanticManifestHash)
    || !COMMIT.test(commit)
    || !UUID.test(actorUserId)
  ) {
    throw new Error("Snapshot migration receipt or release binding is invalid.");
  }
  const analyticalProjectRef = process.env.ALBERT_ANALYTICAL_PROJECT_REF?.trim();
  if (
    !analyticalProjectRef
    || analyticalProjectRef !== artifact.targetProjectRef
  ) {
    throw new Error("Snapshot receipt does not target ALBERT_ANALYTICAL_PROJECT_REF.");
  }
  const controlPlaneUrl = process.env.CONTROL_PLANE_ADMIN_DATABASE_URL?.trim();
  if (!controlPlaneUrl) throw new Error("CONTROL_PLANE_ADMIN_DATABASE_URL is required.");
  const client = new Client({ connectionString: controlPlaneUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE albert_control_migration_owner");
    const operator = await client.query(
      "SELECT 1 FROM control_plane.internal_operators WHERE user_id=$1::uuid AND enabled AND revoked_at IS NULL",
      [actorUserId],
    );
    if (!operator.rows[0]) throw new Error("Snapshot receipt actor is not an enabled internal operator.");
    await client.query(
      `INSERT INTO control_plane.semantic_v2_snapshot_migration_receipts(
         receipt_digest,semantic_manifest_hash,commit_sha,analytical_project_ref,artifact,registered_by
       ) VALUES ($1,$2,$3,$4,$5::jsonb,$6::uuid)
       ON CONFLICT (receipt_digest) DO NOTHING`,
      [
        receiptDigest,
        semanticManifestHash,
        commit,
        analyticalProjectRef,
        JSON.stringify(artifact),
        actorUserId,
      ],
    );
    const persisted = await client.query(
      `SELECT semantic_manifest_hash,commit_sha,analytical_project_ref,artifact,registered_by
         FROM control_plane.semantic_v2_snapshot_migration_receipts
        WHERE receipt_digest=$1`,
      [receiptDigest],
    );
    assert.equal(persisted.rows.length, 1, "Snapshot receipt was not persisted.");
    assert.deepEqual(persisted.rows[0], {
      semantic_manifest_hash: semanticManifestHash,
      commit_sha: commit,
      analytical_project_ref: analyticalProjectRef,
      artifact,
      registered_by: actorUserId,
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
  process.stdout.write(`${JSON.stringify({ status: "passed", receiptDigest })}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await registerSemanticV2SnapshotReceipt();
}
