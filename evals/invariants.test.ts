import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import {
  canonicalizeCandidates,
  dimensionDeclarations,
  factDeclarations,
  type AuthorityRule,
  type CanonicalCandidate,
} from "../packages/canonical-schema/src/index.js";
import { compileSemanticQuery } from "../packages/compiler/src/index.js";
import {
  loadRegistryFile,
  parseRegistryDocument,
  registryDigest,
  type SemanticRegistry,
} from "../packages/semantic-registry/src/index.js";
import {
  contentDigest,
  DefaultSemanticToolExecutor,
  MemorySemanticResultCache,
  type SemanticServiceDependencies,
  type TrustedToolContext,
} from "../services/semantic-query/src/index.js";
import {
  FIXTURE_NOW,
  FIXTURE_TENANT_ID,
} from "./fixtures/retail.js";
import { seedGoldenQuestions } from "./golden/questions.js";

// These five production invariants are permanent CI gates. Supersede them only
// with a demonstrably stronger assertion; never remove one to unblock a change.
const registryPath = resolve("packages/semantic-registry/registry/registry.yaml");
const registryText = readFileSync(registryPath, "utf8");
const registryDocument = parseRegistryDocument(registryText);
const registry = loadRegistryFile(registryPath);
const capabilities = new Set([
  ...[...registry.metrics.values()].flatMap((metric) => metric.requiredCapabilities),
  ...[...registry.topics.values()].flatMap((topic) => topic.requiredCapabilities),
]);
const tenantParameters = {
  active_customer_days: 90,
  lapsed_customer_days: 180,
  stock_velocity_days: 30,
} as const;

test("permanent invariant 1/5: tenant isolation survives compiler, database and cache boundaries", async () => {
  const secondTenantId = "01J00000000000000000000998";
  const databaseCalls: Array<{ tenantId: string; parameterTenant: unknown }> = [];
  const audits: Array<{ cacheHit: boolean }> = [];
  const dependencies: SemanticServiceDependencies = {
    registry,
    contextProvider: {
      async load(context) {
        return tenantSemanticContext(`overlay-${context.tenantId}`);
      },
    },
    database: {
      async queryAsSemanticRole(request) {
        databaseCalls.push({
          tenantId: request.tenantId,
          parameterTenant: request.parameters[0],
        });
        assert.equal(request.parameters[0], request.tenantId);
        assert.doesNotMatch(request.sql, new RegExp(request.tenantId));
        return {
          rows: [{ net_sales_ex_gst: request.tenantId }],
          durationMs: 1,
        };
      },
    },
    cache: new MemorySemanticResultCache(() => Date.parse(FIXTURE_NOW)),
    sourceCatalogue: { async listFields() { return []; } },
    dataHealth: {
      async getForTopic() {
        return { status: "passed", checks: [{ checkId: "tenant_isolation", status: "passed" }] };
      },
    },
    audit: {
      async append(record) { audits.push(record); },
      async promoteSourceField() { return "promotion-tenant-isolation"; },
    },
    publicationEvidence: {
      async inspect() {
        return { registryVersion: registry.version, registryHash: "f".repeat(64), activePublicationMatches: true };
      },
    },
    clock: () => new Date(FIXTURE_NOW),
  };
  const service = new DefaultSemanticToolExecutor(dependencies);
  const ir = legacySalesIr();
  const contextA = trustedContext(FIXTURE_TENANT_ID, "11");
  const contextB = trustedContext(secondTenantId, "12");

  const firstA = await service.execute("run_semantic_query", ir, contextA);
  const firstB = await service.execute("run_semantic_query", ir, contextB);
  const secondA = await service.execute("run_semantic_query", ir, contextA);

  assert.equal(firstA.data?.rows[0]?.net_sales_ex_gst, FIXTURE_TENANT_ID);
  assert.equal(firstB.data?.rows[0]?.net_sales_ex_gst, secondTenantId);
  assert.equal(firstA.performance.cacheHit, false);
  assert.equal(firstB.performance.cacheHit, false);
  assert.equal(secondA.performance.cacheHit, true);
  assert.deepEqual(databaseCalls, [
    { tenantId: FIXTURE_TENANT_ID, parameterTenant: FIXTURE_TENANT_ID },
    { tenantId: secondTenantId, parameterTenant: secondTenantId },
  ]);
  assert.equal(audits.length, 3);
  assert.deepEqual(audits.map((audit) => audit.cacheHit), [false, false, true]);
});

