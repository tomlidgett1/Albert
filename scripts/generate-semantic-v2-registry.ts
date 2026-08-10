import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createSemanticPublicationV2,
  importRegistryV1,
  semanticRegistryDocumentV2Schema,
  type SemanticRegistryDocumentV2,
  type SourceObjectV2,
} from "../packages/semantic-registry/src/v2.js";
import { parseRegistryDocument } from "../packages/semantic-registry/src/registry-build.js";

const projectRoot = resolve(import.meta.dirname, "..");
const inventoryPath = resolve(
  projectRoot,
  "packages/semantic-registry/registry/source-inventory.v2.json",
);
const registryPath = resolve(
  projectRoot,
  "packages/semantic-registry/registry/registry.yaml",
);
const outputPath = resolve(
  projectRoot,
  "packages/semantic-registry/registry/registry.v2.json",
);
const publicationPath = resolve(
  projectRoot,
  "packages/semantic-registry/registry/publication.v2.json",
);
const adminFallbackPath = resolve(
  projectRoot,
  "packages/semantic-registry/src/generated-v2-admin.ts",
);
const relationshipDecisionsPath = resolve(
  projectRoot,
  "packages/semantic-registry/registry/relationship-decisions.v2.json",
);
const omitRelationshipDecisions = process.argv.includes(
  "--without-relationship-decisions",
);

const inventory = JSON.parse(readFileSync(inventoryPath, "utf8")) as {
  sourceObjects: SourceObjectV2[];
};
const v1 = parseRegistryDocument(readFileSync(registryPath, "utf8"));
const excludedFactIds = new Set([
  "workforce_day_worker_location",
  "workforce_sales_aligned",
]);
const retainedFacts = v1.facts.filter(({ id }) => !excludedFactIds.has(id));
const retainedFactIds = new Set(retainedFacts.map(({ id }) => id));
const retainedMetrics = v1.metrics.filter(({ baseFact }) =>
  retainedFactIds.has(baseFact),
);
const retainedMetricIds = new Set(retainedMetrics.map(({ id }) => id));
const retainedTopics = v1.topics
  .filter((topic) => !topic.id.includes("workforce"))
  .map((topic) => ({
    ...topic,
    baseFacts: topic.baseFacts.filter((id) => retainedFactIds.has(id)),
    metrics: topic.metrics.filter((id) => retainedMetricIds.has(id)),
  }))
  .filter(
    (topic) =>
      topic.baseFacts.length >= (topic.composite ? 2 : 1) &&
      topic.metrics.length > 0,
  );
const imported = importRegistryV1({
  ...v1,
  facts: retainedFacts,
  metrics: retainedMetrics,
  topics: retainedTopics,
});

function viewId(source: SourceObjectV2): string {
  return `source.${source.id}`;
}

function dimensionId(source: SourceObjectV2, fieldId: string): string {
  return `${viewId(source)}.${fieldId.split(".").at(-1)}`;
}

function rowCountMeasureId(source: SourceObjectV2): string {
  return `${viewId(source)}.row_count`;
}

function sourceFieldMeasureId(
  source: SourceObjectV2,
  field: SourceObjectV2["fields"][number],
): string {
  return `${viewId(source)}.${field.name}`;
}

function snapshotPolicy(
  source: SourceObjectV2,
): SemanticRegistryDocumentV2["views"][number]["snapshotPolicy"] {
  if (source.additivity !== "semi_additive") return undefined;
  const timeField = source.fields.find(
    (field) => field.primaryKey && field.disposition === "time_role",
  );
  if (!timeField) return undefined;
  const entityFields = source.primaryKey
    .filter((name) => name !== timeField.name)
    .flatMap(
      (name) => source.fields.find((field) => field.name === name)?.id ?? [],
    );
  const tieBreaker =
    source.fields.find(({ name }) =>
      /update|modified|time_stamp/iu.test(name),
    ) ?? source.fields.find(({ primaryKey }) => primaryKey);
  if (entityFields.length === 0 || !tieBreaker) return undefined;
  return {
    timeFieldId: timeField.id,
    entityFieldIds: entityFields,
    tieBreakerFieldIds: [tieBreaker.id],
  };
}

function sourceMeasureSemantics(
  source: SourceObjectV2,
  field: SourceObjectV2["fields"][number],
) {
  const lower = field.name.toLowerCase();
  const snapshot = snapshotPolicy(source);
  const average =
    /(?:^|_)(?:rate|percent|percentage|ratio|unit_price|unit_cost|avg|average)(?:_|$)/u.test(
      lower,
    ) || source.additivity === "non_additive";
  const currentOnly = source.additivity === "semi_additive" && !snapshot;
  const aggregation = snapshot
    ? ("last_value" as const)
    : average
      ? ("average" as const)
      : ("sum" as const);
  const fn = snapshot
    ? ("last_value" as const)
    : average
      ? ("avg" as const)
      : ("sum" as const);
  const unit = /percent|percentage/u.test(lower)
    ? ("percent" as const)
    : /(?:^|_)(?:rate|ratio)(?:_|$)/u.test(lower)
      ? ("ratio" as const)
      : /hour/u.test(lower)
        ? ("hours" as const)
        : /day/u.test(lower)
          ? ("days" as const)
          : /qty|quantity|units?/u.test(lower)
            ? ("units" as const)
            : /price|cost|amount|total|value|balance|tax|discount|revenue|sales|profit|margin|debit|credit|paid|due/u.test(
                  lower,
                )
              ? ("currency" as const)
              : ("units" as const);
  return {
    aggregation,
    fn,
    unit,
    additivity:
      snapshot || currentOnly
        ? ("semi_additive" as const)
        : average
          ? ("non_additive" as const)
          : ("additive" as const),
  };
}

