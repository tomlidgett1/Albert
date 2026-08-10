import type { Page } from "@playwright/test";
import { createDeterministicFixtureTrace } from "../../../services/conversation/src/fixture";

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
      id: "lightspeed",
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
    anthropicDelayMs?: number;
    internalOperator?: boolean;
    semanticDraft?: boolean;
  }> = {},
): Promise<AppApiCapture> {
  await installSupabaseBrowserAuthRoutes(page);
  const capture: AppApiCapture = {
    bootstrapPayloads: [],
    conversationPayloads: [],
    anthropicConversationPayloads: [],
    oauthSelectionPayloads: [],
    reviewPayloads: [],
    semanticPayloads: [],
  };
  let bootstrapped = false;
  let semanticRevision = 3;

  await page.route(/\/api\/session(?:\?.*)?$/u, async (route) => {
    if (route.request().method() === "POST") {
      const payload = route.request().postDataJSON();
      capture.bootstrapPayloads.push(payload);
      bootstrapped = true;
      await route.fulfill({
        status: 201,
        json: { context: { tenant_name: "Albert Bike Store", role: "owner" } },
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
            : { tenant_name: "Albert Bike Store", role: "owner" },
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

  await page.route(/\/api\/conversations(?:\?.*)?$/u, async (route) => {
    await route.fulfill({
      json: {
        conversations: options.anthropicHistory
          ? [
              {
                conversation_id: "01J00000000000000000000021",
                title: "Claude sales review",
                status: "active",
                created_at: "2026-08-09T00:00:00.000Z",
                updated_at: "2026-08-09T00:01:00.000Z",
                last_turn: {
                  turn_id: "01J00000000000000000000022",
                  turn_number: 1,
                  user_message: "Review yesterday's sales",
                  status: "completed",
                  answer_state: "verified",
                  runtime_profile: {
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
                user_message: "Review yesterday's sales",
                status: "completed",
                answer_state: "verified",
                runtime_profile: {
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

  await page.route(/\/api\/conversation$/u, async (route) => {
    capture.conversationPayloads.push(route.request().postDataJSON());
    const body = createDeterministicFixtureTrace()
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("");
    await route.fulfill({
      status: 200,
      body,
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Albert-Runtime": "fixture",
      },
    });
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