test("permanent invariant 2/5: canonical lineage is complete and immutable", () => {
  const candidate = canonicalCandidate("connection-a", "source-order-line-1");
  const authority = authorityRule("connection-a");
  const result = canonicalizeCandidates([candidate], [authority], "2026-03-15T00:00:00.000Z");

  assert.equal(result.rejected.length, 0);
  assert.deepEqual(result.accepted[0]?.lineage, {
    connectionId: "connection-a",
    sourceObjectType: "sale_line",
    sourceRecordId: "source-order-line-1",
    syncRunId: "sync-run-1",
    sourceUpdatedAt: "2026-03-14T23:00:00.000Z",
  });
  assert.equal(result.accepted[0]?.values.gross_amount, "12.3000");

  const incomplete = {
    ...candidate,
    source: { ...candidate.source, sourceRecordId: "" },
  };
  const rejected = canonicalizeCandidates(
    [incomplete],
    [authority],
    "2026-03-15T00:00:00.000Z",
  );
  assert.equal(rejected.accepted.length, 0);
  assert.equal(rejected.rejected[0]?.reason, "invalid_candidate");

  const migration = readFileSync(
    resolve("infra/migrations/analytical/0010_m4_canonical_foundation.sql"),
    "utf8",
  );
  assert.match(migration, /CREATE OR REPLACE FUNCTION core\.protect_fact_lineage\(\)/);
  assert.match(migration, /canonical fact lineage is immutable/);
  assert.match(migration, /CREATE TRIGGER protect_lineage BEFORE UPDATE/);
  for (const fact of factDeclarations) {
    assert.match(migration, new RegExp(`'${fact.id}'`), `${fact.id} has no lineage trigger`);
  }
});

test("permanent invariant 3/5: canonical meaning remains source-neutral", () => {
  const fromA = canonicalizeCandidates(
    [canonicalCandidate("connection-a", "a-1")],
    [authorityRule("connection-a")],
    "2026-03-15T00:00:00.000Z",
  ).accepted[0];
  const fromB = canonicalizeCandidates(
    [canonicalCandidate("connection-b", "b-1")],
    [authorityRule("connection-b")],
    "2026-03-15T00:00:00.000Z",
  ).accepted[0];

  assert.ok(fromA && fromB);
  assert.equal(fromA.fact, fromB.fact);
  assert.deepEqual(fromA.values, fromB.values);
  assert.notDeepEqual(fromA.lineage, fromB.lineage);

  const foundation = readFileSync(
    resolve("infra/migrations/analytical/0010_m4_canonical_foundation.sql"),
    "utf8",
  );
  const transforms = readFileSync(
    resolve("infra/migrations/analytical/0020_m4_transforms_quality_and_marts.sql"),
    "utf8",
  );
  const canonicalDeclarations = JSON.stringify({ dimensionDeclarations, factDeclarations });
  assert.doesNotMatch(`${foundation}\n${transforms}\n${canonicalDeclarations}\n${registryText}`, /lightspeed|xero|deputy/i);
});

test("permanent invariant 4/5: semantic contracts are versioned when meaning changes", () => {
  const baseline = JSON.parse(
    readFileSync(resolve("evals/golden/registry-contracts.json"), "utf8"),
  ) as ContractBaseline;
  const currentRegistryDigest = registryDigest(registryDocument);
  if (currentRegistryDigest !== baseline.registryDigest) {
    assert.ok(
      semverGreaterThan(registryDocument.registryVersion, baseline.registryVersion),
      "registry content changed without a registryVersion bump",
    );
  }

  assertVersionedContracts("metric", baseline.metrics, registryDocument.metrics);
  assertVersionedContracts("topic", baseline.topics, registryDocument.topics);
  assert.equal(registry.metrics.size, 47);
  assert.equal(registry.topics.size, 7);
});

test("permanent invariant 5/5: prior IR and every governed seed remain backward-compatible", () => {
  const context = compilerContext(registry);
  const legacy = legacySalesIr();
  const legacyCompiled = compileSemanticQuery(legacy, registry, context);
  assert.equal(legacyCompiled.topic, "sales_performance");
  assert.deepEqual(legacyCompiled.resultColumns, ["net_sales_ex_gst"]);
  assert.equal(legacyCompiled.parameters[0], FIXTURE_TENANT_ID);

  for (const question of seedGoldenQuestions) {
    if (question.expectedRoute !== "semantic") continue;
    assert.ok(question.ir, `${question.id} is a governed semantic seed without IR`);
    const first = compileSemanticQuery(question.ir, registry, context);
    const second = compileSemanticQuery(question.ir, registry, context);
    assert.deepEqual(first, second, `${question.id} no longer compiles deterministically`);
    for (const key of Object.keys(question.expectedRows?.[0] ?? {})) {
      assert.ok(first.resultColumns.includes(key), `${question.id} dropped result column ${key}`);
    }
  }
});