function timeRole(
  source: SourceObjectV2,
  field: SourceObjectV2["fields"][number],
) {
  if (field.disposition !== "time_role") return "none" as const;
  if (
    source.additivity === "semi_additive" &&
    source.additivityAxis === field.name
  )
    return "snapshot" as const;
  if (/complete/u.test(field.name)) return "completed" as const;
  if (/post/u.test(field.name)) return "posted" as const;
  if (/create/u.test(field.name)) return "created" as const;
  if (/update|modified/u.test(field.name)) return "updated" as const;
  return "event" as const;
}

function sourceConformedKey(
  field: SourceObjectV2["fields"][number],
): string | undefined {
  if (field.disposition === "time_role") return `calendar.${field.name}`;
  if (field.name === "currency" || field.name === "currency_code")
    return "finance.currency";
  return undefined;
}

function isQueryableSourceDimension(
  field: SourceObjectV2["fields"][number],
): boolean {
  return (
    !field.pii &&
    field.disposition !== "sensitive_metadata" &&
    ![
      "technical_lineage",
      "unsupported",
      "deprecated",
      "measure_input",
    ].includes(field.disposition)
  );
}

function isMaterializedSourceField(
  field: SourceObjectV2["fields"][number],
): boolean {
  return !["unsupported", "deprecated"].includes(field.disposition);
}

const sourceViews: SemanticRegistryDocumentV2["views"] =
  inventory.sourceObjects.map((source) => {
    const semanticDimensions = source.fields.filter(isQueryableSourceDimension);
    const sourceTimeRoleIds = semanticDimensions
      .filter(({ disposition }) => disposition === "time_role")
      .map((field) => dimensionId(source, field.id));
    return {
      id: viewId(source),
      label: source.label,
      description: source.description,
      sourceObjectId: source.id,
      physicalTable: source.physicalTable,
      grain: source.grain,
      primaryKey: source.primaryKey,
      tenantField: "tenant_id",
      connectionField: "connection_id",
      mappingVersion: source.mappingVersion,
      activeRecordFilter: { field: "tombstone", value: false },
      temporalAvailability: snapshotPolicy(source)
        ? "snapshot"
        : source.additivity === "semi_additive" || sourceTimeRoleIds.length === 0
          ? "current_only"
          : "historical",
      ...(snapshotPolicy(source)
        ? { snapshotPolicy: snapshotPolicy(source) }
        : {}),
      physicalFields: source.fields
        .filter(isMaterializedSourceField)
        .map((field) => ({
          id: field.id,
          physicalName: field.physicalName,
          dataType: field.dataType,
          semanticState: field.semanticState,
        })),
      dimensionIds: semanticDimensions.map((field) =>
        dimensionId(source, field.id),
      ),
      measureIds: [
        rowCountMeasureId(source),
        ...source.fields
          .filter(({ disposition }) => disposition === "measure_input")
          .map((field) => sourceFieldMeasureId(source, field)),
      ],
      relationshipIds: [],
      timeRoleIds: sourceTimeRoleIds,
      semanticState: source.semanticState,
    };
  });

const sourceDimensions: SemanticRegistryDocumentV2["dimensions"] =
  inventory.sourceObjects.flatMap((source) =>
    source.fields.filter(isQueryableSourceDimension).map((field) => ({
      id: dimensionId(source, field.id),
      viewId: viewId(source),
      fieldId: field.id,
      label: field.name.replaceAll("_", " "),
      description: field.description,
      synonyms: [],
      dataType: field.dataType,
      ...(sourceConformedKey(field)
        ? { conformedKey: sourceConformedKey(field) }
        : {}),
      timeRole: timeRole(source, field),
      semanticState: field.semanticState,
    })),
  );

const sourceMeasures: SemanticRegistryDocumentV2["measures"] =
  inventory.sourceObjects.flatMap((source) => [
    {
      id: rowCountMeasureId(source),
      viewId: viewId(source),
      label: `${source.label} rows`,
      description: `Count of source rows at the documented grain: ${source.grain}. This is a discoverability measure, not a business KPI.`,
      synonyms: ["record count", "row count"],
      grain: source.grain,
      unit: "count" as const,
      aggregation: "count" as const,
      additivity: "additive" as const,
      expression: { op: "aggregate" as const, fn: "count" as const },
      semanticState:
        source.semanticState === "verified"
          ? ("verified" as const)
          : ("exploratory" as const),
      authority: `${source.connector} source object ${source.id}`,
      riskTier: "tier_3" as const,
      testIds: [`${rowCountMeasureId(source)}.non_negative`],
    },
    ...source.fields
      .filter(({ disposition }) => disposition === "measure_input")
      .map((field) => {
        const semantics = sourceMeasureSemantics(source, field);
        const currencyField =
          semantics.unit === "currency"
            ? source.fields.find(
                ({ name }) => name === "currency_code" || name === "currency",
              )
            : undefined;
        return {
          id: sourceFieldMeasureId(source, field),
          viewId: viewId(source),
          label: field.name.replaceAll("_", " "),
          description: `Exploratory aggregation of ${field.description} The aggregation is constrained by the documented source grain and is not a certified business KPI.`,
          synonyms: [],
          grain: source.grain,
          unit: semantics.unit,
          aggregation: semantics.aggregation,
          additivity: semantics.additivity,
          ...(currencyField ? { currencyFieldId: currencyField.id } : {}),
          expression: {
            op: "aggregate" as const,
            fn: semantics.fn,
            fieldId: field.id,
          },
          semanticState: "exploratory" as const,
          authority: `${source.connector} source field ${field.id}`,
          riskTier:
            semantics.unit === "currency"
              ? ("tier_2" as const)
              : ("tier_3" as const),
          testIds: [`${sourceFieldMeasureId(source, field)}.source_grain`],
        };
      }),
  ]);

