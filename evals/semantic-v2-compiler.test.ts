import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  applyWorkspacePatchV2,
  WorkspaceConflictError,
  type QueryWorkspaceV2,
} from "../packages/analytics-v2/src/workspace.js";
import {
  compileQueryWorkspaceV2,
  semanticResultCacheKeyV2,
} from "../packages/compiler/src/v2.js";
import {
  semanticRegistryDocumentV2Schema,
  semanticRegistryV2Digest,
} from "../packages/semantic-registry/src/v2.js";

const registry = semanticRegistryDocumentV2Schema.parse(
  JSON.parse(
    readFileSync(
      "packages/semantic-registry/registry/registry.v2.json",
      "utf8",
    ),
  ),
);
const publication = JSON.parse(
  readFileSync(
    "packages/semantic-registry/registry/publication.v2.json",
    "utf8",
  ),
);
const now = "2026-08-09T00:00:00.000Z";

function workspace(id = "workspace-a"): QueryWorkspaceV2 {
  return {
    id,
    tenantId: "tenant-a",
    publicationHash: publication.publicationHash,
    overlayVersion: "overlay-1",
    revision: 1,
    questionId: "question-a",
    status: "draft",
    createdAt: now,
    updatedAt: now,
    blocks: [
      {
        id: "sales",
        topicIds: ["business.sales_performance"],
        rootViewId: "commerce_sales_event",
        dimensionIds: [
          "commerce_sales_event.location",
          "commerce_sales_event.currency",
        ],
        measureIds: ["commerce.net_sales_ex_gst"],
        filters: [],
        time: {
          dimensionId: "commerce_sales_event.business_date",
          range: { type: "last_complete_month" },
        },
        sort: [],
        limit: 100,
        parameters: {},
      },
    ],
  };
}

test("V2 compiler injects tenant scope first and deterministically lowers semantic IDs", () => {
  const context = {
    tenantId: "tenant-a",
    now,
    timezone: "Australia/Melbourne",
    connectionSet: ["connection-a", "connection-b"],
  };
  const first = compileQueryWorkspaceV2(
    workspace("workspace-a"),
    registry,
    context,
  );
  const second = compileQueryWorkspaceV2(
    workspace("workspace-b"),
    registry,
    context,
  );
  assert.equal(first.normalizedPlanHash, second.normalizedPlanHash);
  assert.equal(first.queries[0]?.sql, second.queries[0]?.sql);
  assert.equal(first.queries[0]?.parameters[0], "tenant-a");
  assert.match(first.queries[0]?.sql ?? "", /^with "tenant_scope"/u);
  assert.match(
    first.queries[0]?.sql ?? "",
    /from "mart"\."commerce_sales_event"/u,
  );
  assert.doesNotMatch(first.queries[0]?.sql ?? "", /workspace-a|question-a/u);
  assert.equal(first.queries[0]?.validationEvidence.parameterized, true);
});

test("workspace batches are optimistic and executed snapshots are immutable", () => {
  assert.throws(
    () =>
      applyWorkspacePatchV2(
        workspace(),
        {
          expectedRevision: 2,
          operations: [{ op: "set_limit", blockId: "sales", limit: 20 }],
        },
        now,
      ),
    WorkspaceConflictError,
  );
  const changed = applyWorkspacePatchV2(
    workspace(),
    {
      expectedRevision: 1,
      operations: [
        { op: "set_limit", blockId: "sales", limit: 20 },
        {
          op: "set_comparison",
          blockId: "sales",
          comparison: { kind: "prior_year" },
        },
      ],
    },
    now,
  );
  assert.equal(changed.revision, 2);
  assert.equal(changed.blocks[0]?.limit, 20);
  assert.equal(changed.blocks[0]?.comparison?.kind, "prior_year");
  assert.throws(
    () =>
      applyWorkspacePatchV2(
        { ...changed, status: "executed" },
        {
          expectedRevision: 2,
          operations: [{ op: "set_limit", blockId: "sales", limit: 10 }],
        },
        now,
      ),
    /immutable/iu,
  );
});

