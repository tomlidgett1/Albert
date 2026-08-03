import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  DOGFOOD_SEED_OUTCOME_SUITE_CASES,
  buildDogfoodSeedObservedOutcomeEvidence,
} from "../evals/golden/seed-outcome-suite.mjs";
import { seedGoldenQuestions } from "../evals/golden/questions.js";
import {
  DOGFOOD_SEMANTIC_SUITE_CASES,
  DOGFOOD_SEMANTIC_SUITE_DIGEST,
  DOGFOOD_SEMANTIC_SUITE_VERSION,
} from "../evals/golden/dogfood-semantic-suite.mjs";
import {
  dogfoodReferenceKeyId,
  signDogfoodReferencePlan,
  verifyDogfoodReferencePlan,
} from "../scripts/dogfood-reference-plan.mjs";
import {
  FLY_RUNTIME_CONTRACTS,
  platformSha256,
  signSitesPlatformProvenance,
  sitesAccessPolicyDigest,
  sitesEnvironmentBinding,
  validateFlyPlatformProvenance,
  verifySitesPlatformProvenance,
} from "../scripts/platform-provenance.mjs";

const candidateSha = "a".repeat(40);
const deploymentId = "staging-20260804-001";
const imageDigest = `sha256:${"b".repeat(64)}`;

function flyObservation() {
  return {
    schemaVersion: 1,
    kind: "albert.fly-platform-provenance",
    organization: { id: "org_01HZZZZZZZZZZZZZZZZZZZZZZZ", slug: "albert-production", name: "Albert" },
    apps: FLY_RUNTIME_CONTRACTS.map((runtime, runtimeIndex) => {
      const appName = `albert-${runtime.service}`;
      return {
        service: runtime.service,
        exposure: runtime.exposure,
        app: {
          id: `app_${String(runtimeIndex + 1).padStart(2, "0")}`,
          name: appName,
          status: "running",
          hostname: runtime.exposure === "public" ? `${appName}.fly.dev` : null,
          organizationId: "org_01HZZZZZZZZZZZZZZZZZZZZZZZ",
          organizationSlug: "albert-production",
          platformVersion: "machines",
          publicServiceCount: runtime.exposure === "public" ? 1 : 0,
        },
        machines: [0, 1].map((machineIndex) => ({
          id: `${(runtimeIndex + 1).toString(16)}${machineIndex}${"0".repeat(12)}`,
          instanceId: `instance_${runtimeIndex}_${machineIndex}`,
          state: "started",
          region: "syd",
          imageDigest,
          configUpdatedAt: `2026-08-04T01:0${machineIndex}:00.000Z`,
          configDigest: (runtimeIndex + 1).toString(16).repeat(64),
          releaseSha: candidateSha,
          deploymentId,
          runtimeIdentity: runtime.service,
          readinessConfig: { type: "http", path: "/readyz", port: 8_000 + runtimeIndex },
        })),
        checks: [0, 1].map((machineIndex) => ({
          machineId: `${(runtimeIndex + 1).toString(16)}${machineIndex}${"0".repeat(12)}`,
          name: "readiness",
          status: "passing",
        })),
        ips: runtime.exposure === "public"
          ? [{ address: `203.0.113.${runtimeIndex + 1}`, type: "v4" }]
          : [],
        secrets: [
          { name: "CONTROL_PLANE_DATABASE_URL", digest: "c".repeat(64) },
          { name: "TOKEN_ENCRYPTION_KEY", digest: "d".repeat(64) },
        ],
      };
    }),
    observedAt: "2026-08-04T02:00:00.000Z",
  };
}

const flyOptions = { candidateSha, deploymentId, expectedImageDigest: imageDigest };

