import type { Page } from "@playwright/test";
import {
  createDeterministicFixtureTrace,
  FIXTURE_RESULT_ID,
} from "../../../services/conversation/src/fixture";

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
  runtimeRequestStartedAt: { v3: number[]; codex: number[] };
  anthropicConversationPayloads: unknown[];
  oauthSelectionPayloads: unknown[];
  reviewPayloads: unknown[];
  semanticPayloads: unknown[];
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
    runtimeRequestStartedAt: { v3: [], codex: [] },
    anthropicConversationPayloads: [],
    oauthSelectionPayloads: [],
    reviewPayloads: [],
    semanticPayloads: [],
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
    const recommendations = options.recentAnalyses
      ? [
          {
            id: "rec-1-wednesday",
            question: "Which products dragged Wednesday's sales last week?",
            why: "Last week's review found sales down 11%, with Wednesday the weak day.",
            move: "diagnose",
            domain: "products",
            fromTitle: "Weekly sales trend",
            fromConversationId: "01J00000000000000000000021",
          },
          {
            id: "rec-2-parts",
            question: "What is dragging parts margin: mix, discounting, or cost?",
            why: "Parts sat at 31% against 44% for workshop in your last category review.",
            move: "diagnose",
            domain: "profit",
            fromTitle: "Margin by category",
            fromConversationId: "01J00000000000000000000033",
          },
          {
            id: "rec-3-cash",
            question: "Did last week's takings reach the bank, and what is still outstanding?",
            why: "You reviewed sales, but not whether that cash actually landed.",
            move: "close_the_loop",
            domain: "cash",
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
        source: recommendations.length > 0 ? "cache" : "empty",
        fingerprint: recommendations.length > 0 ? "a".repeat(64) : "",
      },
    });
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
    const stamp = "2026-08-03T00:44:00.000Z";
    const omniResultId = "01J0000000000000000000OMN1";
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
      {
        id: "omni_fx_tasks_done", sequence: 7, type: "tasks", status: "complete", occurredAt: stamp,
        items: [
          { id: "task-1", label: "Find the revenue fields", completed: true },
          { id: "task-2", label: "Query weekly revenue for the last 12 complete weeks", completed: true },
          { id: "task-3", label: "Summarise the trend", completed: true },
        ],
      },
      {
        id: "omni_fx_answer", sequence: 8, type: "answer", status: "complete", occurredAt: stamp,
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
