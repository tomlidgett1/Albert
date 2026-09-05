import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";

import {
  assertV2OwnerReviewWaiver,
  V2_OWNER_REVIEW_WAIVER_KIND,
  type V2OwnerReviewWaiver,
  type V2OwnerReviewWaiverScope,
  v2OwnerReviewWaiverDigest,
} from "./v2-owner-review-waiver.js";

const { Client } = pg;
const SHA256 = /^[a-f0-9]{64}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/u;

function argument(name: string): string {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
  if (!value) throw new Error(`${prefix}... is required.`);
  return value;
}

function optionalArgument(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
}

function databaseRow(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Persisted owner review waiver is malformed.");
  }
  return value as Record<string, unknown>;
}

function buildArtifact(input: {
  scope: V2OwnerReviewWaiverScope;
  publicationHash: string;
  draftId?: string;
  draftRevision?: number;
  commit?: string;
  runId?: string;
  reason: string;
  authorizedBy: string;
}): V2OwnerReviewWaiver {
  const body = {
    schemaVersion: 1 as const,
    kind: V2_OWNER_REVIEW_WAIVER_KIND,
    status: "authorized" as const,
    scope: input.scope,
    publicationHash: input.publicationHash,
    ...(input.draftId ? { draftId: input.draftId } : {}),
    ...(input.draftRevision ? { draftRevision: input.draftRevision } : {}),
    ...(input.commit ? { commit: input.commit } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    reason: input.reason,
    authorizedBy: input.authorizedBy,
    createdAt: new Date().toISOString(),
  };
  return Object.freeze({
    ...body,
    waiverDigest: v2OwnerReviewWaiverDigest(body),
  });
}

export async function registerSemanticV2OwnerReviewWaiver(): Promise<void> {
  if (!process.argv.includes("--execute")) {
    throw new Error("Refusing to authorize an owner review waiver without --execute.");
  }
  const scope = argument("scope") as V2OwnerReviewWaiverScope;
  if (
    scope !== "semantic_publication_human_review" &&
    scope !== "semantic_publication_tier_1_second_review" &&
    scope !== "evaluation_subjective_human_review"
  ) {
    throw new Error("Unsupported owner review waiver scope.");
  }
  const publicationHash = argument("publication");
  const authorizedBy = argument("actor-user-id");
  const reason = argument("reason").trim();
  const outputPath = resolve(argument("output"));
  const draftId = optionalArgument("draft-id");
  const draftRevisionValue = optionalArgument("draft-revision");
  const draftRevision = draftRevisionValue ? Number(draftRevisionValue) : undefined;
  const commit = optionalArgument("commit");
  const runId = optionalArgument("run-id");
  const publicationScope =
    scope === "semantic_publication_human_review" ||
    scope === "semantic_publication_tier_1_second_review";
  if (
    !SHA256.test(publicationHash) ||
    !UUID.test(authorizedBy) ||
    reason.length < 20 ||
    reason.length > 2_000 ||
    (publicationScope &&
      (!draftId ||
        !ULID.test(draftId) ||
        !Number.isSafeInteger(draftRevision) ||
        Number(draftRevision) < 1 ||
        commit !== undefined ||
        runId !== undefined)) ||
    (!publicationScope &&
      (draftId !== undefined ||
        draftRevision !== undefined ||
        !commit ||
        !COMMIT.test(commit) ||
        !runId ||
        runId.length > 160))
  ) {
    throw new Error("Owner review waiver arguments are invalid for the requested scope.");
  }
  const controlPlaneUrl = process.env.CONTROL_PLANE_ADMIN_DATABASE_URL?.trim();
  if (!controlPlaneUrl) throw new Error("CONTROL_PLANE_ADMIN_DATABASE_URL is required.");
  const client = new Client({ connectionString: controlPlaneUrl });
  await client.connect();
  let artifact: V2OwnerReviewWaiver;
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE albert_control_migration_owner");
    const operator = await client.query(
      "SELECT 1 FROM control_plane.internal_operators WHERE user_id=$1::uuid AND enabled AND revoked_at IS NULL",
      [authorizedBy],
    );
    if (!operator.rows[0]) {
      throw new Error("Waiver actor is not an enabled internal operator.");
    }
    if (publicationScope) {
      const draft = await client.query(
        `SELECT 1 FROM control_plane.semantic_v2_drafts
          WHERE draft_id=$1 AND revision=$2 AND manifest_hash=$3`,
        [draftId, draftRevision, publicationHash],
      );
      if (!draft.rows[0]) {
        throw new Error("Publication waiver does not match the exact semantic draft revision.");
      }
    } else {
      const publication = await client.query(
        "SELECT 1 FROM control_plane.semantic_v2_publications WHERE publication_hash=$1",
        [publicationHash],
      );
      if (!publication.rows[0]) {
        throw new Error("Evaluation waiver requires the exact persisted semantic publication.");
      }
    }
    const existing = await client.query(
      publicationScope
        ? `SELECT artifact FROM control_plane.semantic_v2_owner_review_waivers
            WHERE scope=$1 AND draft_id=$2 AND draft_revision=$3 AND publication_hash=$4`
        : `SELECT artifact FROM control_plane.semantic_v2_owner_review_waivers
            WHERE scope=$1 AND publication_hash=$2 AND commit_sha=$3 AND run_id=$4`,
      publicationScope
        ? [scope, draftId, draftRevision, publicationHash]
        : [scope, publicationHash, commit, runId],
    );
    if (existing.rows[0]) {
      artifact = databaseRow(existing.rows[0]).artifact as V2OwnerReviewWaiver;
    } else {
      artifact = buildArtifact({
        scope,
        publicationHash,
        draftId,
        draftRevision,
        commit,
        runId,
        reason,
        authorizedBy,
      });
      await client.query(
        `INSERT INTO control_plane.semantic_v2_owner_review_waivers(
           waiver_digest,scope,draft_id,draft_revision,publication_hash,commit_sha,run_id,
           reason,artifact,authorized_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::uuid)`,
        [
          artifact.waiverDigest,
          scope,
          draftId ?? null,
          draftRevision ?? null,
          publicationHash,
          commit ?? null,
          runId ?? null,
          reason,
          JSON.stringify(artifact),
          authorizedBy,
        ],
      );
    }
    assertV2OwnerReviewWaiver(artifact, {
      scope,
      publicationHash,
      draftId,
      draftRevision,
      commit,
      runId,
    });
    assert.equal(artifact.authorizedBy, authorizedBy);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, {
    mode: 0o600,
  });
  process.stdout.write(
    `${JSON.stringify({ status: "authorized", scope, waiverDigest: artifact.waiverDigest, outputPath })}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await registerSemanticV2OwnerReviewWaiver();
}