const sourceByConnectorDomain = new Map<string, SourceObjectV2[]>();
for (const source of inventory.sourceObjects) {
  const key = `${source.connector}.${source.domain}`;
  sourceByConnectorDomain.set(key, [
    ...(sourceByConnectorDomain.get(key) ?? []),
    source,
  ]);
}

const sourceTopics: SemanticRegistryDocumentV2["topics"] = [
  ...sourceByConnectorDomain.entries(),
]
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([key, sources]) => {
    const sorted = [...sources].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    return {
      id: `source.${key}`,
      layer: "source_domain",
      label: `${key.replace(".", " ")} source`,
      description: `Complete documented ${key} source catalogue. Fields remain exploratory until promoted into governed business measures.`,
      aiContext:
        "Use this Topic for source discoverability and narrowly scoped source questions. Do not reinterpret row counts or raw fields as certified business KPIs.",
      defaultRootViewId: viewId(sorted[0]!),
      viewIds: sorted.map(viewId),
      relationshipIds: [],
      dimensionIds: sorted.flatMap(
        (source) =>
          sourceViews.find(({ id }) => id === viewId(source))?.dimensionIds ??
          [],
      ),
      measureIds: sorted.flatMap(
        (source) =>
          sourceViews.find(({ id }) => id === viewId(source))?.measureIds ?? [],
      ),
      defaultFilters: [],
      freshnessMinutes: 24 * 60,
      sampleQuestions: [`How many source records are available in ${key}?`],
      ambiguityNotes: [
        "Raw source fields may not use the same recognition date, sign, tax, status, or grain as a certified business metric.",
      ],
      unsupportedQuestions: [
        "Certified financial or performance conclusions from an unpromoted raw source field.",
      ],
      alignOnDimensionIds: [],
      semanticState: "verified",
    };
  });

type CandidateTarget =
  SemanticRegistryDocumentV2["relationshipCandidates"][number]["targets"][number];
const candidateKeyTargets = inventory.sourceObjects.flatMap((source) => {
  if (source.primaryKey.length !== 1) return [];
  const field = source.fields.find(
    ({ name, disposition }) =>
      name === source.primaryKey[0] &&
      !["unsupported", "deprecated"].includes(disposition),
  );
  return field ? [{ source, field }] : [];
});

function candidateMatchKind(
  source: SourceObjectV2,
  field: SourceObjectV2["fields"][number],
  target: (typeof candidateKeyTargets)[number],
): CandidateTarget["matchKind"] | null {
  // Identifier-like names do not make unlike physical types comparable. This
  // rejects traps such as Lightspeed's text item_vendor_id (a supplier SKU)
  // being inferred as a numeric vendor_id relationship.
  if (field.dataType !== target.field.dataType) return null;
  if (field.name === target.field.name) return "exact_key_name";
  // A generic key named `id` carries no entity semantics: allowing every
  // `*_id` field to match it creates an all-to-all candidate explosion. Such
  // sources require a documented target rather than suffix inference.
  if (
    target.field.name !== "id" &&
    field.name.endsWith(`_${target.field.name}`)
  )
    return "role_prefixed_key";
  if (
    source.id === target.source.id &&
    field.name === "parent_id" &&
    target.field.name.endsWith("_id")
  )
    return "self_parent_key";
  return null;
}

const relationshipCandidates: SemanticRegistryDocumentV2["relationshipCandidates"] =
  inventory.sourceObjects.flatMap((source) =>
    source.fields
      .filter(
        (field) =>
          field.name.endsWith("_id") &&
          !field.primaryKey &&
          isMaterializedSourceField(field) &&
          !["tenant_id", "connection_id", "sync_run_id"].includes(field.name),
      )
      .map((field) => {
        const targets = candidateKeyTargets
          .flatMap((target) => {
            if (target.source.connector !== source.connector) return [];
            const matchKind = candidateMatchKind(source, field, target);
            return matchKind
              ? [
                  {
                    viewId: viewId(target.source),
                    fieldId: target.field.id,
                    matchKind,
                  } satisfies CandidateTarget,
                ]
              : [];
          })
          .sort((left, right) =>
            `${left.viewId}:${left.fieldId}`.localeCompare(
              `${right.viewId}:${right.fieldId}`,
            ),
          );
        const candidateViewIds = [
          ...new Set(targets.map(({ viewId: targetViewId }) => targetViewId)),
        ];
        return {
          id: `candidate.${source.connector}.${source.id.split(".")[1]}.${field.name}`,
          fromViewId: viewId(source),
          fromFieldId: field.id,
          targets,
          candidateViewIds,
          disposition: "unresolved" as const,
          reason:
            targets.length === 0
              ? "No exact, role-prefixed, or self-parent single-column primary key target was inferred; source documentation or domain review is required."
              : targets.length === 1
                ? "A key-compatible target exists, but uniqueness, orphan rate, multiplicity, and temporal behavior have not yet been profiled."
                : "Multiple key-compatible targets exist; live profiling and domain review must select or reject each candidate.",
          evidence: [
            `Candidate source and target keys were inferred from governed source contracts for ${field.id}; inference alone never authorizes a join.`,
          ],
        };
      }),
  );

