import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { ulid } from "ulid";

import {
  createSemanticPublicationV2,
  semanticRegistryDocumentV2Schema,
  validateSemanticRegistryV2,
} from "../packages/semantic-registry/src/v2.js";

const { Client } = pg;
const SHA256 = /^[a-f0-9]{64}$/u;
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/u;

function argument(name: string): string {
  const prefix = `--${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length);
  if (!value) throw new Error(`${prefix}... is required.`);
  return value;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

export async function publishSemanticV2Release(): Promise<void> {
  if (!process.argv.includes("--execute")) {
    throw new Error("Refusing to validate and publish Semantic V2 without --execute.");
  }
  const draftId = argument("draft-id");
  const revision = Number(argument("draft-revision"));
  const publicationHash = argument("publication");
  const actorUserId = argument("actor-user-id");
  if (
    !ULID.test(draftId) ||
    !Number.isSafeInteger(revision) ||
    revision < 1 ||
    !SHA256.test(publicationHash) ||
    !UUID.test(actorUserId)
  ) {
    throw new Error("Semantic publication release binding is invalid.");
  }
  const canonicalArtifact = record(
    JSON.parse(
      readFileSync(
        "packages/semantic-registry/registry/publication.v2.json",
        "utf8",
      ),
    ),
    "canonical Semantic V2 publication",
  );
  const canonicalManifest = semanticRegistryDocumentV2Schema.parse(
    canonicalArtifact.manifest,
  );
  const canonicalPublication = createSemanticPublicationV2(canonicalManifest);
  if (
    canonicalArtifact.publicationHash !== publicationHash ||
    canonicalPublication.publicationHash !== publicationHash
  ) {
    throw new Error(
      "The requested publication does not match the canonical repository artifact.",
    );
  }
  const connectionString = process.env.CONTROL_PLANE_ADMIN_DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error("CONTROL_PLANE_ADMIN_DATABASE_URL is required.");
  }
  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE albert_control_migration_owner");
    const operator = await client.query(
      "SELECT 1 FROM control_plane.internal_operators WHERE user_id=$1::uuid AND enabled AND revoked_at IS NULL",
      [actorUserId],
    );
    if (!operator.rows[0]) {
      throw new Error("Semantic publication actor is not an enabled internal operator.");
    }
    await client.query("RESET ROLE");
    await client.query(
      "SELECT set_config('request.jwt.claim.sub',$1,true)",
      [actorUserId],
    );
    await client.query(
      "SELECT set_config('request.jwt.claims',$1,true)",
      [
        JSON.stringify({
          sub: actorUserId,
          role: "authenticated",
          app_metadata: {},
        }),
      ],
    );
    await client.query("SET LOCAL ROLE authenticated");
    const draftResult = await client.query(
      `SELECT manifest,manifest_hash,revision
         FROM control_plane.semantic_v2_drafts
        WHERE draft_id=$1`,
      [draftId],
    );
    if (draftResult.rows.length !== 1) {
      throw new Error("The exact semantic draft does not exist.");
    }
    const draftRow = record(draftResult.rows[0], "semantic draft row");
    const draftManifest = semanticRegistryDocumentV2Schema.parse(draftRow.manifest);
    const draftPublication = createSemanticPublicationV2(draftManifest);
    if (
      draftRow.revision !== revision ||
      draftRow.manifest_hash !== publicationHash ||
      draftPublication.publicationHash !== publicationHash
    ) {
      throw new Error("The semantic draft does not match the exact release binding.");
    }
    const issues = validateSemanticRegistryV2(draftManifest);
    if (issues.length !== 0) {
      throw new Error(
        `Semantic validation found ${issues.length} issue(s); publication is blocked.`,
      );
    }
    const validationId = ulid();
    const deterministicReceipt = {
      status: "passed",
      suite: "semantic_authoring_contracts_v2",
      checks: [
        "schema",
        "references",
        "join_paths",
        "grain",
        "additivity",
        "conformed_alignment",
        "content_hash",
      ],
      modelEvaluationTriggered: false,
    };
    const validationResult = await client.query(
      `SELECT public.albert_semantic_v2_admin_record_validation(
         $1,$2,$3,$4,'passed','[]'::jsonb,$5::jsonb
       ) AS result`,
      [
        validationId,
        draftId,
        revision,
        publicationHash,
        JSON.stringify(deterministicReceipt),
      ],
    );
    const validation = record(
      validationResult.rows[0]?.result,
      "semantic validation receipt",
    );
    if (
      validation.status !== "passed" ||
      validation.manifestHash !== publicationHash ||
      validation.revision !== revision
    ) {
      throw new Error("Persisted semantic validation does not match the release.");
    }
    const effectiveValidationId = String(validation.validationId ?? "");
    if (!ULID.test(effectiveValidationId)) {
      throw new Error("Persisted semantic validation ID is invalid.");
    }
    const publicationResult = await client.query(
      `SELECT public.albert_semantic_v2_publish_draft($1,$2,$3,$4,$5::jsonb) AS result`,
      [
        draftId,
        revision,
        effectiveValidationId,
        publicationHash,
        JSON.stringify(canonicalPublication.objectCounts),
      ],
    );
    const publication = record(
      publicationResult.rows[0]?.result,
      "semantic publication receipt",
    );
    if (
      publication.publicationHash !== publicationHash ||
      publication.reviewDisposition !== "owner_waived_human_review" ||
      !SHA256.test(String(publication.reviewWaiverDigest ?? ""))
    ) {
      throw new Error(
        "Semantic publication did not preserve the exact owner-waiver disposition.",
      );
    }
    const persisted = await client.query(
      `SELECT artifact,review_waiver_digest
         FROM control_plane.semantic_v2_publications
        WHERE publication_hash=$1`,
      [publicationHash],
    );
    const persistedRow = record(
      persisted.rows[0],
      "persisted semantic publication",
    );
    const persistedArtifact = record(
      persistedRow.artifact,
      "persisted semantic publication artifact",
    );
    if (
      createSemanticPublicationV2(persistedArtifact.manifest).publicationHash !==
        publicationHash ||
      persistedRow.review_waiver_digest !== publication.reviewWaiverDigest
    ) {
      throw new Error("Persisted semantic publication failed integrity verification.");
    }
    await client.query("COMMIT");
    process.stdout.write(
      `${JSON.stringify({
        status: "published",
        publicationHash,
        validationId: effectiveValidationId,
        reviewDisposition: publication.reviewDisposition,
        reviewWaiverDigest: publication.reviewWaiverDigest,
      })}\n`,
    );
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await publishSemanticV2Release();
}
