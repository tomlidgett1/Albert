import assert from "node:assert/strict";
import { generateKeyPairSync, sign as signBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DOGFOOD_SEED_OUTCOME_SUITE_CASES,
  DOGFOOD_SEED_OUTCOME_SUITE_DIGEST,
  DOGFOOD_SEED_OUTCOME_SUITE_VERSION,
  buildDogfoodSeedObservedOutcomeEvidence,
  buildDogfoodSeedOutcomeManifestEvidence,
} from "../../evals/golden/seed-outcome-suite.mjs";
import {
  computeEvidenceDigest,
  computeDogfoodM5EvidenceDigest,
  dogfoodSemanticPlanSchema,
  hmacReference,
  sha256,
  signDogfoodAcceptance,
  stableJson,
  verifyDogfoodAcceptance,
} from "../../scripts/dogfood-acceptance-attestation.mjs";
import {
  validatePrivateFlyEvidence,
  validateRuntimePlan,
} from "../../scripts/collect-dogfood-acceptance.mjs";
import { platformSha256 } from "../../scripts/platform-provenance.mjs";
import {
  DOGFOOD_SEMANTIC_SUITE_CASES,
  DOGFOOD_SEMANTIC_SUITE_DIGEST,
  DOGFOOD_SEMANTIC_SUITE_VERSION,
  dogfoodSemanticCollectionAnchor,
  dogfoodSemanticInputContractDigest,
  validateDogfoodSemanticPlanAtCollectionAnchor,
} from "../../evals/golden/dogfood-semantic-suite.mjs";
import { seedGoldenQuestions } from "../../evals/golden/questions.js";
import { FIXTURE_NOW, retailFixtureRows } from "../../evals/fixtures/retail.js";

const candidateSha = "a".repeat(40);
const digest = (character: string) => character.repeat(64);
const repository = "tomlidgett1/Albert";
const workflowRef = "refs/tags/dogfood-attestor-v1";
const toolingSha = "b".repeat(40);
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const privateKeyBase64Url = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url");
const publicKeyBase64Url = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
const zeroResiduals = {
  rawObjects: 0, stagingRows: 0, canonicalRows: 0, bridgeRows: 0,
  linkRows: 0, embeddingRows: 0, cacheRows: 0, otherAnalyticalRows: 0,
  controlRows: 0, derivedArtifacts: 0, queueMessages: 0,
  credentialReferences: 0, credentialEnvelopes: 0, sessionEnvelopes: 0,
};

type SemanticInput = Record<string, unknown>;
type PeriodContract = Readonly<{
  path: readonly (string | number)[];
  boundaryTimezone: string;
  boundaryTime: string;
  shape: string;
  anchorPolicy: string;
  days?: number;
  months?: number;
  startWeekday?: number;
}>;
type SemanticSuiteQuery = Readonly<{
  queryId: "primary" | "comparison";
  rowRequirement: "nonempty" | "allow-empty";
  periods: readonly PeriodContract[];
  inputContractDigest: string;
}>;
type SemanticSuiteCase = Readonly<{
  caseId: string;
  kind: "golden" | "composite";
  expectedState: "verified" | "qualified";
  queries: readonly SemanticSuiteQuery[];
  rangeRelations: readonly Readonly<Record<string, unknown>>[];
}>;
type ProtectedSemanticQuery = {
  queryId: "primary" | "comparison";
  expectedResultDigest: string;
  input: SemanticInput;
};
type ProtectedSemanticPlan = {
  suiteVersion: string;
  suiteDigest: string;
  cases: Array<{ caseId: string; queries: ProtectedSemanticQuery[] }>;
};

const semanticSuiteCases = DOGFOOD_SEMANTIC_SUITE_CASES as readonly SemanticSuiteCase[];

function validM5Cases() {
  return semanticSuiteCases.map((entry, caseIndex) => ({
    caseId: entry.caseId,
    kind: entry.kind,
    answerState: entry.expectedState,
    queries: entry.queries.map((query, queryIndex) => ({
      queryId: query.queryId,
      rowRequirement: query.rowRequirement,
      rowCount: caseIndex + queryIndex + 1,
      resultDigest: digest("e"),
      bundleHash: digest("f"),
    })),
  }));
}

function validProtectedSemanticPlan(): ProtectedSemanticPlan {
  const executableQuestions = new Map(seedGoldenQuestions
    .filter((question) => question.expectedRoute === "semantic" && question.ir)
    .map((question) => [question.id, question]));
  return {
    suiteVersion: DOGFOOD_SEMANTIC_SUITE_VERSION,
    suiteDigest: DOGFOOD_SEMANTIC_SUITE_DIGEST,
    cases: semanticSuiteCases.map((entry) => {
      const question = executableQuestions.get(entry.caseId);
      assert.ok(question?.ir, `Missing executable seed question ${entry.caseId}.`);
      return {
        caseId: entry.caseId,
        queries: entry.queries.map((query) => ({
          queryId: query.queryId,
          expectedResultDigest: digest("d"),
          input: structuredClone(
            query.queryId === "primary" ? question.ir : question.comparisonIr,
          ) as SemanticInput,
        })),
      };
    }),
  };
}

type DateParts = { year: number; month: number; day: number };
type AbsoluteRange = { type: "absolute"; from: string; to: string };

function collectionAnchoredPlan(anchor: string): ProtectedSemanticPlan {
  const plan = validProtectedSemanticPlan();
  const anchorDate = parseDateParts(anchor);
  for (const [caseIndex, entry] of semanticSuiteCases.entries()) {
    for (const [queryIndex, queryContract] of entry.queries.entries()) {
      const query = plan.cases[caseIndex].queries[queryIndex];
      for (const periodContract of queryContract.periods) {
        const range = testAnchoredRange(periodContract, anchorDate);
        if (range) setPath(query.input, periodContract.path, range);
      }
    }
    const relations = entry.rangeRelations as ReadonlyArray<{
      relation: string;
      months?: number;
      source: { queryId: string; path: readonly (string | number)[] };
      target: { queryId: string; path: readonly (string | number)[] };
    }>;
    for (const relation of relations) {
      if (relation.relation !== "calendar-shift") continue;
      const sourceQuery = plan.cases[caseIndex].queries.find(({ queryId }) => queryId === relation.source.queryId);
      const targetQuery = plan.cases[caseIndex].queries.find(({ queryId }) => queryId === relation.target.queryId);
      assert.ok(sourceQuery && targetQuery && relation.months !== undefined);
      const source = getPath(sourceQuery.input, relation.source.path) as AbsoluteRange;
      setPath(targetQuery.input, relation.target.path, {
        type: "absolute",
        from: shiftIsoMonths(source.from, relation.months),
        to: shiftIsoMonths(source.to, relation.months),
      });
    }
  }
  return plan;
}

