import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { registryDocumentSchema, type RegistryDocument, type SemanticRegistry } from "./schema.js";

export function parseRegistryDocument(text: string): RegistryDocument {
  let raw: unknown;
  try {
    // JSON is a strict subset of YAML. The checked-in registry uses this profile so
    // deployment validation has no permissive parser ambiguity.
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`Registry YAML must use the JSON-compatible YAML profile: ${String(error)}`);
  }
  const document = registryDocumentSchema.parse(raw);
  validateRegistry(document);
  return document;
}

export function loadRegistryFile(path: string): SemanticRegistry {
  return buildRegistry(parseRegistryDocument(readFileSync(path, "utf8")));
}

export function buildRegistry(document: RegistryDocument): SemanticRegistry {
  validateRegistry(document);
  return Object.freeze({
    version: document.registryVersion,
    metrics: new Map(document.metrics.map((metric) => [metric.id, Object.freeze(metric)])),
    topics: new Map(document.topics.map((topic) => [topic.id, Object.freeze(topic)])),
    facts: new Map(document.facts.map((fact) => [fact.id, Object.freeze(fact)])),
  });
}

export function registryDigest(document: RegistryDocument): string {
  return createHash("sha256").update(stableStringify(document)).digest("hex");
}

export function generateRegistryDocumentation(document: RegistryDocument): string {
  const domainCounts = new Map<string, number>();
  for (const metric of document.metrics) {
    const domain = metric.id.split(".", 1)[0] ?? "unknown";
    domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + 1);
  }

  for (const fact of document.facts) {
    if (fact.snapshotFields.length > 0 && fact.snapshotEntityKeys.length === 0) {
      throw new Error(`Snapshot fact ${fact.id} must declare snapshotEntityKeys.`);
    }
    for (const key of fact.snapshotEntityKeys) {
      if (!fact.fields.includes(key)) throw new Error(`Snapshot fact ${fact.id} references unknown entity key ${key}.`);
    }
  }
  const counts = [...domainCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([domain, count]) => `- ${domain}: ${count}`)
    .join("\n");
  const metrics = document.metrics
    .map((metric) => `- \`${metric.id}\` — ${metric.description}`)
    .join("\n");
  const topics = document.topics
    .map((topic) => `- \`${topic.id}\` — ${topic.description}`)
    .join("\n");
  return `# Semantic registry ${document.registryVersion}\n\nGenerated from the registry. Do not hand-edit counts.\n\n## Counts\n\n- Metrics: ${document.metrics.length}\n- Topics: ${document.topics.length}\n${counts}\n\n## Metrics\n\n${metrics}\n\n## Topics\n\n${topics}\n`;
}