test("cache identity reuses equivalent plans but isolates tenants and publications", () => {
  const base = {
    normalizedPlanHash: "a".repeat(64),
    tenantId: "tenant-a",
    connectionSet: ["xero", "lightspeed"],
    publicationHash: "b".repeat(64),
    overlayVersion: "overlay-1",
    sourceWatermarks: { xero: "2", lightspeed: "1" },
  };
  assert.equal(
    semanticResultCacheKeyV2(base),
    semanticResultCacheKeyV2({
      ...base,
      connectionSet: ["lightspeed", "xero"],
      sourceWatermarks: { lightspeed: "1", xero: "2" },
    }),
  );
  assert.notEqual(
    semanticResultCacheKeyV2(base),
    semanticResultCacheKeyV2({ ...base, tenantId: "tenant-b" }),
  );
  assert.notEqual(
    semanticResultCacheKeyV2(base),
    semanticResultCacheKeyV2({ ...base, publicationHash: "c".repeat(64) }),
  );
});

test("semi-additive measures use one latest-per-entity window pass inside the selected period", () => {
  const input = workspace();
  input.blocks = [
    {
      id: "inventory",
      topicIds: ["business.inventory_health"],
      rootViewId: "inventory_health_day",
      dimensionIds: [
        "inventory_health_day.stock_location",
        "inventory_health_day.currency",
      ],
      measureIds: [
        "inventory.stock_on_hand_units",
        "inventory.stock_on_hand_value",
      ],
      filters: [],
      time: {
        dimensionId: "inventory_health_day.business_date",
        range: { type: "last_complete_month" },
      },
      sort: [],
      limit: 100,
      parameters: {},
    },
  ];
  const compiled = compileQueryWorkspaceV2(input, registry, {
    tenantId: "tenant-a",
    now,
    timezone: "Australia/Melbourne",
  });
  const query = compiled.queries[0]!;
  assert.equal(query.validationEvidence.snapshotMode, "latest_per_entity");
  assert.match(
    query.sql,
    /row_number\(\) over \(partition by "snapshot_source"\."tenant_id", "snapshot_source"\."product_variant_id", "snapshot_source"\."stock_location_id"/u,
  );
  assert.match(query.sql, /filter \(where "v0"\."__snapshot_rank_1" = 1\)/u);
  assert.match(query.sql, /filter \(where "v0"\."__snapshot_rank_2" = 1\)/u);
  assert.doesNotMatch(query.sql, /select max\(/iu);
  assert.equal(query.parameters[0], "tenant-a");
});

test("current-state source measures cannot masquerade as historical snapshots", () => {
  const input = workspace();
  input.blocks = [
    {
      id: "charges",
      topicIds: ["source.lightspeed.sales"],
      rootViewId: "source.lightspeed.ls_cc_charges",
      dimensionIds: [],
      measureIds: ["source.lightspeed.ls_cc_charges.refunded"],
      filters: [],
      time: { range: { type: "current_snapshot" } },
      sort: [],
      limit: 100,
      parameters: {},
    },
  ];
  const context = {
    tenantId: "tenant-a",
    now,
    timezone: "Australia/Melbourne",
    connectionSet: ["connection-a", "connection-b"],
  };
  const compiled = compileQueryWorkspaceV2(input, registry, context);
  assert.equal(
    compiled.queries[0]?.validationEvidence.snapshotMode,
    "current_only",
  );
  assert.match(compiled.queries[0]?.sql ?? "", /sum\("v0"\."refunded"\)/u);
  assert.match(compiled.queries[0]?.sql ?? "", /"v0"\."connection_id" in/u);
  assert.match(compiled.queries[0]?.sql ?? "", /"v0"\."tombstone" =/u);
  assert.match(
    compiled.queries[0]?.sql ?? "",
    /"v0"\."mapping_version" =/u,
  );
  assert.ok(compiled.queries[0]?.parameters.includes("2.0.0"));
  assert.deepEqual(compiled.queries[0]?.normalizedPlan.connectionSet, [
    "connection-a",
    "connection-b",
  ]);
  assert.doesNotMatch(compiled.queries[0]?.sql ?? "", /time_stamp.*(?:>=|<)/u);

  input.blocks[0]!.time = {
    dimensionId: "source.lightspeed.ls_cc_charges.time_stamp",
    range: { type: "last_complete_month" },
  };
  assert.throws(
    () => compileQueryWorkspaceV2(input, registry, context),
    /contains current state only/iu,
  );
  assert.throws(
    () =>
      compileQueryWorkspaceV2(
        {
          ...input,
          blocks: [
            {
              ...input.blocks[0]!,
              time: { range: { type: "current_snapshot" } },
            },
          ],
        },
        registry,
        {
          tenantId: "tenant-a",
          now,
          timezone: "Australia/Melbourne",
          connectionSet: [],
        },
      ),
    /trusted connection scope/iu,
  );
});

test("currency measures require one currency or an explicit currency grouping", () => {
  const input = workspace();
  input.blocks = [
    {
      id: "xero-invoices",
      topicIds: ["source.xero.invoicing"],
      rootViewId: "source.xero.xero_invoices",
      dimensionIds: [],
      measureIds: ["source.xero.xero_invoices.sub_total"],
      filters: [],
      time: {
        dimensionId: "source.xero.xero_invoices.date",
        range: { type: "last_complete_month" },
      },
      sort: [],
      limit: 100,
      parameters: {},
    },
  ];
  const context = {
    tenantId: "tenant-a",
    now,
    timezone: "Australia/Melbourne",
    connectionSet: ["xero-a"],
  };
  assert.throws(
    () => compileQueryWorkspaceV2(input, registry, context),
    /must be grouped by .*currency_code or filtered to one currency/iu,
  );
  input.blocks[0]!.dimensionIds = ["source.xero.xero_invoices.currency_code"];
  assert.deepEqual(
    compileQueryWorkspaceV2(input, registry, context).queries[0]?.normalizedPlan
      .dimensionIds,
    ["source.xero.xero_invoices.currency_code"],
  );
});

test("source joins are constrained to the trusted tenant and same connection without collapsing optional joins", () => {
  const relationship = {
    id: "source.lightspeed.cc_charge_sale",
    fromViewId: "source.lightspeed.ls_cc_charges",
    toViewId: "source.lightspeed.ls_sales",
    fromFieldId: "lightspeed.ls_cc_charges.sale_id",
    toFieldId: "lightspeed.ls_sales.sale_id",
    cardinality: "many_to_one" as const,
    optional: true,
    supportedDirections: ["from_to" as const],
    temporalBehavior: "current" as const,
    semanticState: "derived" as const,
    evidence: [`profile_receipt:${"a".repeat(64)}`],
  };
  const scopedRegistry = semanticRegistryDocumentV2Schema.parse({
    ...registry,
    relationships: [...registry.relationships, relationship],
    topics: registry.topics.map((topic) =>
      topic.id === "source.lightspeed.sales"
        ? {
            ...topic,
            relationshipIds: [...topic.relationshipIds, relationship.id],
          }
        : topic,
    ),
  });
  const input = workspace();
  input.publicationHash = semanticRegistryV2Digest(scopedRegistry);
  input.blocks = [
    {
      id: "charges",
      topicIds: ["source.lightspeed.sales"],
      rootViewId: "source.lightspeed.ls_cc_charges",
      dimensionIds: ["source.lightspeed.ls_sales.shop_id"],
      measureIds: ["source.lightspeed.ls_cc_charges.refunded"],
      filters: [],
      time: { range: { type: "current_snapshot" } },
      sort: [],
      limit: 100,
      parameters: {},
    },
  ];
  const compiled = compileQueryWorkspaceV2(input, scopedRegistry, {
    tenantId: "tenant-a",
    now,
    timezone: "Australia/Melbourne",
    connectionSet: ["connection-a", "connection-b"],
  });
  const sql = compiled.queries[0]!.sql;
  assert.match(
    sql,
    /left join "source_lightspeed"\."ls_sales" as "v1" on "v0"\."sale_id" = "v1"\."sale_id"/u,
  );
  assert.match(sql, /"v1"\."tenant_id" = "tenant_scope"\."tenant_id"/u);
  assert.match(sql, /"v0"\."connection_id" = "v1"\."connection_id"/u);
  assert.match(sql, /"v1"\."tombstone" =/u);
  assert.match(sql, /"v0"\."mapping_version" =/u);
  assert.match(sql, /"v1"\."mapping_version" =/u);
  assert.doesNotMatch(sql, /where[^]*"v1"\."tenant_id"/u);
});

test("composite Topics independently aggregate facts on conformed dimensions", () => {
  const input = workspace();
  input.blocks = [
    {
      id: "profitability",
      topicIds: ["composite.trading_profitability"],
      rootViewId: "commerce_sales_event",
      dimensionIds: [
        "commerce_sales_event.business_date",
        "commerce_sales_event.currency",
      ],
      measureIds: ["commerce.net_sales_ex_gst", "finance.accrued_revenue"],
      filters: [],
      time: {
        dimensionId: "commerce_sales_event.business_date",
        range: { type: "last_complete_month" },
      },
      sort: [],
      limit: 100,
      parameters: {},
    },
  ];
  const compiled = compileQueryWorkspaceV2(input, registry, {
    tenantId: "tenant-a",
    now,
    timezone: "Australia/Melbourne",
  });
  assert.equal(compiled.queries.length, 2);
  assert.equal(compiled.alignments[0]?.mode, "aggregate_then_align");
  const sales = compiled.queries.find(
    ({ normalizedPlan }) =>
      normalizedPlan.factViewId === "commerce_sales_event",
  )!;
  const finance = compiled.queries.find(
    ({ normalizedPlan }) =>
      normalizedPlan.factViewId === "finance_day_location",
  )!;
  assert.match(sales.sql, /from "mart"\."commerce_sales_event"/u);
  assert.match(finance.sql, /from "mart"\."finance_day_location"/u);
  assert.match(
    finance.sql,
    /"v0"\."business_date" as "commerce_sales_event.business_date"/u,
  );
  assert.ok(
    compiled.queries.every(
      ({ validationEvidence }) => validationEvidence.independentlyAggregated,
    ),
  );
});

test("every published Topic measure and dimension exposure is compiler-representable", () => {
  const views = new Map(registry.views.map((view) => [view.id, view]));
  const measures = new Map(
    registry.measures.map((measure) => [measure.id, measure]),
  );
  const dimensions = new Map(
    registry.dimensions.map((dimension) => [dimension.id, dimension]),
  );
  const failures: string[] = [];
  const timeFor = (viewId: string, topicId: string) => {
    const view = views.get(viewId)!;
    if (view.temporalAvailability === "current_only")
      return { range: { type: "current_snapshot" as const } };
    const topic = registry.topics.find(({ id }) => id === topicId)!;
    const dimensionId = view.timeRoleIds.find((id) =>
      topic.dimensionIds.includes(id),
    );
    if (!dimensionId)
      throw new Error(
        `${view.id} is historically queryable but has no governed time role.`,
      );
    return {
      dimensionId,
      range: { type: "last_complete_month" as const },
    };
  };
  const compileExposure = (
    topicId: string,
    measureId: string,
    dimensionIds: readonly string[],
  ) => {
    const measure = measures.get(measureId)!;
    const topic = registry.topics.find(({ id }) => id === topicId)!;
    const selectedDimensionIds = [...dimensionIds];
    if (measure.currencyFieldId) {
      const currencyDimension = registry.dimensions.find(
        ({ viewId, fieldId }) =>
          viewId === measure.viewId && fieldId === measure.currencyFieldId,
      );
      if (!currencyDimension || !topic.dimensionIds.includes(currencyDimension.id)) {
        failures.push(
          `${topicId} / ${measureId}: currency measure has no Topic-exposed currency dimension.`,
        );
        return;
      }
      if (!selectedDimensionIds.includes(currencyDimension.id))
        selectedDimensionIds.push(currencyDimension.id);
    }
    try {
      compileQueryWorkspaceV2(
        {
          ...workspace(`coverage-${topicId}-${measureId}`),
          blocks: [
            {
              id: "coverage",
              topicIds: [topicId],
              rootViewId: measure.viewId,
              dimensionIds: selectedDimensionIds,
              measureIds: [measureId],
              filters: [],
              time: timeFor(measure.viewId, topicId),
              sort: [],
              limit: 10,
              parameters: {},
            },
          ],
        },
        registry,
        {
          tenantId: "tenant-a",
          now,
          timezone: "Australia/Melbourne",
          connectionSet: ["connection-a"],
        },
      );
    } catch (error) {
      failures.push(
        `${topicId} / ${measureId}${dimensionIds.length ? ` / ${dimensionIds.join(",")}` : ""}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const topicByMeasure = new Map<string, (typeof registry.topics)[number]>();
  for (const measure of registry.measures) {
    const topic = registry.topics.find(
      ({ measureIds, viewIds }) =>
        measureIds.includes(measure.id) && viewIds.includes(measure.viewId),
    );
    if (!topic) {
      failures.push(`${measure.id}: no Topic exposes its owning view.`);
      continue;
    }
    topicByMeasure.set(measure.id, topic);
    if (measure.currencyFieldId) {
      const currencyDimension = registry.dimensions.find(
        ({ viewId, fieldId }) =>
          viewId === measure.viewId && fieldId === measure.currencyFieldId,
      );
      if (
        !currencyDimension ||
        !topic.dimensionIds.includes(currencyDimension.id)
      )
        failures.push(
          `${topic.id} / ${measure.id}: currency measure has no Topic-exposed currency dimension.`,
        );
    }
  }

  const representativeSourceMeasures = new Map<string, string>();
  for (const measure of registry.measures.filter(({ id }) =>
    id.startsWith("source."),
  ))
    if (!representativeSourceMeasures.has(measure.viewId))
      representativeSourceMeasures.set(measure.viewId, measure.id);
  const compileMeasureIds = new Set([
    ...registry.measures
      .filter(({ id }) => !id.startsWith("source."))
      .map(({ id }) => id),
    ...representativeSourceMeasures.values(),
  ]);
  for (const measureId of compileMeasureIds) {
    const topic = topicByMeasure.get(measureId);
    if (topic) compileExposure(topic.id, measureId, []);
  }

  for (const topic of registry.topics) {
    const representative = topic.measureIds.find((measureId) => {
      const measure = measures.get(measureId);
      return measure && topic.viewIds.includes(measure.viewId);
    });
    if (!representative) {
      failures.push(`${topic.id}: no measure is owned by an allowed Topic view.`);
      continue;
    }
    compileExposure(topic.id, representative, []);
  }

  for (const view of registry.views) {
    if (!registry.topics.some(({ viewIds }) => viewIds.includes(view.id)))
      continue;
    const dimensionId = view.dimensionIds[0];
    if (!dimensionId) continue;
    const topic = registry.topics.find(
      ({ dimensionIds, measureIds, viewIds }) =>
        viewIds.includes(view.id) &&
        dimensionIds.includes(dimensionId) &&
        measureIds.some(
          (measureId) => measures.get(measureId)?.viewId === view.id,
        ),
    );
    const sameViewMeasure = topic?.measureIds.find(
      (measureId) => measures.get(measureId)?.viewId === view.id,
    );
    if (!topic || !sameViewMeasure) {
      failures.push(
        `${view.id} / ${dimensionId}: no Topic measure can query this view's dimensions at their own grain.`,
      );
      continue;
    }
    assert.ok(dimensions.has(dimensionId));
    compileExposure(topic.id, sameViewMeasure, [dimensionId]);
  }

  assert.deepEqual(failures, []);
});
