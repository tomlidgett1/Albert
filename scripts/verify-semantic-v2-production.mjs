import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { collectVercelPlatformProvenance } from "./collect-vercel-platform-provenance.mjs";

const { Client } = pg;
const SHA = /^[a-f0-9]{40}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const SUPABASE_PROJECT_REF = /^[a-z0-9]{20}$/u;
const DEPLOYMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u;

function required(source, name, pattern) {
  const value = source[name]?.trim();
  assert.ok(value, `${name} is required.`);
  if (pattern) assert.match(value, pattern, `${name} is invalid.`);
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  }
  return value;
}

function digest(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

async function boundedReadiness(fetchImpl, url, label) {
  const response = await fetchImpl(url, {
    headers: { accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
  });
  assert.equal(response.ok, true, `${label} is not ready.`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  assert.ok(!Number.isFinite(declared) || declared <= 16_384, `${label} readiness is too large.`);
  const text = await response.text();
  assert.ok(Buffer.byteLength(text) <= 16_384, `${label} readiness is too large.`);
  const value = JSON.parse(text);
  assert.ok(value && typeof value === "object" && !Array.isArray(value), `${label} readiness is invalid.`);
  return value;
}

function verifyQualification(row, publicationHash, candidateSha, analyticalProjectRef) {
  assert.equal(row.status, "passed", "Semantic V2 activation qualification did not pass.");
  assert.equal(row.publication_hash, publicationHash);
  assert.equal(row.commit_sha, candidateSha);
  const deterministic = row.deterministic_receipt;
  const evaluation = row.model_evaluation_receipt;
  assert.equal(deterministic?.status, "passed");
  assert.equal(deterministic?.publicationHash, publicationHash);
  assert.equal(deterministic?.commit, candidateSha);
  assert.equal(
    deterministic?.analyticalProjectRef,
    analyticalProjectRef,
    "The deterministic qualification was not run against the required analytical project.",
  );
  assert.ok(
    Array.isArray(deterministic?.suites) &&
      deterministic.suites.every((suite) => suite?.status === "passed"),
    "Every deterministic qualification suite must pass.",
  );
  const launch = evaluation?.launch;
  const grade = evaluation?.grade;
  assert.equal(launch?.model, "gpt-5.6-luna");
  assert.equal(launch?.reasoningEffort, "max");
  assert.equal(launch?.processingMode, "standard");
  assert.equal(launch?.fastMode, false);
  assert.equal(launch?.proMode, false);
  assert.equal(launch?.caseCount, 200);
  assert.equal(launch?.publicationHash, publicationHash);
  assert.equal(launch?.commit, candidateSha);
  assert.equal(grade?.status, "passed");
  assert.equal(grade?.caseCount, 200);
  assert.ok(
    grade?.gates &&
      Object.values(grade.gates).length > 0 &&
      Object.values(grade.gates).every((value) => value === true),
    "Every model and independent human-review gate must pass.",
  );
  assert.equal(grade?.releaseBinding?.publicationHash, publicationHash);
  assert.equal(grade?.releaseBinding?.commit, candidateSha);
  return Object.freeze({
    qualificationId: row.qualification_id,
    deterministicReceiptHash: digest(deterministic),
    modelEvaluationReceiptHash: digest(evaluation),
  });
}

export async function verifySemanticV2Production({
  source = process.env,
  fetchImpl = fetch,
  databaseClientFactory = (connectionString) =>
    new Client({ connectionString, statement_timeout: 10_000 }),
  now = new Date(),
} = {}) {
  const candidateSha = required(source, "ALBERT_RELEASE_CANDIDATE_SHA", SHA);
  const publicationHash = required(source, "ALBERT_SEMANTIC_V2_PUBLICATION_HASH", DIGEST);
  const analyticalProjectRef = required(
    source,
    "ALBERT_ANALYTICAL_PROJECT_REF",
    SUPABASE_PROJECT_REF,
  );
  const controlPlaneUrl = required(source, "CONTROL_PLANE_ADMIN_DATABASE_URL");
  const semanticOrigin = new URL(required(source, "SEMANTIC_QUERY_SERVICE_URL"));
  const publicOrigin = new URL(required(source, "ALBERT_PUBLIC_ORIGIN"));
  assert.equal(semanticOrigin.protocol, "https:");
  assert.equal(publicOrigin.protocol, "https:");

  const client = databaseClientFactory(controlPlaneUrl);
  await client.connect();
  let qualification;
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await client.query("SET LOCAL ROLE albert_control_migration_owner");
    const result = await client.query(
      `SELECT q.qualification_id,q.publication_hash,q.commit_sha,q.status,
              q.deterministic_receipt,q.model_evaluation_receipt,
              a.publication_hash AS active_publication_hash
         FROM control_plane.semantic_v2_activation_qualifications q
         JOIN control_plane.semantic_v2_publications p
           ON p.publication_hash=q.publication_hash
         LEFT JOIN control_plane.semantic_v2_active_publication a ON a.singleton
        WHERE q.publication_hash=$1 AND q.commit_sha=$2 AND q.status='passed'
        ORDER BY q.created_at DESC`,
      [publicationHash, candidateSha],
    );
    assert.equal(result.rows.length, 1, "Expected one exact passed Semantic V2 qualification.");
    assert.equal(
      result.rows[0].active_publication_hash,
      publicationHash,
      "The qualified Semantic V2 publication is not active.",
    );
    qualification = verifyQualification(
      result.rows[0],
      publicationHash,
      candidateSha,
      analyticalProjectRef,
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }

  const vercel = await collectVercelPlatformProvenance({ source, fetchImpl, observedAt: now.toISOString() });
  const [semantic, web] = await Promise.all([
    boundedReadiness(fetchImpl, new URL("/readyz", semanticOrigin), "Semantic V2 service"),
    boundedReadiness(fetchImpl, new URL("/api/health", publicOrigin), "Vercel web application"),
  ]);
  assert.equal(semantic.status, "ready");
  assert.equal(semantic.analyticalRuntime, "v2");
  assert.equal(semantic.v2PublicationHash, publicationHash);
  assert.equal(semantic.releaseSha, candidateSha);
  assert.match(semantic.deploymentId ?? "", DEPLOYMENT_ID);
  assert.equal(web.status, "ready");
  assert.equal(web.releaseSha, candidateSha);
  assert.equal(web.deploymentId, vercel.deployment.id);

  const body = Object.freeze({
    schemaVersion: 1,
    kind: "albert.semantic-v2-production-verification",
    status: "passed",
    verifiedAt: now.toISOString(),
    candidateSha,
    publicationHash,
    analyticalProjectRef,
    qualification,
    vercelProvenanceDigest: vercel.provenanceDigest,
    web: Object.freeze({ deploymentId: web.deploymentId, releaseSha: web.releaseSha }),
    semantic: Object.freeze({
      deploymentId: semantic.deploymentId,
      releaseSha: semantic.releaseSha,
      publicationHash: semantic.v2PublicationHash,
    }),
  });
  return Object.freeze({ ...body, verificationDigest: digest(body) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const receipt = await verifySemanticV2Production();
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
}