type ContractBaseline = Readonly<{
  registryVersion: string;
  registryDigest: string;
  metrics: Readonly<Record<string, string>>;
  topics: Readonly<Record<string, string>>;
}>;

function assertVersionedContracts(
  kind: "metric" | "topic",
  baseline: Readonly<Record<string, string>>,
  current: readonly Readonly<{ id: string; version: number }>[],
): void {
  const byId = new Map(current.map((contract) => [contract.id, contract]));
  for (const [id, signature] of Object.entries(baseline)) {
    const contract = byId.get(id);
    assert.ok(contract, `${kind} ${id} was removed; add a superseding compatibility path`);
    const separator = signature.indexOf(":");
    const baselineVersion = Number(signature.slice(0, separator));
    const baselineDigest = signature.slice(separator + 1);
    const currentDigest = contentDigest(contract);
    assert.ok(Number.isInteger(contract.version) && contract.version > 0);
    if (currentDigest !== baselineDigest) {
      assert.ok(
        contract.version > baselineVersion,
        `${kind} ${id} changed without incrementing its contract version`,
      );
    } else {
      assert.ok(contract.version >= baselineVersion);
    }
  }
}

function semverGreaterThan(left: string, right: string): boolean {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return false;
}

function compilerContext(semanticRegistry: SemanticRegistry) {
  return {
    tenantId: FIXTURE_TENANT_ID,
    role: "owner" as const,
    capabilities: new Set([
      ...[...semanticRegistry.metrics.values()].flatMap((metric) => metric.requiredCapabilities),
      ...[...semanticRegistry.topics.values()].flatMap((topic) => topic.requiredCapabilities),
    ]),
    now: FIXTURE_NOW,
    timezone: "Australia/Melbourne",
    tradingDayCutoff: "00:00",
    fiscalYearStartMonth: 7,
    fiscalYearStartDay: 1,
    weekStartsOn: 1,
    tenantParameters,
    maxRows: 1000,
    maxEstimatedCost: 100,
  } satisfies Parameters<typeof compileSemanticQuery>[2];
}

function tenantSemanticContext(overlayVersion: string) {
  return {
    timezone: "Australia/Melbourne",
    tradingDayCutoff: "00:00",
    fiscalYearStartMonth: 7,
    fiscalYearStartDay: 1,
    weekStartsOn: 1,
    tenantParameters,
    capabilities,
    overlayVersion,
    identityGraphVersion: 0,
    identityGraphHash: "d41d8cd98f00b204e9800998ecf8427e",
    defaults: {},
    dossier: {},
    packVersions: { fixture: "1.0.0" },
    sourceWatermarks: { "connection-a": "2026-03-15T11:00:00.000Z" },
    sourceDetails: [{
      connectorId: "fixture",
      connectionId: "connection-a",
      label: "Fixture source",
      dataThrough: "2026-03-15T11:00:00.000Z",
    }],
    authorityByConcept: { operational_sales: "connection-a" },
  };
}

function trustedContext(tenantId: string, suffix: string): TrustedToolContext {
  return {
    tenantId,
    role: "owner",
    conversationId: `01J000000000000000000000${suffix}`,
    turnId: `01J000000000000000000001${suffix}`,
  };
}

function legacySalesIr() {
  return {
    topic: "sales_performance",
    metrics: ["net_sales_ex_gst"],
    dimensions: [],
    filters: [],
    time: {
      field: "business_date",
      range: {
        type: "absolute",
        from: "2026-03-01T00:00:00.000Z",
        to: "2026-03-16T00:00:00.000Z",
      },
      compare: "none",
    },
    sort: [],
    limit: 20,
    parameters: {},
  } as const;
}

function canonicalCandidate(
  connectionId: string,
  sourceRecordId: string,
): CanonicalCandidate<Readonly<Record<string, unknown>>> {
  return {
    tenantId: FIXTURE_TENANT_ID,
    id: "canonical-line-1",
    fact: "commerce_order_line",
    authorityConcept: "operational_sales",
    source: {
      connectionId,
      sourceObjectType: "sale_line",
      sourceRecordId,
    },
    syncRunId: "sync-run-1",
    sourceUpdatedAt: "2026-03-14T23:00:00.000Z",
    values: {
      gross_amount: "12.3",
      quantity: "1.0000",
      currency: "AUD",
    },
  };
}

function authorityRule(connectionId: string): AuthorityRule {
  return {
    concept: "operational_sales",
    connectionId,
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    scopeType: "tenant",
    scopeId: FIXTURE_TENANT_ID,
  };
}