test("Fly provenance derives all public origins from six exact platform-attested apps", () => {
  const evidence = validateFlyPlatformProvenance(flyObservation(), flyOptions);
  assert.equal(evidence.apps.length, 6);
  assert.equal(evidence.organization.id, "org_01HZZZZZZZZZZZZZZZZZZZZZZZ");
  assert.equal(evidence.imageDigest, imageDigest);
  assert.match(evidence.manifestDigest, /^[a-f0-9]{64}$/u);
  assert.deepEqual(
    evidence.apps.filter(({ exposure }) => exposure === "public").map(({ origin }) => origin),
    [
      "https://albert-operator-diagnostic.fly.dev",
      "https://albert-semantic-query.fly.dev",
      "https://albert-sync-worker.fly.dev",
      "https://albert-webhook-gateway.fly.dev",
    ],
  );
});

test("Fly provenance rejects fake responders and every target-identity substitution", () => {
  const mutations = [
    ["wrong app id", (value) => { value.apps[0].app.id = value.apps[1].app.id; }, /application ids/u],
    ["wrong organization", (value) => { value.apps[0].app.organizationId = "org_attacker"; }, /another organization/u],
    ["wrong machine", (value) => { value.apps[0].machines[0].runtimeIdentity = "sync-worker"; }, /wrong process identity/u],
    ["wrong image", (value) => { value.apps[0].machines[0].imageDigest = `sha256:${"0".repeat(64)}`; }, /one exact immutable image digest/u],
    ["wrong region", (value) => { value.apps[0].machines[0].region = "iad"; }, /outside Sydney/u],
    ["wrong check path", (value) => { value.apps[0].machines[0].readinessConfig.path = "/healthz"; }, /readiness path drifted/u],
    ["failed check", (value) => { value.apps[0].checks[0].status = "critical"; }, /not passing/u],
    ["public private worker", (value) => { value.apps[0].app.publicServiceCount = 1; }, /Fly Proxy service/u],
    ["missing runtime", (value) => { value.apps.pop(); }, /exactly six/u],
    ["self-reported health", (value) => { value.apps[0].reportedHealth = { releaseSha: candidateSha }; }, /shape is invalid/u],
  ];
  for (const [label, mutate, pattern] of mutations) {
    const candidate = flyObservation();
    mutate(candidate);
    assert.throws(() => validateFlyPlatformProvenance(candidate, flyOptions), pattern, label);
  }
  assert.throws(
    () => validateFlyPlatformProvenance(flyObservation(), { ...flyOptions, deploymentId: "substituted" }),
    /wrong deployment id/u,
  );
  assert.throws(
    () => validateFlyPlatformProvenance(flyObservation(), { ...flyOptions, expectedImageDigest: `sha256:${"e".repeat(64)}` }),
    /wrong image digest/u,
  );
});

const sitesKeys = generateKeyPairSync("ed25519");
const sitesPrivateKey = sitesKeys.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url");
const sitesPublicKey = sitesKeys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
const projectId = "appgprj_6a6da1d589608191b95650ffb3aad67f";
const versionId = `${projectId}~appgver_bbd9728e973c8191bfde6216b8945de4`;
const sitesDeploymentId = "appgdep_01HZZZZZZZZZZZZZZZZZZZZZZZ";
const deploymentUrl = "https://albert-chat-019fbc3d.tomlidgett.chatgpt.site";

function sitesBody() {
  const accessPolicy = {
    mode: "custom",
    revision: 7,
    allowedAccountUserIds: ["account-owner-1"],
    allowedGroupIds: [],
    externalVisitorCount: 0,
  };
  const environment = sitesEnvironmentBinding([
    { key: "ALBERT_CONVERSATION_RUNTIME", isSecret: false, value: "live" },
    { key: "OPENAI_API_KEY", isSecret: true, value: null },
  ]);
  return {
    schemaVersion: 1,
    kind: "albert.sites-platform-provenance",
    project: { id: projectId, status: "active" },
    version: {
      id: versionId,
      number: 15,
      sourceCommitSha: candidateSha,
      archiveContentHash: `sha256:${"f".repeat(64)}`,
    },
    deployment: {
      id: sitesDeploymentId,
      providerDeploymentId: "cloudflare-deployment-01",
      status: "succeeded",
      type: "publish",
      versionId,
      url: deploymentUrl,
      environmentRevision: 11,
    },
    accessPolicy: { ...accessPolicy, policyDigest: sitesAccessPolicyDigest(accessPolicy) },
    environment: { revision: 11, ...environment },
    customDomains: [],
    observedAt: "2026-08-04T02:00:00.000Z",
    expiresAt: "2026-08-04T04:00:00.000Z",
  };
}

