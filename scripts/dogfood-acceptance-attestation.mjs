import assert from "node:assert/strict";
import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  sign as signBytes,
  verify as verifyBytes,
} from "node:crypto";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { z } from "zod";

const { Client } = pg;

const SHA256_HEX = /^[a-f0-9]{64}$/u;
const COMMIT_SHA = /^[a-f0-9]{40}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const SAFE_ID = /^[a-z][a-z0-9_-]{1,79}$/u;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const WORKFLOW_REF = /^refs\/tags\/[A-Za-z0-9][A-Za-z0-9._\/-]{0,239}$/u;
const DIGIT_STRING = /^[1-9][0-9]{0,19}$/u;
const MAX_ATTESTATION_LIFETIME_MS = 6 * 60 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;

const digestSchema = z.string().regex(SHA256_HEX);
const connectorSchema = z.enum(["lightspeed-r", "xero", "deputy"]);
const answerStateSchema = z.enum(["verified", "qualified"]);
export const DOGFOOD_REQUIRED_RUNTIMES = Object.freeze([
  "deletion-worker",
  "operator-diagnostic",
  "semantic-query",
  "sync-worker",
  "transform-worker",
  "web",
  "webhook-gateway",
]);
const deploymentIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u);

const zeroResidualsSchema = z.object({
  rawObjects: z.literal(0),
  stagingRows: z.literal(0),
  canonicalRows: z.literal(0),
  bridgeRows: z.literal(0),
  linkRows: z.literal(0),
  embeddingRows: z.literal(0),
  cacheRows: z.literal(0),
  otherAnalyticalRows: z.literal(0),
  controlRows: z.literal(0),
  derivedArtifacts: z.literal(0),
  queueMessages: z.literal(0),
  credentialReferences: z.literal(0),
  credentialEnvelopes: z.literal(0),
  sessionEnvelopes: z.literal(0),
}).strict();

const deletionProofSchema = z.object({
  subjectRef: digestSchema,
  proofDigest: digestSchema,
  completedAt: z.string().datetime({ offset: true }),
  providerGenerationsDigest: digestSchema,
  remoteRevocationVerified: z.literal(true),
  storesVerified: z.literal(true),
  residuals: zeroResidualsSchema,
}).strict();

export const dogfoodAcceptanceBodySchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("albert.protected-dogfood-acceptance"),
  attestationId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
  candidateSha: z.string().regex(COMMIT_SHA),
  sourceEnvironment: z.literal("staging"),
  targetEnvironment: z.literal("production"),
  repository: z.string().regex(REPOSITORY),
  workflow: z.object({
    file: z.literal("dogfood-acceptance.yml"),
    runId: z.string().regex(DIGIT_STRING),
    runAttempt: z.number().int().positive().max(10_000),
    actorId: z.string().regex(DIGIT_STRING),
    ref: z.string().regex(WORKFLOW_REF),
    toolingSha: z.string().regex(COMMIT_SHA),
  }).strict(),
  issuedAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
  nonceDigest: digestSchema,
  controlSnapshotDigest: digestSchema,
  subjects: z.object({
    dogfoodTenantRef: digestSchema,
    onboardingTenantRef: digestSchema,
    deletionTenantRef: digestSchema,
  }).strict(),
  runtimes: z.object({
    checkedCount: z.literal(7),
    requiredServices: z.tuple([
      z.literal("deletion-worker"),
      z.literal("operator-diagnostic"),
      z.literal("semantic-query"),
      z.literal("sync-worker"),
      z.literal("transform-worker"),
      z.literal("web"),
      z.literal("webhook-gateway"),
    ]),
    deploymentId: deploymentIdSchema,
    barrierAt: z.string().datetime({ offset: true }),
    identityDigest: digestSchema,
  }).strict(),
  connectionGenerations: z.array(z.object({
    connector: connectorSchema,
    connectionRef: digestSchema,
    generation: z.number().int().positive(),
  }).strict()).length(3),
  milestones: z.object({
    m3: z.object({
      passed: z.literal(true),
      streamCount: z.number().int().positive().max(1_000),
      liveRecordedStreams: z.number().int().positive().max(1_000),
      backfillCompleteStreams: z.number().int().positive().max(1_000),
      reconciledStreams: z.number().int().positive().max(1_000),
      qualityCheckCount: z.number().int().min(7).max(1_000),
      evidenceDigest: digestSchema,
    }).strict(),
    m4: z.object({
      passed: z.literal(true),
      invariantCount: z.number().int().min(12).max(1_000),
      identitySuggestionCount: z.number().int().positive().max(1_000_000),
      xeroPostingBridgeVerified: z.literal(true),
      evidenceDigest: digestSchema,
    }).strict(),
    m5: z.object({
      passed: z.literal(true),
      planDigest: digestSchema,
      cases: z.array(z.object({
        caseId: z.string().regex(SAFE_ID),
        kind: z.enum(["golden", "composite"]),
        answerState: answerStateSchema,
        rowCount: z.number().int().nonnegative().max(10_000),
        resultDigest: digestSchema,
        bundleHash: digestSchema,
      }).strict()).min(2).max(20),
      evidenceDigest: digestSchema,
    }).strict(),
    m6: z.object({
      passed: z.literal(true),
      flagship: z.object({
        artifactDigest: digestSchema,
        traceDigest: digestSchema,
        answerState: answerStateSchema,
        queryCount: z.number().int().min(2).max(20),
        provenanceComplete: z.literal(true),
        sequentialNarrative: z.literal(true),
      }).strict(),
      category: z.object({
        artifactDigest: digestSchema,
        traceDigest: digestSchema,
        answerState: answerStateSchema,
        queryCount: z.number().int().positive().max(20),
        provenanceComplete: z.literal(true),
        sequentialNarrative: z.literal(true),
        chartPresent: z.literal(true),
      }).strict(),
      evidenceDigest: digestSchema,
    }).strict(),
    m7: z.object({
      passed: z.literal(true),
      onboardingMinutes: z.number().nonnegative().max(24 * 60),
      targetMinutes: z.number().int().positive().max(24 * 60),
      readyPartialDomainCount: z.number().int().positive().max(100),
      blockingAnswerCount: z.number().int().min(4).max(100),
      overlayDigest: digestSchema,
      evidenceDigest: digestSchema,
    }).strict(),
    m8: z.object({
      passed: z.literal(true),
      disconnect: deletionProofSchema.extend({
        provider: connectorSchema,
        connectionGeneration: z.number().int().positive(),
      }).strict(),
      tenantDeletion: deletionProofSchema,
      evidenceDigest: digestSchema,
    }).strict(),
  }).strict(),
  evidenceDigest: digestSchema,
}).strict().superRefine((value, context) => {
  const issuedAt = Date.parse(value.issuedAt);
  const expiresAt = Date.parse(value.expiresAt);
  if (expiresAt <= issuedAt || expiresAt - issuedAt > MAX_ATTESTATION_LIFETIME_MS) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "Attestation lifetime is invalid." });
  }
  if (Date.parse(value.runtimes.barrierAt) > issuedAt) {
    context.addIssue({ code: "custom", path: ["runtimes", "barrierAt"], message: "Candidate deployment barrier is after evidence issuance." });
  }
  const connectorSet = new Set(value.connectionGenerations.map(({ connector }) => connector));
  if (connectorSet.size !== 3) {
    context.addIssue({ code: "custom", path: ["connectionGenerations"], message: "Each V1 connector must be attested exactly once." });
  }
  if (new Set(value.connectionGenerations.map(({ connectionRef }) => connectionRef)).size !== 3) {
    context.addIssue({ code: "custom", path: ["connectionGenerations"], message: "Connection references must be distinct." });
  }
  const { m3, m5, m7 } = value.milestones;
  if (m3.liveRecordedStreams !== m3.streamCount ||
      m3.backfillCompleteStreams !== m3.streamCount ||
      m3.reconciledStreams !== m3.streamCount) {
    context.addIssue({ code: "custom", path: ["milestones", "m3"], message: "Every planned stream must be live-recorded, complete, and reconciled." });
  }
  if (m7.onboardingMinutes > m7.targetMinutes) {
    context.addIssue({ code: "custom", path: ["milestones", "m7", "onboardingMinutes"], message: "Fresh onboarding exceeded its target." });
  }
  const kinds = new Set(m5.cases.map(({ kind }) => kind));
  if (!kinds.has("golden") || !kinds.has("composite")) {
    context.addIssue({ code: "custom", path: ["milestones", "m5", "cases"], message: "Dogfood requires both numeric golden and composite cases." });
  }
  if (new Set(m5.cases.map(({ caseId }) => caseId)).size !== m5.cases.length) {
    context.addIssue({ code: "custom", path: ["milestones", "m5", "cases"], message: "Dogfood case ids must be unique." });
  }
});

export const dogfoodAcceptanceEnvelopeSchema = z.object({
  attestation: dogfoodAcceptanceBodySchema,
  signature: z.object({
    algorithm: z.literal("Ed25519"),
    keyId: z.string().regex(KEY_ID),
    value: z.string().regex(BASE64URL).length(86),
  }).strict(),
}).strict();