function testAnchoredRange(contract: PeriodContract, anchor: DateParts): AbsoluteRange | undefined {
  if (contract.anchorPolicy === "primary-calendar-shift") return undefined;
  const included = addDays(anchor, -1);
  let from: DateParts;
  let to: DateParts;
  if (contract.anchorPolicy === "collection") {
    to = anchor;
    if (contract.shape === "month-to-date") {
      from = { year: included.year, month: included.month, day: 1 };
    } else if (contract.shape === "quarter-to-date") {
      from = { year: included.year, month: Math.floor((included.month - 1) / 3) * 3 + 1, day: 1 };
    } else if (contract.shape === "year-to-date") {
      from = { year: included.year, month: 1, day: 1 };
    } else if (contract.shape === "rolling-days" || contract.shape === "minimum-history-days") {
      assert.ok(contract.days);
      from = addDays(anchor, -contract.days);
    } else {
      assert.equal(contract.shape, "rolling-calendar-months-inclusive");
      assert.ok(contract.months);
      from = addDays(addMonths(anchor, -contract.months), -1);
    }
  } else if (contract.anchorPolicy === "previous-calendar-month") {
    const currentMonthStart = { year: included.year, month: included.month, day: 1 };
    from = addMonths(currentMonthStart, -1);
    to = currentMonthStart;
  } else if (contract.anchorPolicy === "previous-complete-week") {
    assert.ok(contract.startWeekday !== undefined);
    const currentWeekStart = addDays(included, -((weekday(included) - contract.startWeekday + 7) % 7));
    from = addDays(currentWeekStart, -7);
    to = currentWeekStart;
  } else if (contract.anchorPolicy === "previous-calendar-day") {
    from = addDays(anchor, -2);
    to = addDays(anchor, -1);
  } else {
    assert.equal(contract.anchorPolicy, "most-recent-weekday");
    assert.ok(contract.startWeekday !== undefined);
    from = addDays(included, -((weekday(included) - contract.startWeekday + 7) % 7));
    to = addDays(from, 1);
  }
  return {
    type: "absolute",
    from: `${formatDate(from)}T00:00:00.000Z`,
    to: `${formatDate(to)}T00:00:00.000Z`,
  };
}

function getPath(value: SemanticInput, path: readonly (string | number)[]): unknown {
  return path.reduce<unknown>((current, segment) => (
    (current as Record<string | number, unknown>)[segment]
  ), value);
}

function setPath(value: SemanticInput, path: readonly (string | number)[], replacement: unknown) {
  let current: unknown = value;
  for (const segment of path.slice(0, -1)) {
    current = (current as Record<string | number, unknown>)[segment];
  }
  (current as Record<string | number, unknown>)[path.at(-1) as string | number] = replacement;
}