type BusinessTopicSeed = Readonly<{
  id: string;
  label: string;
  description: string;
  sourceDomains: readonly string[];
  v1TopicIds?: readonly string[];
  extraMeasureIds?: readonly string[];
  sample: string;
}>;
const businessSeeds: readonly BusinessTopicSeed[] = [
  {
    id: "business.sales_performance",
    label: "Sales performance",
    description:
      "Revenue, transactions, units, tax, refunds, tenders, stores and trading periods.",
    sourceDomains: [
      "lightspeed.sales",
      "lightspeed.registers",
      "lightspeed.taxreports",
    ],
    v1TopicIds: ["sales_performance"],
    extraMeasureIds: ["commerce.tender_amount"],
    sample: "Why did sales change last month?",
  },
  {
    id: "business.product_category_performance",
    label: "Product and category performance",
    description:
      "Product, matrix, category and line-level trading performance.",
    sourceDomains: ["lightspeed.catalogue", "lightspeed.sales"],
    v1TopicIds: ["sales_performance", "merchandising"],
    sample: "Which categories drove the sales change?",
  },
  {
    id: "business.gross_margin_discounting",
    label: "Gross margin and discounting",
    description:
      "Gross profit, cost basis, pricing, discount and return behaviour.",
    sourceDomains: ["lightspeed.sales", "lightspeed.catalogue"],
    v1TopicIds: ["sales_performance"],
    sample: "Where is margin leaking through discounts?",
  },
  {
    id: "business.inventory_health",
    label: "Inventory health",
    description:
      "Stock position, availability, ageing, sell-through and stockout opportunity.",
    sourceDomains: ["lightspeed.inventory", "lightspeed.catalogue"],
    v1TopicIds: ["inventory_health", "merchandising"],
    sample: "What stockouts are costing us the most?",
  },
  {
    id: "business.purchasing_suppliers",
    label: "Purchasing and suppliers",
    description:
      "Orders, receipts, suppliers, lead times and purchasing performance.",
    sourceDomains: ["lightspeed.purchasing", "xero.purchasing_items"],
    sample: "Which suppliers have weak fill rates?",
  },
  {
    id: "business.customers_retention",
    label: "Customers and retention",
    description: "Customer acquisition, repeat purchase, cohorts and value.",
    sourceDomains: [
      "lightspeed.customers",
      "lightspeed.sales",
      "xero.contacts_dir",
    ],
    v1TopicIds: ["customers_retention"],
    sample: "Are new customers returning?",
  },
  {
    id: "business.store_employee_performance",
    label: "Store and employee performance",
    description:
      "Store, register and employee-attributed Lightspeed performance.",
    sourceDomains: [
      "lightspeed.org",
      "lightspeed.registers",
      "lightspeed.sales",
    ],
    v1TopicIds: ["sales_performance"],
    sample: "Which stores contributed most to growth?",
  },
  {
    id: "business.cash_banking",
    label: "Cash and banking",
    description: "Xero bank transactions, balances and cash movement.",
    sourceDomains: ["xero.banking", "xero.payments_credits"],
    v1TopicIds: ["profitability_cash"],
    sample: "What changed in cash receipts?",
  },
  {
    id: "business.receivables",
    label: "Receivables",
    description:
      "Invoices, credit notes, contacts, payments and overdue receivables.",
    sourceDomains: [
      "xero.invoicing",
      "xero.payments_credits",
      "xero.contacts_dir",
    ],
    v1TopicIds: ["profitability_cash"],
    sample: "Who owes us money and how overdue is it?",
  },
  {
    id: "business.payables_expenses",
    label: "Payables and expenses",
    description: "Bills, supplier payments, expenses and payables.",
    sourceDomains: [
      "xero.invoicing",
      "xero.payments_credits",
      "xero.purchasing_items",
    ],
    v1TopicIds: ["profitability_cash"],
    sample: "Which expense categories increased?",
  },
  {
    id: "business.financial_performance",
    label: "Financial performance",
    description:
      "Accrual and cash financial performance from governed Xero measures.",
    sourceDomains: ["xero.ledger_config", "xero.invoicing", "xero.banking"],
    v1TopicIds: ["profitability_cash"],
    sample: "What drove operating profit this quarter?",
  },
  {
    id: "business.gst_tax",
    label: "GST and tax",
    description: "GST collected, paid, tax rates and tax reporting periods.",
    sourceDomains: [
      "lightspeed.taxreports",
      "xero.ledger_config",
      "xero.invoicing",
    ],
    v1TopicIds: ["profitability_cash"],
    sample: "How much GST was collected and paid?",
  },
];

const allViews = [...imported.views, ...sourceViews];
const allDimensions = [...imported.dimensions, ...sourceDimensions];
const allMeasures = [...imported.measures, ...sourceMeasures];
const importedTopics = new Map(
  imported.topics.map((topic) => [topic.id, topic]),
);

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
function topicParts(seed: BusinessTopicSeed) {
  const sourceParts = seed.sourceDomains.flatMap((domain) => {
    const topic = sourceTopics.find(({ id }) => id === `source.${domain}`);
    return topic ? [topic] : [];
  });
  const governedParts = (seed.v1TopicIds ?? []).flatMap((id) => {
    const topic = importedTopics.get(id);
    return topic ? [topic] : [];
  });
  const parts = [...governedParts, ...sourceParts];
  return { parts, governedParts };
}