function sitesExpected(body = sitesBody()) {
  return {
    encodedPublicKey: sitesPublicKey,
    projectId,
    candidateSha,
    deploymentId: sitesDeploymentId,
    deploymentUrl,
    customDomains: [],
    accessMode: body.accessPolicy.mode,
    accessPolicyDigest: body.accessPolicy.policyDigest,
    environmentRevision: body.environment.revision,
    environmentBindingDigest: body.environment.entryBindingDigest,
    now: Date.parse("2026-08-04T02:30:00.000Z"),
  };
}

test("signed Sites provenance binds project, saved source, deployment, URL, policy, domains, and environment revision", () => {
  const body = sitesBody();
  const envelope = signSitesPlatformProvenance(body, sitesPrivateKey);
  const manifest = verifySitesPlatformProvenance(envelope, sitesExpected(body));
  assert.equal(manifest.projectId, projectId);
  assert.equal(manifest.versionId, versionId);
  assert.equal(manifest.sourceCommitSha, candidateSha);
  assert.equal(manifest.deploymentId, sitesDeploymentId);
  assert.equal(manifest.environmentRevision, 11);
  assert.equal(manifest.accessPolicyRevision, 7);
  assert.match(manifest.manifestDigest, /^[a-f0-9]{64}$/u);
});

test("Sites provenance fails closed for absent evidence and every provenance substitution", () => {
  const body = sitesBody();
  const envelope = signSitesPlatformProvenance(body, sitesPrivateKey);
  const expected = sitesExpected(body);
  assert.throws(() => verifySitesPlatformProvenance(undefined, expected), /must be an object/u);
  const substitutions = [
    ["project", { ...expected, projectId: `appgprj_${"0".repeat(32)}` }, /another project/u],
    ["version commit", { ...expected, candidateSha: "0".repeat(40) }, /not the candidate commit/u],
    ["deployment", { ...expected, deploymentId: "appgdep_attacker" }, /another deployment/u],
    ["URL", { ...expected, deploymentUrl: "https://attacker.example" }, /URL differs/u],
    ["access policy", { ...expected, accessPolicyDigest: "0".repeat(64) }, /access policy differs/u],
    ["environment revision", { ...expected, environmentRevision: 12 }, /revision differs/u],
    ["environment binding", { ...expected, environmentBindingDigest: "0".repeat(64) }, /environment binding differs/u],
    ["custom domain", { ...expected, customDomains: ["albert.example"] }, /custom domains differ/u],
  ];
  for (const [label, changed, pattern] of substitutions) {
    assert.throws(() => verifySitesPlatformProvenance(envelope, changed), pattern, label);
  }

  const selfReported = structuredClone(envelope);
  selfReported.provenance.deployment.health = { releaseSha: candidateSha };
  assert.throws(() => verifySitesPlatformProvenance(selfReported, expected), /shape is invalid/u);

  const tampered = structuredClone(envelope);
  tampered.provenance.deployment.url = "https://attacker.example";
  assert.throws(() => verifySitesPlatformProvenance(tampered, { ...expected, deploymentUrl: "https://attacker.example" }),
    /signature is invalid/u);
});

test("Sites secret presence is bound without disclosing its value", () => {
  const first = sitesEnvironmentBinding([{ key: "OPENAI_API_KEY", isSecret: true, value: null }]);
  const second = sitesEnvironmentBinding([{ key: "OPENAI_API_KEY", isSecret: true, value: null }]);
  assert.equal(first.entryBindingDigest, second.entryBindingDigest);
  assert.equal(first.entries[0].valueDigest.includes("OPENAI"), false);
  assert.equal(platformSha256(first.entries), first.entryBindingDigest);
});