function parseDateParts(value: string): DateParts {
  const date = new Date(value);
  assert.ok(Number.isFinite(date.getTime()));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function addDays(value: DateParts, days: number): DateParts {
  const date = new Date(Date.UTC(value.year, value.month - 1, value.day + days));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function addMonths(value: DateParts, months: number): DateParts {
  const monthIndex = value.year * 12 + value.month - 1 + months;
  const year = Math.floor(monthIndex / 12);
  const month = ((monthIndex % 12) + 12) % 12 + 1;
  const day = Math.min(value.day, new Date(Date.UTC(year, month, 0)).getUTCDate());
  return { year, month, day };
}

function weekday(value: DateParts): number {
  return new Date(Date.UTC(value.year, value.month - 1, value.day)).getUTCDay();
}

function shiftIsoMonths(value: string, months: number): string {
  return `${formatDate(addMonths(parseDateParts(value), months))}T00:00:00.000Z`;
}

function formatDate(value: DateParts): string {
  return `${String(value.year).padStart(4, "0")}-${String(value.month).padStart(2, "0")}-${String(value.day).padStart(2, "0")}`;
}

function proof(seed: string) {
  return {
    subjectRef: digest(seed),
    proofDigest: digest(seed),
    completedAt: "2026-08-03T00:20:00.000Z",
    providerGenerationsDigest: digest(seed),
    remoteRevocationVerified: true as const,
    storesVerified: true as const,
    residuals: zeroResiduals,
  };
}

function validSeedOutcomes() {
  return buildDogfoodSeedObservedOutcomeEvidence(DOGFOOD_SEED_OUTCOME_SUITE_CASES.map((entry: Readonly<{
    expectedRoute: string;
    expectedState: string;
    requiredOutcomeDigest: string;
  }>) => ({
    observedRoute: entry.expectedRoute,
    observedState: entry.expectedState,
    observedOutcomeDigest: entry.requiredOutcomeDigest,
    passed: true,
  })));
}

function validRuntimeProvenance() {
  const deploymentId = "staging-20260803-001";
  const flyWithoutDigest = {
    organization: { id: "org_01HZZZZZZZZZZZZZZZZZZZZZZZ", slug: "albert-production", name: "Albert" },
    candidateSha,
    deploymentId,
    imageDigest: `sha256:${digest("e")}`,
    observedAt: "2026-08-03T00:25:00.000Z",
    apps: [
      ["deletion-worker", "private"],
      ["operator-diagnostic", "public"],
      ["semantic-query", "public"],
      ["sync-worker", "public"],
      ["transform-worker", "private"],
      ["webhook-gateway", "public"],
    ].map(([service, exposure], index) => ({
      service,
      exposure,
      appId: `app_${index}`,
      appName: `albert-${service}`,
      origin: exposure === "public" ? `https://albert-${service}.fly.dev` : null,
      platformVersion: "deployed",
      machineIds: [`${index + 1}0${"0".repeat(12)}`, `${index + 1}1${"0".repeat(12)}`],
      machineConfigDigest: digest("c"),
      secretSetDigest: digest("d"),
    })),
  };
  const sitesWithoutDigest = {
    projectId: "appgprj_6a6da1d589608191b95650ffb3aad67f",
    versionId: "appgprj_6a6da1d589608191b95650ffb3aad67f~appgver_bbd9728e973c8191bfde6216b8945de4",
    versionNumber: 15,
    sourceCommitSha: candidateSha,
    archiveContentHash: `sha256:${digest("f")}`,
    deploymentId: "appgdep_01HZZZZZZZZZZZZZZZZZZZZZZZ",
    providerDeploymentId: "cloudflare-deployment-01",
    deploymentUrl: "https://albert-chat-019fbc3d.tomlidgett.chatgpt.site",
    environmentRevision: 11,
    environmentBindingDigest: digest("1"),
    accessMode: "custom",
    accessPolicyRevision: 7,
    accessPolicyDigest: digest("2"),
    customDomains: [],
    observedAt: "2026-08-03T00:25:00.000Z",
  };
  const fly = { ...flyWithoutDigest, manifestDigest: platformSha256(flyWithoutDigest) };
  const sites = { ...sitesWithoutDigest, manifestDigest: platformSha256(sitesWithoutDigest) };
  return { fly, sites, identityDigest: platformSha256({ fly, sites }) };
}

function validBody() {
  const runtimeProvenance = validRuntimeProvenance();
  const seedOutcomeManifest = buildDogfoodSeedOutcomeManifestEvidence();
  const seedOutcomeEvidence = validSeedOutcomes();
  const body = {
    schemaVersion: 4,
    kind: "albert.protected-dogfood-acceptance",
    attestationId: "01K2ZZZZZZ0000000000000001",
    candidateSha,
    sourceEnvironment: "staging",
    targetEnvironment: "production",
    repository,
    workflow: {
      file: "dogfood-acceptance.yml",
      runId: "123456789",
      runAttempt: 1,
      actorId: "42",
      ref: workflowRef,
      toolingSha,
    },
    issuedAt: "2026-08-03T00:30:00.000Z",
    expiresAt: "2026-08-03T02:30:00.000Z",
    nonceDigest: digest("1"),
    controlSnapshotDigest: digest("2"),
    subjects: {
      dogfoodTenantRef: digest("3"),
      onboardingTenantRef: digest("4"),
      deletionTenantRef: digest("5"),
    },
    runtimes: {
      checkedCount: 7,
      requiredServices: [
        "deletion-worker", "operator-diagnostic", "semantic-query", "sync-worker",
        "transform-worker", "web", "webhook-gateway",
      ] as const,
      deploymentId: "staging-20260803-001",
      barrierAt: "2026-08-03T00:00:00.000Z",
      identityDigest: runtimeProvenance.identityDigest,
      fly: runtimeProvenance.fly,
      sites: runtimeProvenance.sites,
    },
    connectionGenerations: [
      { connector: "deputy", connectionRef: digest("7"), generation: 1 },
      { connector: "lightspeed-r", connectionRef: digest("8"), generation: 2 },
      { connector: "xero", connectionRef: digest("9"), generation: 3 },
    ],
    milestones: {
      m3: {
        passed: true, streamCount: 30, liveRecordedStreams: 30,
        backfillCompleteStreams: 30, reconciledStreams: 30,
        qualityCheckCount: 14, evidenceDigest: digest("a"),
      },
      m4: {
        passed: true, invariantCount: 14, identitySuggestionCount: 1,
        xeroPostingBridgeVerified: true, evidenceDigest: digest("b"),
      },
      m5: {
        passed: true,
        suiteVersion: DOGFOOD_SEMANTIC_SUITE_VERSION,
        suiteDigest: DOGFOOD_SEMANTIC_SUITE_DIGEST,
        caseCount: semanticSuiteCases.length,
        collectionAnchor: "2026-08-04T00:00:00.000Z",
        planDigest: digest("c"),
        referencePlanDigest: digest("d"),
        referenceSignerKeyId: `ed25519:${digest("e")}`,
        seedOutcomeSuiteVersion: DOGFOOD_SEED_OUTCOME_SUITE_VERSION,
        seedOutcomeSuiteDigest: DOGFOOD_SEED_OUTCOME_SUITE_DIGEST,
        seedOutcomeCaseCount: DOGFOOD_SEED_OUTCOME_SUITE_CASES.length,
        seedOutcomeManifestDigest: sha256(seedOutcomeManifest),
        seedOutcomeEvidenceDigest: sha256(seedOutcomeEvidence),
        seedOutcomes: seedOutcomeEvidence.cases,
        cases: validM5Cases(),
        evidenceDigest: digest("d"),
      },
      m6: {
        passed: true,
        flagship: {
          artifactDigest: digest("2"), traceDigest: digest("3"), answerState: "verified",
          queryCount: 2, provenanceComplete: true, sequentialNarrative: true,
          contractVersion: 1, caseContractDigest: digest("0"), questionDigest: digest("1"),
          semanticPlanDigest: digest("2"), traceContractDigest: digest("3"),
          provenanceDigest: digest("4"), lineageBindingDigest: digest("5"),
        },
        category: {
          artifactDigest: digest("4"), traceDigest: digest("5"), answerState: "qualified",
          queryCount: 1, provenanceComplete: true, sequentialNarrative: true, chartPresent: true,
          contractVersion: 1, caseContractDigest: digest("6"), questionDigest: digest("7"),
          semanticPlanDigest: digest("8"), traceContractDigest: digest("9"),
          provenanceDigest: digest("a"), lineageBindingDigest: digest("b"),
        },
        evidenceDigest: digest("6"),
      },
      m7: {
        passed: true,
        journeyRef: digest("0"),
        journeyIssuedAt: "2026-08-03T00:01:00.000Z",
        claimedAt: "2026-08-03T00:03:00.000Z",
        browserReceiptAt: "2026-08-03T00:05:00.000Z",
        onboardingMinutes: 18.5,
        targetMinutes: 30,
        readyPartialDomainCount: 4,
        readinessBindingDigest: digest("1"),
        liveVendorAttestationConsumptionRef: digest("2"),
        liveVendorAttestationEvidenceDigest: digest("3"),
        liveVendorAttestationProviderCount: 3,
        controlEvidenceDigest: digest("4"),
        blockingAnswerCount: 4,
        blockingQuestionContractDigest: digest("5"),
        blockingResponseDigest: digest("6"),
        overlayDigest: digest("7"),
        oauthConnectionCount: 3,
        claimDigest: digest("8"),
        browserReceiptDigest: digest("9"),
        authAuditProofDigest: digest("a"),
        oauthBindingDigest: digest("b"),
        journeyBindingDigest: digest("c"),
        evidenceDigest: digest("d"),
      },
      m8: {
        passed: true,
        disconnect: { ...proof("9"), provider: "xero", connectionGeneration: 4 },
        tenantDeletion: proof("a"),
        evidenceDigest: digest("b"),
      },
    },
    evidenceDigest: digest("c"),
  };
  body.milestones.m5.evidenceDigest = computeDogfoodM5EvidenceDigest(body.milestones.m5);
  const m7Content: Record<string, unknown> = { ...body.milestones.m7 };
  delete m7Content.evidenceDigest;
  body.milestones.m7.evidenceDigest = sha256(m7Content);
  return body;
}

const expected = {
  candidateSha,
  repository,
  targetEnvironment: "production",
  expectedWorkflowRef: workflowRef,
  expectedToolingSha: toolingSha,
  encodedPublicKey: publicKeyBase64Url,
  now: Date.parse("2026-08-03T00:40:00.000Z"),
};

test("Ed25519 dogfood evidence binds live milestones to the candidate and protected ref", () => {
  const envelope = signDogfoodAcceptance(validBody(), privateKeyBase64Url);
  const result = verifyDogfoodAcceptance(envelope, expected);
  assert.equal(result.candidateSha, candidateSha);
  assert.equal(result.attestationId, "01K2ZZZZZZ0000000000000001");
  assert.equal(result.controlSnapshotDigest, digest("2"));
});

test("signed M6 evidence requires the exact lineage fields and case cardinalities", () => {
  const missingLineage = validBody();
  delete (missingLineage.milestones.m6.flagship as unknown as Record<string, unknown>)
    .lineageBindingDigest;
  assert.throws(() => signDogfoodAcceptance(missingLineage, privateKeyBase64Url));

  const extraFlagshipQuery = validBody();
  extraFlagshipQuery.milestones.m6.flagship.queryCount = 3;
  assert.throws(() => signDogfoodAcceptance(extraFlagshipQuery, privateKeyBase64Url));

  const chartlessCategory = validBody();
  chartlessCategory.milestones.m6.category.chartPresent = false;
  assert.throws(() => signDogfoodAcceptance(chartlessCategory, privateKeyBase64Url));
});

test("the protected M5 registry is exactly the executable V1 semantic seed suite", () => {
  const executableQuestions = seedGoldenQuestions
    .filter((question) => question.expectedRoute === "semantic" && question.ir);
  const executableSeedCases = executableQuestions.map((question) => ({
    caseId: question.id,
    kind: (question.ir as { kind?: string }).kind === "composite" ? "composite" : "golden",
    expectedState: question.expectedState,
    queryIds: question.comparisonIr ? ["primary", "comparison"] : ["primary"],
  }));
  const registryCases = semanticSuiteCases.map((entry) => ({
    caseId: entry.caseId,
    kind: entry.kind,
    expectedState: entry.expectedState,
    queryIds: entry.queries.map(({ queryId }) => queryId),
  }));

  assert.equal(executableSeedCases.length, 20);
  assert.deepEqual(executableSeedCases, registryCases);
  assert.equal(semanticSuiteCases.flatMap(({ queries }) => queries).length, 21);
  assert.equal(semanticSuiteCases.filter(({ kind }) => kind === "golden").length, 16);
  assert.equal(semanticSuiteCases.filter(({ kind }) => kind === "composite").length, 4);
  for (const entry of semanticSuiteCases) {
    const question = executableQuestions.find(({ id }) => id === entry.caseId);
    assert.ok(question?.ir, `Missing executable seed question ${entry.caseId}.`);
    for (const query of entry.queries) {
      const input: unknown = query.queryId === "primary" ? question.ir : question.comparisonIr;
      assert.ok(input, `Missing ${entry.caseId}/${query.queryId} seed input.`);
      assert.equal(
        dogfoodSemanticInputContractDigest(input, query.periods),
        query.inputContractDigest,
        `${entry.caseId}/${query.queryId} input contract drifted.`,
      );
    }
  }
  assert.match(DOGFOOD_SEMANTIC_SUITE_VERSION, /^albert-v1-m5-semantic-suite@[1-9][0-9]*$/u);
  assert.match(DOGFOOD_SEMANTIC_SUITE_DIGEST, /^[a-f0-9]{64}$/u);
});

test("protected semantic inputs can only fill the exact reviewed suite", () => {
  const validPlan = validProtectedSemanticPlan();
  const parsed = dogfoodSemanticPlanSchema.parse(validPlan);
  assert.equal(parsed.suiteVersion, DOGFOOD_SEMANTIC_SUITE_VERSION);
  assert.equal(parsed.suiteDigest, DOGFOOD_SEMANTIC_SUITE_DIGEST);
  assert.deepEqual(
    parsed.cases.map((item: {
      caseId: string;
      kind: string;
      expectedState: string;
      queries: Array<{ queryId: string; rowRequirement: string; inputContractDigest: string }>;
    }) => ({
      caseId: item.caseId,
      kind: item.kind,
      expectedState: item.expectedState,
      queries: item.queries.map(({ queryId, rowRequirement, inputContractDigest }) => ({
        queryId, rowRequirement, inputContractDigest,
      })),
    })),
    semanticSuiteCases.map((entry) => ({
      caseId: entry.caseId,
      kind: entry.kind,
      expectedState: entry.expectedState,
      queries: entry.queries.map(({ queryId, rowRequirement, inputContractDigest }) => ({
        queryId, rowRequirement, inputContractDigest,
      })),
    })),
  );

  const arbitraryCase = structuredClone(validPlan);
  arbitraryCase.cases[0].caseId = "operator-selected-case";
  assert.throws(() => dogfoodSemanticPlanSchema.parse(arbitraryCase));

  const missingCase = structuredClone(validPlan);
  missingCase.cases.pop();
  assert.throws(() => dogfoodSemanticPlanSchema.parse(missingCase));

  const reorderedCases = structuredClone(validPlan);
  [reorderedCases.cases[0], reorderedCases.cases[1]] = [reorderedCases.cases[1], reorderedCases.cases[0]];
  assert.throws(() => dogfoodSemanticPlanSchema.parse(reorderedCases));

  const secretOwnedKind = structuredClone(validPlan) as typeof validPlan & { cases: Array<Record<string, unknown>> };
  secretOwnedKind.cases[0].kind = "golden";
  assert.throws(() => dogfoodSemanticPlanSchema.parse(secretOwnedKind));

  assert.throws(() => dogfoodSemanticPlanSchema.parse({ ...validPlan, suiteVersion: "operator-suite@99" }));
  assert.throws(() => dogfoodSemanticPlanSchema.parse({ ...validPlan, suiteDigest: digest("0") }));

  const wrongCompositeShape = structuredClone(validPlan);
  const compositeIndex = semanticSuiteCases.findIndex(({ kind }) => kind === "composite");
  wrongCompositeShape.cases[compositeIndex].queries[0].input = { topic: "not_a_composite" };
  assert.throws(() => dogfoodSemanticPlanSchema.parse(wrongCompositeShape), /reviewed composite IR shape/u);

  const wrongGoldenShape = structuredClone(validPlan);
  wrongGoldenShape.cases[0].queries[0].input = { kind: "composite", topic: "not_a_golden" };
  assert.throws(() => dogfoodSemanticPlanSchema.parse(wrongGoldenShape), /reviewed golden IR shape/u);

  const relabelledGolden = structuredClone(validPlan);
  relabelledGolden.cases[0].queries[0].input = structuredClone(validPlan.cases[1].queries[0].input);
  assert.throws(() => dogfoodSemanticPlanSchema.parse(relabelledGolden), /reviewed semantic input contract/u);

  const currentLiveDates = structuredClone(validPlan);
  const currentRange = (currentLiveDates.cases[0].queries[0].input as {
    time: { range: { from: string; to: string } };
  }).time.range;
  currentRange.from = "2026-08-01T00:00:00.000Z";
  currentRange.to = "2026-08-04T00:00:00.000Z";
  assert.doesNotThrow(() => dogfoodSemanticPlanSchema.parse(currentLiveDates));

  const shortenedMonth = structuredClone(currentLiveDates);
  (shortenedMonth.cases[0].queries[0].input as {
    time: { range: { from: string } };
  }).time.range.from = "2026-08-02T00:00:00.000Z";
  assert.throws(() => dogfoodSemanticPlanSchema.parse(shortenedMonth), /start on day one/u);

  const shortenedRollingWindow = structuredClone(validPlan);
  const inventoryOutIndex = semanticSuiteCases.findIndex(({ caseId }) => caseId === "inventory-out");
  const inventoryRange = (shortenedRollingWindow.cases[inventoryOutIndex].queries[0].input as {
    time: { range: { from: string; to: string } };
  }).time.range;
  inventoryRange.from = "2026-03-14T00:00:00.000Z";
  inventoryRange.to = "2026-03-16T00:00:00.000Z";
  assert.throws(() => dogfoodSemanticPlanSchema.parse(shortenedRollingWindow), /wrong calendar duration/u);

  const missingComparison = structuredClone(validPlan);
  const refundIndex = semanticSuiteCases.findIndex(({ caseId }) => caseId === "sales-refund-rate");
  missingComparison.cases[refundIndex].queries.pop();
  assert.throws(() => dogfoodSemanticPlanSchema.parse(missingComparison));

  const misalignedComparison = structuredClone(validPlan);
  const comparisonRange = (misalignedComparison.cases[refundIndex].queries[1].input as {
    time: { range: { from: string; to: string } };
  }).time.range;
  comparisonRange.from = "2025-07-01T00:00:00.000Z";
  comparisonRange.to = "2025-09-16T00:00:00.000Z";
  assert.throws(() => dogfoodSemanticPlanSchema.parse(misalignedComparison), /not calendar-aligned/u);

  const misalignedComposite = structuredClone(validPlan);
  const labourIndex = semanticSuiteCases.findIndex(({ caseId }) => caseId === "workforce-labour-percent");
  const labourInput = misalignedComposite.cases[labourIndex].queries[0].input as {
    queries: Array<{ time: { range: { type: string; from: string; to: string } } }>;
  };
  labourInput.queries[1].time.range = {
    type: "absolute",
    from: "2026-04-01T00:00:00.000Z",
    to: "2026-05-01T00:00:00.000Z",
  };
  assert.throws(() => dogfoodSemanticPlanSchema.parse(misalignedComposite), /must align are different/u);
});

test("trusted collection anchor rejects shortened or historical dynamic periods", () => {
  const anchor = dogfoodSemanticCollectionAnchor("2026-08-04T10:30:00.000Z");
  assert.equal(anchor, "2026-08-05T00:00:00.000Z");
  assert.ok(semanticSuiteCases.every(({ queries }) => queries.every(({ periods }) => (
    periods.every(({ anchorPolicy }) => anchorPolicy.length > 0)
  ))));

  const validPlan = collectionAnchoredPlan(anchor);
  const parsed = dogfoodSemanticPlanSchema.parse(validPlan);
  assert.equal(validateDogfoodSemanticPlanAtCollectionAnchor(parsed, anchor), true);

  const rejectsAnchor = (plan: ProtectedSemanticPlan) => {
    const shapeValidPlan = dogfoodSemanticPlanSchema.parse(plan);
    assert.throws(
      () => validateDogfoodSemanticPlanAtCollectionAnchor(shapeValidPlan, anchor),
      /stale|shortened/u,
    );
  };
  const replacePrimaryRange = (plan: ProtectedSemanticPlan, caseId: string, range: AbsoluteRange) => {
    const caseIndex = semanticSuiteCases.findIndex((entry) => entry.caseId === caseId);
    setPath(plan.cases[caseIndex].queries[0].input, ["time", "range"], range);
  };

  const shortMonth = structuredClone(validPlan);
  replacePrimaryRange(shortMonth, "sales-month-vs-last", {
    type: "absolute",
    from: "2026-08-01T00:00:00.000Z",
    to: "2026-08-02T00:00:00.000Z",
  });
  rejectsAnchor(shortMonth);

  const shortQuarter = structuredClone(validPlan);
  replacePrimaryRange(shortQuarter, "sales-products-margin", {
    type: "absolute",
    from: "2026-07-01T00:00:00.000Z",
    to: "2026-07-02T00:00:00.000Z",
  });
  rejectsAnchor(shortQuarter);

  const shortYear = structuredClone(validPlan);
  replacePrimaryRange(shortYear, "customers-repeat", {
    type: "absolute",
    from: "2026-01-01T00:00:00.000Z",
    to: "2026-01-02T00:00:00.000Z",
  });
  rejectsAnchor(shortYear);

  const staleRollingDays = structuredClone(validPlan);
  replacePrimaryRange(staleRollingDays, "inventory-out", {
    type: "absolute",
    from: "2026-07-05T00:00:00.000Z",
    to: "2026-08-04T00:00:00.000Z",
  });
  rejectsAnchor(staleRollingDays);

  const staleRollingMonths = structuredClone(validPlan);
  replacePrimaryRange(staleRollingMonths, "sales-aov-trend", {
    type: "absolute",
    from: "2026-02-03T00:00:00.000Z",
    to: "2026-08-04T00:00:00.000Z",
  });
  rejectsAnchor(staleRollingMonths);

  const staleFullMonth = structuredClone(validPlan);
  replacePrimaryRange(staleFullMonth, "sales-discount-location", {
    type: "absolute",
    from: "2026-06-01T00:00:00.000Z",
    to: "2026-07-01T00:00:00.000Z",
  });
  rejectsAnchor(staleFullMonth);

  const staleHistory = structuredClone(validPlan);
  const staleHistoryTo = addDays(parseDateParts(anchor), -1);
  replacePrimaryRange(staleHistory, "customers-lapsed", {
    type: "absolute",
    from: `${formatDate(addDays(staleHistoryTo, -180))}T00:00:00.000Z`,
    to: `${formatDate(staleHistoryTo)}T00:00:00.000Z`,
  });
  rejectsAnchor(staleHistory);

  const staleWeek = structuredClone(validPlan);
  replacePrimaryRange(staleWeek, "workforce-roster-vs-worked", {
    type: "absolute",
    from: "2026-07-19T00:00:00.000Z",
    to: "2026-07-26T00:00:00.000Z",
  });
  rejectsAnchor(staleWeek);

  for (const [caseId, from, to] of [
    ["finance-cash-pos", "2026-07-31T00:00:00.000Z", "2026-08-01T00:00:00.000Z"],
    ["reconcile-bank", "2026-07-28T00:00:00.000Z", "2026-07-29T00:00:00.000Z"],
  ] as const) {
    const staleDay = structuredClone(validPlan);
    const caseIndex = semanticSuiteCases.findIndex((entry) => entry.caseId === caseId);
    const input = staleDay.cases[caseIndex].queries[0].input;
    for (const path of semanticSuiteCases[caseIndex].queries[0].periods.map(({ path }) => path)) {
      setPath(input, path, { type: "absolute", from, to });
    }
    rejectsAnchor(staleDay);
  }
});

test("collection anchor is an exclusive end and does not require future fixture rows", async () => {
  const anchor = dogfoodSemanticCollectionAnchor(FIXTURE_NOW);
  assert.equal(anchor, "2026-03-16T00:00:00.000Z");
  for (const { values } of retailFixtureRows) {
    for (const field of ["business_date", "snapshot_date", "last_order_at"] as const) {
      const value = values[field];
      if (typeof value === "string") {
        assert.ok(Date.parse(value) < Date.parse(anchor), `${field} fixture row reaches the exclusive anchor.`);
      }
    }
  }
  const fixtureEngine = await readFile(new URL("../../evals/fixture-engine.ts", import.meta.url), "utf8");
  const compiler = await readFile(new URL("../../packages/compiler/src/compiler.ts", import.meta.url), "utf8");
  assert.match(fixtureEngine, /value < Date\.parse\(query\.time\.range\.to\)/u);
  assert.match(compiler, /f\.\$\{quoteIdentifier\(query\.time\.field\)\} < \$\{toParameter\}/u);
});

test("signed M5 evidence rejects a partial, reordered, or state-drifted suite", () => {
  const partial = validBody();
  partial.milestones.m5.cases = partial.milestones.m5.cases.slice(0, 2) as typeof partial.milestones.m5.cases;
  partial.milestones.m5.evidenceDigest = computeDogfoodM5EvidenceDigest(partial.milestones.m5);
  assert.throws(() => signDogfoodAcceptance(partial, privateKeyBase64Url));

  const reordered = validBody();
  [reordered.milestones.m5.cases[0], reordered.milestones.m5.cases[1]] = [
    reordered.milestones.m5.cases[1],
    reordered.milestones.m5.cases[0],
  ];
  reordered.milestones.m5.evidenceDigest = computeDogfoodM5EvidenceDigest(reordered.milestones.m5);
  assert.throws(() => signDogfoodAcceptance(reordered, privateKeyBase64Url));

  const wrongState = validBody();
  wrongState.milestones.m5.cases[0].answerState = "qualified";
  wrongState.milestones.m5.evidenceDigest = computeDogfoodM5EvidenceDigest(wrongState.milestones.m5);
  assert.throws(() => signDogfoodAcceptance(wrongState, privateKeyBase64Url));

  const emptyRequiredResult = validBody();
  const nonemptyIndex = semanticSuiteCases.findIndex(({ queries }) => queries[0].rowRequirement === "nonempty");
  emptyRequiredResult.milestones.m5.cases[nonemptyIndex].queries[0].rowCount = 0;
  emptyRequiredResult.milestones.m5.evidenceDigest = computeDogfoodM5EvidenceDigest(emptyRequiredResult.milestones.m5);
  assert.throws(() => signDogfoodAcceptance(emptyRequiredResult, privateKeyBase64Url));

  const emptyValidResult = validBody();
  const allowEmptyIndex = semanticSuiteCases.findIndex(({ queries }) => queries[0].rowRequirement === "allow-empty");
  emptyValidResult.milestones.m5.cases[allowEmptyIndex].queries[0].rowCount = 0;
  emptyValidResult.milestones.m5.evidenceDigest = computeDogfoodM5EvidenceDigest(emptyValidResult.milestones.m5);
  assert.doesNotThrow(() => signDogfoodAcceptance(emptyValidResult, privateKeyBase64Url));

  const missingComparison = validBody();
  const refundIndex = semanticSuiteCases.findIndex(({ caseId }) => caseId === "sales-refund-rate");
  missingComparison.milestones.m5.cases[refundIndex].queries.pop();
  missingComparison.milestones.m5.evidenceDigest = computeDogfoodM5EvidenceDigest(missingComparison.milestones.m5);
  assert.throws(() => signDogfoodAcceptance(missingComparison, privateKeyBase64Url));

  const wrongSuite = validBody();
  wrongSuite.milestones.m5.suiteDigest = digest("0");
  wrongSuite.milestones.m5.evidenceDigest = computeDogfoodM5EvidenceDigest(wrongSuite.milestones.m5);
  assert.throws(() => signDogfoodAcceptance(wrongSuite, privateKeyBase64Url));

  const staleCollectionAnchor = validBody();
  staleCollectionAnchor.milestones.m5.collectionAnchor = "2026-08-02T00:00:00.000Z";
  staleCollectionAnchor.milestones.m5.evidenceDigest = computeDogfoodM5EvidenceDigest(staleCollectionAnchor.milestones.m5);
  assert.throws(
    () => signDogfoodAcceptance(staleCollectionAnchor, privateKeyBase64Url),
    /not contemporaneous/u,
  );

  const futureCollectionAnchor = validBody();
  futureCollectionAnchor.milestones.m5.collectionAnchor = "2026-08-05T00:00:00.000Z";
  futureCollectionAnchor.milestones.m5.evidenceDigest = computeDogfoodM5EvidenceDigest(futureCollectionAnchor.milestones.m5);
  assert.throws(
    () => signDogfoodAcceptance(futureCollectionAnchor, privateKeyBase64Url),
    /not contemporaneous/u,
  );

  const nonBoundaryAnchor = validBody();
  nonBoundaryAnchor.milestones.m5.collectionAnchor = "2026-08-04T00:01:00.000Z";
  nonBoundaryAnchor.milestones.m5.evidenceDigest = computeDogfoodM5EvidenceDigest(nonBoundaryAnchor.milestones.m5);
  assert.throws(() => signDogfoodAcceptance(nonBoundaryAnchor, privateKeyBase64Url));

  const invalidCalendarAnchor = validBody();
  invalidCalendarAnchor.milestones.m5.collectionAnchor = "2026-99-99T00:00:00.000Z";
  invalidCalendarAnchor.milestones.m5.evidenceDigest = computeDogfoodM5EvidenceDigest(invalidCalendarAnchor.milestones.m5);
  assert.throws(() => signDogfoodAcceptance(invalidCalendarAnchor, privateKeyBase64Url));

  const inconsistentDigest = validBody();
  inconsistentDigest.milestones.m5.cases[0].queries[0].rowCount += 1;
  assert.throws(
    () => signDogfoodAcceptance(inconsistentDigest, privateKeyBase64Url),
    /M5 evidence digest is inconsistent/u,
  );

  const verifierForgery = structuredClone(signDogfoodAcceptance(validBody(), privateKeyBase64Url));
  verifierForgery.attestation.milestones.m5.cases[0].queries[0].rowCount += 1;
  verifierForgery.attestation.evidenceDigest = computeEvidenceDigest(verifierForgery.attestation);
  verifierForgery.signature.value = signBytes(
    null,
    Buffer.from(stableJson(verifierForgery.attestation)),
    privateKey,
  ).toString("base64url");
  assert.throws(
    () => verifyDogfoodAcceptance(verifierForgery, expected),
    /M5 evidence digest is inconsistent/u,
  );
});

test("tampering, wrong ref, expiry, and incomplete milestones fail closed", () => {
  const envelope = signDogfoodAcceptance(validBody(), privateKeyBase64Url);
  const tampered = structuredClone(envelope);
  tampered.attestation.milestones.m7.onboardingMinutes = 1;
  assert.throws(() => verifyDogfoodAcceptance(tampered, expected), /digest is inconsistent|signature is invalid/u);
  assert.throws(() => verifyDogfoodAcceptance(envelope, { ...expected, expectedWorkflowRef: "refs/heads/release" }), /protected workflow ref/u);
  assert.throws(() => verifyDogfoodAcceptance(envelope, { ...expected, expectedToolingSha: "c".repeat(40) }), /trusted tooling commit/u);
  assert.throws(() => verifyDogfoodAcceptance(envelope, { ...expected, now: Date.parse("2026-08-03T02:31:00.000Z") }), /expired/u);

  const incomplete = validBody();
  incomplete.milestones.m3.reconciledStreams = 29;
  assert.throws(() => signDogfoodAcceptance(incomplete, privateKeyBase64Url), /Every planned stream/u);

  const partialFleet = validBody();
  partialFleet.runtimes.checkedCount = 6 as 7;
  assert.throws(() => signDogfoodAcceptance(partialFleet, privateKeyBase64Url));
});

test("subject pseudonyms are keyed and domain separated", () => {
  const key = Buffer.alloc(32, 7).toString("base64url");
  assert.notEqual(hmacReference(key, "tenant", "same"), hmacReference(key, "connection", "same"));
  assert.doesNotMatch(hmacReference(key, "tenant", "customer-id"), /customer/u);
});

test("private worker evidence uses Fly control-plane checks without public ingress", () => {
  const plan = validateRuntimePlan([
    { name: "web", url: "https://web.example" },
    { name: "sync-worker", url: "https://sync.example" },
    { name: "transform-worker", flyApp: "albert-transform-staging" },
    { name: "webhook-gateway", url: "https://webhooks.example" },
    { name: "semantic-query", url: "https://semantic.example" },
    { name: "operator-diagnostic", url: "https://diagnostic.example" },
    { name: "deletion-worker", flyApp: "albert-deletion-staging" },
  ]);
  assert.equal(plan.find(({ name }) => name === "transform-worker")?.mode, "fly-private");
  assert.throws(() => validateRuntimePlan(plan.map((item) => (
    item.name === "transform-worker" ? { name: item.name, url: "https://private.example" } :
      item.mode === "https" ? { name: item.name, url: item.url } : { name: item.name, flyApp: item.flyApp }
  ))));
  assert.throws(() => validateRuntimePlan([
    { name: "web", url: "https://web.example" },
    { name: "sync-worker", url: "https://sync.example" },
    { name: "transform-worker", flyApp: "same-private-app" },
    { name: "webhook-gateway", url: "https://webhooks.example" },
    { name: "semantic-query", url: "https://semantic.example" },
    { name: "operator-diagnostic", url: "https://diagnostic.example" },
    { name: "deletion-worker", flyApp: "same-private-app" },
  ]), /distinct Fly app/u);

  const machine = (id: string, runtimeIdentity = "transform-worker") => ({
    id,
    state: "started",
    region: "syd",
    instance_id: `instance-${id}`,
    image_ref: { digest: digest("a") },
    config: {
      env: {
        ALBERT_SERVICE_VERSION: candidateSha,
        ALBERT_DEPLOYMENT_ID: "staging-release-1",
        ALBERT_TRANSFORM_WORKER_ID: runtimeIdentity,
      },
      checks: { readiness: { type: "http", path: "/readyz" } },
    },
  });
  const machines = [machine("abcdef01234567"), machine("0123456789abcd")];
  const checks = Object.fromEntries(machines.map(({ id }) => [id, [
    { name: "readiness", status: "passing", updated_at: "2026-08-03T00:00:00Z" },
  ]]));
  const result = validatePrivateFlyEvidence(
    { machines, checks, ips: [] },
    { name: "transform-worker", mode: "fly-private", flyApp: "albert-transform-staging" },
    { candidateSha, deploymentId: "staging-release-1" },
  );
  assert.equal(result.machineCount, 2);
  assert.throws(() => validatePrivateFlyEvidence(
    { machines, checks, ips: [{ type: "v6" }] },
    { name: "transform-worker", mode: "fly-private", flyApp: "albert-transform-staging" },
    { candidateSha, deploymentId: "staging-release-1" },
  ), /public IP/u);
  assert.throws(() => validatePrivateFlyEvidence(
    { machines: [machine("abcdef01234567", "deletion-worker"), machines[1]], checks, ips: [] },
    { name: "transform-worker", mode: "fly-private", flyApp: "albert-transform-staging" },
    { candidateSha, deploymentId: "staging-release-1" },
  ), /expected transform-worker process identity/u);
});

test("the database snapshot is immutable and production consumption is one-use", async () => {
  const migration = await readFile(new URL(
    "../../infra/migrations/control-plane/0054_m3_m8_protected_dogfood_acceptance.sql",
    import.meta.url,
  ), "utf8");
  assert.match(migration, /protected_dogfood_acceptance_snapshots/u);
  assert.match(migration, /protected_dogfood_acceptance_consumptions[\s\S]*snapshot_id text PRIMARY KEY/u);
  assert.match(migration, /snapshot was already consumed/u);
  assert.match(migration, /snapshot\.captured_at<=clock_timestamp\(\)-interval '6 hours'/u);
  assert.match(migration, /assert_operator_diagnostic_control_ready/u);
  assert.match(migration, /protected_dogfood_deployment_barrier/u);
  assert.match(migration, /protected_dogfood_runtime_observations/u);
  assert.match(migration, /WHEN 'albert_sync_control_runtime' THEN 'sync-worker'/u);
  assert.match(migration, /WHEN 'albert_transform_control_runtime' THEN 'transform-worker'/u);
  assert.match(migration, /WHEN 'albert_deletion_control_runtime' THEN 'deletion-worker'/u);
  assert.match(migration, /clock_timestamp\(\)[\s\S]*ON CONFLICT ON CONSTRAINT protected_dogfood_runtime_observations_pkey DO NOTHING/u);
  assert.match(migration, /manifest\.created_at>=barrier_at/u);
  assert.match(migration, /artifact\.finalized_at<p_barrier_at/u);
  assert.match(migration, /onboarding_created<barrier_at/u);
  assert.match(migration, /ready_connection_count<>3/u);
  assert.match(migration, /protected_dogfood_semantic_turn_leases/u);
  assert.match(migration, /issue_protected_dogfood_semantic_turn/u);
  assert.match(migration, /turn_record\.status='running'/u);
  assert.doesNotMatch(migration, /GRANT SELECT ON (?:TABLE )?control_plane\.protected_dogfood/iu);

  const workflow = await readFile(new URL(
    "../../.github/workflows/dogfood-acceptance.yml",
    import.meta.url,
  ), "utf8");
  assert.match(workflow, /name: Collect live M3-M8 acceptance evidence\s+if: github\.run_attempt == 1/u);
  assert.match(workflow, /test "\$GITHUB_SHA" = "\$TRUSTED_TOOLING_SHA"/u);
  assert.match(workflow, /test "\$GITHUB_EVENT_NAME" = workflow_dispatch/u);
  assert.match(workflow, /test "\$GITHUB_RUN_ATTEMPT" = 1/u);
  assert.match(workflow, /GITHUB_WORKFLOW_REF/u);
  assert.match(workflow, /verification\.verified/u);
  assert.doesNotMatch(workflow, /ALBERT_DOGFOOD_DEPLOYMENT_ID/u);
  assert.match(workflow, /ALBERT_DOGFOOD_REFERENCE_PLAN_ENVELOPE_JSON/u);
  assert.match(workflow, /ALBERT_DOGFOOD_SITES_PROVENANCE_ENVELOPE_JSON/u);
  assert.match(workflow, /timeout-minutes: 60/u);

  const onboardingWorkflow = await readFile(new URL(
    "../../.github/workflows/dogfood-onboarding-journey.yml",
    import.meta.url,
  ), "utf8");
  assert.match(onboardingWorkflow, /name: Issue one candidate-bound human journey\s+if: github\.run_attempt == 1/u);
  assert.match(onboardingWorkflow, /test "\$GITHUB_EVENT_NAME" = workflow_dispatch/u);
  assert.match(onboardingWorkflow, /test "\$GITHUB_RUN_ATTEMPT" = 1/u);
  assert.match(onboardingWorkflow, /dogfood-onboarding-journey\.yml@\$PROTECTED_WORKFLOW_REF/u);
  assert.match(onboardingWorkflow, /verification\.verified/u);

  const collector = await readFile(new URL(
    "../../scripts/collect-dogfood-acceptance.mjs",
    import.meta.url,
  ), "utf8");
  assert.match(collector, /collectFlyPlatformProvenance/u);
  assert.match(collector, /Fly platform evidence contains no semantic-query public origin/u);
  assert.doesNotMatch(collector, /body\.runtime, probe\.name/u);
  assert.doesNotMatch(collector, /ALBERT_DOGFOOD_RUNTIME_PROBES_JSON/u);
  assert.doesNotMatch(collector, /ALBERT_DOGFOOD_SEMANTIC_QUERY_URL/u);
  assert.match(collector, /testCase\.expectedState/u);
  assert.match(collector, /for \(const query of testCase\.queries\)/u);
  assert.match(collector, /query\.expectedResultDigest/u);
  assert.match(collector, /query\.rowRequirement === "nonempty"/u);
  assert.match(collector, /testCase\.caseId.*query\.queryId/u);
  assert.match(collector, /dogfoodSemanticCollectionAnchor\(new Date\(\)\)/u);
  assert.match(collector, /validateDogfoodSemanticPlanAtCollectionAnchor\(semanticPlan, semanticCollectionAnchor\)/u);
  assert.match(collector, /collectionAnchor: config\.semanticCollectionAnchor/u);
  assert.match(collector, /computeDogfoodM5EvidenceDigest\(milestone\)/u);
  assert.match(collector, /suiteVersion: config\.semanticPlan\.suiteVersion/u);
  assert.match(collector, /suiteDigest: config\.semanticPlan\.suiteDigest/u);
  const flyCollector = await readFile(new URL(
    "../../scripts/collect-fly-platform-provenance.mjs",
    import.meta.url,
  ), "utf8");
  assert.match(flyCollector, /api\.machines\.dev/u);
  assert.match(flyCollector, /instance_id/u);
  assert.match(flyCollector, /updated_at/u);
  assert.match(flyCollector, /configDigest: platformSha256\(machine\.config\)/u);
  assert.match(flyCollector, /\["ips", "list"/u);
  assert.match(flyCollector, /\["secrets", "list"/u);
});
