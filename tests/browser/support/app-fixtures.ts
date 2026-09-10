import type { Page } from "@playwright/test";
import {
  createDeterministicFixtureTrace,
  FIXTURE_RESULT_ID,
} from "../../../services/conversation/src/fixture";
import { selectDiscoverCards } from "../../../services/discover/src/library";
import { heuristicSchedule } from "../../../services/scheduled/src/parse";

export const fixtureWorkspace = Object.freeze({
  tenantName: "Albert Bike Store",
  timezone: "Australia/Melbourne",
  syncSummary: Object.freeze({
    progress: 72,
    detail:
      "Recent sales and workforce data are ready while accounting history backfills.",
    latestActivityAt: "2026-08-04T01:42:00.000Z",
  }),
  providers: Object.freeze([
    Object.freeze({
      id: "fivetran-lightspeed",
      name: "Lightspeed",
      description: "Sales, inventory, customers, and store activity.",
      logo: "/logos/lightspeed.png",
      connectDetail: "Connect a Lightspeed Retail R-Series account.",
      connections: Object.freeze([]),
    }),
    Object.freeze({
      id: "xero",
      name: "Xero",
      description: "Accounting, invoices, journals, and bank activity.",
      logo: "/logos/xero.svg",
      connectDetail: "Connect a Xero organisation.",
      connections: Object.freeze([
        Object.freeze({
          connectionId: "01J00000000000000000000XR1",
          auth: Object.freeze({
            state: "healthy",
            label: "Connected",
            detail: "Token checked moments ago",
            accountName: "Albert Bike Store Pty Ltd",
            checkedAt: "2026-08-04T01:41:00.000Z",
          }),
          domains: Object.freeze([
            Object.freeze({
              id: "finance",
              label: "Accounting",
              state: "ready_partial",
              detail:
                "Current accounting period is queryable; deep history is backfilling.",
              progress: 63,
              watermark: Object.freeze({
                label: "Ready through 11:41 am",
                at: "2026-08-04T01:41:00.000Z",
              }),
            }),
          ]),
        }),
      ]),
    }),
    Object.freeze({
      id: "deputy",
      name: "Deputy",
      description: "Rosters, timesheets, leave, and workforce activity.",
      logo: "/logos/deputy.png",
      connectDetail: "Connect a Deputy installation.",
      connections: Object.freeze([
        Object.freeze({
          connectionId: "01J00000000000000000000DP1",
          auth: Object.freeze({
            state: "healthy",
            label: "Connected",
            detail: "Melbourne install",
            accountName: "Albert Bike Store",
            checkedAt: "2026-08-04T01:40:00.000Z",
          }),
          domains: Object.freeze([
            Object.freeze({
              id: "workforce",
              label: "Workforce",
              state: "ready_complete",
              detail: "Rosters, timesheets, and leave are queryable.",
              progress: 100,
              watermark: Object.freeze({
                label: "Ready through 11:40 am",
                at: "2026-08-04T01:40:00.000Z",
              }),
            }),
          ]),
        }),
      ]),
    }),
  ]),
  dossier: Object.freeze([
    Object.freeze({
      id: "dossier-industry",
      label: "Industry",
      value: "Independent bicycle retail",
      confidence: Object.freeze({ label: "High", percent: 96 }),
      provenance: "Lightspeed category and product mix",
      observedAt: "2026-08-04T01:38:00.000Z",
    }),
  ]),
  blockingQuestions: Object.freeze([
    Object.freeze({
      id: "sales-tax-lens",
      label: "Sales definition",
      question: "Should sales normally include or exclude GST?",
      options: Object.freeze([
        Object.freeze({ id: "exclude-gst", label: "Exclude GST" }),
        Object.freeze({ id: "include-gst", label: "Include GST" }),
      ]),
    }),
  ]),
  identityMatches: Object.freeze([
    Object.freeze({
      id: "identity-jess",
      kind: "worker",
      title: "Is this the same employee?",
      first: Object.freeze({
        provider: "deputy",
        providerLabel: "Deputy",
        value: "Jessica Chen",
      }),
      second: Object.freeze({
        provider: "lightspeed",
        providerLabel: "Lightspeed",
        value: "Jess C",
      }),
      evidence: "Same work email and primary Melbourne location.",
      confidence: "High",
      decision: "proposed",
      projectionStatus: "applied",
    }),
  ]),
  oauthSelections: Object.freeze([
    Object.freeze({
      oauthSessionId: "01J0000000000000000000OS1",
      provider: "xero",
      providerLabel: "Xero",
      expiresAt: "2026-08-04T02:00:00.000Z",
      accounts: Object.freeze([
        Object.freeze({
          id: "xero-account-1",
          label: "Albert Bike Store Pty Ltd",
          detail: "AU organisation",
        }),
        Object.freeze({
          id: "xero-account-2",
          label: "Albert Workshop Pty Ltd",
          detail: "AU organisation",
        }),
      ]),
    }),
  ]),
});

export type AppApiCapture = {
  bootstrapPayloads: unknown[];
  conversationPayloads: unknown[];
  codexConversationPayloads: unknown[];
  omniConversationPayloads: unknown[];
  swarmPayloads: unknown[];
  dashboardMasterPayloads: unknown[];
  dashboardBuildPayloads: unknown[];
  runtimeRequestStartedAt: { v3: number[]; codex: number[] };
  anthropicConversationPayloads: unknown[];
  oauthSelectionPayloads: unknown[];
  reviewPayloads: unknown[];
  semanticPayloads: unknown[];
  discoverPayloads: unknown[];
  scheduledPayloads: unknown[];
  alertsPayloads: unknown[];
};

const semanticPublicationHash =
  "3769a30c9a9ff34d9677b369b3bfac2301bd2eea19e613d2e0022f14585e1293";

function semanticAdminFixture(
  section: string,
  semanticDraft = false,
  semanticRevision = 3,
  objectId = "",
) {
  const sourceItems = [
    {
      id: "source.lightspeed.sales",
      label: "Sales",
      description: "Completed Lightspeed sales at ticket grain.",
      connector: "lightspeed",
      domain: "sales",
      fieldCount: 4,
      semanticState: "exploratory",
      _objectType: "sourceObject",
      fields: [
        {
          id: "field.lightspeed.sales.sale_id",
          name: "sale_id",
          dataType: "string",
          disposition: "key",
          semanticState: "verified",
        },
        {
          id: "field.lightspeed.sales.completed_at",
          name: "completed_at",
          dataType: "timestamp",
          disposition: "time_role",
          semanticState: "verified",
        },
        {
          id: "field.lightspeed.sales.total",
          name: "total",
          dataType: "decimal",
          disposition: "measure_input",
          semanticState: "exploratory",
        },
        {
          id: "field.lightspeed.sales.status",
          name: "status",
          dataType: "string",
          disposition: "status_filter",
          semanticState: "verified",
        },
      ],
    },
  ];
  const measureItems = [
    {
      id: "commerce.net_sales",
      viewId: "commerce_sales_event",
      label: "Net sales",
      description: "Completed sales excluding GST and recognized refunds.",
      synonyms: ["revenue", "sales"],
      grain: "sale line",
      unit: "currency",
      aggregation: "sum",
      additivity: "additive",
      currencyFieldId: "commerce.currency",
      expression: {
        op: "aggregate",
        fn: "sum",
        fieldId: "commerce.net_sales_ex_gst",
      },
      semanticState: "verified",
      authority: "Lightspeed completed sale lines using governed refund signs.",
      riskTier: "tier_1",
      testIds: ["sales-net-total"],
    },
  ];
  const topicItems = [
    {
      id: "business.sales_performance",
      layer: "business",
      label: "Sales performance",
      description: "Governed sales analysis by time, store and product.",
      aiContext: "Use completed sales and disclosed refund semantics.",
      defaultRootViewId: "commerce_sales_event",
      viewIds: ["commerce_sales_event"],
      relationshipIds: [],
      dimensionIds: ["commerce.business_date"],
      measureIds: ["commerce.net_sales"],
      defaultFilters: [],
      freshnessMinutes: 60,
      sampleQuestions: ["Why did sales change last month?"],
      ambiguityNotes: ["Resolve gross or net sales before querying."],
      unsupportedQuestions: ["Do not infer causality from one comparison."],
      alignOnDimensionIds: [],
      semanticState: "verified",
      measureCount: 1,
      dimensionCount: 1,
    },
  ];
  const relationshipItems = [
    {
      id: "candidate.lightspeed.sales.customer_id",
      fromViewId: "source.lightspeed.sales",
      fromFieldId: "lightspeed.sales.customer_id",
      targets: [
        {
          viewId: "source.lightspeed.customers",
          fieldId: "lightspeed.customers.customer_id",
          matchKind: "exact_key_name",
        },
      ],
      candidateViewIds: ["source.lightspeed.customers"],
      disposition: "unresolved",
      reason: "Live uniqueness, orphan and multiplicity evidence is required.",
      evidence: ["Governed source key-name candidate only."],
      _objectType: "relationshipCandidate",
    },
  ];
  const items =
    section === "sources"
      ? sourceItems
      : section === "measures"
        ? measureItems
        : section === "topics" || section === "test_lab"
          ? topicItems
          : section === "relationships"
            ? relationshipItems
            : [];
  return {
    section,
    overview: {
      publicationHash: semanticPublicationHash,
      registryVersion: "2.0.0",
      objectCounts: {
        sourceObjects: 287,
        fields: 3028,
        views: 298,
        dimensions: 2438,
        measures: 710,
        relationships: 0,
        relationshipCandidates: 414,
        topics: 43,
        businessContext: 10,
      },
      semanticStateCounts: {
        verified: 9,
        derived: 2299,
        exploratory: 4457,
        unsupported: 17,
        deprecated: 22,
      },
      fieldDispositionCounts: {
        deprecated: 22,
        descriptive_metadata: 405,
        dimension: 809,
        key: 428,
        measure_input: 381,
        sensitive_metadata: 212,
        status_filter: 498,
        time_role: 256,
        unsupported: 17,
      },
      physicalMapping: { materialized: 2989, unsupported: 17, aliased: 158 },
      sourceConnectorCounts: {
        lightspeed: { objects: 90, fields: 949 },
        xero: { objects: 197, fields: 2079 },
      },
      unresolvedRelationships: 414,
      topicLayers: { source_domain: 26, business: 11, composite: 6 },
    },
    persistence: {
      available: semanticDraft,
      drafts: semanticDraft
        ? [
            {
              draft_id: "01J0000000000000000000SD1",
              name: "Margin definition review",
              revision: semanticRevision,
              status: "draft",
              manifest_hash: semanticPublicationHash,
              updated_at: "2026-08-10T01:00:00.000Z",
            },
          ]
        : [],
      validations: [],
      reviews: [],
      profileReceipts: [],
      publications: [],
      qualifications: [],
      contextValues: [],
      runtimeEvents: [],
      active: null,
    },
    items,
    total: items.length,
    offset: 0,
    limit: 100,
    authoringContext:
      section === "measures" && objectId === "commerce.net_sales"
        ? {
            measureId: "commerce.net_sales",
            view: {
              id: "commerce_sales_event",
              label: "Commerce sales event",
              grain: "sale line",
              temporalAvailability: "historical",
            },
            fields: [
              {
                id: "commerce.net_sales_ex_gst",
                label: "net_sales_ex_gst",
                dataType: "numeric",
                semanticState: "verified",
                disposition: "measure_input",
              },
              {
                id: "commerce.currency",
                label: "currency",
                dataType: "text",
                semanticState: "verified",
                disposition: "dimension",
              },
            ],
            measures: [
              {
                id: "commerce.net_sales",
                label: "Net sales",
                unit: "currency",
                aggregation: "sum",
                semanticState: "verified",
                selected: true,
              },
            ],
            dependencies: {
              fieldIds: ["commerce.net_sales_ex_gst"],
              measureIds: [],
            },
            dependents: [
              {
                id: "commerce.gross_margin",
                label: "Gross margin",
                viewId: "commerce_sales_event",
              },
            ],
            topics: [
              {
                id: "business.sales_performance",
                label: "Sales performance",
                layer: "business",
              },
            ],
            limits: { maximumNodes: 64, maximumDepth: 8 },
          }
        : null,
    topicAuthoringContext:
      section === "topics" && objectId === "business.sales_performance"
        ? {
            topicId: "business.sales_performance",
            layer: "business",
            views: [
              {
                id: "commerce_sales_event",
                label: "Commerce sales event",
                grain: "sale line",
                temporalAvailability: "historical",
                semanticState: "verified",
                selected: true,
                root: true,
              },
              {
                id: "commerce_payment",
                label: "Commerce payment",
                grain: "payment",
                temporalAvailability: "historical",
                semanticState: "derived",
                selected: false,
                root: false,
              },
            ],
            dimensions: [
              {
                id: "commerce.business_date",
                label: "Business date",
                viewId: "commerce_sales_event",
                viewLabel: "Commerce sales event",
                dataType: "date",
                timeRole: "event",
                conformedKey: "business_date",
                semanticState: "verified",
                selected: true,
                aligned: false,
              },
              {
                id: "commerce.payment_type",
                label: "Payment type",
                viewId: "commerce_payment",
                viewLabel: "Commerce payment",
                dataType: "string",
                timeRole: null,
                conformedKey: null,
                semanticState: "derived",
                selected: false,
                aligned: false,
              },
            ],
            measures: [
              {
                id: "commerce.net_sales",
                label: "Net sales",
                viewId: "commerce_sales_event",
                viewLabel: "Commerce sales event",
                unit: "currency",
                aggregation: "sum",
                semanticState: "verified",
                selected: true,
              },
              {
                id: "commerce.tender_amount",
                label: "Tender amount",
                viewId: "commerce_payment",
                viewLabel: "Commerce payment",
                unit: "currency",
                aggregation: "sum",
                semanticState: "derived",
                selected: false,
              },
            ],
            relationships: [],
            impact: {
              defaultFilters: 0,
              sampleQuestions: 1,
              ambiguityNotes: 1,
              unsupportedQuestions: 1,
              reviewTier: "tier_3",
            },
          }
        : null,
    relationshipGraph:
      section === "relationships"
        ? {
            nodes: [
              {
                id: "source.lightspeed.sales",
                label: "Sales",
                grain: "sale",
                group: "Lightspeed",
                semanticState: "exploratory",
              },
              {
                id: "source.lightspeed.customers",
                label: "Customers",
                grain: "customer",
                group: "Lightspeed",
                semanticState: "derived",
              },
              {
                id: "source.lightspeed.employees",
                label: "Employees",
                grain: "employee",
                group: "Lightspeed",
                semanticState: "derived",
              },
            ],
            edges: [
              {
                id: "edge.candidate.lightspeed.sales.customer_id.0",
                objectId: "candidate.lightspeed.sales.customer_id",
                fromViewId: "source.lightspeed.sales",
                toViewId: "source.lightspeed.customers",
                fromFieldId: "lightspeed.sales.customer_id",
                toFieldId: "lightspeed.customers.customer_id",
                kind: "candidate",
                status: "unresolved",
                cardinality: null,
                matchKind: "exact_key_name",
              },
              {
                id: "edge.candidate.lightspeed.sales.employee_id.0",
                objectId: "candidate.lightspeed.sales.employee_id",
                fromViewId: "source.lightspeed.sales",
                toViewId: "source.lightspeed.employees",
                fromFieldId: "lightspeed.sales.employee_id",
                toFieldId: "lightspeed.employees.employee_id",
                kind: "candidate",
                status: "rejected",
                cardinality: null,
                matchKind: "exact_key_name",
              },
            ],
            objects: [
              relationshipItems[0],
              {
                id: "candidate.lightspeed.sales.employee_id",
                fromViewId: "source.lightspeed.sales",
                fromFieldId: "lightspeed.sales.employee_id",
                targets: [
                  {
                    viewId: "source.lightspeed.employees",
                    fieldId: "lightspeed.employees.employee_id",
                    matchKind: "exact_key_name",
                  },
                ],
                candidateViewIds: ["source.lightspeed.employees"],
                disposition: "rejected",
                reason: "Rejected fixture edge.",
                evidence: ["Fixture review."],
                _objectType: "relationshipCandidate",
              },
            ],
            counts: {
              views: 3,
              supported: 0,
              unresolved: 1,
              rejected: 1,
              conflicts: 0,
              fanoutWarnings: 0,
            },
          }
        : null,
    semanticHealth:
      section === "health"
        ? {
            available: true,
            summary: {
              schemaVersion: 1,
              windowStart: "2026-07-11T00:00:00.000Z",
              generatedAt: "2026-08-10T00:00:00.000Z",
              turnCount: 12,
              answerStates: {
                verified: 7,
                derived: 2,
                exploratory: 1,
                clarification: 1,
                no_data: 1,
                unavailable: 0,
              },
              rates: {
                answerability: 0.9167,
                clarification: 0.0833,
                unavailable: 0,
              },
              eventKinds: { clarification: 1 },
              eventReasons: [
                {
                  reasonCode: "AMBIGUOUS_FINANCIAL_BASIS",
                  eventKind: "clarification",
                  count: 1,
                },
              ],
              topicUsage: [
                { id: "business.sales_performance", count: 8 },
              ],
              objectUsage: [{ id: "commerce.net_sales", count: 8 }],
              latency: { queryCount: 10, p50Ms: 42, p95Ms: 130 },
            },
          }
        : null,
    evaluationCorpus:
      section === "test_lab"
        ? {
            total: 200,
            visible: 160,
            hidden: 40,
            allocations: {
              source: { lightspeed: 80, xero: 80, lightspeed_xero: 40 },
              difficulty: { easy: 30, medium: 60, hard: 70, adversarial: 40 },
              questionClass: {
                lookup: 35,
                comparison: 40,
                diagnosis: 50,
                recommendation: 45,
                open_exploration: 30,
              },
              terminalState: {
                verified: 105,
                derived: 30,
                exploratory: 20,
                clarification: 15,
                no_data: 15,
                unavailable: 15,
              },
            },
            runtimePolicy: {
              model: "gpt-5.6-luna",
              reasoningEffort: "max",
              fastMode: false,
              proMode: false,
              maximumExecutions: 200,
              deputyAllowed: false,
            },
            matchingVisibleCount: 160,
            cases: [
              {
                id: "v2_001",
                ask: "Compare sales for the last complete month.",
                source: "lightspeed",
                difficulty: "easy",
                questionClass: "comparison",
                expectedTerminalState: "verified",
                expectedOperator: null,
                tags: ["lightspeed", "verified"],
                thread: null,
                followUpOf: null,
              },
            ],
          }
        : null,
    draftDiff: semanticDraft
      ? {
          baseManifestHash: semanticPublicationHash,
          candidateManifestHash:
            "a769e123f229e582b47a4561ff8fd546e5d6ab73dd77d168d99a9fe12c61b813",
          diffHash:
            "54c6d43dc6f519f5f3b597a8cd03001fd0ca53545938114d881985f301bc3707",
          summary: {
            added: 0,
            removed: 0,
            changed: 1,
            high: 1,
            medium: 0,
            low: 0,
            byObjectType: { measure: 1 },
          },
          changes: [
            {
              objectType: "measure",
              objectId: "commerce.gross_margin",
              parentId: null,
              operation: "changed",
              changedFields: ["expression", "authority"],
              severity: "high",
              requiredReviewTier: "tier_1",
              reason:
                "The change touches executable semantics, grain, identity, authority, classification, or Topic membership.",
            },
          ],
        }
      : null,
    reviewQueue: semanticDraft
      ? [
          {
            objectId: "commerce.gross_margin",
            objectType: "measure",
            label: "Gross margin",
            riskTier: "tier_1",
            requiredApprovals: 2,
            approvalCount: 0,
            remainingApprovals: 2,
            changesRequested: false,
            complete: false,
            currentReviewerDisposition: null,
            reviewDetails: {
              contractFingerprint:
                "c823a4e4b3593e3f67d64df3345fdfb0b8ef81155f9dcf1dff6f2f990686b2d2",
              semanticState: "verified",
              riskReason:
                "Financial semantics can materially change reported money or interpretation.",
              summary:
                "Gross margin from governed net sales and cost-of-goods evidence.",
              checks: [
                "View and grain: commerce_sales_event · one_sales_or_refund_event",
                "Authority: operational_sales",
                'Expression: {"op":"subtract","left":{"op":"measure","measureId":"commerce.net_sales"},"right":{"op":"measure","measureId":"commerce.cogs"}}',
              ],
              evidence: [
                "Contract test: commerce.gross_margin.test_1.fixture",
              ],
            },
          },
          {
            objectId: "commerce.net_sales",
            objectType: "measure",
            label: "Net sales",
            riskTier: "tier_2",
            requiredApprovals: 1,
            approvalCount: 0,
            remainingApprovals: 1,
            changesRequested: false,
            complete: false,
            currentReviewerDisposition: null,
            reviewDetails: {
              contractFingerprint:
                "39116526456945781bdc708cddf82f6a2f42a5b272186d1f9056f3f326327aa6",
              semanticState: "verified",
              riskReason:
                "Reusable operational semantics require domain review plus deterministic contract tests.",
              summary:
                "Completed sales net of refunds at the governed sales-event grain.",
              checks: [
                "View and grain: commerce_sales_event · one_sales_or_refund_event",
                "Authority: operational_sales",
                'Expression: {"op":"aggregate","fn":"sum","fieldId":"signed_net_amount_ex_tax"}',
              ],
              evidence: [
                "Contract test: commerce.net_sales.test_1.fixture",
              ],
            },
          },
        ]
      : null,
  };
}