const businessTopics: SemanticRegistryDocumentV2["topics"] = businessSeeds.map(
  (seed) => {
    const { parts, governedParts } = topicParts(seed);
    const measureIds = unique([
      ...parts.flatMap(({ measureIds }) => measureIds),
      ...(seed.extraMeasureIds ?? []),
    ]);
    const measureViewIds = measureIds.flatMap(
      (id) => allMeasures.find((measure) => measure.id === id)?.viewId ?? [],
    );
    return {
      id: seed.id,
      layer: "business",
      label: seed.label,
      description: seed.description,
      aiContext: `Prefer governed measures in this Topic. Raw source views are included for discoverability and must remain Exploratory until promoted. ${seed.description}`,
      defaultRootViewId:
        governedParts[0]?.defaultRootViewId ?? parts[0]!.defaultRootViewId,
      viewIds: unique([
        ...parts.flatMap(({ viewIds }) => viewIds),
        ...measureViewIds,
      ]),
      relationshipIds: unique(
        parts.flatMap(({ relationshipIds }) => relationshipIds),
      ),
      dimensionIds: unique([
        ...parts.flatMap(({ dimensionIds }) => dimensionIds),
        ...allDimensions
          .filter(({ viewId }) => measureViewIds.includes(viewId))
          .map(({ id }) => id),
      ]),
      measureIds,
      defaultFilters: [],
      freshnessMinutes: Math.min(
        ...parts.map(({ freshnessMinutes }) => freshnessMinutes),
      ),
      sampleQuestions: [seed.sample],
      ambiguityNotes: unique(
        parts.flatMap(({ ambiguityNotes }) => ambiguityNotes),
      ),
      unsupportedQuestions: unique(
        parts.flatMap(({ unsupportedQuestions }) => unsupportedQuestions),
      ),
      alignOnDimensionIds: [],
      semanticState: governedParts.length ? "derived" : "exploratory",
    };
  },
);

type CompositeSeed = Readonly<{
  id: string;
  label: string;
  description: string;
  businessTopicIds: readonly string[];
  extraMeasureIds?: readonly string[];
  sample: string;
}>;
const compositeSeeds: readonly CompositeSeed[] = [
  {
    id: "composite.trading_profitability",
    label: "Trading profitability",
    description:
      "Lightspeed trading revenue and margin aligned to Xero operating expenses and accounting profit.",
    businessTopicIds: [
      "business.sales_performance",
      "business.financial_performance",
    ],
    sample: "How can we improve profitability?",
  },
  {
    id: "composite.pos_accounting_revenue",
    label: "POS-to-accounting revenue reconciliation",
    description:
      "Independently aggregated Lightspeed revenue and Xero revenue postings with explicit residuals.",
    businessTopicIds: [
      "business.sales_performance",
      "business.financial_performance",
    ],
    extraMeasureIds: ["composites.pos_to_ledger_variance"],
    sample: "Does POS revenue reconcile to Xero?",
  },
  {
    id: "composite.sales_bank",
    label: "Sales-to-bank reconciliation",
    description:
      "Lightspeed sales and tenders aligned to Xero settlements and bank movement.",
    businessTopicIds: ["business.sales_performance", "business.cash_banking"],
    extraMeasureIds: ["composites.pos_to_bank_variance"],
    sample: "Do sales reconcile to bank deposits?",
  },
  {
    id: "composite.inventory_cogs",
    label: "Inventory and COGS",
    description:
      "Lightspeed stock and purchasing aligned to Xero COGS postings.",
    businessTopicIds: [
      "business.inventory_health",
      "business.purchasing_suppliers",
      "business.financial_performance",
    ],
    sample: "Does inventory movement explain COGS?",
  },
  {
    id: "composite.customer_accounting",
    label: "Customer-to-accounting reconciliation",
    description:
      "Lightspeed customers and sales aligned to Xero contacts, invoices and receipts.",
    businessTopicIds: ["business.customers_retention", "business.receivables"],
    sample: "Which customer balances do not reconcile?",
  },
  {
    id: "composite.cash_conversion",
    label: "Cash conversion and working capital",
    description:
      "Trading, inventory, receivables, payables and cash conversion across Lightspeed and Xero.",
    businessTopicIds: [
      "business.sales_performance",
      "business.inventory_health",
      "business.receivables",
      "business.payables_expenses",
      "business.cash_banking",
    ],
    sample: "What is slowing cash conversion?",
  },
];

