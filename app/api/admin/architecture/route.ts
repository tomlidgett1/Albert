import registrySource from "@/packages/semantic-registry/registry/registry.yaml?raw";
import { buildRegistry, parseRegistryDocument } from "@/packages/semantic-registry/src/registry-build";
import {
  isInternalOperator,
  loadOperatorFleet,
  type OperatorFleet,
} from "@/services/control-plane/src/operator-repository";
import { ControlPlaneError } from "@/services/control-plane/src/web-repository";

const DOMAIN_LABELS: Readonly<Record<string, string>> = {
  commerce: "Sales",
  customers: "Customers",
  inventory: "Inventory",
  workforce: "Workforce",
  finance: "Finance",
  composites: "Combined views",
};

const UNIT_LABELS: Readonly<Record<string, string>> = {
  currency: "Currency",
  units: "Units",
  count: "Count",
  percent: "Percent",
  hours: "Hours",
  days: "Days",
  currency_per_unit: "Currency per unit",
};

const CONNECTOR_PACKS = Object.freeze([
  {
    key: "lightspeed-r",
    label: "Lightspeed R-Series",
    role: "Sales, stock, products, customers and staff from the till",
  },
  {
    key: "xero",
    label: "Xero",
    role: "Invoices, bank feeds, journals and tax from the books",
  },
  {
    key: "deputy",
    label: "Deputy",
    role: "Rosters, timesheets and labour cost from the floor",
  },
] as const);

