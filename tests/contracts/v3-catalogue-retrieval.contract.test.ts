import assert from "node:assert/strict";
import test from "node:test";

import { loadAgentConfig } from "../../packages/albert-v3/src/agent-config/loader.ts";
import { CubeClient } from "../../packages/albert-v3/src/cube/client.ts";
import {
  hydrateViewSchemas,
  renderCompactCatalogueIndex,
  renderViewSchemasForPrompt,
  searchSemanticCatalogue,
  selectCatalogueViews,
  type CatalogueViewDescriptor,
} from "../../packages/albert-v3/src/cube/catalogue.ts";
import type {
  CubeCatalogue,
  CubeCatalogueMember,
  CubeCatalogueView,
} from "../../packages/albert-v3/src/cube/types.ts";

function member(input: Readonly<{
  name: string;
  kind: CubeCatalogueMember["kind"];
  title: string;
  description: string;
  type?: CubeCatalogueMember["type"];
  folder?: string;
  aiContext?: string;
  aliasMember?: string;
}>): CubeCatalogueMember {
  return Object.freeze({
    shortTitle: input.title,
    ...input,
  });
}

function catalogueView(input: Readonly<{
  name: string;
  title: string;
  description: string;
  aiContext?: string;
  queryPolicy?: CubeCatalogueView["queryPolicy"];
  minimumTimeGranularity?: CubeCatalogueView["minimumTimeGranularity"];
  minimumGroupSize?: number;
  populationMeasure?: string;
  members: readonly CubeCatalogueMember[];
}>): CubeCatalogueView {
  return Object.freeze({ ...input, members: Object.freeze([...input.members]) });
}

const RETAIL_SALES = catalogueView({
  name: "retail_sales_analytics",
  title: "Retail sales",
  description: "Completed point-of-sale sales, discounts, tax and net revenue.",
  aiContext: "Use completed sales unless the question explicitly asks for another state.",
  members: [
    member({
      name: "retail_sales_analytics.gross_takings",
      kind: "measure",
      title: "Gross takings",
      description: "Gross completed takings before discounts and refunds.",
      type: "number",
      folder: "Revenue",
      aliasMember: "source_sales.gross_takings",
    }),
    member({
      name: "retail_sales_analytics.net_sales",
      kind: "measure",
      title: "Net sales",
      description: "Completed sales after discounts and refunds.",
      type: "number",
      folder: "Revenue",
    }),
    member({
      name: "retail_sales_analytics.product_name",
      kind: "dimension",
      title: "Product",
      description: "The governed display name of the product sold.",
      type: "string",
      folder: "Product",
    }),
  ],
});

const INVENTORY = catalogueView({
  name: "inventory_analytics",
  title: "Inventory",
  description: "Current and historical stock quantities by outlet and product.",
  members: [
    member({
      name: "inventory_analytics.available_units",
      kind: "measure",
      title: "Available units",
      description: "Units currently available for sale.",
      type: "number",
      folder: "Stock",
    }),
    member({
      name: "inventory_analytics.outlet_name",
      kind: "dimension",
      title: "Outlet",
      description: "The outlet holding the stock.",
      type: "string",
      folder: "Outlet",
    }),
  ],
});

const PAYROLL = catalogueView({
  name: "payroll_analytics",
  title: "Payroll",
  description: "Employee wages, payroll cost and paid hours.",
  members: [
    member({
      name: "payroll_analytics.gross_wages",
      kind: "measure",
      title: "Gross wages",
      description: "Gross wage cost before deductions.",
      type: "number",
      folder: "Wages",
    }),
    member({
      name: "payroll_analytics.employee_name",
      kind: "dimension",
      title: "Employee",
      description: "Protected employee display name.",
      type: "string",
      folder: "Employee",
    }),
  ],
});

const PROTECTED_CUSTOMERS = catalogueView({
  name: "protected_customer_analytics",
  title: "Protected customers",
  description: "Privacy-preserving customer cohort analytics.",
  aiContext: "Never expose individual customer rows.",
  queryPolicy: "aggregate_only",
  minimumTimeGranularity: "day",
  minimumGroupSize: 10,
  populationMeasure: "protected_customer_analytics.population",
  members: [
    member({
      name: "protected_customer_analytics.population",
      kind: "measure",
      title: "Population",
      description: "Distinct protected customers contributing to the group.",
      type: "number",
      folder: "Privacy",
    }),
    member({
      name: "protected_customer_analytics.repeat_rate",
      kind: "measure",
      title: "Repeat rate",
      description: "Share of the protected cohort that purchased repeatedly.",
      type: "number",
      folder: "Retention",
    }),
    member({
      name: "protected_customer_analytics.cohort_month",
      kind: "dimension",
      title: "Cohort month",
      description: "Month in which the protected cohort first purchased.",
      type: "time",
      folder: "Cohort",
    }),
  ],
});