const businessById = new Map(businessTopics.map((topic) => [topic.id, topic]));
const compositeTopics: SemanticRegistryDocumentV2["topics"] =
  compositeSeeds.map((seed) => {
    const parts = seed.businessTopicIds
      .map((id) => businessById.get(id)!)
      .filter(Boolean);
    const measureIds = unique([
      ...parts.flatMap(({ measureIds }) => measureIds),
      ...(seed.extraMeasureIds ?? []),
    ]);
    const extraMeasureViewIds = measureIds.flatMap(
      (id) => allMeasures.find((measure) => measure.id === id)?.viewId ?? [],
    );
    const alignOnDimensionIds = unique(
      [
        ...parts.flatMap((part) => {
          const preferred = `${part.defaultRootViewId}.business_date`;
          return part.dimensionIds.includes(preferred) ? [preferred] : [];
        }),
        ...parts
          .flatMap(({ dimensionIds }) => dimensionIds)
          .filter(
            (id) =>
              allDimensions.find((dimension) => dimension.id === id)
                ?.conformedKey === "finance.currency",
          ),
      ],
    );
    return {
      id: seed.id,
      layer: "composite",
      label: seed.label,
      description: seed.description,
      aiContext: `${seed.description} Aggregate every source fact independently before alignment. Never infer event identity or timing equivalence from equal totals alone.`,
      defaultRootViewId: parts[0]!.defaultRootViewId,
      viewIds: unique([
        ...parts.flatMap(({ viewIds }) => viewIds),
        ...extraMeasureViewIds,
      ]),
      relationshipIds: unique(
        parts.flatMap(({ relationshipIds }) => relationshipIds),
      ),
      dimensionIds: unique([
        ...parts.flatMap(({ dimensionIds }) => dimensionIds),
        ...allDimensions
          .filter(({ viewId }) => extraMeasureViewIds.includes(viewId))
          .map(({ id }) => id),
      ]),
      measureIds,
      defaultFilters: [],
      freshnessMinutes: Math.min(
        ...parts.map(({ freshnessMinutes }) => freshnessMinutes),
      ),
      sampleQuestions: [seed.sample],
      ambiguityNotes: [
        "Recognition date, tax basis, status, currency and source authority must be resolved before alignment.",
      ],
      unsupportedQuestions: [
        "Direct raw fact-to-fact joins or reconciliation without disclosed unmatched coverage.",
      ],
      alignOnDimensionIds,
      semanticState: "derived",
    };
  });

const unresolvedDocument = semanticRegistryDocumentV2Schema.parse({
  schemaVersion: 2,
  registryVersion: "2.0.0",
  sourceObjects: inventory.sourceObjects,
  views: allViews,
  dimensions: allDimensions,
  measures: allMeasures,
  relationships: imported.relationships,
  relationshipCandidates,
  topics: [...sourceTopics, ...businessTopics, ...compositeTopics],
  businessContext: [
    {
      id: "calendar.timezone",
      label: "Timezone",
      description: "Tenant reporting timezone.",
      valueType: "string",
      source: "system",
      semanticState: "verified",
    },
    {
      id: "calendar.week_start",
      label: "Week start",
      description: "ISO weekday that begins a reporting week.",
      valueType: "number",
      source: "operator",
      semanticState: "derived",
    },
    {
      id: "calendar.fiscal_year_start",
      label: "Fiscal year start",
      description: "Tenant fiscal-year start date.",
      valueType: "string",
      source: "operator",
      semanticState: "derived",
    },
    {
      id: "tax.gst_basis",
      label: "GST basis",
      description: "GST-inclusive or GST-exclusive reporting convention.",
      valueType: "string",
      source: "tenant_confirmation",
      semanticState: "derived",
    },
    {
      id: "finance.reporting_basis",
      label: "Reporting basis",
      description: "Cash or accrual basis used for the question.",
      valueType: "string",
      source: "tenant_confirmation",
      semanticState: "derived",
    },
    {
      id: "margin.cost_basis",
      label: "Cost basis",
      description: "FIFO, average or other governed cost basis.",
      valueType: "string",
      source: "tenant_confirmation",
      semanticState: "derived",
    },
    {
      id: "business.targets",
      label: "Targets",
      description: "Versioned business targets and budgets.",
      valueType: "string_list",
      source: "operator",
      semanticState: "exploratory",
    },
    {
      id: "business.priorities",
      label: "Priorities",
      description:
        "Current strategic priorities and controllability constraints.",
      valueType: "string_list",
      source: "operator",
      semanticState: "exploratory",
    },
    {
      id: "reconciliation.pos_xero_tolerance",
      label: "POS to Xero tolerance",
      description:
        "Maximum governed absolute variance accepted when reconciling independently aggregated POS revenue and Xero revenue.",
      valueType: "currency",
      source: "operator",
      semanticState: "derived",
    },
    {
      id: "reconciliation.sales_bank_tolerance",
      label: "Sales to bank tolerance",
      description:
        "Maximum governed absolute variance accepted after explicit settlement timing and fee adjustments.",
      valueType: "currency",
      source: "operator",
      semanticState: "derived",
    },
  ],
});
type RelationshipDecision =
  | Readonly<{
      candidateId: string;
      disposition: "promote";
      targetViewId: string;
      targetFieldId: string;
      optional: boolean;
      temporalBehavior: "not_applicable";
      topicIds: readonly string[];
      reason: string;
    }>
  | Readonly<{
      candidateId: string;
      disposition: "reject";
      reason: string;
    }>;
type RelationshipDecisionManifest = Readonly<{
  schemaVersion: 1;
  basePublicationHash: string;
  profileReceiptHash: string;
  reviewDigest: string;
  certifiedSourceObjectIds: readonly string[];
  decisions: readonly RelationshipDecision[];
}>;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry)]),
    );
  return value;
}

function relationshipReviewDigest(
  manifest: Omit<RelationshipDecisionManifest, "reviewDigest">,
): string {
  return createHash("sha256")
    .update("albert-semantic-v2-relationship-review\0")
    .update(JSON.stringify(canonical(manifest)))
    .digest("hex");
}