function humanize(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function metricDomain(metricId: string) {
  return metricId.split(".", 1)[0] ?? "unknown";
}

function connectionSeverity(connection: OperatorFleet["connections"][number]) {
  const readiness = Object.values(connection.readiness).map(({ state }) => state);
  if (
    connection.status === "blocked"
    || ["expired", "revoked", "error"].includes(connection.auth_health)
    || readiness.includes("blocked")
    || connection.quality_failures.some(({ status }) => status === "failed" || status === "blocked")
  ) return "blocked" as const;
  if (
    connection.status === "degraded"
    || ["unknown", "expiring"].includes(connection.auth_health)
    || readiness.includes("degraded")
    || connection.open_quarantine_count > 0
    || connection.quality_failures.length > 0
    || connection.webhook.gap_recovery_status === "gap_detected"
  ) return "degraded" as const;
  return "healthy" as const;
}

function summariseFleet(fleet: OperatorFleet) {
  const connectorCounts = new Map<string, { healthy: number; degraded: number; blocked: number; total: number }>();
  let blocked = 0;
  let degraded = 0;
  let healthy = 0;
  let quarantine = 0;

  for (const connection of fleet.connections) {
    const severity = connectionSeverity(connection);
    if (severity === "blocked") blocked += 1;
    else if (severity === "degraded") degraded += 1;
    else healthy += 1;
    quarantine += connection.open_quarantine_count;

    const current = connectorCounts.get(connection.connector_key) ?? {
      healthy: 0,
      degraded: 0,
      blocked: 0,
      total: 0,
    };
    current.total += 1;
    current[severity] += 1;
    connectorCounts.set(connection.connector_key, current);
  }

  const queueDepth = fleet.queues.reduce((total, queue) => {
    const value = queue.queue_length ?? queue.total_messages ?? queue.msg_count ?? 0;
    const count = Number(value);
    return total + (Number.isFinite(count) ? count : 0);
  }, 0);

  return {
    generated_at: fleet.generated_at,
    connections: fleet.connections.length,
    blocked,
    degraded,
    healthy,
    workers_healthy: fleet.workers.filter(({ healthy: isHealthy }) => isHealthy).length,
    workers_total: fleet.workers.length,
    queue_depth: queueDepth,
    quarantine,
    connectors: CONNECTOR_PACKS.map((pack) => {
      const counts = connectorCounts.get(pack.key) ?? {
        healthy: 0,
        degraded: 0,
        blocked: 0,
        total: 0,
      };
      return {
        ...pack,
        connected: counts.total,
        healthy: counts.healthy,
        degraded: counts.degraded,
        blocked: counts.blocked,
      };
    }),
  };
}

function loadSemanticCatalogue() {
  // Bundle the registry into the worker. Vinext/Cloudflare has no workspace
  // filesystem for synchronous registry file reads at request time.
  const registry = buildRegistry(parseRegistryDocument(registrySource));
  const domains = new Map<string, number>();
  for (const metric of registry.metrics.values()) {
    const domain = metricDomain(metric.id);
    domains.set(domain, (domains.get(domain) ?? 0) + 1);
  }

  const metrics = [...registry.metrics.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((metric) => ({
      id: metric.id,
      domain: metricDomain(metric.id),
      domain_label: DOMAIN_LABELS[metricDomain(metric.id)] ?? humanize(metricDomain(metric.id)),
      label: metric.label,
      synonyms: [...metric.synonyms],
      description: metric.description,
      ai_context: metric.aiContext,
      base_fact: metric.baseFact,
      grain: metric.grain,
      expression: metric.expression,
      default_time: metric.defaultTime,
      unit: metric.unit,
      unit_label: UNIT_LABELS[metric.unit] ?? humanize(metric.unit),
      authority: metric.authority,
      aggregation: metric.aggregation,
      refund_handling: metric.refundHandling,
      allowed_dimensions: [...metric.allowedDimensions],
      required_capabilities: [...metric.requiredCapabilities],
      tenant_parameters: [...metric.tenantParameters],
      version: metric.version,
    }));

  const topics = [...registry.topics.values()]
    .sort((left, right) => left.label.localeCompare(right.label))
    .map((topic) => ({
      id: topic.id,
      label: topic.label,
      description: topic.description,
      ai_context: topic.aiContext,
      composite: topic.composite,
      base_facts: [...topic.baseFacts],
      approved_dimensions: [...topic.approvedDimensions],
      metrics: [...topic.metrics],
      metric_count: topic.metrics.length,
      sample_questions: [...topic.sampleQuestions],
      sample_question: topic.sampleQuestions[0] ?? null,
      roles: [...topic.roles],
      freshness_minutes: topic.freshnessMinutes,
      required_capabilities: [...topic.requiredCapabilities],
      align_on: [...topic.alignOn],
      version: topic.version,
    }));

  const facts = [...registry.facts.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((fact) => ({
      id: fact.id,
      table: fact.table,
      fields: [...fact.fields],
      time_fields: [...fact.timeFields],
      join_count: fact.joins.length,
      joins: fact.joins.map((join) => ({
        dimension: join.dimension,
        table: join.table,
        cardinality: join.cardinality,
        identity_type: join.identityType ?? null,
      })),
      snapshot_fields: [...fact.snapshotFields],
      snapshot_entity_keys: [...fact.snapshotEntityKeys],
    }));

  const dimensionTopics = new Map<string, string[]>();
  for (const topic of registry.topics.values()) {
    for (const dimension of topic.approvedDimensions) {
      const current = dimensionTopics.get(dimension) ?? [];
      current.push(topic.id);
      dimensionTopics.set(dimension, current);
    }
  }

  const dimensions = [...dimensionTopics.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, topicIds]) => ({
      id,
      label: humanize(id),
      topic_count: topicIds.length,
      topics: [...topicIds].sort(),
    }));

  return {
    version: registry.version,
    metric_count: registry.metrics.size,
    topic_count: registry.topics.size,
    fact_count: registry.facts.size,
    dimension_count: dimensions.length,
    domains: [...domains.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([id, metric_count]) => ({
        id,
        label: DOMAIN_LABELS[id] ?? id.replaceAll("_", " "),
        metric_count,
      })),
    topics,
    metrics,
    facts,
    dimensions,
  };
}

export async function GET() {
  try {
    if (!(await isInternalOperator())) {
      return Response.json({ error: "Internal operator access is required." }, { status: 403 });
    }

    const semantic = loadSemanticCatalogue();
    let live: ReturnType<typeof summariseFleet> | null = null;
    let live_error: string | null = null;

    try {
      live = summariseFleet(await loadOperatorFleet());
    } catch (error) {
      live_error = error instanceof ControlPlaneError
        ? error.message
        : "Live sync health could not be loaded.";
    }

    return Response.json({
      architecture: {
        generated_at: new Date().toISOString(),
        packs: CONNECTOR_PACKS,
        semantic,
        live,
        live_error,
      },
    }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    const status = error instanceof ControlPlaneError ? error.status : 503;
    const message = error instanceof ControlPlaneError
      ? error.message
      : "Architecture overview is unavailable.";
    return Response.json({ error: message }, { status });
  }
}
