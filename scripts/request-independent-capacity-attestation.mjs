import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { TRANSFORM_CAPACITY_CORPUS_CONTRACT_DIGEST } from "./transform-fleet-capacity-attestation.mjs";
import { CAPACITY_ATTESTATION_POLL_WINDOW_MS } from "./capacity-attestation-timing.mjs";

const OIDC_AUDIENCE = "albert-transform-capacity-attestor";
let cachedOidcToken;

function required(name) {
  const value = process.env[name]?.trim();
  assert.ok(value, `${name} is required to request independent capacity attestation.`);
  return value;
}

function appName(name) {
  const value = required(name);
  assert.match(value, /^[a-z0-9][a-z0-9-]{1,62}$/u, `${name} is invalid.`);
  return value;
}

async function githubOidcToken() {
  if (cachedOidcToken && cachedOidcToken.expiresAt > Date.now() + 60_000) {
    return cachedOidcToken.value;
  }
  const requestUrl = new URL(required("ACTIONS_ID_TOKEN_REQUEST_URL"));
  requestUrl.searchParams.set("audience", OIDC_AUDIENCE);
  const response = await fetch(requestUrl, {
    headers: { authorization: `Bearer ${required("ACTIONS_ID_TOKEN_REQUEST_TOKEN")}` },
    signal: AbortSignal.timeout(15_000),
  });
  assert.equal(response.ok, true, `GitHub OIDC token request returned ${response.status}.`);
  const body = await response.json();
  assert.match(body.value ?? "", /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u,
    "GitHub OIDC response is invalid.");
  const claims = JSON.parse(Buffer.from(body.value.split(".")[1], "base64url").toString("utf8"));
  assert.ok(Number.isSafeInteger(claims.exp), "GitHub OIDC expiry is invalid.");
  cachedOidcToken = Object.freeze({ value: body.value, expiresAt: claims.exp * 1_000 });
  return body.value;
}

export async function requestIndependentCapacityAttestation(outputPath) {
  assert.ok(outputPath, "Capacity attestation output path is required.");
  const attestorOrigin = new URL(required("ATTESTOR_URL"));
  assert.equal(attestorOrigin.protocol, "https:", "Capacity attestor must use HTTPS.");
  assert.equal(attestorOrigin.username, "", "Capacity attestor URL cannot contain credentials.");
  assert.equal(attestorOrigin.password, "", "Capacity attestor URL cannot contain credentials.");
  assert.equal(attestorOrigin.pathname, "/", "Capacity attestor setting must be an origin.");
  assert.equal(attestorOrigin.search, "", "Capacity attestor URL cannot contain a query.");
  assert.equal(attestorOrigin.hash, "", "Capacity attestor URL cannot contain a fragment.");
  assert.equal(["localhost", "127.0.0.1", "::1"].includes(attestorOrigin.hostname), false,
    "Capacity attestor cannot be local.");
  const requestedFloor = Number(required("REQUESTED_FLOOR"));
  assert.ok(Number.isInteger(requestedFloor) && requestedFloor >= 2 && requestedFloor <= 40,
    "Capacity floor is outside the reviewed range.");
  const corpusFingerprint = required("ALBERT_CAPACITY_CORPUS_FINGERPRINT");
  assert.match(corpusFingerprint, /^[a-f0-9]{64}$/u, "Capacity corpus fingerprint is invalid.");
  const requestBody = JSON.stringify({
      schemaVersion: 1,
      candidateSha: required("GITHUB_SHA"),
      repository: required("GITHUB_REPOSITORY"),
      workflowRunId: required("GITHUB_RUN_ID"),
      workflowRunAttempt: Number(required("GITHUB_RUN_ATTEMPT")),
      workflowRef: required("GITHUB_WORKFLOW_REF"),
      capacityRunId: `${required("GITHUB_RUN_ID")}-${required("GITHUB_RUN_ATTEMPT")}`,
      stagingCellId: required("STAGING_CELL_ID"),
      transformApp: appName("TARGET_APP"),
      autoscalerApp: appName("AUTOSCALER_APP"),
      requestedFloor,
      corpusContractDigest: TRANSFORM_CAPACITY_CORPUS_CONTRACT_DIGEST,
      corpusFingerprint,
  });
  const deadline = Date.now() + CAPACITY_ATTESTATION_POLL_WINDOW_MS;
  let attestationId;
  let envelope;
  while (Date.now() <= deadline) {
    const oidcToken = await githubOidcToken();
    const response = await fetch(new URL("/v1/transform-capacity-attestations", attestorOrigin), {
      method: "POST",
      headers: {
        authorization: `Bearer ${oidcToken}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: requestBody,
      signal: AbortSignal.timeout(20_000),
    });
    const text = await response.text();
    assert.ok(text.length > 0 && text.length <= 64 * 1_024, "Capacity attestor response size is invalid.");
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      assert.fail("Independent capacity attestor returned invalid JSON.");
    }
    if (response.status === 202) {
      assert.deepEqual(Object.keys(body).sort(), ["attestationId", "pollAfterSeconds", "schemaVersion", "status"],
        "Capacity attestor pending response shape is invalid.");
      assert.equal(body.schemaVersion, 1, "Capacity attestor pending schema is invalid.");
      assert.equal(body.status, "pending", "Capacity attestor pending state is invalid.");
      assert.match(body.attestationId ?? "", /^[a-f0-9]{64}$/u, "Capacity attestor id is invalid.");
      assert.ok(Number.isInteger(body.pollAfterSeconds) && body.pollAfterSeconds >= 5 && body.pollAfterSeconds <= 30,
        "Capacity attestor polling interval is invalid.");
      attestationId ??= body.attestationId;
      assert.equal(body.attestationId, attestationId, "Capacity attestor id changed during polling.");
      await new Promise((resolve) => setTimeout(resolve, body.pollAfterSeconds * 1_000));
      continue;
    }
    assert.equal(response.ok, true,
      `Independent capacity attestor returned ${response.status}: ${text.slice(0, 240)}`);
    envelope = body;
    break;
  }
  assert.ok(envelope, "Independent capacity attestor did not complete within the protected polling window.");
  assert.deepEqual(Object.keys(envelope).sort(), ["payload", "signature"],
    "Independent capacity attestor returned an invalid envelope shape.");
  await writeFile(outputPath, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  requestIndependentCapacityAttestation(process.argv[2]).then(() => {
    process.stdout.write("independent transform fleet capacity attestation received\n");
  }).catch((error) => {
    process.stderr.write(`capacity attestation request failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