export const dogfoodSemanticPlanSchema = z.array(z.object({
  caseId: z.string().regex(SAFE_ID),
  kind: z.enum(["golden", "composite"]),
  expectedResultDigest: digestSchema,
  input: z.record(z.string(), z.unknown()),
}).strict()).min(2).max(20).superRefine((cases, context) => {
  if (new Set(cases.map(({ caseId }) => caseId)).size !== cases.length) {
    context.addIssue({ code: "custom", message: "Semantic case ids must be unique." });
  }
  const kinds = new Set(cases.map(({ kind }) => kind));
  if (!kinds.has("golden") || !kinds.has("composite")) {
    context.addIssue({ code: "custom", message: "The plan requires a golden and a composite case." });
  }
  for (const [index, item] of cases.entries()) {
    if ((item.kind === "composite") !== (item.input.kind === "composite")) {
      context.addIssue({ code: "custom", path: [index, "input", "kind"], message: "Case kind and semantic IR kind do not agree." });
    }
  }
});

export const DOGFOOD_ACCEPTANCE_JSON_SCHEMA = Object.freeze(z.toJSONSchema(
  dogfoodAcceptanceEnvelopeSchema,
  { target: "draft-2020-12", unrepresentable: "throw" },
));

export function stableJson(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value), "Attestation contains a non-finite number.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  assert.ok(value && typeof value === "object", "Attestation contains an unsupported value.");
  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`).join(",")}}`;
}

export function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : stableJson(value)).digest("hex");
}

export function hmacReference(key, kind, value) {
  const decoded = decodeReferenceKey(key);
  assert.match(kind, /^[a-z][a-z0-9_-]{1,60}$/u, "Reference kind is invalid.");
  assert.ok(typeof value === "string" && value.length > 0 && value.length <= 512, "Reference value is invalid.");
  return createHmac("sha256", decoded).update(`albert-dogfood-acceptance-v1:${kind}:${value}`).digest("hex");
}

export function computeEvidenceDigest(body) {
  return sha256({
    candidateSha: body.candidateSha,
    sourceEnvironment: body.sourceEnvironment,
    controlSnapshotDigest: body.controlSnapshotDigest,
    subjects: body.subjects,
    runtimes: body.runtimes,
    connectionGenerations: body.connectionGenerations,
    milestones: body.milestones,
  });
}

export function dogfoodAcceptanceKeyId(keyInput) {
  const publicKey = keyInput?.type === "public" && keyInput?.asymmetricKeyType
    ? keyInput
    : createPublicKey(keyInput);
  assert.equal(publicKey.asymmetricKeyType, "ed25519", "Dogfood attestation key must be Ed25519.");
  return `ed25519:${createHash("sha256").update(publicKey.export({ type: "spki", format: "der" })).digest("hex")}`;
}

export function signDogfoodAcceptance(attestationInput, encodedPrivateKey) {
  const attestation = dogfoodAcceptanceBodySchema.parse({
    ...attestationInput,
    evidenceDigest: computeEvidenceDigest(attestationInput),
  });
  const privateKey = createPrivateKey({
    key: decodeDerKey(encodedPrivateKey, "private"),
    format: "der",
    type: "pkcs8",
  });
  assert.equal(privateKey.asymmetricKeyType, "ed25519", "Dogfood attestation private key must be Ed25519.");
  const keyId = dogfoodAcceptanceKeyId(privateKey);
  const signature = signBytes(null, Buffer.from(stableJson(attestation)), privateKey).toString("base64url");
  return dogfoodAcceptanceEnvelopeSchema.parse({
    attestation, signature: { algorithm: "Ed25519", keyId, value: signature },
  });
}

export function verifyDogfoodAcceptance(rawEnvelope, options) {
  const envelope = dogfoodAcceptanceEnvelopeSchema.parse(
    typeof rawEnvelope === "string" ? JSON.parse(rawEnvelope) : rawEnvelope,
  );
  const publicKey = createPublicKey({
    key: decodeDerKey(options.encodedPublicKey, "public"),
    format: "der",
    type: "spki",
  });
  assert.equal(publicKey.asymmetricKeyType, "ed25519", "Dogfood attestation public key must be Ed25519.");
  assert.equal(envelope.signature.keyId, dogfoodAcceptanceKeyId(publicKey), "Dogfood attestation signer is not trusted.");
  assert.equal(envelope.attestation.candidateSha, options.candidateSha, "Dogfood attestation is for a different candidate SHA.");
  assert.equal(envelope.attestation.repository, options.repository, "Dogfood attestation repository does not match this release.");
  assert.equal(envelope.attestation.sourceEnvironment, "staging", "Dogfood evidence must be produced before production.");
  assert.equal(envelope.attestation.targetEnvironment, options.targetEnvironment, "Dogfood attestation target environment does not match.");
  assert.equal(envelope.attestation.workflow.file, "dogfood-acceptance.yml", "Dogfood evidence came from an untrusted workflow.");
  assert.equal(envelope.attestation.workflow.ref, options.expectedWorkflowRef, "Dogfood evidence did not run from the protected workflow ref.");
  assert.equal(envelope.attestation.workflow.toolingSha, options.expectedToolingSha, "Dogfood evidence did not run the trusted tooling commit.");

  const now = options.now ?? Date.now();
  const issuedAt = Date.parse(envelope.attestation.issuedAt);
  const expiresAt = Date.parse(envelope.attestation.expiresAt);
  assert.ok(issuedAt <= now + MAX_CLOCK_SKEW_MS, "Dogfood attestation is issued in the future.");
  assert.ok(expiresAt > now, "Dogfood attestation has expired.");
  assert.ok(now - issuedAt <= MAX_ATTESTATION_LIFETIME_MS, "Dogfood attestation is too old.");
  assert.equal(
    envelope.attestation.evidenceDigest,
    computeEvidenceDigest(envelope.attestation),
    "Dogfood evidence digest is inconsistent.",
  );

  assert.equal(verifyBytes(
    null,
    Buffer.from(stableJson(envelope.attestation)),
    publicKey,
    Buffer.from(envelope.signature.value, "base64url"),
  ), true, "Dogfood attestation signature is invalid.");
  return Object.freeze({
    attestationId: envelope.attestation.attestationId,
    candidateSha: envelope.attestation.candidateSha,
    expiresAt: envelope.attestation.expiresAt,
    workflowRunId: envelope.attestation.workflow.runId,
    evidenceDigest: envelope.attestation.evidenceDigest,
    controlSnapshotDigest: envelope.attestation.controlSnapshotDigest,
  });
}

