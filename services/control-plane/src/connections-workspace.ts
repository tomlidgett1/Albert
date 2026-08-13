import { z } from "zod";

import { ALBERT_BLOCKING_QUESTIONS_CONTRACT } from "../../../packages/config/src/blocking-questions.js";

const readinessSchema = z.object({
  domain: z.string(),
  state: z.enum(["not_started", "syncing", "transforming", "validating", "ready_partial", "ready_complete", "degraded", "blocked"]),
  progress: z.coerce.number().min(0).max(1).nullable().optional(),
  data_ready_through: z.string().nullable().optional(),
  backfill_complete: z.boolean().nullable().optional(),
  reason_code: z.string().nullable().optional(),
});
const connectionSchema = z.object({
  connection_id: z.string(),
  connector_key: z.enum([
    "lightspeed-r", "lightspeed-x", "xero", "deputy", "square", "shopify", "stripe",
    "momence", "meta-ads", "google-ads",
  ]),
  display_name: z.string(),
  status: z.enum(["pending", "connected", "degraded", "blocked", "disconnected"]),
  auth_health: z.enum(["unknown", "healthy", "expiring", "expired", "revoked", "error"]),
  authorised_at: z.string().nullable().optional(),
  last_checked_at: z.string().nullable().optional(),
  account_metadata: z.record(z.string(), z.unknown()).default({}),
  manual_ingestion_start_required: z.boolean().default(false),
  ingestion_blocked_reason: z.string().nullable().optional(),
  ingestion_state: z.enum([
    "inactive", "awaiting_manual_start", "queued", "running", "active",
  ]).default("active"),
  readiness: z.array(readinessSchema).default([]),
});
const workspaceSchema = z.object({
  tenant_id: z.string(),
  tenant_name: z.string(),
  connections: z.array(connectionSchema).default([]),
  dossier: z.object({
    content: z.record(z.string(), z.unknown()),
    provenance: z.record(z.string(), z.unknown()),
    published_at: z.string().nullable().optional(),
  }).nullable().optional(),
  identity_review_tasks: z.array(z.object({
    task_id: z.string(),
    entity_type: z.enum(["worker", "location", "product_variant", "customer_account", "supplier"]),
    status: z.enum(["proposed", "accepted", "rejected"]),
    confidence_band: z.string(),
    candidate_links: z.unknown(),
    evidence: z.unknown(),
    resolution: z.record(z.string(), z.unknown()).nullable().optional(),
  })).default([]),
  blocking_answers: z.record(z.string(), z.string()).default({}),
  oauth_sessions: z.array(z.object({
    oauth_session_id: z.string(),
    provider: z.enum([
      "lightspeed-r", "lightspeed-x", "xero", "deputy", "square", "shopify", "stripe",
      "momence", "meta-ads", "google-ads",
    ]),
    status: z.string(),
    discovered_account_choices: z.array(z.object({
      externalAccountId: z.string(),
      displayName: z.string(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    })).nullable().default([]).transform((choices) => choices ?? []),
    expires_at: z.string(),
  })).default([]),
});

const providerDefinitions = {
  "lightspeed-r": {
    id: "lightspeed",
    name: "Lightspeed",
    description: "Sales, inventory, customers, and store activity.",
    logo: "/logos/lightspeed.png",
    connectDetail: "Connect a Lightspeed Retail R-Series account.",
  },
  "lightspeed-x": {
    id: "lightspeed-x",
    name: "Lightspeed X-Series",
    description: "Sales, products, inventory, customers, purchasing, services, and store operations.",
    logo: "/logos/lightspeed.png",
    connectDetail: "Connect a Lightspeed Retail X-Series store, then choose when ingestion starts.",
  },
  xero: {
    id: "xero",
    name: "Xero",
    description: "Accounting, invoices, journals, and bank activity.",
    logo: "/logos/xero.svg",
    connectDetail: "Connect a Xero organisation.",
  },
  deputy: {
    id: "deputy",
    name: "Deputy",
    description: "Rosters, timesheets, leave, and workforce activity.",
    logo: "/logos/deputy.png",
    connectDetail: "Connect a Deputy installation.",
  },
  square: {
    id: "square",
    name: "Square",
    description: "Sales, payments, catalogue, customers, inventory, and team activity.",
    logo: "/logos/square.svg",
    connectDetail: "Connect a Square merchant account, then choose when ingestion starts.",
  },
  shopify: {
    id: "shopify",
    name: "Shopify",
    description: "Orders, products, customers, inventory, fulfilment, and payments.",
    logo: "/logos/shopify.svg",
    connectDetail: "Connect a myshopify.com store, then choose when ingestion starts.",
  },
  stripe: {
    id: "stripe",
    name: "Stripe",
    description: "Authorization only. No Stripe data is synced yet.",
    logo: "/logos/stripe.svg",
    connectDetail: "Connect a Stripe account.",
  },
  momence: {
    id: "momence",
    name: "Momence",
    description: "Classes, bookings, memberships, customers, instructors, locations, and payments.",
    logo: "/logos/momence.svg",
    connectDetail: "Connect a Momence studio, then choose when ingestion starts.",
  },
  "meta-ads": {
    id: "meta-ads",
    name: "Meta Ads",
    description: "Authorization only. No Meta Ads data is synced yet.",
    logo: "/logos/meta.svg",
    connectDetail: "Connect a Meta advertising account.",
  },
  "google-ads": {
    id: "google-ads",
    name: "Google Ads",
    description: "Authorization only. No Google Ads data is synced yet.",
    logo: "/logos/google-ads.svg",
    connectDetail: "Connect a Google Ads account.",
  },
} as const;

const shopifyDeletionContinuityReasons = new Set([
  "shopify_deletion_continuity_unproven",
  "shopify_deletion_watermark_missing",
  "shopify_deletion_retention_gap",
  "shopify_deletion_feed_unavailable",
]);
const shopifyDeletionRecoveryDetail =
  "Shopify deletion history cannot be proven. Disconnect this store, wait for verified local deletion to complete, reconnect it, then choose Start ingestion.";

const comingSoonProviders = [
  {
    id: "employment_hero",
    name: "Employment Hero",
    description: "HR, payroll, and people operations.",
    logo: "/logos/employment-hero.png",
    connectDetail: "Employment Hero support is coming soon.",
    comingSoon: true as const,
    connections: [] as const,
  },
  {
    id: "myob",
    name: "MYOB",
    description: "Accounting, invoices, and Australian business books.",
    logo: "/logos/myob.svg",
    connectDetail: "MYOB support is coming soon.",
    comingSoon: true as const,
    connections: [] as const,
  },
  {
    id: "tiktok_ads",
    name: "TikTok Ads",
    description: "Short-form video campaign spend and attribution.",
    logo: "/logos/tiktok.svg",
    connectDetail: "TikTok Ads support is coming soon.",
    comingSoon: true as const,
    connections: [] as const,
  },
  {
    id: "google_analytics",
    name: "Google Analytics",
    description: "Website traffic, conversion paths, and storefront funnels.",
    logo: "/logos/google-analytics.svg",
    connectDetail: "Google Analytics support is coming soon.",
    comingSoon: true as const,
    connections: [] as const,
  },
  {
    id: "paypal",
    name: "PayPal",
    description: "Checkout payments, invoices, and payout activity.",
    logo: "/logos/paypal.svg",
    connectDetail: "PayPal support is coming soon.",
    comingSoon: true as const,
    connections: [] as const,
  },
  {
    id: "afterpay",
    name: "Afterpay",
    description: "Buy now, pay later orders and settlement activity.",
    logo: "/logos/afterpay.svg",
    connectDetail: "Afterpay support is coming soon.",
    comingSoon: true as const,
    connections: [] as const,
  },
  {
    id: "tyro",
    name: "Tyro",
    description: "Australian EFTPOS, in-person payments, and settlements.",
    logo: "/logos/tyro.png",
    connectDetail: "Tyro support is coming soon.",
    comingSoon: true as const,
    connections: [] as const,
  },
  {
    id: "klaviyo",
    name: "Klaviyo",
    description: "Email and SMS campaigns, flows, and attributed revenue.",
    logo: "/logos/klaviyo.png",
    connectDetail: "Klaviyo support is coming soon.",
    comingSoon: true as const,
    connections: [] as const,
  },
  {
    id: "woocommerce",
    name: "WooCommerce",
    description: "WordPress storefront orders, products, and customers.",
    logo: "/logos/woocommerce.svg",
    connectDetail: "WooCommerce support is coming soon.",
    comingSoon: true as const,
    connections: [] as const,
  },
  {
    id: "servicem8",
    name: "ServiceM8",
    description: "Tradie jobs, scheduling, quotes, and field invoices.",
    logo: "/logos/servicem8.png",
    connectDetail: "ServiceM8 support is coming soon.",
    comingSoon: true as const,
    connections: [] as const,
  },
] as const;

const domainLabels: Readonly<Record<string, string>> = {
  sales: "Sales",
  inventory: "Inventory",
  customers: "Customers",
  products: "Product catalogue",
  accounting: "Accounting",
  cash_settlement: "Cash settlement",
  payables: "Payables",
  receivables: "Receivables",
  workforce: "Workforce",
};

const dossierLabels: Readonly<Record<string, string>> = {
  industry: "Business type",
  locations: "Trading locations",
  trading_hours: "Trading hours",
  seasonality: "Seasonality",
  gst_registration: "GST registration",
  accounting_basis: "Accounting basis",
  channels: "Sales channels",
};

function validDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}

function displayValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    const items = value.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
    return items.length ? items.join(", ") : null;
  }
  return null;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function authState(connection: z.infer<typeof connectionSchema> | undefined) {
  if (!connection || connection.status === "disconnected") {
    return { state: "not_connected", label: "Not connected" } as const;
  }
  if (connection.status === "pending") return { state: "authorizing", label: "Authorizing" } as const;
  if (connection.auth_health === "expired" || connection.auth_health === "revoked") {
    return { state: "reauth_required", label: "Reconnect required" } as const;
  }
  if (connection.auth_health === "error" || connection.status === "blocked") {
    return { state: "error", label: "Connection error" } as const;
  }
  if (connection.status === "degraded") {
    return { state: "error", label: "Connected · setup needs attention" } as const;
  }
  if (connection.auth_health === "healthy" || connection.auth_health === "expiring") {
    return { state: "healthy", label: connection.auth_health === "expiring" ? "Connected · expiring" : "Connected" } as const;
  }
  return { state: "authorizing", label: "Checking connection" } as const;
}

export function toConnectionsWorkspace(raw: unknown, timezone: string) {
  const workspace = workspaceSchema.parse(raw);
  const providers = Object.entries(providerDefinitions).map(([connectorKey, definition]) => {
    const connections = workspace.connections
      .filter((connection) =>
        connection.connector_key === connectorKey && connection.status !== "disconnected"
      )
      .map((connection) => {
        const auth = authState(connection);
        const deletionContinuityBlocked = connectorKey === "shopify" &&
          shopifyDeletionContinuityReasons.has(connection.ingestion_blocked_reason ?? "");
        const webhookSetup = asObject(connection.account_metadata.webhook_setup);
        const deputyWebhookInstallationRequired = connectorKey === "deputy" &&
          webhookSetup.status === "operator_installation_required";
        const domains = connection.readiness.map((domain) => {
          const dataReadyThrough = validDate(domain.data_ready_through);
          return {
            id: `${definition.id}-${connection.connection_id}-${domain.domain}`,
            label: domainLabels[domain.domain] ?? domain.domain.replaceAll("_", " "),
            state: domain.state,
            detail: shopifyDeletionContinuityReasons.has(domain.reason_code ?? "")
              ? shopifyDeletionRecoveryDetail
              : domain.reason_code
                ? domain.reason_code.replaceAll("_", " ")
              : domain.backfill_complete
                ? "Available history has completed validation."
                : domain.state === "ready_partial"
                  ? "Recent data is queryable while deep history continues."
                  : domain.state.replaceAll("_", " "),
            progress: domain.progress == null ? undefined : domain.progress * 100,
            watermark: dataReadyThrough
              ? {
                  label: `Ready through ${new Intl.DateTimeFormat("en-AU", {
                    timeZone: timezone,
                    dateStyle: "medium",
                    timeStyle: "short",
                  }).format(new Date(dataReadyThrough))}`,
                  at: dataReadyThrough,
                }
              : undefined,
          };
        });
        return {
          connectionId: connection.connection_id,
          ingestionState: connection.ingestion_state,
          manualIngestionStartRequired: connection.manual_ingestion_start_required,
          auth: {
            ...auth,
            detail: deletionContinuityBlocked
              ? shopifyDeletionRecoveryDetail
              : connection.status === "degraded"
              ? "Your account is connected, but integration setup needs attention. Reconnect to retry."
              : deputyWebhookInstallationRequired
                ? "Connected. Scheduled polling and reconciliation provide complete ingestion; optional webhooks require explicit owner or operator installation."
                : connection.display_name || definition.connectDetail,
            accountName: connection.display_name,
            checkedAt: validDate(connection.last_checked_at),
          },
          domains,
        };
      });
    return {
      id: definition.id,
      name: definition.name,
      description: definition.description,
      logo: definition.logo,
      connectDetail: definition.connectDetail,
      additionalConnectionLabel: "additionalConnectionLabel" in definition
        ? definition.additionalConnectionLabel
        : undefined,
      connections,
    };
  });

  const allDomains = providers.flatMap(({ connections }) =>
    connections.flatMap(({ domains }) => domains),
  );
  const progress = allDomains.length
    ? Math.round(allDomains.reduce((total, domain) => total + (domain.progress ?? (domain.state === "ready_complete" ? 100 : 0)), 0) / allDomains.length)
    : 0;
  const timestamps = workspace.connections
    .filter(({ status }) => status !== "disconnected")
    .flatMap((connection) => [
      validDate(connection.last_checked_at),
      ...connection.readiness.map(({ data_ready_through }) => validDate(data_ready_through)),
    ])
    .filter((value): value is string => Boolean(value));
  const latestActivityAt = timestamps.sort((first, second) => Date.parse(second) - Date.parse(first))[0];
  const activeConnectorKeys = new Set<string>(
    workspace.connections
      .filter((connection) =>
        connection.status !== "pending"
        && connection.status !== "disconnected"
        && !["inactive", "awaiting_manual_start"].includes(connection.ingestion_state)
      )
      .map(({ connector_key }) => connector_key),
  );

  const dossierContent = workspace.dossier?.content ?? {};
  const dossierProvenance = workspace.dossier?.provenance ?? {};
  const dossier = Object.entries(dossierContent).flatMap(([key, value]) => {
    const displayed = displayValue(value);
    if (!displayed) return [];
    const provenance = asObject(dossierProvenance[key]);
    const confidenceValue = typeof provenance.confidence === "number"
      ? Math.min(100, Math.max(0, Math.round(provenance.confidence * (provenance.confidence <= 1 ? 100 : 1))))
      : 0;
    return [{
      id: key,
      label: dossierLabels[key] ?? key.replaceAll("_", " "),
      value: displayed,
      confidence: {
        label: confidenceValue >= 85 ? "High" : confidenceValue >= 60 ? "Medium" : "Low",
        percent: confidenceValue,
      },
      provenance: typeof provenance.source === "string" ? provenance.source : "Connected source data",
      observedAt: validDate(provenance.observed_at) || workspace.dossier?.published_at || new Date(0).toISOString(),
    }];
  });

  const providerByConnectionId = new Map(workspace.connections.map((connection) => [
    connection.connection_id,
    providerDefinitions[connection.connector_key],
  ] as const));
  const identityPresentation = {
    worker: { kind: "worker", title: "Is this the same team member?" },
    location: { kind: "location", title: "Do these names describe the same place?" },
    product_variant: { kind: "product_variant", title: "Is this the same product variant?" },
    customer_account: { kind: "customer_account", title: "Is this the same customer account?" },
    supplier: { kind: "supplier", title: "Is this the same supplier?" },
  } as const;
  const identityMatches = workspace.identity_review_tasks.flatMap((task) => {
    const links = Array.isArray(task.candidate_links) ? task.candidate_links.map(asObject) : [];
    if (links.length < 2) return [];
    const first = links[0];
    const second = links[1];
    const firstDefinition = providerByConnectionId.get(String(first.connection_id ?? ""));
    const secondDefinition = providerByConnectionId.get(String(second.connection_id ?? ""));
    if (!firstDefinition || !secondDefinition) return [];
    const evidence = asObject(task.evidence);
    const resolution = task.resolution ?? {};
    const projectionValue = resolution.projection_status;
    const projectionStatus = projectionValue === "pending" || projectionValue === "failed" || projectionValue === "applied"
      ? projectionValue
      : "applied";
    const presentation = identityPresentation[task.entity_type];
    return [{
      id: task.task_id,
      kind: presentation.kind,
      title: presentation.title,
      first: {
        provider: firstDefinition.id,
        providerLabel: firstDefinition.name,
        value: String(first.label ?? first.display_name ?? first.source_record_id ?? "Source record"),
      },
      second: {
        provider: secondDefinition.id,
        providerLabel: secondDefinition.name,
        value: String(second.label ?? second.display_name ?? second.source_record_id ?? "Source record"),
      },
      evidence: typeof evidence.summary === "string" ? evidence.summary : "Deterministic identity evidence is available for review.",
      confidence: task.confidence_band.toLowerCase() === "high" ? "High" : "Medium",
      decision: task.status,
      projectionStatus,
    }];
  });

  return {
    tenantName: workspace.tenant_name,
    timezone,
    providers: [...providers, ...comingSoonProviders],
    syncSummary: {
      progress,
      detail: allDomains.length
        ? "Recent data is prepared first. Deep history continues in the background."
        : workspace.connections.some((connection) =>
            connection.status !== "disconnected"
            && connection.ingestion_state === "awaiting_manual_start"
          )
          ? "A connected source is ready. Start ingestion when you are ready."
          : "Connect a source to begin the recent-first sync.",
      latestActivityAt,
    },
    dossier,
    blockingQuestions: ALBERT_BLOCKING_QUESTIONS_CONTRACT.questions
      .filter((question) => question.connectorPrerequisites
        .every((connectorKey) => activeConnectorKeys.has(connectorKey)))
      .map((question) => ({
        id: question.id,
        label: question.label,
        question: question.question,
        options: question.options.map((option) => ({
          id: option.id,
          label: option.label,
        })),
        selectedOptionId: workspace.blocking_answers[question.id],
      })),
    identityMatches,
    oauthSelections: workspace.oauth_sessions
      .filter((session) => session.status === "selecting_account" && Date.parse(session.expires_at) > Date.now())
      .map((session) => ({
        oauthSessionId: session.oauth_session_id,
        provider: providerDefinitions[session.provider].id,
        providerLabel: providerDefinitions[session.provider].name,
        expiresAt: session.expires_at,
        accounts: session.discovered_account_choices.map((account) => ({
          id: account.externalAccountId,
          label: account.displayName,
          detail: typeof account.metadata?.organisationType === "string"
            ? account.metadata.organisationType
            : undefined,
        })),
      })),
  };
}