export function validateRegistry(document: RegistryDocument): void {
  assertUnique(document.metrics.map((metric) => metric.id), "metric");
  assertUnique(document.topics.map((topic) => topic.id), "topic");
  assertUnique(document.facts.map((fact) => fact.id), "fact");

  const metrics = new Map(document.metrics.map((metric) => [metric.id, metric]));
  const facts = new Map(document.facts.map((fact) => [fact.id, fact]));
  const identityTables = {
    worker: "core.worker",
    location: "core.location",
    product_variant: "core.product_variant",
    customer_account: "core.customer_account",
    supplier: "core.supplier",
  } as const;
  for (const fact of document.facts) {
    const identityTypesByKey = new Map<string, string>();
    for (const join of fact.joins) {
      if (!fact.fields.includes(join.factKey)) {
        throw new Error(`Fact ${fact.id} join ${join.dimension} references unknown key ${join.factKey}.`);
      }
      if (!join.identityType) continue;
      if (join.dimensionKey !== "id" || join.table !== identityTables[join.identityType]) {
        throw new Error(`Fact ${fact.id} identity join ${join.dimension} does not target the canonical ${join.identityType} id.`);
      }
      const existing = identityTypesByKey.get(join.factKey);
      if (existing && existing !== join.identityType) {
        throw new Error(`Fact ${fact.id} assigns conflicting identity types to ${join.factKey}.`);
      }
      identityTypesByKey.set(join.factKey, join.identityType);
    }
  }
  for (const metric of document.metrics) {
    const fact = facts.get(metric.baseFact);
    if (!fact) throw new Error(`Metric ${metric.id} references unknown fact ${metric.baseFact}.`);
    for (const dimension of metric.allowedDimensions) {
      if (dimension === "business_date") continue;
      if (dimension === "calendar_week") {
        if (!fact.timeFields.includes("business_date")) {
          throw new Error(`Metric ${metric.id} requires business_date for calendar_week.`);
        }
        continue;
      }
      if (!fact.joins.some((join) => join.dimension === dimension || Object.hasOwn(join.fields, dimension))) {
        throw new Error(`Metric ${metric.id} allows illegal dimension ${dimension}.`);
      }
    }
    validateCalculation(metric.id, metric.calculation, fact, metrics, new Set());
  }

  for (const topic of document.topics) {
    for (const factId of topic.baseFacts) {
      if (!facts.has(factId)) throw new Error(`Topic ${topic.id} references unknown fact ${factId}.`);
    }
    for (const metricId of topic.metrics) {
      if (!metrics.has(metricId)) throw new Error(`Topic ${topic.id} references unknown metric ${metricId}.`);
    }
    if (!topic.composite && topic.baseFacts.length !== 1) {
      throw new Error(`Non-composite topic ${topic.id} must declare one base fact.`);
    }
    if (topic.composite && topic.baseFacts.length < 2) {
      throw new Error(`Composite topic ${topic.id} must declare at least two base facts.`);
    }
  }
}

function validateCalculation(
  metricId: string,
  calculation: RegistryDocument["metrics"][number]["calculation"],
  fact: RegistryDocument["facts"][number],
  metrics: ReadonlyMap<string, RegistryDocument["metrics"][number]>,
  stack: Set<string>,
): void {
  if ("field" in calculation && calculation.field && !fact.fields.includes(calculation.field)) {
    throw new Error(`Metric ${metricId} references unknown field ${calculation.field} on ${fact.id}.`);
  }
  if ("filter" in calculation && calculation.filter && !fact.fields.includes(calculation.filter.field)) {
    throw new Error(`Metric ${metricId} filters unknown field ${calculation.filter.field}.`);
  }
  if (calculation.op === "metric") {
    const dependency = metrics.get(calculation.metric);
    if (!dependency) throw new Error(`Metric ${metricId} references unknown metric ${calculation.metric}.`);
    if (dependency.baseFact !== fact.id) {
      throw new Error(`Metric ${metricId} directly references another fact; use a composite topic.`);
    }
    if (stack.has(dependency.id)) throw new Error(`Metric cycle detected at ${dependency.id}.`);
    stack.add(dependency.id);
    validateCalculation(metricId, dependency.calculation, fact, metrics, stack);
    stack.delete(dependency.id);
  }
  if (["add", "subtract", "multiply", "divide"].includes(calculation.op)) {
    const binary = calculation as Extract<typeof calculation, { left: unknown }>;
    validateCalculation(metricId, binary.left, fact, metrics, stack);
    validateCalculation(metricId, binary.right, fact, metrics, stack);
  }
  if (calculation.op === "conditional") {
    if (!fact.fields.includes(calculation.condition.field)) {
      throw new Error(`Metric ${metricId} filters unknown field ${calculation.condition.field}.`);
    }
    validateCalculation(metricId, calculation.value, fact, metrics, stack);
    validateCalculation(metricId, calculation.otherwise, fact, metrics, stack);
  }
}

function assertUnique(values: readonly string[], type: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`Duplicate ${type} id: ${value}`);
    seen.add(value);
  }
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