function applyRelationshipDecisions(
  base: SemanticRegistryDocumentV2,
  rawManifest: unknown,
): SemanticRegistryDocumentV2 {
  if (!rawManifest || typeof rawManifest !== "object" || Array.isArray(rawManifest))
    throw new Error("Relationship decision ledger must be a JSON object.");
  const manifest = rawManifest as RelationshipDecisionManifest;
  const basePublicationHash = createSemanticPublicationV2(base).publicationHash;
  if (
    manifest.schemaVersion !== 1 ||
    manifest.basePublicationHash !== basePublicationHash ||
    !/^[a-f0-9]{64}$/u.test(manifest.profileReceiptHash) ||
    !Array.isArray(manifest.decisions) ||
    manifest.reviewDigest !==
      relationshipReviewDigest({
        schemaVersion: manifest.schemaVersion,
        basePublicationHash: manifest.basePublicationHash,
        profileReceiptHash: manifest.profileReceiptHash,
        certifiedSourceObjectIds: manifest.certifiedSourceObjectIds,
        decisions: manifest.decisions,
      })
  )
    throw new Error(
      "Relationship decision ledger is stale, malformed, or failed its content-addressed review digest.",
    );
  const decisionByCandidate = new Map(
    manifest.decisions.map((decision) => [decision.candidateId, decision]),
  );
  if (
    decisionByCandidate.size !== base.relationshipCandidates.length ||
    manifest.decisions.length !== base.relationshipCandidates.length ||
    base.relationshipCandidates.some(({ id }) => !decisionByCandidate.has(id))
  )
    throw new Error(
      "Relationship decision ledger must resolve every candidate exactly once.",
    );
  if (
    !Array.isArray(manifest.certifiedSourceObjectIds) ||
    new Set(manifest.certifiedSourceObjectIds).size !==
      base.sourceObjects.length ||
    base.sourceObjects.some(
      ({ id }) => !manifest.certifiedSourceObjectIds.includes(id),
    )
  )
    throw new Error(
      "Relationship decision ledger must bind structural certification for every live-profiled source object.",
    );

  const clone = structuredClone(base);
  const certifiedSources = new Set(manifest.certifiedSourceObjectIds);
  for (const source of clone.sourceObjects) {
    if (!certifiedSources.has(source.id)) continue;
    source.semanticState = "verified";
    const structuralFields = new Set(
      source.fields
        .filter(({ disposition }) =>
          ["key", "time_role", "status_filter"].includes(disposition),
        )
        .map(({ id }) => id),
    );
    for (const field of source.fields)
      if (structuralFields.has(field.id)) field.semanticState = "verified";
    const sourceView = clone.views.find(
      ({ sourceObjectId }) => sourceObjectId === source.id,
    );
    if (!sourceView) continue;
    sourceView.semanticState = "verified";
    for (const physicalField of sourceView.physicalFields)
      if (structuralFields.has(physicalField.id))
        physicalField.semanticState = "verified";
    for (const dimension of clone.dimensions)
      if (
        dimension.viewId === sourceView.id &&
        structuralFields.has(dimension.fieldId)
      )
        dimension.semanticState = "verified";
    const rowCount = clone.measures.find(
      ({ id }) => id === `${sourceView.id}.row_count`,
    );
    if (rowCount) rowCount.semanticState = "verified";
  }
  for (const candidate of clone.relationshipCandidates) {
    const decision = decisionByCandidate.get(candidate.id)!;
    if (
      !decision.reason?.trim() ||
      (decision.disposition !== "promote" && decision.disposition !== "reject")
    )
      throw new Error(`Relationship decision ${candidate.id} is invalid.`);
    if (decision.disposition === "reject") {
      candidate.disposition = "rejected";
      candidate.reason = decision.reason;
      candidate.evidence = [
        ...candidate.evidence,
        `operator_review:${manifest.reviewDigest}`,
        `profile_receipt:${manifest.profileReceiptHash}`,
      ];
      continue;
    }
    const target = candidate.targets.find(
      ({ viewId, fieldId }) =>
        viewId === decision.targetViewId && fieldId === decision.targetFieldId,
    );
    if (!target)
      throw new Error(
        `Relationship promotion ${candidate.id} does not name an explicit candidate target.`,
      );
    if (
      decision.temporalBehavior !== "not_applicable" ||
      new Set(decision.topicIds).size !== decision.topicIds.length
    )
      throw new Error(`Relationship promotion ${candidate.id} is malformed.`);
    const relationshipId = candidate.id.replace(
      /^candidate\./u,
      "relationship.",
    );
    clone.relationships.push({
      id: relationshipId,
      fromViewId: candidate.fromViewId,
      toViewId: decision.targetViewId,
      fromFieldId: candidate.fromFieldId,
      toFieldId: decision.targetFieldId,
      cardinality: "many_to_one",
      optional: decision.optional,
      supportedDirections: ["from_to"],
      temporalBehavior: decision.temporalBehavior,
      semanticState: "verified",
      evidence: [
        `profile_receipt:${manifest.profileReceiptHash}`,
        `candidate_match:${target.matchKind}`,
        `operator_review:${manifest.reviewDigest}`,
        decision.reason,
      ],
    });
    for (const viewId of [candidate.fromViewId, decision.targetViewId]) {
      const view = clone.views.find(({ id }) => id === viewId);
      if (!view) throw new Error(`Relationship ${candidate.id} has no view ${viewId}.`);
      view.relationshipIds = [...new Set([...view.relationshipIds, relationshipId])];
    }
    for (const topicId of decision.topicIds) {
      const topic = clone.topics.find(({ id }) => id === topicId);
      if (
        !topic ||
        !topic.viewIds.includes(candidate.fromViewId) ||
        !topic.viewIds.includes(decision.targetViewId)
      )
        throw new Error(
          `Relationship ${candidate.id} cannot be exposed by Topic ${topicId}.`,
        );
      topic.relationshipIds = [
        ...new Set([...topic.relationshipIds, relationshipId]),
      ];
    }
    candidate.disposition = "verified";
    candidate.reason = decision.reason;
    candidate.evidence = [
      ...candidate.evidence,
      `profile_receipt:${manifest.profileReceiptHash}`,
      `operator_review:${manifest.reviewDigest}`,
    ];
  }
  return semanticRegistryDocumentV2Schema.parse(clone);
}