function semanticReferencePlan() {
  const questions = new Map(seedGoldenQuestions
    .filter(({ expectedRoute, ir }) => expectedRoute === "semantic" && ir)
    .map((question) => [question.id, question]));
  return {
    suiteVersion: DOGFOOD_SEMANTIC_SUITE_VERSION,
    suiteDigest: DOGFOOD_SEMANTIC_SUITE_DIGEST,
    cases: DOGFOOD_SEMANTIC_SUITE_CASES.map((entry) => {
      const question = questions.get(entry.caseId);
      assert.ok(question?.ir);
      return {
        caseId: entry.caseId,
        queries: entry.queries.map(({ queryId }) => ({
          queryId,
          expectedResultDigest: "1".repeat(64),
          input: structuredClone(queryId === "primary" ? question.ir : question.comparisonIr),
        })),
      };
    }),
  };
}

function observedSeedOutcomes() {
  return buildDogfoodSeedObservedOutcomeEvidence(DOGFOOD_SEED_OUTCOME_SUITE_CASES.map((entry) => ({
    observedRoute: entry.expectedRoute,
    observedState: entry.expectedState,
    observedOutcomeDigest: entry.requiredOutcomeDigest,
    passed: true,
  })));
}

const referenceKeys = generateKeyPairSync("ed25519");
const referencePrivateKey = referenceKeys.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url");
const referencePublicKey = referenceKeys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");

function signedReferencePlan() {
  return signDogfoodReferencePlan({
    candidateSha,
    semanticPlan: semanticReferencePlan(),
    seedOutcomeEvidence: observedSeedOutcomes(),
    issuedAt: "2026-08-04T02:00:00.000Z",
    expiresAt: "2026-08-04T04:00:00.000Z",
  }, referencePrivateKey);
}

test("separate signed reference authority binds semantic expected results and all 25 seed outcomes", () => {
  const result = verifyDogfoodReferencePlan(signedReferencePlan(), {
    encodedPublicKey: referencePublicKey,
    candidateSha,
    forbiddenDogfoodSignerKeyId: "ed25519:not-the-reference-key",
    now: Date.parse("2026-08-04T02:30:00.000Z"),
  });
  assert.equal(result.semanticPlan.cases.length, 20);
  assert.equal(result.seedOutcomeManifest.cases.length, 25);
  assert.equal(result.seedOutcomeEvidence.cases.length, 25);
  assert.match(result.semanticPlanDigest, /^[a-f0-9]{64}$/u);
  assert.match(result.seedOutcomeManifestDigest, /^[a-f0-9]{64}$/u);
  assert.match(result.seedOutcomeEvidenceDigest, /^[a-f0-9]{64}$/u);
});

test("reference authority rejects plan, digest, outcome, candidate, signer, and missing-case substitution", () => {
  const envelope = signedReferencePlan();
  const expected = {
    encodedPublicKey: referencePublicKey,
    candidateSha,
    forbiddenDogfoodSignerKeyId: "ed25519:not-the-reference-key",
    now: Date.parse("2026-08-04T02:30:00.000Z"),
  };
  const mutations = [
    ["expected result", (value) => { value.plan.semanticPlan.cases[0].queries[0].expectedResultDigest = "2".repeat(64); }, /digest is inconsistent/u],
    ["semantic digest", (value) => { value.plan.semanticPlanDigest = "0".repeat(64); }, /digest is inconsistent/u],
    ["outcome", (value) => { value.plan.seedOutcomeEvidence.cases[0].observedState = "qualified"; }, /did not satisfy/u],
    ["missing outcome", (value) => { value.plan.seedOutcomeEvidence.cases.pop(); }, /exactly 25/u],
  ];
  for (const [label, mutate, pattern] of mutations) {
    const candidate = structuredClone(envelope);
    mutate(candidate);
    assert.throws(() => verifyDogfoodReferencePlan(candidate, expected), pattern, label);
  }
  assert.throws(() => verifyDogfoodReferencePlan(envelope, { ...expected, candidateSha: "0".repeat(40) }),
    /another candidate/u);
  assert.throws(() => verifyDogfoodReferencePlan(envelope, {
    ...expected,
    forbiddenDogfoodSignerKeyId: dogfoodReferenceKeyId(referenceKeys.publicKey),
  }), /separate from the acceptance signer/u);
});