export async function consumeDogfoodAcceptance(options) {
  assert.match(options.attestationId, /^[0-9A-HJKMNP-TV-Z]{26}$/u, "Dogfood attestation id is invalid.");
  assert.match(options.candidateSha, COMMIT_SHA, "Dogfood candidate SHA is invalid.");
  assert.match(options.evidenceDigest, SHA256_HEX, "Dogfood evidence digest is invalid.");
  assert.match(options.releaseRunId, DIGIT_STRING, "Release workflow run id is invalid.");
  assert.match(options.repository, REPOSITORY, "Release repository is invalid.");
  const client = new Client({ connectionString: options.databaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE albert_operator_diagnostic_control");
    const result = await client.query(
      `select control_plane.consume_protected_dogfood_acceptance(
         $1::text,$2::text,$3::text,$4::text,$5::text
       ) as consumed`,
      [
        options.attestationId,
        options.candidateSha,
        options.evidenceDigest,
        options.releaseRunId,
        options.repository,
      ],
    );
    assert.equal(result.rows[0]?.consumed, true, "Dogfood attestation was not consumed.");
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

function decodeReferenceKey(encodedKey) {
  assert.ok(typeof encodedKey === "string" && BASE64URL.test(encodedKey), "Dogfood attestation key must be base64url.");
  const decoded = Buffer.from(encodedKey, "base64url");
  assert.ok(decoded.length >= 32 && decoded.length <= 64, "Dogfood attestation key must decode to 32-64 bytes.");
  return decoded;
}

function decodeDerKey(encodedKey, kind) {
  assert.ok(typeof encodedKey === "string" && BASE64URL.test(encodedKey), `Dogfood ${kind} key must be base64url DER.`);
  const decoded = Buffer.from(encodedKey, "base64url");
  assert.ok(decoded.length >= 32 && decoded.length <= 256, `Dogfood ${kind} key DER length is invalid.`);
  return decoded;
}

function required(source, name) {
  const value = source[name]?.trim();
  assert.ok(value, `${name} is required.`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = verifyDogfoodAcceptance(
    required(process.env, "ALBERT_DOGFOOD_ACCEPTANCE_EVIDENCE"),
    {
      candidateSha: required(process.env, "ALBERT_RELEASE_COMMIT_SHA"),
      repository: required(process.env, "GITHUB_REPOSITORY"),
      targetEnvironment: "production",
      expectedWorkflowRef: required(process.env, "ALBERT_DOGFOOD_ACCEPTANCE_WORKFLOW_REF"),
      expectedToolingSha: required(process.env, "ALBERT_DOGFOOD_TRUSTED_TOOLING_SHA"),
      encodedPublicKey: required(process.env, "ALBERT_DOGFOOD_ACCEPTANCE_ED25519_PUBLIC_KEY_BASE64URL"),
    },
  );
  await consumeDogfoodAcceptance({
    databaseUrl: required(process.env, "ALBERT_DOGFOOD_CONTROL_DATABASE_URL"),
    attestationId: result.attestationId,
    candidateSha: result.candidateSha,
    evidenceDigest: result.controlSnapshotDigest,
    releaseRunId: required(process.env, "GITHUB_RUN_ID"),
    repository: required(process.env, "GITHUB_REPOSITORY"),
  });
  process.stdout.write(`dogfood acceptance verified for ${result.candidateSha} from protected run ${result.workflowRunId}\n`);
}