const document =
  existsSync(relationshipDecisionsPath) && !omitRelationshipDecisions
  ? applyRelationshipDecisions(
      unresolvedDocument,
      JSON.parse(readFileSync(relationshipDecisionsPath, "utf8")),
    )
  : unresolvedDocument;
const publication = createSemanticPublicationV2(document);
const adminFallback = {
  publicationHash: publication.publicationHash,
  registryVersion: publication.registryVersion,
  objectCounts: publication.objectCounts,
  semanticStateCounts: Object.fromEntries(
    ["verified", "derived", "exploratory", "unsupported", "deprecated"].map(
      (state) => [
        state,
        [
          ...document.sourceObjects,
          ...document.sourceObjects.flatMap(({ fields }) => fields),
          ...document.views,
          ...document.dimensions,
          ...document.measures,
          ...document.relationships,
          ...document.topics,
        ].filter((item) => item.semanticState === state).length,
      ],
    ),
  ),
  fieldDispositionCounts: Object.fromEntries(
    [
      ...new Set(
        document.sourceObjects.flatMap(({ fields }) =>
          fields.map(({ disposition }) => disposition),
        ),
      ),
    ]
      .sort()
      .map((disposition) => [
        disposition,
        document.sourceObjects
          .flatMap(({ fields }) => fields)
          .filter((field) => field.disposition === disposition).length,
      ]),
  ),
  sourceConnectorCounts: Object.fromEntries(
    ["lightspeed", "xero"].map((connector) => [
      connector,
      {
        objects: document.sourceObjects.filter(
          (source) => source.connector === connector,
        ).length,
        fields: document.sourceObjects
          .filter((source) => source.connector === connector)
          .reduce((total, source) => total + source.fields.length, 0),
      },
    ]),
  ),
  sources: document.sourceObjects.map((source) => ({
    id: source.id,
    connector: source.connector,
    domain: source.domain,
    label: source.label,
    description: source.description,
    grain: source.grain,
    additivity: source.additivity,
    semanticState: source.semanticState,
    fieldCount: source.fields.length,
    fields: source.fields.map((field) => ({
      id: field.id,
      name: field.name,
      dataType: field.dataType,
      disposition: field.disposition,
      semanticState: field.semanticState,
      nullable: field.nullable,
      primaryKey: field.primaryKey,
      pii: field.pii,
    })),
  })),
  relationships: document.relationships,
  relationshipCandidates: document.relationshipCandidates,
  views: document.views.map((view) => ({
    id: view.id,
    label: view.label,
    description: view.description,
    grain: view.grain,
    physicalTable: view.physicalTable,
    semanticState: view.semanticState,
    dimensionCount: view.dimensionIds.length,
    measureCount: view.measureIds.length,
    relationshipCount: view.relationshipIds.length,
  })),
  measures: document.measures.map((measure) => ({
    id: measure.id,
    label: measure.label,
    description: measure.description,
    viewId: measure.viewId,
    unit: measure.unit,
    aggregation: measure.aggregation,
    additivity: measure.additivity,
    semanticState: measure.semanticState,
    riskTier: measure.riskTier,
    authority: measure.authority,
  })),
  topics: document.topics.map((topic) => ({
    id: topic.id,
    label: topic.label,
    description: topic.description,
    layer: topic.layer,
    semanticState: topic.semanticState,
    viewCount: topic.viewIds.length,
    dimensionCount: topic.dimensionIds.length,
    measureCount: topic.measureIds.length,
    sampleQuestions: topic.sampleQuestions,
  })),
  businessContext: document.businessContext,
};
const outputs = [
  [outputPath, `${JSON.stringify(document, null, 2)}\n`],
  [publicationPath, `${JSON.stringify(publication, null, 2)}\n`],
  [
    adminFallbackPath,
    `// Generated by scripts/generate-semantic-v2-registry.ts. Do not hand-edit.\nexport const SEMANTIC_V2_ADMIN_FALLBACK = ${JSON.stringify(adminFallback)} as const;\n`,
  ],
] as const;
if (process.argv.includes("--check")) {
  const stale = outputs
    .filter(([path, content]) => readFileSync(path, "utf8") !== content)
    .map(([path]) => path);
  if (stale.length)
    throw new Error(
      `Semantic V2 generated artifacts are stale: ${stale.join(", ")}. Run npm run registry:v2:generate.`,
    );
  process.stdout.write(
    `Semantic Registry V2 ${publication.publicationHash} is fresh.\n`,
  );
} else {
  for (const [path, content] of outputs) writeFileSync(path, content);
  process.stdout.write(
    `Generated registry V2 ${publication.publicationHash}: ${publication.objectCounts.sourceObjects} sources, ${publication.objectCounts.fields} fields, ${publication.objectCounts.views} views, ${publication.objectCounts.measures} measures, ${publication.objectCounts.topics} Topics, ${publication.objectCounts.relationshipCandidates} relationship candidates.\n`,
  );
}
