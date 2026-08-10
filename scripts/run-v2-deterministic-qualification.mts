import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { Client } from "pg";

import {
  semanticProfileReceiptDigestV2,
  verifySemanticProfileReceiptAttestationV2,
} from "../packages/semantic-registry/src/profile-receipt-attestation.js";
import { createSemanticPublicationV2 } from "../packages/semantic-registry/src/v2.js";

type JsonRecord = Record<string, unknown>;

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be a JSON object.`);
  return value as JsonRecord;
}

function records(value: unknown, label: string): JsonRecord[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value.map((item, index) => record(item, `${label}[${index}]`));
}

if (!process.argv.includes("--execute"))
  throw new Error("Refusing to run release qualification without --execute.");
const publicationArgument = process.argv
  .find((argument) => argument.startsWith("--publication="))
  ?.slice("--publication=".length);
if (!publicationArgument || !/^[a-f0-9]{64}$/u.test(publicationArgument))
  throw new Error("--publication=<64-character hash> is required.");
const commit = spawnSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).stdout.trim();
if (!/^[a-f0-9]{40}$/u.test(commit))
  throw new Error("An exact Git commit is required for qualification.");
const analyticalProjectRef =
  process.env.ALBERT_ANALYTICAL_PROJECT_REF?.trim();
if (!analyticalProjectRef || !/^[a-z0-9]{20}$/u.test(analyticalProjectRef))
  throw new Error(
    "ALBERT_ANALYTICAL_PROJECT_REF must pin the exact analytical release project.",
  );
const dirty = spawnSync("git", ["status", "--porcelain"], {
  encoding: "utf8",
}).stdout.trim();
if (dirty)
  throw new Error(
    "Deterministic release qualification requires a clean worktree so every receipt maps to one commit.",
  );
const publicationArtifact = JSON.parse(
  readFileSync(
    "packages/semantic-registry/registry/publication.v2.json",
    "utf8",
  ),
) as Record<string, unknown>;
const generatedPublication = createSemanticPublicationV2(
  publicationArtifact.manifest,
);
if (
  publicationArtifact.publicationHash !== publicationArgument ||
  generatedPublication.publicationHash !== publicationArgument
) {
  throw new Error(
    "The qualified publication argument does not match the canonical repository artifact and manifest digest.",
  );
}
const manifest = generatedPublication.manifest;
const relationshipDecisionArtifact = record(
  JSON.parse(
    readFileSync(
      "packages/semantic-registry/registry/relationship-decisions.v2.json",
      "utf8",
    ),
  ),
  "relationship decision artifact",
);
const expectedProfilePublication = String(
  relationshipDecisionArtifact.basePublicationHash ?? "",
);
const expectedProfileReceiptHash = String(
  relationshipDecisionArtifact.profileReceiptHash ?? "",
);
if (
  relationshipDecisionArtifact.schemaVersion !== 1 ||
  !/^[a-f0-9]{64}$/u.test(expectedProfilePublication) ||
  !/^[a-f0-9]{64}$/u.test(expectedProfileReceiptHash)
) {
  throw new Error(
    "The canonical relationship decision artifact has invalid immutable profile lineage.",
  );
}
const lightspeedObjects = manifest.sourceObjects.filter(
  ({ connector }) => connector === "lightspeed",
);
const xeroObjects = manifest.sourceObjects.filter(
  ({ connector }) => connector === "xero",
);
if (
  lightspeedObjects.length !== 90 ||
  lightspeedObjects.reduce(
    (total, source) => total + source.fields.length,
    0,
  ) !== 949 ||
  xeroObjects.length !== 197 ||
  xeroObjects.reduce((total, source) => total + source.fields.length, 0) !==
    2_079
) {
  throw new Error(
    "The release publication does not contain the locked complete Lightspeed and Xero inventory.",
  );
}
const unresolvedRelationships = manifest.relationshipCandidates.filter(
  ({ disposition }) => disposition === "unresolved",
);
if (unresolvedRelationships.length > 0) {
  throw new Error(
    `Release qualification requires every relationship candidate to be verified or rejected; ${unresolvedRelationships.length} remain unresolved.`,
  );
}
if (
  manifest.relationships.some(
    ({ evidence }) =>
      !evidence.some((item) => item.startsWith("profile_receipt:")),
  )
) {
  throw new Error(
    "Every supported relationship requires immutable live-profile receipt evidence before release qualification.",
  );
}
const controlPlaneUrl = process.env.CONTROL_PLANE_ADMIN_DATABASE_URL?.trim();
if (!controlPlaneUrl)
  throw new Error(
    "CONTROL_PLANE_ADMIN_DATABASE_URL is required to verify the migrated control plane and persisted publication.",
  );
const profileSigningSecret =
  process.env.ALBERT_SEMANTIC_PROFILE_SIGNING_SECRET?.trim();
if (!profileSigningSecret || profileSigningSecret.length < 32)
  throw new Error(
    "ALBERT_SEMANTIC_PROFILE_SIGNING_SECRET is required to verify registered relationship evidence.",
  );
const client = new Client({ connectionString: controlPlaneUrl });
await client.connect();
try {
  await client.query("BEGIN TRANSACTION READ ONLY");
  await client.query("SET LOCAL ROLE albert_control_migration_owner");
  const persisted = await client.query(
    `SELECT publication_hash,artifact,source_draft_id,source_draft_revision
       FROM control_plane.semantic_v2_publications
      WHERE publication_hash=$1`,
    [publicationArgument],
  );
  if (persisted.rows.length !== 1) {
    throw new Error(
      "The exact canonical publication is not persisted in the migrated control plane.",
    );
  }
  const persistedRow = record(persisted.rows[0], "persisted publication row");
  const persistedArtifact = record(
    persistedRow.artifact,
    "persisted publication artifact",
  );
  const persistedManifest = persistedArtifact.manifest;
  if (
    persistedArtifact.publicationHash !== publicationArgument ||
    createSemanticPublicationV2(persistedManifest).publicationHash !==
      publicationArgument
  )
    throw new Error(
      "The persisted publication failed its content-addressed integrity check.",
    );
  const requiredTables = await client.query(
    `SELECT to_regclass('control_plane.query_workspaces_v2') AS workspaces,
            to_regclass('control_plane.query_execution_snapshots_v2') AS executions,
            to_regclass('control_plane.semantic_v2_profile_receipts') AS profile_receipts,
            to_regclass('control_plane.semantic_v2_activation_qualifications') AS qualifications,
            to_regprocedure('public.albert_semantic_v2_admin_health(timestamptz)') AS admin_health`,
  );
  if (
    !requiredTables.rows[0] ||
    Object.values(requiredTables.rows[0]).some((value) => value === null)
  ) {
    throw new Error(
      "The control plane has not applied every required Semantic V2 migration.",
    );
  }
  const relationshipReceiptHashes = manifest.relationships.map(
    (relationship) => {
      const references = relationship.evidence
        .filter((item) => item.startsWith("profile_receipt:"))
        .map((item) => item.slice("profile_receipt:".length));
      if (
        references.length !== 1 ||
        !/^[a-f0-9]{64}$/u.test(references[0] ?? "")
      )
        throw new Error(
          `Relationship ${relationship.id} must cite exactly one valid profile receipt.`,
        );
      return references[0]!;
    },
  );
  const uniqueReceiptHashes = [...new Set(relationshipReceiptHashes)];
  if (
    uniqueReceiptHashes.length !== 1 ||
    uniqueReceiptHashes[0] !== expectedProfileReceiptHash
  ) {
    throw new Error(
      "Published relationships do not cite the canonical relationship decision receipt.",
    );
  }
  const registeredReceipts = uniqueReceiptHashes.length
    ? await client.query(
        `SELECT profile_receipt_hash,publication_hash,status,artifact
           FROM control_plane.semantic_v2_profile_receipts
          WHERE profile_receipt_hash=ANY($1::text[])`,
        [uniqueReceiptHashes],
      )
    : { rows: [] };
  const receiptsByHash = new Map<string, JsonRecord>();
  for (const rawRow of registeredReceipts.rows) {
    const row = record(rawRow, "registered profile receipt row");
    const receiptHash = String(row.profile_receipt_hash);
    const receipt = record(row.artifact, `profile receipt ${receiptHash}`);
    const attestation = record(
      receipt.attestation,
      `profile receipt ${receiptHash} attestation`,
    );
    if (
      row.status !== "complete" ||
      receipt.status !== "complete" ||
      row.publication_hash !== expectedProfilePublication ||
      receipt.publicationHash !== expectedProfilePublication ||
      semanticProfileReceiptDigestV2(receipt) !== receiptHash ||
      records(receipt.errors, `profile receipt ${receiptHash} errors`).length >
        0 ||
      attestation.algorithm !== "hmac-sha256" ||
      attestation.keyPurpose !== "semantic-profile-v2" ||
      typeof attestation.signature !== "string" ||
      !verifySemanticProfileReceiptAttestationV2(
        receipt as Parameters<
          typeof verifySemanticProfileReceiptAttestationV2
        >[0],
        profileSigningSecret,
      )
    )
      throw new Error(
        `Profile receipt ${receiptHash} is incomplete, stale, corrupt, or unauthenticated.`,
      );
    receiptsByHash.set(receiptHash, receipt);
  }
  if (receiptsByHash.size !== uniqueReceiptHashes.length)
    throw new Error(
      "Every supported relationship must cite a registered immutable profile receipt.",
    );
  for (const [index, relationship] of manifest.relationships.entries()) {
    const candidateId = relationship.id.replace(
      /^relationship\./u,
      "candidate.",
    );
    const candidate = manifest.relationshipCandidates.find(
      ({ id }) => id === candidateId,
    );
    if (
      !candidate ||
      candidate.disposition !== "verified" ||
      candidate.fromViewId !== relationship.fromViewId ||
      candidate.fromFieldId !== relationship.fromFieldId ||
      !candidate.targets.some(
        ({ viewId, fieldId }) =>
          viewId === relationship.toViewId &&
          fieldId === relationship.toFieldId,
      )
    )
      throw new Error(
        `Relationship ${relationship.id} is not bound to its verified source candidate and explicit target.`,
      );
    const receiptHash = relationshipReceiptHashes[index]!;
    const receipt = receiptsByHash.get(receiptHash)!;
    const candidateProfile = records(
      receipt.relationshipProfiles,
      `profile receipt ${receiptHash} relationshipProfiles`,
    ).find((profile) => profile.candidateId === candidateId);
    const targetProfile = candidateProfile
      ? records(
          candidateProfile.targets,
          `profile receipt ${receiptHash} candidate ${candidateId} targets`,
        ).find(
          (target) =>
            target.targetViewId === relationship.toViewId &&
            target.targetFieldId === relationship.toFieldId,
        )
      : undefined;
    if (
      relationship.cardinality !== "many_to_one" ||
      !targetProfile ||
      Number(targetProfile.sampledForeignKeys) < 1 ||
      Number(targetProfile.sampledForeignKeys) <=
        Number(targetProfile.orphanRows) ||
      Number(targetProfile.maximumTargetMatches) !== 1 ||
      Number(targetProfile.ambiguousRows) > 0 ||
      Number(targetProfile.duplicateTargetKeyGroups) > 0 ||
      targetProfile.recommendedCardinality !== "many_to_one" ||
      targetProfile.recommendedDisposition !== "review_candidate"
    )
      throw new Error(
        `Profile receipt ${receiptHash} does not prove ${relationship.id} is a safe many-to-one relationship.`,
      );
    if (
      !relationship.optional &&
      (targetProfile.profileCoverageComplete !== true ||
        Number(targetProfile.nullForeignKeys) > 0 ||
        Number(targetProfile.orphanRows) > 0)
    )
      throw new Error(
        `Required relationship ${relationship.id} lacks complete, non-null, orphan-free profile coverage.`,
      );
  }
  await client.query("COMMIT");
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}

const suites = [
  [
    "physical-staging-contract",
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/audit-semantic-v2-schema.mts",
      "--live",
      "--require-project-ref",
      `--publication=${publicationArgument}`,
    ],
  ],
  ["semantic-v2-generated-artifacts", "npm", ["run", "registry:v2:check"]],
  ["legacy-registry-artifacts", "npm", ["run", "registry:check"]],
  ["prompt-documentation", "npm", ["run", "prompt-docs:check"]],
  ["deployment-contract", "npm", ["run", "test:deployment"]],
  ["all-contracts", "npm", ["run", "test:contracts"]],
  ["all-evaluations", "npm", ["run", "test:evals"]],
  ["semantic-v2-static-lint", "npm", ["run", "lint:v2"]],
  ["full-typecheck", "npm", ["run", "typecheck"]],
  ["service-build", "npm", ["run", "test:service-build"]],
  ["application-build", "npm", ["run", "build"]],
  [
    "rendered-html",
    process.execPath,
    ["--test", "tests/rendered-html.test.mjs"],
  ],
  ["browser-accessibility", "npm", ["run", "test:browser"]],
] as const;
const results: Record<string, unknown>[] = [];
for (const [name, executable, arguments_] of suites) {
  const startedAt = Date.now();
  const run = spawnSync(executable, arguments_, {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 32 * 1024 * 1024,
  });
  const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  const result = {
    name,
    status: run.status === 0 ? "passed" : "failed",
    exitCode: run.status ?? 1,
    durationMs: Date.now() - startedAt,
    outputDigest: createHash("sha256").update(output).digest("hex"),
  };
  results.push(result);
  process.stderr.write(
    `${JSON.stringify({ event: "v2_deterministic_suite", ...result })}\n`,
  );
  if (run.status !== 0) {
    const receipt = {
      schemaVersion: 2,
      status: "failed",
      publicationHash: publicationArgument,
      commit,
      analyticalProjectRef,
      createdAt: new Date().toISOString(),
      suites: results,
    };
    mkdirSync(resolve(".albert-agent-qa-out", "qualification"), {
      recursive: true,
    });
    writeFileSync(
      resolve(
        ".albert-agent-qa-out",
        "qualification",
        `deterministic-${commit}-${publicationArgument}.json`,
      ),
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
    process.stderr.write(output.slice(-8_000));
    process.exit(1);
  }
}
const receipt = {
  schemaVersion: 2,
  status: "passed",
  publicationHash: publicationArgument,
  commit,
  analyticalProjectRef,
  createdAt: new Date().toISOString(),
  suites: results,
};
const outputPath = resolve(
  ".albert-agent-qa-out",
  "qualification",
  `deterministic-${commit}-${publicationArgument}.json`,
);
mkdirSync(resolve(".albert-agent-qa-out", "qualification"), {
  recursive: true,
});
writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`);
process.stdout.write(
  `${JSON.stringify({ outputPath, status: "passed" }, null, 2)}\n`,
);