export async function installSupabaseBrowserAuthRoutes(
  page: Page,
): Promise<void> {
  await page.route(
    /^https:\/\/abcdefghijklmnopqrst\.supabase\.co\/auth\/v1\//u,
    async (route) => {
      const request = route.request();
      const sourceUrl = new URL(request.url());
      const localUrl = `http://127.0.0.1:55431${sourceUrl.pathname}${sourceUrl.search}`;
      const headers = { ...request.headers() };
      delete headers.host;
      delete headers["content-length"];
      const response = await fetch(localUrl, {
        method: request.method(),
        headers,
        body: ["GET", "HEAD"].includes(request.method())
          ? undefined
          : (request.postData() ?? undefined),
      });
      await route.fulfill({
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: Buffer.from(await response.arrayBuffer()),
      });
    },
  );
}

export async function installAppApiRoutes(
  page: Page,
  options: Readonly<{
    needsBootstrap?: boolean;
    anthropicHistory?: boolean;
    specialistHistory?: boolean;
    codexHistory?: boolean;
    recentAnalyses?: boolean;
    v3DelayMs?: number;
    codexDelayMs?: number;
    anthropicDelayMs?: number;
    internalOperator?: boolean;
    /** The built dashboard already exists: the Dashboards list starts with it. */
    dashboardApplied?: boolean;
    semanticDraft?: boolean;
    role?: "owner" | "manager" | "bookkeeper" | "internal_operator";
  }> = {},
): Promise<AppApiCapture> {
  await installSupabaseBrowserAuthRoutes(page);
  const capture: AppApiCapture = {
    bootstrapPayloads: [],
    conversationPayloads: [],
    codexConversationPayloads: [],
    omniConversationPayloads: [],
    swarmPayloads: [],
    dashboardMasterPayloads: [],
    dashboardBuildPayloads: [],
    runtimeRequestStartedAt: { v3: [], codex: [] },
    anthropicConversationPayloads: [],
    oauthSelectionPayloads: [],
    reviewPayloads: [],
    semanticPayloads: [],
    discoverPayloads: [],
    scheduledPayloads: [],
    alertsPayloads: [],
  };
  const sessionRole = options.role ?? "owner";
  let bootstrapped = false;
  let semanticRevision = 3;

  await page.route(/\/api\/session(?:\?.*)?$/u, async (route) => {
    if (route.request().method() === "POST") {
      const payload = route.request().postDataJSON();
      capture.bootstrapPayloads.push(payload);
      bootstrapped = true;
      await route.fulfill({
        status: 201,
        json: { context: { tenant_name: "Albert Bike Store", role: sessionRole } },
      });
      return;
    }

    await route.fulfill({
      json: {
        user: {
          id: "11111111-1111-4111-8111-111111111111",
          email: "owner@example.com",
          suggestedOrganisationName: "Albert Bike Store",
          timezone: "Australia/Melbourne",
        },
        context:
          options.needsBootstrap && !bootstrapped
            ? null
            : { tenant_name: "Albert Bike Store", role: sessionRole },
        internalOperator: Boolean(options.internalOperator),
        deletionReceipt: null,
        needsBootstrap: Boolean(options.needsBootstrap && !bootstrapped),
      },
    });
  });

  await page.route(/\/api\/connections(?:\?.*)?$/u, async (route) => {
    await route.fulfill({ json: { workspace: fixtureWorkspace } });
  });

  await page.route(/\/api\/admin\/architecture(?:\?.*)?$/u, async (route) => {
    await route.fulfill({
      json: {
        architecture: {
          generated_at: "2026-08-10T00:00:00.000Z",
          packs: [],
          semantic: {
            version: "2.0.0",
            metric_count: 0,
            topic_count: 0,
            fact_count: 0,
            dimension_count: 0,
            domains: [],
            topics: [],
            metrics: [],
            facts: [],
            dimensions: [],
          },
          live: null,
          live_error: null,
        },
      },
    });
  });

  await page.route(/\/api\/admin\/fleet(?:\?.*)?$/u, async (route) => {
    await route.fulfill({
      json: {
        fleet: {
          generated_at: "2026-08-10T00:00:00.000Z",
          connections: [],
          workers: [],
          queues: [],
        },
      },
    });
  });

  await page.route(/\/api\/admin\/semantic(?:\?.*)?$/u, async (route) => {
    if (route.request().method() === "POST") {
      const payload = route.request().postDataJSON();
      capture.semanticPayloads.push(payload);
      if (
        payload.action === "update_object" &&
        payload.expectedRevision === semanticRevision
      ) {
        semanticRevision += 1;
        await route.fulfill({ json: { draft: { revision: semanticRevision } } });
        return;
      }
      if (payload.action === "preview_topic_context") {
        await route.fulfill({
          json: {
            preview: {
              question: payload.question,
              topic: {
                id: payload.topicId,
                label: "Sales performance",
                routingScore: 12,
              },
              candidateBlock: {
                topicIds: [payload.topicId],
                rootViewId: "commerce_sales_event",
                measureIds: ["commerce.net_sales"],
              },
              compiledPlan: {
                normalizedPlanHash: semanticPublicationHash,
                budget: { estimatedCost: 7, maximumCost: 250 },
                executableSqlDisclosed: false,
              },
              compilerFailure: null,
              modelEvaluationTriggered: false,
            },
          },
        });
        return;
      }
      if (payload.action === "batch_review_objects") {
        await route.fulfill({
          json: {
            reviewBatch: {
              draftId: payload.draftId,
              revision: payload.expectedRevision,
              recorded: payload.reviews.length,
              reviews: payload.reviews,
            },
          },
        });
        return;
      }
      await route.fulfill({ status: 400, json: { error: "Invalid fixture mutation." } });
      return;
    }
    const url = new URL(route.request().url());
    const section = url.searchParams.get("section") ?? "overview";
    await route.fulfill({
      json: semanticAdminFixture(
        section,
        options.semanticDraft,
        semanticRevision,
        url.searchParams.get("objectId") ?? "",
      ),
    });
  });

  await page.route(/\/api\/connections\/review$/u, async (route) => {
    capture.reviewPayloads.push(route.request().postDataJSON());
    await route.fulfill({ json: { accepted: true } });
  });

  await page.route(/\/api\/oauth\/select$/u, async (route) => {
    capture.oauthSelectionPayloads.push(route.request().postDataJSON());
    await route.fulfill({ json: { connected: true } });
  });

  await page.route(/\/api\/recommended-analysis(?:\?.*)?$/u, async (route) => {
    const briefNow = Date.now();
    const recommendations = options.recentAnalyses
      ? [
          {
            id: "rec-1-wednesday",
            title: "Sales slowed despite more customers visiting",
            question: "Which products explain the lower sales over the last 24 hours?",
            why: "Sales fell 11% against comparable weekday windows, despite more transactions.",
            move: "diagnose",
            domain: "products",
            tool: "lightspeed",
            fromTitle: "Daily look",
            fromConversationId: "01J00000000000000000000021",
          },
          {
            id: "rec-2-parts",
            title: "Discounts are weighing on parts margin",
            question: "What is dragging parts margin: mix, discounting, or cost?",
            why: "Parts sat at 31% against 44% for workshop in your last category review.",
            move: "diagnose",
            domain: "profit",
            tool: "xero",
            fromTitle: "Margin by category",
            fromConversationId: "01J00000000000000000000033",
          },
          {
            id: "rec-3-cash",
            title: "Customer payments need a closer look",
            question: "Which customer payments changed over the last 24 hours and need following up?",
            why: "You reviewed sales, but not whether that cash actually landed.",
            move: "close_the_loop",
            domain: "cash",
            tool: "xero",
            fromTitle: "Weekly sales trend",
            fromConversationId: "01J00000000000000000000021",
          },
        ]
      : [];
    await route.fulfill({
      json: {
        verdict: recommendations.length > 0
          ? "You've looked at sales and customers recently. Cash and labour have gone quiet."
          : "",
        recommendations,
        sourceCount: recommendations.length > 0 ? 12 : 0,
        source: recommendations.length > 0 ? "daily" : "empty",
        generatedAt: new Date(briefNow).toISOString(),
        windowStart: new Date(briefNow - 86_400_000).toISOString(),
        windowEnd: new Date(briefNow).toISOString(),
        expiresAt: new Date(briefNow + 7_200_000).toISOString(),
        timezone: "Australia/Melbourne",
        connectors: ["xero", "deputy"],
        fingerprint: recommendations.length > 0 ? "a".repeat(64) : "",
      },
    });
  });

  // Discover: the fixture tenant has Xero and Deputy connected, so the grid is
  // the library resolved for those two tools, served as an up-to-date cache.
  await page.route(/\/api\/discover(?:\?.*)?$/u, async (route) => {
    capture.discoverPayloads.push({
      method: route.request().method(),
      body: route.request().method() === "POST" ? route.request().postDataJSON() : null,
    });
    await route.fulfill({
      json: {
        cards: selectDiscoverCards(["xero", "deputy"]),
        connectors: ["xero", "deputy"],
        business: "Albert Bike Store",
        source: "cache",
        fingerprint: "b".repeat(64),
        generatedAt: "2026-08-31T22:00:00.000Z",
      },
    });
  });

  // Scheduled (ADR 0131): one standing schedule with a sent run. Creates
  // append (through the deterministic reading), updates merge, a manual run
  // is queued and flips to sent on the next poll, so the tab's whole loop
  // is exercised without a bridge.
  const scheduledRun = {
    runId: "01J00000000000000000000032",
    taskId: "01J00000000000000000000031",
    trigger: "schedule",
    status: "sent",
    requestedAt: "2026-08-31T23:00:02.000Z",
    startedAt: "2026-08-31T23:00:02.000Z",
    finishedAt: "2026-08-31T23:00:41.000Z",
    scheduledFor: "2026-08-31T23:00:00.000Z",
    conversationId: "01J00000000000000000000021",
    turnId: "01J00000000000000000000022",
    answerState: "Verified",
    summary: "Sales hit $12,400 yesterday, up 8% on the same Monday last week.",
    error: null,
    bubbles: 1,
  };
  const scheduledTasks: Array<Record<string, unknown>> = [{
    taskId: "01J00000000000000000000031",
    title: "Yesterday's sales overview",
    requestText: "Send me a message every morning at 9am with an overview of yesterday's sales performance",
    prompt: "How did sales perform yesterday compared with the same day last week?",
    timeOfDay: "09:00",
    days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
    timezone: "Australia/Melbourne",
    phone: "+61414187820",
    enabled: true,
    nextRunAt: "2026-09-01T23:00:00.000Z",
    lastRunAt: "2026-08-31T23:00:02.000Z",
    createdAt: "2026-08-30T10:00:00.000Z",
    updatedAt: "2026-08-30T10:00:00.000Z",
    lastRun: scheduledRun,
    recentRuns: [scheduledRun],
  }];
  let scheduledSequence = 40;
  const scheduledId = () => `01J000000000000000000000${String(scheduledSequence++).padStart(2, "0")}`;
  const scheduledPayload = () => ({
    tasks: scheduledTasks,
    numbers: [
      { phone: "+61414187820", displayName: "Tom", isOwner: true },
      { phone: "+61400000002", displayName: "Sam", isOwner: false },
    ],
    defaults: { timezone: "Australia/Melbourne", phone: "+61414187820" },
    botNumberDisplay: "+1 (650) 283-1814",
    canManage: true,
  });
  await page.route(/\/api\/scheduled(?:\?.*)?$/u, async (route) => {
    const method = route.request().method();
    const body = method === "POST" ? route.request().postDataJSON() as Record<string, unknown> : null;
    capture.scheduledPayloads.push({ method, body });
    if (method === "GET") {
      // The bridge would have picked a queued run up by now.
      for (const task of scheduledTasks) {
        const lastRun = task.lastRun as Record<string, unknown> | null;
        if (lastRun && (lastRun.status === "queued" || lastRun.status === "running")) {
          const finished = {
            ...lastRun,
            status: "sent",
            startedAt: "2026-09-01T04:10:03.000Z",
            finishedAt: "2026-09-01T04:10:40.000Z",
            conversationId: "01J00000000000000000000021",
            turnId: "01J00000000000000000000022",
            answerState: "Verified",
            summary: "Sales hit $9,800 last week, down 3% on the week before.",
            bubbles: 1,
          };
          task.lastRun = finished;
          task.recentRuns = [finished, ...(task.recentRuns as unknown[]).slice(1)];
          task.lastRunAt = finished.startedAt;
        }
      }
      await route.fulfill({ json: scheduledPayload() });
      return;
    }
    const action = body?.action;
    if (action === "create") {
      const draft = heuristicSchedule(String(body?.text ?? ""), "Australia/Melbourne");
      const task = {
        taskId: scheduledId(),
        title: draft.title,
        requestText: String(body?.text ?? ""),
        prompt: draft.prompt,
        timeOfDay: draft.timeOfDay,
        days: [...draft.days],
        timezone: draft.timezone,
        phone: "+61414187820",
        enabled: true,
        nextRunAt: "2026-09-06T22:30:00.000Z",
        lastRunAt: null,
        createdAt: "2026-09-01T04:00:00.000Z",
        updatedAt: "2026-09-01T04:00:00.000Z",
        lastRun: null,
        recentRuns: [],
      };
      scheduledTasks.push(task);
      await route.fulfill({ json: { task, note: draft.note, source: "heuristic" } });
      return;
    }
    const task = scheduledTasks.find((item) => item.taskId === body?.taskId);
    if (!task) {
      await route.fulfill({ status: 404, json: { error: "That schedule no longer exists." } });
      return;
    }
    if (action === "update") {
      const changes = Object.fromEntries(
        Object.entries(body ?? {}).filter(([key]) => key !== "action" && key !== "taskId"),
      );
      Object.assign(task, changes, { updatedAt: "2026-09-01T04:05:00.000Z" });
      if (task.enabled === false) task.nextRunAt = null;
      else if (!task.nextRunAt) task.nextRunAt = "2026-09-06T22:30:00.000Z";
      await route.fulfill({ json: { task } });
      return;
    }
    if (action === "delete") {
      scheduledTasks.splice(scheduledTasks.indexOf(task), 1);
      await route.fulfill({ json: { removed: true } });
      return;
    }
    if (action === "run") {
      const run = {
        runId: scheduledId(),
        taskId: task.taskId,
        trigger: "manual",
        status: "queued",
        requestedAt: "2026-09-01T04:10:00.000Z",
        startedAt: null,
        finishedAt: null,
        scheduledFor: null,
        conversationId: null,
        turnId: null,
        answerState: null,
        summary: null,
        error: null,
        bubbles: null,
      };
      task.lastRun = run;
      task.recentRuns = [run, ...(task.recentRuns as unknown[])].slice(0, 5);
      await route.fulfill({ json: { run } });
      return;
    }
    await route.fulfill({ status: 400, json: { error: "That request wasn't valid." } });
  });

  // Alerts (ADR 0132): the ten catalogue triggers with one stored override,
  // one reading each, a couple of fired events and a finished evaluation.
  // Updates merge; "check" opens an evaluation that finishes on the next
  // poll, so the tab's whole loop is exercised without a bridge.
  const alertsNumbers = [
    { phone: "+61414187820", displayName: "Tom", isOwner: true },
    { phone: "+61400000002", displayName: "Sam", isOwner: false },
  ];
  const alertsEvents: Array<Record<string, unknown>> = [
    {
      eventId: "01J00000000000000000000051",
      triggerKey: "trading_day",
      dedupeKey: "record:2026-08-27",
      headline: "Biggest day in a year",
      body: "Thu 27 Aug did $11,994 from 11 sales. Your previous best in the last 12 months was $8,751 on Sat 9 May.",
      evidence: {},
      status: "sent",
      recipients: ["+61414187820"],
      evaluationId: "01J00000000000000000000050",
      firedAt: "2026-08-28T21:05:00.000Z",
      deliveredAt: "2026-08-28T21:05:03.000Z",
      error: null,
    },
    {
      eventId: "01J00000000000000000000052",
      triggerKey: "stockout",
      dedupeKey: "stockout:Gear Inner Wire:2026-09-01",
      headline: "Out of stock: Gear Inner Wire",
      body: "Gear Inner Wire hit zero on Tue 1 Sep. It sold 56 units in the last 90 days, about 4.3 a week.",
      evidence: {},
      status: "sent",
      recipients: ["+61414187820"],
      evaluationId: "01J00000000000000000000050",
      firedAt: "2026-09-01T21:05:00.000Z",
      deliveredAt: "2026-09-01T21:05:04.000Z",
      error: null,
    },
  ];
  const alertsCatalogue = [
    ["trading_day", "Trading day", "Sales", "A record day, a day the shop was staffed but the till barely moved, or a month that closes at a three-year low.", "Wed 2 Sep: $638 from 6 sales · best day in 12 months $11,994 (Thu 27 Aug)"],
    ["bike_sold", "Bike sold", "Sales", "A bike over $1,500 or a first-time customer's bike, then the six-week and twelve-month service reminders if they have not been back.", "0 bikes sold Wed 2 Sep · 3 first services due · 0 annual services due"],
    ["vip_customer", "Big customers", "Customers", "A $5k-plus customer buys again after a year away, goes quiet for six months, or crosses $5k or $10k lifetime for the first time.", "106 customers over $5k lifetime · 61 quiet for six months or more"],
    ["workshop_uncollected", "Waiting on the customer", "Workshop", "A job finished for a week with nothing charged, or an open job past its promised date.", "20 finished awaiting collection · 18 open past their promised date"],
    ["workshop_load", "Workshop load", "Workshop", "More bikes promised back on a day than the roster can turn, and a record or unusually quiet intake week.", "18 bikes promised back in the next 7 days · 101 rostered hours · 35 jobs in last week (avg 31)"],
    ["stockout", "Consumable hit zero", "Stock", "A stocked item with sales in the last 90 days reaches zero on hand.", "14 stocked items at zero with sales in the last 90 days"],
    ["aged_bike", "Bike on the floor a year", "Stock", "A bike passes another year in stock, and a new brand that has not sold a unit.", "8 bikes over a year old, $23,734 at cost"],
    ["labour_roster", "Labour and roster", "People", "Wages over 30% of takings for a week, a leave request waiting, leave approved in the peak, or a trading day with nobody rostered.", "Labour 11% of takings last week (usual 23%) · 1 leave request waiting"],
    ["supplier_bills", "Supplier bills", "Money", "A first bill from a new supplier, a look-alike supplier name, a bill bigger than any before, and Monday's overdue and due-this-week digests.", "0 bills in the last week · 16 bills open ($5,823) · 16 past due ($5,823)"],
    ["cash_integrity", "Till and refunds", "Money", "The till uncounted for three trading days, a count out by $50, a refund over $500, a sale below cost, a big stock adjustment, or a heavy discount week.", "Till last counted Sun 9 Aug · 0 counts out by $50+ in 45 days"],
  ] as const;
  const alertsSummaries: Record<string, string> = {
    trading_day: "Record days, dead days, quiet months.",
    bike_sold: "Bike sales and service reminders.",
    vip_customer: "Big customers back, quiet or new.",
    workshop_uncollected: "Jobs waiting on the customer.",
    workshop_load: "Busy days against the roster.",
    stockout: "Stocked items hitting zero.",
    aged_bike: "Bikes a year on the floor.",
    labour_roster: "Wages, leave and roster gaps.",
    supplier_bills: "New, odd and overdue bills.",
    cash_integrity: "Till counts, refunds and discounts.",
  };
  const alertsTriggers: Array<Record<string, unknown>> = alertsCatalogue.map(([key, title, domain, rule, line]) => ({
    key,
    title,
    domain,
    summary: alertsSummaries[key],
    rule,
    example: "",
    needs: key === "supplier_bills"
      ? ["xero"]
      : key === "workshop_load" || key === "labour_roster"
        ? ["lightspeed-r", "deputy"]
        : ["lightspeed-r"],
    enabled: key !== "aged_bike",
    recipients: key === "supplier_bills" ? ["+61414187820", "+61400000002"] : ["+61414187820"],
    stored: key === "aged_bike" || key === "supplier_bills",
    updatedAt: key === "aged_bike" || key === "supplier_bills" ? "2026-09-01T10:00:00.000Z" : null,
    state: {
      lastEvaluatedAt: "2026-09-02T00:05:00.000Z",
      lastResult: { status: key === "trading_day" || key === "stockout" ? "fired" : "quiet", line },
      lastFiredAt: key === "trading_day" ? "2026-08-28T21:05:00.000Z" : key === "stockout" ? "2026-09-01T21:05:00.000Z" : null,
    },
    recentEvents: alertsEvents.filter((event) => event.triggerKey === key),
  }));
  let alertsOpenEvaluation: Record<string, unknown> | null = null;
  let alertsLastEvaluation: Record<string, unknown> = {
    evaluationId: "01J00000000000000000000050",
    trigger: "schedule",
    status: "finished",
    requestedAt: "2026-09-02T00:05:00.000Z",
    startedAt: "2026-09-02T00:05:00.000Z",
    finishedAt: "2026-09-02T00:05:31.000Z",
    conversationId: "01J00000000000000000000060",
    turnId: "01J00000000000000000000061",
    freshnessDigest: "abc",
    summary: {
      evaluated: 10,
      queries: 31,
      fired: 2,
      dataThrough: [
        { connector: "lightspeed-r", domain: "sales", dataThrough: "2026-09-01T23:40:00.000Z" },
        { connector: "xero", domain: "invoices", dataThrough: "2026-08-18T03:27:00.000Z" },
        { connector: "deputy", domain: "timesheets", dataThrough: "2026-09-01T22:00:00.000Z" },
      ],
    },
    error: null,
  };
  const alertsPayload = () => ({
    triggers: alertsTriggers,
    events: alertsEvents,
    settings: { cadenceMinutes: 60, lastEvaluatedAt: "2026-09-02T00:05:31.000Z", lastFreshnessDigest: "abc" },
    lastEvaluation: alertsLastEvaluation,
    openEvaluation: alertsOpenEvaluation,
    numbers: alertsNumbers,
    defaults: { recipients: ["+61414187820"] },
    botNumberDisplay: "+1 (650) 283-1814",
    canManage: true,
  });
  await page.route(/\/api\/alerts(?:\?.*)?$/u, async (route) => {
    const method = route.request().method();
    const body = method === "POST" ? route.request().postDataJSON() as Record<string, unknown> : null;
    capture.alertsPayloads.push({ method, body });
    if (method === "GET") {
      if (alertsOpenEvaluation) {
        // The bridge would have run the check by now.
        alertsLastEvaluation = {
          ...alertsOpenEvaluation,
          status: "finished",
          startedAt: "2026-09-02T04:10:01.000Z",
          finishedAt: "2026-09-02T04:10:32.000Z",
          summary: alertsLastEvaluation.summary,
        };
        alertsOpenEvaluation = null;
      }
      await route.fulfill({ json: alertsPayload() });
      return;
    }
    if (body?.action === "check") {
      alertsOpenEvaluation = {
        evaluationId: "01J00000000000000000000070",
        trigger: "manual",
        status: "queued",
        requestedAt: "2026-09-02T04:10:00.000Z",
        startedAt: null,
        finishedAt: null,
        conversationId: null,
        turnId: null,
        freshnessDigest: null,
        summary: {},
        error: null,
      };
      await route.fulfill({ json: { evaluation: alertsOpenEvaluation } });
      return;
    }
    if (body?.action === "update") {
      const trigger = alertsTriggers.find((item) => item.key === body.triggerKey);
      if (!trigger) {
        await route.fulfill({ status: 404, json: { error: "Unknown alert." } });
        return;
      }
      if (typeof body.enabled === "boolean") trigger.enabled = body.enabled;
      if (Array.isArray(body.recipients)) trigger.recipients = body.recipients;
      trigger.stored = true;
      trigger.updatedAt = "2026-09-02T04:05:00.000Z";
      await route.fulfill({ json: { trigger } });
      return;
    }
    await route.fulfill({ status: 400, json: { error: "That request wasn't valid." } });
  });

  await page.route(/\/api\/conversations(?:\?.*)?$/u, async (route) => {
    await route.fulfill({
      json: {
        conversations: options.recentAnalyses
          ? [
              {
                conversation_id: "01J00000000000000000000021",
                title: "Weekly sales trend",
                status: "active",
                created_at: "2026-08-09T00:00:00.000Z",
                updated_at: "2026-08-09T04:01:00.000Z",
                last_turn: {
                  turn_id: "01J00000000000000000000022",
                  turn_number: 1,
                  user_message: "How did this week compare to last week?",
                  status: "completed",
                  answer_state: "verified",
                  runtime_profile: {
                    model: "gpt-5.6-luna",
                    runtime: "albert-v3",
                    analyticalRuntime: "cube-v3",
                  },
                  created_at: "2026-08-09T04:00:00.000Z",
                  completed_at: "2026-08-09T04:01:00.000Z",
                },
              },
              {
                conversation_id: "01J00000000000000000000031",
                title: "Top customers this month",
                status: "active",
                created_at: "2026-08-08T00:00:00.000Z",
                updated_at: "2026-08-08T03:01:00.000Z",
                last_turn: {
                  turn_id: "01J00000000000000000000032",
                  turn_number: 1,
                  user_message: "Who were the top customers this month?",
                  status: "completed",
                  answer_state: "verified",
                  runtime_profile: {
                    model: "gpt-5.6-luna",
                    runtime: "albert-v3",
                    analyticalRuntime: "cube-v3",
                  },
                  created_at: "2026-08-08T03:00:00.000Z",
                  completed_at: "2026-08-08T03:01:00.000Z",
                },
              },
              {
                conversation_id: "01J00000000000000000000033",
                title: "Margin by category",
                status: "active",
                created_at: "2026-08-07T00:00:00.000Z",
                updated_at: "2026-08-07T02:01:00.000Z",
                last_turn: {
                  turn_id: "01J00000000000000000000034",
                  turn_number: 1,
                  user_message: "Which categories are compressing margin?",
                  status: "completed",
                  answer_state: "verified",
                  runtime_profile: {
                    model: "gpt-5.6-luna",
                    runtime: "albert-v3",
                    analyticalRuntime: "cube-v3",
                  },
                  created_at: "2026-08-07T02:00:00.000Z",
                  completed_at: "2026-08-07T02:01:00.000Z",
                },
              },
              {
                conversation_id: "01J00000000000000000000035",
                title: "Refunds by store",
                status: "active",
                created_at: "2026-08-06T00:00:00.000Z",
                updated_at: "2026-08-06T01:01:00.000Z",
                last_turn: {
                  turn_id: "01J00000000000000000000036",
                  turn_number: 1,
                  user_message: "Where are refunds concentrating?",
                  status: "completed",
                  answer_state: "verified",
                  runtime_profile: {
                    model: "gpt-5.6-luna",
                    runtime: "albert-v3",
                    analyticalRuntime: "cube-v3",
                  },
                  created_at: "2026-08-06T01:00:00.000Z",
                  completed_at: "2026-08-06T01:01:00.000Z",
                },
              },
            ]
          : options.anthropicHistory || options.specialistHistory || options.codexHistory
          ? [
              {
                conversation_id: "01J00000000000000000000021",
                title: options.specialistHistory
                  ? "Customer review"
                  : options.codexHistory
                    ? "Codex business review"
                    : "Claude sales review",
                status: "active",
                created_at: "2026-08-09T00:00:00.000Z",
                updated_at: "2026-08-09T00:01:00.000Z",
                last_turn: {
                  turn_id: "01J00000000000000000000022",
                  turn_number: 1,
                  user_message: options.specialistHistory
                    ? "Review our customer base"
                    : options.codexHistory
                      ? "Review the business"
                      : "Review yesterday's sales",
                  status: "completed",
                  answer_state: "verified",
                  runtime_profile: options.specialistHistory
                    ? {
                        model: "gpt-5.6-luna",
                        runtime: "albert-v3",
                        analyticalRuntime: "cube-v3",
                        specialistAgentId: "customers",
                      }
                    : options.codexHistory
                      ? {
                          model: "gpt-5.6-sol",
                          runtime: "codex-app-server",
                          analyticalRuntime: "cube-codex-v1",
                        }
                      : {
                        model: "claude-opus-5",
                        runtime: "anthropic-agent-sdk",
                      },
                  created_at: "2026-08-09T00:00:00.000Z",
                  completed_at: "2026-08-09T00:01:00.000Z",
                },
              },
            ]
          : [],
      },
    });
  });

  await page.route(
    /\/api\/conversations\/01J00000000000000000000021$/u,
    async (route) => {
      await route.fulfill({
        json: {
          history: {
            conversation_id: "01J00000000000000000000021",
            next_sequence: 9,
            turns: [
              {
                turn_id: "01J00000000000000000000022",
                turn_number: 1,
                user_message: options.recentAnalyses
                  ? "How did this week compare to last week?"
                  : options.specialistHistory
                  ? "Review our customer base"
                  : options.codexHistory
                    ? "Review the business"
                    : "Review yesterday's sales",
                status: "completed",
                answer_state: "verified",
                runtime_profile: options.specialistHistory
                  ? {
                      model: "gpt-5.6-luna",
                      runtime: "albert-v3",
                      analyticalRuntime: "cube-v3",
                      specialistAgentId: "customers",
                    }
                  : options.codexHistory
                    ? {
                        model: "gpt-5.6-sol",
                        runtime: "codex-app-server",
                        analyticalRuntime: "cube-codex-v1",
                      }
                    : {
                      model: "claude-opus-5",
                      runtime: "anthropic-agent-sdk",
                    },
                created_at: "2026-08-09T00:00:00.000Z",
                completed_at: "2026-08-09T00:01:00.000Z",
                events: createDeterministicFixtureTrace(),
              },
            ],
          },
        },
      });
    },
  );

  await page.route(/\/api\/(?:v3-)?conversation$/u, async (route) => {
    const requestPayload = route.request().postDataJSON() as Record<string, unknown>;
    capture.conversationPayloads.push(requestPayload);
    const fixtureTurnId = `01J000000000000000000000${String(40 + capture.conversationPayloads.length).padStart(2, "0")}`;
    const isV3 = /v3-conversation/u.test(route.request().url());
    const requestedPreferences = requestPayload.preferences && typeof requestPayload.preferences === "object"
      ? requestPayload.preferences as Record<string, unknown>
      : {};
    const requestedModel = typeof requestedPreferences.model === "string"
      ? requestedPreferences.model
      : "gpt-5.6-luna";
    if (isV3) capture.runtimeRequestStartedAt.v3.push(Date.now());
    if (isV3 && options.v3DelayMs) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, options.v3DelayMs));
    }
    const body = createDeterministicFixtureTrace()
      .map((event) =>
        isV3
          ? `id: ${event.sequence}\nevent: trace\ndata: ${JSON.stringify(event)}\n\n`
          : `data: ${JSON.stringify(event)}\n\n`,
      )
      .join("");
    await route.fulfill({
      status: 200,
      body,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Albert-Runtime": isV3 ? "v3" : "fixture",
        ...(isV3 ? {
          "X-Albert-Model": requestedModel,
          "X-Albert-Conversation-Id": "01J00000000000000000000020",
          "X-Albert-Turn-Id": fixtureTurnId,
          "X-Albert-Specialist-Agent": typeof requestPayload.specialistAgentId === "string"
            ? requestPayload.specialistAgentId
            : "general",
          ...(requestPayload.comparisonMode === true
            ? { "X-Albert-Analysis-Brief": "fixture-shared-brief" }
            : {}),
        } : {}),
      },
    }).catch(() => undefined);
  });

  await page.route(/\/api\/swarm(?:\?.*)?$/u, async (route) => {
    if (route.request().method() !== "POST") {
      await route.fulfill({ json: { run: null } });
      return;
    }
    const requestPayload = route.request().postDataJSON() as Record<string, unknown>;
    capture.swarmPayloads.push(requestPayload);
    const preferences = requestPayload.preferences && typeof requestPayload.preferences === "object"
      ? requestPayload.preferences as Record<string, unknown>
      : {};
    const superAgent = requestPayload.kind === "super-agent";
    const swarmRuntime = requestPayload.runtime === "omni" ? "omni" : "codex";
    await route.fulfill({
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "X-Albert-Runtime": swarmRuntime,
        "X-Albert-Conversation-Id": "01J00000000000000000000061",
        "X-Albert-Turn-Id": "01J00000000000000000000062",
      },
      json: {
        run: {
          runId: "01J00000000000000000000063",
          plan: { periodLabel: "As asked", runtime: swarmRuntime },
        },
        // Omni swarms carry one worker so the browser exercises the real
        // fan-out through the omni conversation fixture; codex fixtures keep
        // the historical empty fleet.
        agents: swarmRuntime === "omni"
          ? [{
              key: "sales-measure",
              title: "Sales trajectory",
              tagline: "Measure the sales trend",
              role: "measure",
              prompt: "Measure the sales trajectory for the governed period.",
            }]
          : [],
        preferences: {
          model: typeof preferences.model === "string" ? preferences.model : "gpt-5.6-luna",
          reasoningEffort: typeof preferences.reasoningEffort === "string" ? preferences.reasoningEffort : "max",
          fastMode: preferences.fastMode === true,
          solPlanner: requestPayload.solPlanner === true,
          proMode: false,
        },
        synthesisProMode: requestPayload.proMode === true,
        concurrency: superAgent ? 1 : 3,
        kind: superAgent ? "super-agent" : "question",
        runtime: swarmRuntime,
        ...(superAgent ? {
          durationMs: 45 * 60_000,
          checkpointIntervalMs: 2 * 60_000,
        } : {}),
      },
    });
  });

  await page.route(/\/api\/swarm\/agent$/u, async (route) => {
    await route.fulfill({ json: { agent: { headline: null, answerState: null, keyNumbers: [] } } });
  });

  await page.route(/\/api\/swarm\/heartbeat$/u, async (route) => {
    await route.fulfill({ json: { ok: true } });
  });

  await page.route(/\/api\/swarm\/synthesis$/u, async (route) => {
    await route.fulfill({
      json: {
        synthesis: {
          answer: "The fixture swarm completed without launching worker fixtures.",
          answerState: "Unavailable",
          followUps: [],
        },
      },
    });
  });

  // Dashboard Master: a stateful mock of the daily deep-dive family. The
  // session assigns one objective; once compose is requested the panel serves
  // a completed five-focus report whose first item carries governed evidence.
  const dashboardMasterState = { composed: false };
  const dashboardMasterReportFixture = {
    reportId: "01J000000000000000000000DM",
    generatedAt: "2026-08-30T05:00:00.000Z",
    periodLabel: "the last 12 complete weeks, with the latest complete month in focus",
    model: "gpt-5.6-luna",
    investigationMinutes: 58.4,
    workerTurns: 11,
    governedQueries: 214,
    headline: "Margins, not sales volume, are the biggest profit lever this month.",
    overview: "Sales are steady across the last 12 weeks, but discounting and labour-data gaps are eroding profit. The five focus areas below carry the most money and are ranked by how quickly you can act on them.",
    focus: [1, 2, 3, 4, 5].map((rank) => ({
      rank,
      title: rank === 1 ? "Stop the discount leakage on bikes" : `Fixture focus area ${rank}`,
      verdict: "Discounts of $5,209.42 in twelve weeks sit almost entirely on the bike floor, at margins already below benchmark.",
      whyItMatters: "Bikes carry most of the revenue but the thinnest margin, so pricing moves swing profit more than sales volume does.",
      keyFigures: [
        { label: "Discounts (12 wks)", value: "$5,209.42", sentiment: "negative" },
        { label: "Floor margin", value: "43.3%", sentiment: "neutral" },
      ],
      actions: [
        "Set a discount approval threshold for anything over 10%.",
        "Review pricing on the top ten discounted bikes this week.",
      ],
      tables: rank === 1
        ? [{
            resultId: "01J00000000000000000000091",
            caption: "Weekly revenue",
            connector: "lightspeed",
            timeRangeLabel: "last 12 weeks",
            columns: [
              { key: "sales_analytics_completed_at", label: "Completed", type: "date" },
              { key: "sales_analytics_gross_takings", label: "Gross takings", type: "currency", currency: "AUD" },
            ],
            rows: [
              { sales_analytics_completed_at: "2026-07-20", sales_analytics_gross_takings: 8120.5 },
              { sales_analytics_completed_at: "2026-07-27", sales_analytics_gross_takings: 8379.02 },
              { sales_analytics_completed_at: "2026-08-03", sales_analytics_gross_takings: 8654.1 },
            ],
            rowCount: 3,
          }]
        : [],
      charts: rank === 1
        ? [{
            resultId: "01J00000000000000000000091",
            caption: "Weekly revenue trend",
            chartType: "line",
            xKey: "sales_analytics_completed_at",
            yKey: "sales_analytics_gross_takings",
            columns: [
              { key: "sales_analytics_completed_at", label: "Completed", type: "date" },
              { key: "sales_analytics_gross_takings", label: "Gross takings", type: "currency", currency: "AUD" },
            ],
            rows: [
              { sales_analytics_completed_at: "2026-07-20", sales_analytics_gross_takings: 8120.5 },
              { sales_analytics_completed_at: "2026-07-27", sales_analytics_gross_takings: 8379.02 },
              { sales_analytics_completed_at: "2026-08-03", sales_analytics_gross_takings: 8654.1 },
            ],
          }]
        : [],
    })),
    cautions: ["The latest labour week is partial; wage ratios exclude it."],
  };
  await page.route(/\/api\/dashboard-master(?:\?.*)?$/u, async (route) => {
    await route.fulfill({
      json: {
        latest: dashboardMasterState.composed
          ? {
              reportId: dashboardMasterReportFixture.reportId,
              status: "completed",
              model: "gpt-5.6-luna",
              reasoningEffort: "max",
              startedAt: "2026-08-30T04:00:00.000Z",
              completedAt: "2026-08-30T05:00:00.000Z",
              report: dashboardMasterReportFixture,
              failureNote: null,
            }
          : null,
        running: null,
        conversationIds: [],
        refreshDue: false,
        canRun: true,
      },
    });
  });
  await page.route(/\/api\/dashboard-master\/session$/u, async (route) => {
    capture.dashboardMasterPayloads.push({ endpoint: "session", body: route.request().postDataJSON() });
    await route.fulfill({
      json: {
        reportId: "01J000000000000000000000DM",
        state: { phase: "round-1" },
        turns: [{
          key: "sales-trajectory",
          round: 1,
          title: "Sales trajectory and demand",
          message: "Investigate the sales trajectory for the daily dashboard.",
        }],
      },
    });
  });
  await page.route(/\/api\/dashboard-master\/finding$/u, async (route) => {
    capture.dashboardMasterPayloads.push({ endpoint: "finding", body: route.request().postDataJSON() });
    await route.fulfill({ json: { state: { phase: "round-1" } } });
  });
  await page.route(/\/api\/dashboard-master\/direct$/u, async (route) => {
    capture.dashboardMasterPayloads.push({ endpoint: "direct", body: route.request().postDataJSON() });
    await route.fulfill({ json: { state: { phase: "compose" }, turns: [] } });
  });
  await page.route(/\/api\/dashboard-master\/compose$/u, async (route) => {
    capture.dashboardMasterPayloads.push({ endpoint: "compose", body: route.request().postDataJSON() });
    dashboardMasterState.composed = true;
    await route.fulfill({ json: { latest: { reportId: "01J000000000000000000000DM" } } });
  });

  // ---- Natural-language dashboard builder (ADR 0129) ----------------------
  const dashboardBuildState = {
    /** Element editor state (ADR 0134): presentation, authored order, requeried granularity. */
    presentation: {} as Record<string, Record<string, unknown>>,
    displays: {} as Record<string, Record<string, unknown>>,
    order: {} as Record<string, string[]>,
    granularity: null as string | null,
    recipeVersion: {} as Record<string, number>,
    applied: options.dashboardApplied === true,
    title: options.dashboardApplied ? "Ashburton at a glance" : null as string | null,
    /** An element edit replaced "Revenue by week" with "Revenue by day". */
    edited: false,
    /** "New dashboard" created the blank second dashboard. */
    created: false,
    /** Which dashboard the last whole build applied to. */
    appliedTo: null as string | null,
    /** The first dashboard was deleted from the list. */
    deleted: false,
    /** Element sort/filters saved through the tile route, by tile id. */
    overrides: {} as Record<string, Record<string, unknown>>,
  };
  const dashboardBuildDigest = "0f".repeat(32);
  const dashboardBuildStamp = "2026-08-30T04:10:00.000Z";
  const dashboardBuildWatermarks = [
    { connector: "lightspeed", label: "Lightspeed", dataThrough: "2026-08-30T02:00:00.000Z" },
  ];
  const dashboardBuildSnapshot = (
    columns: readonly Record<string, unknown>[],
    rows: readonly Record<string, unknown>[],
  ) => ({
    columns,
    rows,
    totalRowCount: rows.length,
    resultDigest: dashboardBuildDigest,
    provenance: columns[0]?.key === "metric" ? { dashboardPivot: { rowFormats: [{ type: "currency", currency: "AUD" }, { type: "currency", currency: "AUD" }, { type: "number" }] } } : null,
    sourceWatermarks: dashboardBuildWatermarks,
    queryTime: dashboardBuildStamp,
    refreshedAt: dashboardBuildStamp,
    empty: rows.length === 0,
  });
  const dashboardBuildTile = (
    tileId: string,
    title: string,
    resultSuffix: string,
    display: Record<string, unknown>,
    snapshot: Record<string, unknown>,
    replayKind: "cube_v3" | "derived_v1" = "cube_v3",
  ) => ({
    tileId,
    title,
    source: {
      conversationId: "01J00000000000000000DBCV01",
      turnId: "01J00000000000000000DBTN01",
      tableEventId: `01J00000000000000000DBE${resultSuffix}`,
      resultId: `01J00000000000000000DBR${resultSuffix}`,
    },
    replayKind,
    queryYaml: replayKind === "cube_v3" ? "measures:\n  - sales_analytics.gross_takings" : null,
    recipeVersion: dashboardBuildState.recipeVersion[tileId] ?? 1,
    recipeOrigin: (dashboardBuildState.recipeVersion[tileId] ?? 1) > 1 ? "edited" : "trace",
    snapshot: dashboardBuildState.order[tileId] && snapshot && Array.isArray((snapshot as { columns?: unknown }).columns)
      ? {
        ...snapshot,
        columns: [...((snapshot as { columns: { key: string }[] }).columns)].sort((left, right) => {
          const order = dashboardBuildState.order[tileId]!;
          const rank = (key: string) => { const index = order.indexOf(key); return index < 0 ? order.length : index; };
          return rank(left.key) - rank(right.key);
        }),
      }
      : snapshot,
    columnPresentation: dashboardBuildState.presentation[tileId] ?? {},
    display: dashboardBuildState.displays[tileId] ?? display,
    queryOverrides: dashboardBuildState.overrides[tileId] ?? {},
    refreshState: "current",
    lastErrorCode: null,
    lastRefreshAttemptAt: null,
    lastRefreshedAt: dashboardBuildStamp,
    createdAt: dashboardBuildStamp,
  });
  const revenueColumns = [
    { key: "sales_analytics_gross_takings", label: "Gross takings", type: "currency", currency: "AUD" },
    { key: "compareDateRange", label: "Date range", type: "string" },
  ];
  const builtDashboardDocument = () => ({
    dashboardId: "01J00000000000000000DBRD01",
    title: dashboardBuildState.title,
    lastBuildConversationId: dashboardBuildState.applied ? "01J00000000000000000DBCV01" : null,
    revision: dashboardBuildState.applied ? 9 : 0,
    layouts: dashboardBuildState.applied
      ? {
          desktop: [
            { i: "01J00000000000000000DBT101", x: 0, y: 0, w: 3, h: 5 },
            { i: "01J00000000000000000DBT201", x: 3, y: 0, w: 3, h: 5 },
            { i: dashboardBuildState.edited ? "01J00000000000000000DBT601" : "01J00000000000000000DBT301", x: 0, y: 5, w: 6, h: 8 },
            { i: "01J00000000000000000DBT401", x: 6, y: 5, w: 6, h: 7 },
            { i: "01J00000000000000000DBT501", x: 0, y: 13, w: 12, h: 7 },
          ],
          tablet: [
            { i: "01J00000000000000000DBT101", x: 0, y: 0, w: 4, h: 5 },
            { i: "01J00000000000000000DBT201", x: 4, y: 0, w: 4, h: 5 },
            { i: dashboardBuildState.edited ? "01J00000000000000000DBT601" : "01J00000000000000000DBT301", x: 0, y: 5, w: 4, h: 8 },
            { i: "01J00000000000000000DBT401", x: 4, y: 5, w: 4, h: 7 },
            { i: "01J00000000000000000DBT501", x: 0, y: 13, w: 8, h: 7 },
          ],
        }
      : { desktop: [], tablet: [] },
    tiles: dashboardBuildState.applied
      ? [
          dashboardBuildTile(
            "01J00000000000000000DBT101",
            "Revenue",
            "V01",
            { mode: "kpi", valueKey: "sales_analytics_gross_takings", note: "vs previous 30 days" },
            dashboardBuildSnapshot(revenueColumns, [
              { sales_analytics_gross_takings: 41230.55, compareDateRange: "2026-08-01 - 2026-08-30" },
              { sales_analytics_gross_takings: 36780.1, compareDateRange: "2026-07-02 - 2026-07-31" },
            ]),
          ),
          dashboardBuildTile(
            "01J00000000000000000DBT201",
            "Refunds",
            "V02",
            { mode: "kpi", valueKey: "refunds_analytics_refund_total", note: "vs previous 30 days" },
            dashboardBuildSnapshot([
              { key: "refunds_analytics_refund_total", label: "Refund total", type: "currency", currency: "AUD" },
              { key: "compareDateRange", label: "Date range", type: "string" },
            ], [
              { refunds_analytics_refund_total: 512.4, compareDateRange: "2026-08-01 - 2026-08-30" },
              { refunds_analytics_refund_total: 698.9, compareDateRange: "2026-07-02 - 2026-07-31" },
            ]),
          ),
          // An element edit swaps this chart for a daily one in the same slot.
          dashboardBuildState.edited
            ? dashboardBuildTile(
              "01J00000000000000000DBT601",
              "Revenue by day",
              "V06",
              {
                mode: "chart",
                chartType: "line",
                xKey: "sales_analytics_completed_at",
                yKey: "sales_analytics_gross_takings",
                note: "by day, last 30 days",
              },
              dashboardBuildSnapshot([
                { key: "sales_analytics_completed_at", label: "Completed", type: "date" },
                { key: "sales_analytics_gross_takings", label: "Gross takings", type: "currency", currency: "AUD" },
              ], [
                { sales_analytics_completed_at: "2026-08-27", sales_analytics_gross_takings: 1210.5 },
                { sales_analytics_completed_at: "2026-08-28", sales_analytics_gross_takings: 1379.02 },
                { sales_analytics_completed_at: "2026-08-29", sales_analytics_gross_takings: 1490.4 },
                { sales_analytics_completed_at: "2026-08-30", sales_analytics_gross_takings: 1621.83 },
              ]),
            )
            : dashboardBuildTile(
              "01J00000000000000000DBT301",
              "Revenue by week",
              "V03",
              {
                mode: "chart",
                chartType: "line",
                // The server carries display keys across a re-spelled time column.
                xKey: dashboardBuildState.granularity === "month" ? "sales_analytics_completed_at_month" : "sales_analytics_completed_at",
                yKey: "sales_analytics_gross_takings",
                note: "by week, last 12 weeks",
              },
              dashboardBuildState.granularity === "month"
                ? dashboardBuildSnapshot([
                  { key: "sales_analytics_completed_at_month", label: "Completed (month)", type: "date" },
                  { key: "sales_analytics_gross_takings", label: "Gross takings", type: "currency", currency: "AUD" },
                ], [
                  { sales_analytics_completed_at_month: "2026-06-01", sales_analytics_gross_takings: 31200.5 },
                  { sales_analytics_completed_at_month: "2026-07-01", sales_analytics_gross_takings: 34911.02 },
                  { sales_analytics_completed_at_month: "2026-08-01", sales_analytics_gross_takings: 36780.1 },
                ])
                : dashboardBuildSnapshot([
                  { key: "sales_analytics_completed_at", label: "Completed", type: "date" },
                  { key: "sales_analytics_gross_takings", label: "Gross takings", type: "currency", currency: "AUD" },
                ], [
                  { sales_analytics_completed_at: "2026-07-20", sales_analytics_gross_takings: 8120.5 },
                  { sales_analytics_completed_at: "2026-07-27", sales_analytics_gross_takings: 8379.02 },
                  { sales_analytics_completed_at: "2026-08-03", sales_analytics_gross_takings: 8990.4 },
                  { sales_analytics_completed_at: "2026-08-10", sales_analytics_gross_takings: 9421.83 },
                ]),
            ),
          dashboardBuildTile(
            "01J00000000000000000DBT401",
            "Top products by revenue",
            "V04",
            { mode: "table" },
            dashboardBuildSnapshot([
              { key: "sales_analytics_product", label: "Product", type: "string" },
              { key: "sales_analytics_gross_takings", label: "Gross takings", type: "currency", currency: "AUD" },
            ], [
              { sales_analytics_product: "Service — full tune", sales_analytics_gross_takings: 6240 },
              { sales_analytics_product: "Gravel bike hire", sales_analytics_gross_takings: 4180.5 },
              { sales_analytics_product: "Helmets", sales_analytics_gross_takings: 2310.9 },
            ]),
          ),
          // A composed pivot: metrics down the rows, weeks across the columns.
          dashboardBuildTile(
            "01J00000000000000000DBT501",
            "Weekly scorecard",
            "V05",
            { mode: "table", note: "Last 3 weeks, by Monday-starting week" },
            dashboardBuildSnapshot([
              { key: "metric", label: "Metric", type: "string" },
              { key: "p_2026_07_27", label: "27 Jul", type: "number" },
              { key: "p_2026_08_03", label: "3 Aug", type: "number" },
              { key: "p_2026_08_10", label: "10 Aug", type: "number" },
            ], [
              { metric: "Sales", p_2026_07_27: 8379.02, p_2026_08_03: 8990.4, p_2026_08_10: 9421.83 },
              { metric: "Gross profit", p_2026_07_27: 3120.5, p_2026_08_03: 3388.12, p_2026_08_10: 3610.77 },
              { metric: "Transactions", p_2026_07_27: 214, p_2026_08_03: 231, p_2026_08_10: 246 },
            ]),
            "derived_v1",
          ),
        ]
      : [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: dashboardBuildStamp,
  });
  // Dashboards, plural (ADR 0134): the list, create, delete, and every
  // document call addressed by id (the query string must not break the match).
  const dashboardSummaries = () => {
    const built = builtDashboardDocument();
    return [
      ...(dashboardBuildState.deleted ? [] : [{
        dashboardId: built.dashboardId,
        title: built.title,
        revision: built.revision,
        tileCount: built.tiles.length,
        lastBuildConversationId: dashboardBuildState.applied ? "01J00000000000000000DBCV01" : null,
        createdAt: built.createdAt,
        updatedAt: built.updatedAt,
      }]),
      ...(dashboardBuildState.created ? [{
        dashboardId: "01J00000000000000000DBRD02",
        title: dashboardBuildState.appliedTo === "01J00000000000000000DBRD02" ? dashboardBuildState.title : null,
        revision: 0,
        tileCount: dashboardBuildState.appliedTo === "01J00000000000000000DBRD02" ? 5 : 0,
        lastBuildConversationId: null,
        createdAt: dashboardBuildStamp,
        updatedAt: dashboardBuildStamp,
      }] : []),
    ];
  };
  const emptyDashboardDocument = () => ({
    dashboardId: "01J00000000000000000DBRD02",
    title: null,
    revision: 0,
    layouts: { desktop: [], tablet: [] },
    lastBuildConversationId: null,
    tiles: [],
    createdAt: dashboardBuildStamp,
    updatedAt: dashboardBuildStamp,
  });
  const documentFor = (dashboardId: string | null) => (
    dashboardId === "01J00000000000000000DBRD02" && dashboardBuildState.appliedTo !== "01J00000000000000000DBRD02"
      ? emptyDashboardDocument()
      : builtDashboardDocument()
  );
  await page.route(/\/api\/dashboard\/list$/u, async (route) => {
    await route.fulfill({ json: { dashboards: dashboardSummaries() } });
  });
  await page.route(/\/api\/dashboard(?:\?.*)?$/u, async (route) => {
    const method = route.request().method();
    if (method === "POST") {
      capture.dashboardBuildPayloads.push({ endpoint: "create", body: route.request().postDataJSON() });
      dashboardBuildState.created = true;
      await route.fulfill({ status: 201, json: { dashboard: emptyDashboardDocument() } });
      return;
    }
    if (method === "DELETE") {
      capture.dashboardBuildPayloads.push({ endpoint: "delete", body: route.request().postDataJSON() });
      dashboardBuildState.deleted = true;
      await route.fulfill({ json: { dashboards: dashboardSummaries() } });
      return;
    }
    const requested = new URL(route.request().url()).searchParams.get("dashboardId");
    await route.fulfill({ json: { dashboard: documentFor(requested) } });
  });
  await page.route(/\/api\/dashboard\/refresh$/u, async (route) => {
    const body = route.request().postDataJSON() as { dashboardId?: string; tileIds?: string[] };
    capture.dashboardBuildPayloads.push({ endpoint: "refresh", body });
    await route.fulfill({ json: { dashboard: documentFor(body.dashboardId ?? null), refreshedTileIds: body.tileIds ?? [] } });
  });
  await page.route(/\/api\/dashboard\/layout$/u, async (route) => {
    await route.fulfill({ json: { dashboard: builtDashboardDocument() } });
  });
  // The element editor (ADR 0134, migration 0187): the governed view's
  // fields behind an element, and one deterministic requery of its query.
  const dashboardFieldsFixture = (tileId: string) => ({
    view: { name: "sales_analytics", title: "Sales analytics" },
    inQuery: tileId === "01J00000000000000000DBT301"
      ? {
        measures: ["sales_analytics.gross_takings"],
        dimensions: [],
        timeDimensions: [{ dimension: "sales_analytics.completed_at", granularity: dashboardBuildState.granularity ?? "week", dateRange: "last 12 weeks" }],
        limit: 50,
      }
      : tileId === "01J00000000000000000DBT401"
        ? {
          measures: ["sales_analytics.gross_takings"],
          dimensions: ["sales_analytics.product"],
          timeDimensions: [{ dimension: "sales_analytics.completed_at", dateRange: "last 30 days" }],
          limit: 10,
        }
        : {
          measures: ["sales_analytics.gross_takings"],
          dimensions: [],
          timeDimensions: [{ dimension: "sales_analytics.completed_at", compareDateRange: [["2026-08-01", "2026-08-30"], ["2026-07-02", "2026-07-31"]] }],
        },
    members: [
      { name: "sales_analytics.gross_takings", kind: "measure", title: "Gross takings", shortTitle: "Gross takings", type: "number" },
      { name: "sales_analytics.net_takings", kind: "measure", title: "Net takings", shortTitle: "Net takings", type: "number" },
      { name: "sales_analytics.product", kind: "dimension", title: "Product", shortTitle: "Product", type: "string" },
      { name: "sales_analytics.completed_at", kind: "dimension", title: "Completed", shortTitle: "Completed", type: "time" },
      { name: "sales_analytics.staff_member", kind: "dimension", title: "Staff member", shortTitle: "Staff member", type: "string" },
    ],
  });
  await page.route(/\/api\/dashboard\/tiles(?:\/.*)?$/u, async (route) => {
    const method = route.request().method();
    const pathname = new URL(route.request().url()).pathname;
    if (method === "GET" && pathname.endsWith("/fields")) {
      const tileId = pathname.split("/").at(-2) ?? "";
      capture.dashboardBuildPayloads.push({ endpoint: "fields", tileId });
      await route.fulfill({ json: dashboardFieldsFixture(tileId) });
      return;
    }
    if (method === "POST" && pathname.endsWith("/query")) {
      const tileId = pathname.split("/").at(-2) ?? "";
      const body = route.request().postDataJSON() as { edits?: { op: string; granularity?: string }[]; recipeVersion?: number };
      capture.dashboardBuildPayloads.push({ endpoint: "query", tileId, body });
      for (const edit of body.edits ?? []) {
        if (edit.op === "set_granularity" && edit.granularity) dashboardBuildState.granularity = edit.granularity;
      }
      dashboardBuildState.recipeVersion[tileId] = (body.recipeVersion ?? 1) + 1;
      // Stale-while-revalidate: the element keeps its data while this runs.
      await new Promise((resolve) => setTimeout(resolve, 250));
      const dashboard = builtDashboardDocument();
      await route.fulfill({ json: { dashboard, tile: dashboard.tiles.find((tile) => tile.tileId === tileId) ?? null, executionMs: 900 } });
      return;
    }
    if (method === "POST") {
      capture.dashboardBuildPayloads.push({ endpoint: "pin", body: route.request().postDataJSON() });
    }
    if (method === "PATCH") {
      const tileId = pathname.split("/").pop() ?? "";
      const body = route.request().postDataJSON() as {
        queryOverrides?: Record<string, unknown>;
        columnPresentation?: Record<string, Record<string, unknown>>;
        columnOrder?: string[];
        display?: unknown;
        title?: string;
      };
      capture.dashboardBuildPayloads.push({ endpoint: "tile", tileId, body });
      // The element's sort/filters, presentation and column order live on
      // the document; the client re-reads them.
      if (body.queryOverrides) dashboardBuildState.overrides[tileId] = body.queryOverrides;
      if (body.columnPresentation) dashboardBuildState.presentation[tileId] = body.columnPresentation;
      if (body.columnOrder) dashboardBuildState.order[tileId] = body.columnOrder;
      if (body.display && typeof body.display === "object") dashboardBuildState.displays[tileId] = body.display as Record<string, unknown>;
    }
    await route.fulfill({ json: { dashboard: builtDashboardDocument() } });
  });
  await page.route(/\/api\/dashboard\/build$/u, async (route) => {
    capture.dashboardBuildPayloads.push({ endpoint: "build", body: route.request().postDataJSON() });
    const body = route.request().postDataJSON() as { instruction?: string; dashboardId?: string; tileId?: string };
    const dashboardId = body.dashboardId ?? "01J00000000000000000DBRD01";
    if (body.tileId) {
      // An element edit briefs the architect with the one element (ADR 0134).
      await route.fulfill({
        json: {
          message: `Edit one element of my dashboard.\n\nElement: "Revenue by week" (chart)\nWhat I want changed: ${body.instruction ?? ""}\n\nThe element's governed query today (YAML):\nmeasures:\n  - sales_analytics.gross_takings\n\nDisplay today: line chart, x sales_analytics_completed_at, y sales_analytics_gross_takings\nWidth today: half\n\nRules for an element edit:\n- Rebuild ONLY this element; never add, remove or redesign any other element.\n\nTarget dashboard: ${dashboardId}\nTarget element: ${body.tileId}`,
          preferences: { model: "gpt-5.6-luna", reasoningEffort: "max", fastMode: false },
          dashboardId,
          editTileId: body.tileId,
          replacesTiles: 1,
        },
      });
      return;
    }
    await route.fulfill({
      json: {
        message: `Design and build my dashboard.\n\nWhat I want: ${body.instruction ?? ""}\n\nTarget dashboard: ${dashboardId}`,
        preferences: { model: "gpt-5.6-luna", reasoningEffort: "max", fastMode: false },
        dashboardId,
        replacesTiles: 0,
      },
    });
  });
  await page.route(/\/api\/dashboard\/rename$/u, async (route) => {
    const body = route.request().postDataJSON() as { title?: string | null };
    capture.dashboardBuildPayloads.push({ endpoint: "rename", body });
    dashboardBuildState.title = typeof body.title === "string" ? body.title : null;
    await route.fulfill({ json: { dashboard: builtDashboardDocument() } });
  });
  await page.route(/\/api\/dashboard\/build\/apply$/u, async (route) => {
    const body = route.request().postDataJSON() as { replaceTileId?: string; dashboardId?: string };
    capture.dashboardBuildPayloads.push({ endpoint: "apply", body });
    if (body.replaceTileId) {
      // The edited tile is replaced in place; nothing else moves.
      dashboardBuildState.edited = true;
      await route.fulfill({
        json: {
          dashboard: builtDashboardDocument(),
          applied: {
            dashboardId: body.dashboardId ?? "01J00000000000000000DBRD01",
            dashboardTitle: dashboardBuildState.title ?? "Ashburton at a glance",
            timeframe: "Last 30 days, by day",
            tiles: 1,
            skipped: [],
            replacedTileId: body.replaceTileId,
            newTileId: "01J00000000000000000DBT601",
          },
        },
      });
      return;
    }
    dashboardBuildState.applied = true;
    dashboardBuildState.appliedTo = body.dashboardId ?? "01J00000000000000000DBRD01";
    dashboardBuildState.title = "Ashburton at a glance";
    await route.fulfill({
      json: {
        dashboard: builtDashboardDocument(),
        applied: {
          dashboardId: body.dashboardId ?? "01J00000000000000000DBRD01",
          dashboardTitle: "Ashburton at a glance",
          timeframe: "Last 30 days vs the previous 30",
          tiles: 4,
          skipped: [],
        },
      },
    });
  });

  await page.route(/\/api\/codex-conversation$/u, async (route) => {
    const requestPayload = route.request().postDataJSON() as Record<string, unknown>;
    capture.codexConversationPayloads.push(requestPayload);
    capture.runtimeRequestStartedAt.codex.push(Date.now());
    if (options.codexDelayMs) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, options.codexDelayMs));
    }
    const fixtureEvents = createDeterministicFixtureTrace();
    const requestedMessage = typeof requestPayload.message === "string" ? requestPayload.message : "";
    const contextualAcknowledgement = /categor/iu.test(requestedMessage)
      ? "I’ll compare category performance and check what explains the difference."
      : /opportun/iu.test(requestedMessage)
        ? "I’ll investigate the strongest near-term business opportunity and follow the evidence."
        : "I’ll investigate the requested business question and follow the strongest evidence.";
    const analyticalCodexEvents = [
      {
        id: "trace_fixture_codex_acknowledgement",
        sequence: 1,
        type: "narrative",
        status: "complete",
        purpose: "acknowledgement",
        occurredAt: "2026-08-03T00:42:59.980Z",
        text: contextualAcknowledgement,
      },
      { ...fixtureEvents[0], sequence: 2 },
      {
        id: "trace_fixture_codex_plan",
        sequence: 3,
        type: "plan",
        status: "complete",
        occurredAt: "2026-08-03T00:43:00.040Z",
        steps: [
          { id: "codex_plan_step_1", label: "Find the governed sales view", status: "active", kind: "evidence", evidenceResultIds: [] },
          { id: "codex_plan_step_2", label: "Query the supported sales measure", status: "pending", kind: "evidence", evidenceResultIds: [] },
          { id: "codex_plan_step_3", label: "Validate and present the answer", status: "pending", kind: "synthesis", evidenceResultIds: [] },
        ],
      },
      ...fixtureEvents.slice(1, 5).map((event) => ({ ...event, sequence: event.sequence + 2 })),
      {
        id: "trace_fixture_codex_plan_evidence",
        sequence: 8,
        type: "plan",
        status: "complete",
        occurredAt: "2026-08-03T00:43:00.440Z",
        steps: [
          { id: "codex_plan_step_1", label: "Find the governed sales view", status: "done", kind: "evidence", evidenceResultIds: [FIXTURE_RESULT_ID] },
          { id: "codex_plan_step_2", label: "Query the supported sales measure", status: "done", kind: "evidence", evidenceResultIds: [FIXTURE_RESULT_ID] },
          { id: "codex_plan_step_3", label: "Validate and present the answer", status: "active", kind: "synthesis", evidenceResultIds: [] },
        ],
      },
      ...fixtureEvents.slice(5, 7).map((event) => ({ ...event, sequence: event.sequence + 3 })),
      {
        id: "trace_fixture_codex_evidence_update",
        sequence: 11,
        type: "narrative",
        status: "complete",
        occurredAt: "2026-08-03T00:43:00.600Z",
        text: "Bikes led category net sales at $84,240.00.",
      },
      {
        id: "trace_fixture_codex_reasoning_summary",
        sequence: 12,
        type: "narrative",
        status: "complete",
        purpose: "reasoning_summary",
        occurredAt: "2026-08-03T00:43:00.640Z",
        text: "I compared category performance, checked the strongest alternative explanations, and verified the leading result against the governed evidence.",
      },
      {
        id: "trace_fixture_codex_plan_complete",
        sequence: 13,
        type: "plan",
        status: "complete",
        occurredAt: "2026-08-03T00:43:00.680Z",
        steps: [
          { id: "codex_plan_step_1", label: "Find the governed sales view", status: "done", kind: "evidence", evidenceResultIds: [FIXTURE_RESULT_ID] },
          { id: "codex_plan_step_2", label: "Query the supported sales measure", status: "done", kind: "evidence", evidenceResultIds: [FIXTURE_RESULT_ID] },
          { id: "codex_plan_step_3", label: "Validate and present the answer", status: "done", kind: "synthesis", evidenceResultIds: [FIXTURE_RESULT_ID] },
        ],
      },
      ...fixtureEvents.slice(8).map((event) => ({ ...event, sequence: event.sequence + 5 })),
    ];
    const localConversationEvent = (id: string, text: string) => ({
      id,
      sequence: 1,
      type: "answer",
      status: "complete",
      occurredAt: "2026-08-03T00:43:00.000Z",
      state: "Verified",
      text,
      provenance: {
        sources: [],
        timeRange: {
          label: "Not applicable — conversational reply",
          start: "unknown",
          end: "unknown",
          timezone: "UTC",
        },
        definitions: [],
        semanticBundleHash: "albert-codex-social-v1",
        identityGraph: { version: 0, hash: "d41d8cd98f00b204e9800998ecf8427e" },
      },
      followUps: [],
      presentedResultIds: [],
      claims: [],
    });
    const codexEvents = /^date tomorrow[?.!]?$/iu.test(requestedMessage.trim())
      ? [localConversationEvent(
          "trace_fixture_codex_tomorrow_answer",
          "Tomorrow is Saturday, 22 August 2026.",
        )]
      : /^whats todays date[?.!]?$/iu.test(requestedMessage.trim())
        ? [localConversationEvent(
          "trace_fixture_codex_date_answer",
          "Today is Friday, 21 August 2026.",
        )]
        : /^nice one[.!]?$/iu.test(requestedMessage.trim())
          ? [localConversationEvent(
            "trace_fixture_codex_social_answer",
            "Glad that helped.",
          )]
          : analyticalCodexEvents;
    const body = codexEvents
      .map((event) => `id: ${event.sequence}\nevent: trace\ndata: ${JSON.stringify(event)}\n\n`)
      .join("");
    const requestedPreferences = requestPayload.preferences && typeof requestPayload.preferences === "object"
      ? requestPayload.preferences as Record<string, unknown>
      : {};
    const requestedModel = typeof requestedPreferences.model === "string"
      ? requestedPreferences.model
      : "gpt-5.6-luna";
    await route.fulfill({
      status: 200,
      body,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Albert-Runtime": "codex",
        "X-Albert-Model": requestedModel,
        "X-Albert-Conversation-Id": "01J00000000000000000000031",
        "X-Albert-Turn-Id": "01J00000000000000000000032",
        "X-Albert-Codex-Version": "0.148.0",
        ...(requestPayload.comparisonMode === true
          ? { "X-Albert-Analysis-Brief": "fixture-shared-brief" }
          : {}),
      },
    }).catch(() => undefined);
  });

  await page.route(/\/api\/omni-conversation$/u, async (route) => {
    const requestPayload = route.request().postDataJSON() as Record<string, unknown>;
    capture.omniConversationPayloads.push(requestPayload);
    if (
      requestPayload.dashboardBuild === true
      && typeof requestPayload.message === "string"
      && requestPayload.message.startsWith("Edit one element of my dashboard.")
    ) {
      // An element edit (ADR 0134): the architect re-runs one query and
      // composes exactly one replacement tile.
      const editStamp = "2026-08-30T04:12:00.000Z";
      const editEvents = [
        { id: "omni_ed_ack", sequence: 1, type: "narrative", purpose: "acknowledgement", occurredAt: editStamp, text: "I’ll rework the revenue trend by day." },
        {
          id: "omni_ed_query", sequence: 2, type: "query", status: "complete", occurredAt: editStamp,
          topic: "Sales analytics", name: "Revenue by day",
          metrics: ["sales_analytics.gross_takings"], dimensions: ["sales_analytics.completed_at"],
          timeRange: { label: "last 30 days", start: "unknown", end: "unknown", timezone: "Australia/Melbourne" },
          lens: "Cube view: sales_analytics", view: "sales_analytics", cubesUsed: ["sales_analytics"],
          queryYaml: "measures:\n  - sales_analytics.gross_takings\ntimeDimensions:\n  - dimension: sales_analytics.completed_at\n    granularity: day\n    dateRange: last 30 days",
          rowCount: 4, executionMs: 700, connector: "lightspeed",
          resultId: "01J00000000000000000DBRV06",
        },
        {
          id: "omni_ed_table", sequence: 3, type: "table", status: "complete", occurredAt: editStamp,
          caption: "Revenue by day",
          columns: [
            { key: "sales_analytics_completed_at", label: "Completed", type: "date" },
            { key: "sales_analytics_gross_takings", label: "Gross takings", type: "currency", currency: "AUD" },
          ],
          rows: [
            { sales_analytics_completed_at: "2026-08-27", sales_analytics_gross_takings: 1210.5 },
            { sales_analytics_completed_at: "2026-08-28", sales_analytics_gross_takings: 1379.02 },
            { sales_analytics_completed_at: "2026-08-29", sales_analytics_gross_takings: 1490.4 },
            { sales_analytics_completed_at: "2026-08-30", sales_analytics_gross_takings: 1621.83 },
          ],
          resultId: "01J00000000000000000DBRV06",
          provenance: {
            sources: [{ connector: "lightspeed", label: "Cube semantic layer · lightspeed", dataThrough: "2026-08-30" }],
            timeRange: { label: "last 30 days", start: "unknown", end: "unknown", timezone: "Australia/Melbourne" },
            definitions: [],
            semanticBundleHash: "albert-omni-fixture",
            identityGraph: { version: 0, hash: "d41d8cd98f00b204e9800998ecf8427e" },
          },
          presentation: "evidence",
          dashboardReplay: {
            kind: "cube_v3",
            queryEventId: "omni_ed_query",
            queryDigest: "ab".repeat(32),
            semanticVersionDigest: "cd".repeat(32),
          },
        },
        {
          id: "omni_ed_plan", sequence: 4, type: "dashboard_plan", status: "complete", occurredAt: editStamp,
          dashboardTitle: "Ashburton at a glance",
          timeframe: "Last 30 days, by day",
          tiles: [
            { resultId: "01J00000000000000000DBRV06", kind: "chart", title: "Revenue by day", width: "half", chartType: "line", xKey: "sales_analytics_completed_at", yKey: "sales_analytics_gross_takings" },
          ],
        },
        {
          id: "omni_ed_answer", sequence: 5, type: "answer", status: "complete", occurredAt: editStamp,
          state: "Verified",
          text: "The revenue trend now runs by day over the last 30 days.",
          provenance: {
            sources: [{ connector: "lightspeed", label: "Cube semantic layer · lightspeed", dataThrough: "2026-08-30" }],
            timeRange: { label: "last 30 days", start: "unknown", end: "unknown", timezone: "Australia/Melbourne" },
            definitions: [],
            semanticBundleHash: "albert-omni-fixture",
            identityGraph: { version: 0, hash: "d41d8cd98f00b204e9800998ecf8427e" },
          },
          followUps: [],
          presentedResultIds: ["01J00000000000000000DBRV06"],
          claims: [],
        },
      ];
      await route.fulfill({
        status: 200,
        body: editEvents
          .map((event) => `id: ${event.sequence}\nevent: trace\ndata: ${JSON.stringify(event)}\n\n`)
          .join(""),
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "text/event-stream; charset=utf-8",
          "X-Albert-Runtime": "omni",
          "X-Albert-Model": "gpt-5.6-luna",
          "X-Albert-Conversation-Id": "01J00000000000000000DBCV02",
          "X-Albert-Turn-Id": "01J00000000000000000DBTN02",
        },
      }).catch(() => undefined);
      return;
    }
    if (requestPayload.dashboardBuild === true) {
      const buildStamp = "2026-08-30T04:09:00.000Z";
      const buildEvents = [
        { id: "omni_db_ack", sequence: 1, type: "narrative", purpose: "acknowledgement", occurredAt: buildStamp, text: "I’ll design your top-level dashboard now." },
        {
          id: "omni_db_tasks", sequence: 2, type: "tasks", status: "running", occurredAt: buildStamp,
          items: [
            { id: "task-1", label: "Choose the standing questions", completed: true },
            { id: "task-2", label: "Verify the KPI queries", completed: false },
            { id: "task-3", label: "Compose the dashboard", completed: false },
          ],
        },
        {
          id: "omni_db_query", sequence: 3, type: "query", status: "complete", occurredAt: buildStamp,
          topic: "Sales analytics", name: "Revenue vs previous 30 days",
          metrics: ["sales_analytics.gross_takings"], dimensions: ["sales_analytics.completed_at"],
          timeRange: { label: "last 30 days", start: "unknown", end: "unknown", timezone: "Australia/Melbourne" },
          lens: "Cube view: sales_analytics", view: "sales_analytics", cubesUsed: ["sales_analytics"],
          queryYaml: "measures:\n  - sales_analytics.gross_takings",
          rowCount: 2, executionMs: 900, connector: "lightspeed",
          resultId: "01J00000000000000000DBRV01",
        },
        {
          id: "omni_db_table", sequence: 4, type: "table", status: "complete", occurredAt: buildStamp,
          caption: "Revenue vs previous 30 days",
          columns: [
            { key: "sales_analytics_gross_takings", label: "Gross takings", type: "currency", currency: "AUD" },
            { key: "compareDateRange", label: "Date range", type: "string" },
          ],
          rows: [
            { sales_analytics_gross_takings: 41230.55, compareDateRange: "2026-08-01 - 2026-08-30" },
            { sales_analytics_gross_takings: 36780.1, compareDateRange: "2026-07-02 - 2026-07-31" },
          ],
          resultId: "01J00000000000000000DBRV01",
          provenance: {
            sources: [{ connector: "lightspeed", label: "Cube semantic layer · lightspeed", dataThrough: "2026-08-30" }],
            timeRange: { label: "last 30 days", start: "unknown", end: "unknown", timezone: "Australia/Melbourne" },
            definitions: [],
            semanticBundleHash: "albert-omni-fixture",
            identityGraph: { version: 0, hash: "d41d8cd98f00b204e9800998ecf8427e" },
          },
          presentation: "evidence",
          dashboardReplay: {
            kind: "cube_v3",
            queryEventId: "omni_db_query",
            queryDigest: "ab".repeat(32),
            semanticVersionDigest: "cd".repeat(32),
          },
        },
        {
          id: "omni_db_plan", sequence: 5, type: "dashboard_plan", status: "complete", occurredAt: buildStamp,
          dashboardTitle: "Ashburton at a glance",
          timeframe: "Last 30 days vs the previous 30",
          tiles: [
            { resultId: "01J00000000000000000DBRV01", kind: "kpi", title: "Revenue", note: "vs previous 30 days", width: "quarter", valueKey: "sales_analytics_gross_takings" },
            { resultId: "01J00000000000000000DBRV01", kind: "chart", title: "Revenue by week", width: "half", chartType: "line", xKey: "sales_analytics_completed_at", yKey: "sales_analytics_gross_takings" },
            { resultId: "01J00000000000000000DBRV01", kind: "table", title: "Top products by revenue", width: "half" },
          ],
        },
        {
          id: "omni_db_tasks_done", sequence: 6, type: "tasks", status: "complete", occurredAt: buildStamp,
          items: [
            { id: "task-1", label: "Choose the standing questions", completed: true },
            { id: "task-2", label: "Verify the KPI queries", completed: true },
            { id: "task-3", label: "Compose the dashboard", completed: true },
          ],
        },
        {
          id: "omni_db_answer", sequence: 7, type: "answer", status: "complete", occurredAt: buildStamp,
          state: "Verified",
          text: "Your dashboard watches revenue, refunds, the weekly trend and top products over the last 30 days against the previous 30.",
          provenance: {
            sources: [{ connector: "lightspeed", label: "Cube semantic layer · lightspeed", dataThrough: "2026-08-30" }],
            timeRange: { label: "last 30 days", start: "unknown", end: "unknown", timezone: "Australia/Melbourne" },
            definitions: [],
            semanticBundleHash: "albert-omni-fixture",
            identityGraph: { version: 0, hash: "d41d8cd98f00b204e9800998ecf8427e" },
          },
          followUps: [],
          presentedResultIds: ["01J00000000000000000DBRV01"],
          claims: [],
        },
      ];
      await route.fulfill({
        status: 200,
        body: buildEvents
          .map((event) => `id: ${event.sequence}\nevent: trace\ndata: ${JSON.stringify(event)}\n\n`)
          .join(""),
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "text/event-stream; charset=utf-8",
          "X-Albert-Runtime": "omni",
          "X-Albert-Model": "gpt-5.6-luna",
          "X-Albert-Conversation-Id": "01J00000000000000000DBCV01",
          "X-Albert-Turn-Id": "01J00000000000000000DBTN01",
        },
      }).catch(() => undefined);
      return;
    }
    const stamp = "2026-08-03T00:44:00.000Z";
    const omniResultId = "01J0000000000000000000OMN1";
    const workerPrompt = /^(Investigate |You are one specialist|Measure )/u.test(
      typeof requestPayload.message === "string" ? requestPayload.message : "",
    );
    const omniProvenance = {
      sources: [{ connector: "lightspeed", label: "Cube semantic layer · lightspeed", dataThrough: "2026-08-02" }],
      timeRange: { label: "last 12 weeks", start: "unknown", end: "unknown", timezone: "Australia/Melbourne" },
      definitions: [
        { metric: "sales_analytics.gross_takings", label: "Gross takings", definition: "Total completed sale value including tax.", view: "sales_analytics", kind: "measure" },
        { metric: "sales_analytics.completed_at", label: "Completed", definition: "Completion time of the sale.", view: "sales_analytics", kind: "time" },
      ],
      semanticBundleHash: "albert-omni-fixture",
      identityGraph: { version: 0, hash: "d41d8cd98f00b204e9800998ecf8427e" },
      view: { name: "sales_analytics", label: "Sales analytics", description: "Completed POS sales." },
    };
    const omniEvents = [
      { id: "omni_fx_ack", sequence: 1, type: "narrative", purpose: "acknowledgement", occurredAt: stamp, text: "I’ll analyse weekly revenue over the last 12 complete weeks." },
      {
        id: "omni_fx_tasks", sequence: 2, type: "tasks", status: "running", occurredAt: stamp,
        items: [
          { id: "task-1", label: "Find the revenue fields", completed: false },
          { id: "task-2", label: "Query weekly revenue for the last 12 complete weeks", completed: false },
          { id: "task-3", label: "Summarise the trend", completed: false },
        ],
      },
      {
        id: "omni_fx_research", sequence: 3, type: "research", status: "complete", occurredAt: stamp,
        tool: "search_model",
        label: "Look up revenue fields in the Sales analytics topic",
        summary: "2 fields found matching \"revenue\"",
        query: "revenue",
        document: "## Field Definitions\n\nYAML representation of all available fields, grouped by view:\n```yaml\n- view_name: sales_analytics\n  label: Sales analytics\n  measures:\n    - name: sales_analytics.gross_takings\n      data_type: NUMBER\n      description: Total completed sale value including tax.\n```\nSee instructions in system prompt around field selection in topics.",
      },
      { id: "omni_fx_narrative", sequence: 4, type: "narrative", occurredAt: stamp, text: "I found the governed revenue measure. Querying weekly revenue now." },
      {
        id: "omni_fx_query", sequence: 5, type: "query", status: "complete", occurredAt: stamp,
        topic: "Sales analytics", name: "Weekly revenue", metrics: ["sales_analytics.gross_takings"],
        dimensions: ["sales_analytics.completed_at"],
        timeRange: omniProvenance.timeRange,
        lens: "Cube view: sales_analytics", view: "sales_analytics", cubesUsed: ["sales_analytics"],
        queryYaml: "measures:\n  - sales_analytics.gross_takings\ntimeDimensions:\n  - dimension: sales_analytics.completed_at\n    granularity: week\n    dateRange: last 12 weeks",
        rowCount: 2, executionMs: 1200, connector: "lightspeed",
      },
      {
        id: "omni_fx_table", sequence: 6, type: "table", status: "complete", occurredAt: stamp,
        caption: "Weekly revenue",
        columns: [
          { key: "sales_analytics_completed_at", label: "Completed", type: "date" },
          { key: "sales_analytics_gross_takings", label: "Gross takings", type: "currency", currency: "AUD" },
        ],
        rows: [
          { sales_analytics_completed_at: "2026-07-20", sales_analytics_gross_takings: 8120.5 },
          { sales_analytics_completed_at: "2026-07-27", sales_analytics_gross_takings: 8379.02 },
        ],
        resultId: omniResultId,
        provenance: omniProvenance,
        presentation: "evidence",
      },
      // Ordinary chat turns also compose a pivot; fleet workers (Dashboard
      // Master, Swarm) keep their single-result stream so their finding
      // counts stay exact.
      ...(workerPrompt ? [] : [
        {
          id: "omni_fx_pivot_query", sequence: 7, type: "query", status: "complete", occurredAt: stamp,
          topic: "Composed pivot", name: "Weekly scorecard",
          metrics: ["sales_analytics_gross_takings", "sales_analytics_gross_profit"],
          dimensions: ["sales_analytics_completed_at"],
          timeRange: omniProvenance.timeRange,
          lens: "Derived pivot over this turn's results", view: "derived_result", cubesUsed: [],
          queryYaml: "derived: albert_omni_pivot_v1\ncaption: Weekly scorecard",
          rowCount: 2, executionMs: 0, connector: "lightspeed",
          resultId: "01J0000000000000000000OMP1",
        },
        {
          id: "omni_fx_pivot_table", sequence: 8, type: "table", status: "complete", occurredAt: stamp,
          caption: "Weekly scorecard",
          columns: [
            { key: "metric", label: "Metric", type: "string" },
            { key: "p_2026_07_20", label: "20 Jul", type: "number" },
            { key: "p_2026_07_27", label: "27 Jul", type: "number" },
          ],
          rows: [
            { metric: "Sales", p_2026_07_20: 8120.5, p_2026_07_27: 8379.02 },
            { metric: "Gross profit", p_2026_07_20: 3010.2, p_2026_07_27: 3120.5 },
          ],
          rowFormats: [
            { type: "currency", currency: "AUD" },
            { type: "currency", currency: "AUD" },
          ],
          resultId: "01J0000000000000000000OMP1",
          provenance: omniProvenance,
          presentation: "evidence",
          dashboardReplay: {
            kind: "derived_v1",
            sourceTableEventIds: ["omni_fx_table"],
            transformDigest: "ef".repeat(32),
          },
          dashboardDerivation: {
            version: "derived_table_v1",
            sources: [{ tableEventId: "omni_fx_table", resultId: omniResultId }],
            columns: [
              { key: "metric", label: "Metric", type: "string" },
              { key: "p_2026_07_20", label: "20 Jul", type: "number" },
              { key: "p_2026_07_27", label: "27 Jul", type: "number" },
            ],
            rows: [],
          },
        },
      ]),
      {
        id: "omni_fx_tasks_done", sequence: 9, type: "tasks", status: "complete", occurredAt: stamp,
        items: [
          { id: "task-1", label: "Find the revenue fields", completed: true },
          { id: "task-2", label: "Query weekly revenue for the last 12 complete weeks", completed: true },
          { id: "task-3", label: "Summarise the trend", completed: true },
        ],
      },
      {
        id: "omni_fx_answer", sequence: 10, type: "answer", status: "complete", occurredAt: stamp,
        state: "Verified",
        text: [
          "Revenue held steady across the last 12 complete weeks, finishing at **$8,379.02** in the latest week.",
          "",
          "### Weekly detail",
          "",
          "| Week | Gross takings | Change |",
          "|---|---|---|",
          "| 20 July | $8,120.50 | — |",
          "| 27 July | $8,379.02 | +3.2% |",
          "",
          "### July at statement level",
          "",
          "| P&L line | July |",
          "|---|---|",
          "| Sales revenue | $42,016.69 |",
          "| Cost of sales | ($16,908.12) |",
          "| **Gross profit** | **$25,108.57** |",
          "| &nbsp;&nbsp;Wages and salaries | ($12,227.85) |",
          "| **Net profit** | **$441.65** |",
          "",
          "The lift came from stronger weekend trade.",
        ].join("\n"),
        provenance: omniProvenance,
        followUps: ["How does this compare to last year?"],
        presentedResultIds: [omniResultId],
        claims: [],
      },
    ];
    const body = omniEvents
      .map((event) => `id: ${event.sequence}\nevent: trace\ndata: ${JSON.stringify(event)}\n\n`)
      .join("");
    const requestedPreferences = requestPayload.preferences && typeof requestPayload.preferences === "object"
      ? requestPayload.preferences as Record<string, unknown>
      : {};
    await route.fulfill({
      status: 200,
      body,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Albert-Runtime": "omni",
        "X-Albert-Model": typeof requestedPreferences.model === "string" ? requestedPreferences.model : "gpt-5.6-luna",
        "X-Albert-Conversation-Id": "01J00000000000000000000041",
        "X-Albert-Turn-Id": "01J00000000000000000000042",
      },
    }).catch(() => undefined);
  });

  await page.route(/\/api\/anthropic-conversation$/u, async (route) => {
    capture.anthropicConversationPayloads.push(route.request().postDataJSON());
    if (options.anthropicDelayMs) {
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, options.anthropicDelayMs),
      );
    }
    const body = createDeterministicFixtureTrace()
      .map(
        (event) =>
          `id: ${event.sequence}\nevent: trace\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join("");
    await route
      .fulfill({
        status: 200,
        body,
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "text/event-stream; charset=utf-8",
          "X-Albert-Runtime": "anthropic",
          "X-Albert-Conversation-Id": "01J00000000000000000000021",
          "X-Albert-Turn-Id": "01J00000000000000000000023",
        },
      })
      .catch(() => undefined);
  });

  return capture;
}