const FIXTURE_VIEWS = [RETAIL_SALES, INVENTORY, PAYROLL, PROTECTED_CUSTOMERS] as const;
const FIXTURE_DESCRIPTORS: readonly CatalogueViewDescriptor[] = Object.freeze([
  { name: RETAIL_SALES.name, connector: "lightspeed", guidance: "Retail point-of-sale revenue and product performance." },
  { name: INVENTORY.name, connector: "lightspeed", guidance: "Stock availability and inventory movement." },
  { name: PAYROLL.name, connector: "deputy", guidance: "Employee wage cost, payroll and paid hours." },
  { name: PROTECTED_CUSTOMERS.name, connector: "shopify", guidance: "Privacy-preserving customer cohorts and retention." },
]);

function fixtureCatalogue(views: readonly CubeCatalogueView[] = FIXTURE_VIEWS): CubeCatalogue {
  return Object.freeze({
    views: Object.freeze([...views]),
    fetchedAt: "2026-08-13T00:00:00.000Z",
  });
}

test("the compact v3 catalogue index covers every configured view inside its bounded envelope", () => {
  const config = loadAgentConfig();
  const neverEmbed = "FULL_MEMBER_DEFINITION_MUST_NOT_ENTER_THE_BASE_PROMPT";
  const catalogue: CubeCatalogue = {
    fetchedAt: "2026-08-13T00:00:00.000Z",
    views: config.accessibleViews.map((descriptor) => catalogueView({
      name: descriptor.name,
      title: descriptor.name,
      description: `${neverEmbed} ${"description ".repeat(200)}`,
      aiContext: `${neverEmbed} ${"guidance ".repeat(200)}`,
      members: [
        member({
          name: `${descriptor.name}.primary_metric`,
          kind: "measure",
          title: "Primary metric",
          description: `${neverEmbed} ${"metric definition ".repeat(100)}`,
          type: "number",
        }),
        member({
          name: `${descriptor.name}.hidden_dimension`,
          kind: "dimension",
          title: "Hidden dimension",
          description: `${neverEmbed} ${"dimension definition ".repeat(100)}`,
          type: "string",
        }),
      ],
    })),
  };

  const index = renderCompactCatalogueIndex(catalogue, config.accessibleViews);
  const lines = index.split("\n");
  const indexedNames = lines.map((line) => /^- ([^ ]+) \[/u.exec(line)?.[1]);

  assert.equal(lines.length, config.accessibleViews.length);
  assert.equal(new Set(indexedNames).size, config.accessibleViews.length);
  for (const descriptor of config.accessibleViews) {
    const line = lines.find((candidate) => candidate.startsWith(`- ${descriptor.name} [`));
    assert.ok(line, `${descriptor.name} is missing from the compact index`);
    const connectorAndPolicy = line.slice(line.indexOf("[") + 1, line.indexOf("]"));
    assert.equal(connectorAndPolicy.split(";")[0], descriptor.connector);
    assert.match(line, /Key metrics: primary_metric\./u);
  }
  assert.ok(index.length <= 20_000, `compact index grew to ${index.length} characters`);
  assert.ok(lines.every((line) => line.length <= 260), "a compact-index row is no longer bounded");
  assert.doesNotMatch(index, new RegExp(neverEmbed, "u"));
  assert.doesNotMatch(index, /hidden_dimension/u);
});

test("semantic catalogue retrieval gives exact view and member identities deterministic priority", () => {
  const catalogue = fixtureCatalogue();
  const exactView = searchSemanticCatalogue(
    catalogue,
    "Use retail_sales_analytics for this answer",
    FIXTURE_DESCRIPTORS,
  );
  assert.equal(exactView[0]?.name, RETAIL_SALES.name);

  const exactMember = searchSemanticCatalogue(
    catalogue,
    "How many inventory_analytics.available_units do we have?",
    FIXTURE_DESCRIPTORS,
  );
  assert.equal(exactMember[0]?.name, INVENTORY.name);
  assert.equal(exactMember[0]?.relevantMembers[0]?.name, "inventory_analytics.available_units");

  const original = searchSemanticCatalogue(
    catalogue,
    "Compare available stock, gross wages and net retail sales",
    FIXTURE_DESCRIPTORS,
    { limit: 4, memberLimit: 3 },
  );
  const shuffled = searchSemanticCatalogue(
    fixtureCatalogue([PROTECTED_CUSTOMERS, PAYROLL, RETAIL_SALES, INVENTORY]),
    "Compare available stock, gross wages and net retail sales",
    [...FIXTURE_DESCRIPTORS].reverse(),
    { limit: 4, memberLimit: 3 },
  );
  assert.deepEqual(shuffled, original);
});

test("on-demand schema disclosure is lossless for one to three views and reports unknown names", () => {
  const catalogue = fixtureCatalogue();

  const one = renderViewSchemasForPrompt(catalogue, [RETAIL_SALES.name]);
  assert.deepEqual(one.unknownViewNames, []);
  assert.match(one.schemas, /## View: retail_sales_analytics/u);
  assert.match(one.schemas, /Completed point-of-sale sales, discounts, tax and net revenue\./u);
  assert.match(one.schemas, /Guidance: Use completed sales/u);
  assert.match(one.schemas, /retail_sales_analytics\.gross_takings \(measure, number\)/u);
  assert.match(one.schemas, /Gross completed takings before discounts and refunds\./u);
  assert.doesNotMatch(one.schemas, /aliasMember|source_sales\.gross_takings/u);
  assert.doesNotMatch(one.schemas, /## View: inventory_analytics/u);

  const threeNames = [PROTECTED_CUSTOMERS.name, INVENTORY.name, PAYROLL.name] as const;
  const three = renderViewSchemasForPrompt(catalogue, threeNames);
  assert.deepEqual(three.unknownViewNames, []);
  assert.deepEqual(
    [...three.schemas.matchAll(/^## View: ([^\n]+)$/gmu)].map((match) => match[1]),
    threeNames,
  );
  assert.match(three.schemas, /Query policy: aggregate-only\./u);
  assert.match(three.schemas, /including protected_customer_analytics\.population/u);
  assert.match(three.schemas, /fewer than 10 protected subjects/u);
  assert.match(three.schemas, /protected_customer_analytics\.repeat_rate/u);

  const selected = selectCatalogueViews(catalogue, [INVENTORY.name, "missing_view", INVENTORY.name]);
  assert.deepEqual(selected.views.map(({ name }) => name), [INVENTORY.name]);
  assert.deepEqual(selected.unknownViewNames, ["missing_view"]);

  const partial = renderViewSchemasForPrompt(catalogue, [INVENTORY.name, "missing_view"]);
  assert.deepEqual(partial.unknownViewNames, ["missing_view"]);
  assert.match(partial.schemas, /## View: inventory_analytics/u);
  assert.doesNotMatch(partial.schemas, /missing_view/u);

  const hydrated = hydrateViewSchemas(catalogue, [PROTECTED_CUSTOMERS.name], FIXTURE_DESCRIPTORS);
  assert.deepEqual(hydrated.unknownViewNames, []);
  assert.deepEqual(hydrated.views[0], {
    name: PROTECTED_CUSTOMERS.name,
    connector: "shopify",
    title: PROTECTED_CUSTOMERS.title,
    purpose: FIXTURE_DESCRIPTORS[3]?.guidance,
    guidance: FIXTURE_DESCRIPTORS[3]?.guidance,
    description: PROTECTED_CUSTOMERS.description,
    aiContext: PROTECTED_CUSTOMERS.aiContext,
    queryPolicy: "aggregate_only",
    minimumTimeGranularity: "day",
    minimumGroupSize: 10,
    populationMeasure: "protected_customer_analytics.population",
    members: PROTECTED_CUSTOMERS.members.map((member) => {
      const publicMember = { ...member } as Record<string, unknown>;
      delete publicMember.aliasMember;
      return publicMember;
    }),
  });

  const unpublished = catalogueView({
    name: "internal_unpublished_view",
    title: "Internal",
    description: "Must remain server-only.",
    members: [],
  });
  const denied = hydrateViewSchemas(
    fixtureCatalogue([...FIXTURE_VIEWS, unpublished]),
    [unpublished.name],
    FIXTURE_DESCRIPTORS,
  );
  assert.deepEqual(denied.views, []);
  assert.deepEqual(denied.unknownViewNames, [unpublished.name]);
});

test("progressive discovery shares one authoritative Cube catalogue fetch per turn", async () => {
  let metaCalls = 0;
  const client = new CubeClient({
    apiUrl: "https://cube.invalid",
    apiSecret: "catalogue-cache-contract-secret",
    securityContext: {
      tenant_id: "01J00000000000000000000000",
      conversation_id: "01J00000000000000000000001",
      turn_id: "01J00000000000000000000002",
    },
    fetcher: async () => {
      metaCalls += 1;
      return new Response(JSON.stringify({ cubes: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const [first, second, third] = await Promise.all([
    client.fetchCatalogue(),
    client.fetchCatalogue(),
    client.fetchCatalogue(),
  ]);
  assert.equal(metaCalls, 1);
  assert.strictEqual(first, second);
  assert.strictEqual(second, third);
  assert.strictEqual(await client.fetchCatalogue(), first);
  assert.equal(metaCalls, 1);
});
