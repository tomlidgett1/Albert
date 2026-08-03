/**
 * Albert's capability vocabulary is a cross-pack protocol. Connector manifests,
 * live observations and semantic contracts must use these exact identifiers;
 * aliases at either side of the boundary would make capability gating fail
 * closed for otherwise queryable tenant data.
 */
export const SEMANTIC_CAPABILITY_IDS = [
  "commerce.order_lines",
  "commerce.order_lines.cost",
  "commerce.order_lines.discounts",
  "commerce.order_lines.worker_attribution",
  "commerce.orders",
  "commerce.orders.customer",
  "commerce.payments",
  "commerce.refunds",
  "finance.bank_transactions",
  "finance.invoices",
  "finance.journals",
  "finance.journals.tax",
  "inventory.balances",
  "inventory.cost",
  "inventory.movements",
  "inventory.stocktakes",
  "workforce.shifts",
  "workforce.time_entries",
  "workforce.time_entries.cost",
  "workforce.time_entries.overtime",
] as const;

export const OPERATIONAL_CAPABILITY_IDS = [
  "connector.variant.r_series",
  "finance.settings",
  "finance.payments",
  "workforce.leave",
  "source.webhooks",
  "source.webhooks.contacts",
  "source.webhooks.invoices",
  "source.webhooks.credit_notes",
] as const;

export const CAPABILITY_IDS = [
  ...SEMANTIC_CAPABILITY_IDS,
  ...OPERATIONAL_CAPABILITY_IDS,
] as const;

export type SemanticCapabilityId = (typeof SEMANTIC_CAPABILITY_IDS)[number];
export type CapabilityId = (typeof CAPABILITY_IDS)[number];
export type CapabilitySupport = "full" | "partial" | "unavailable" | "unknown";

const capabilityIds = new Set<string>(CAPABILITY_IDS);

export function isCapabilityId(value: unknown): value is CapabilityId {
  return typeof value === "string" && capabilityIds.has(value);
}

export function assertCapabilityIds(
  values: readonly string[],
  subject: string,
): asserts values is readonly CapabilityId[] {
  const unknown = [...new Set(values.filter((value) => !isCapabilityId(value)))].sort();
  if (unknown.length > 0) {
    throw new Error(`${subject} uses unknown capability identifiers: ${unknown.join(", ")}.`);
  }
}

export type CapabilityCoverage = Readonly<{
  stream?: string;
  observedRecords?: number;
  eligibleRecords?: number;
  nonNullRecords?: number;
  ratio?: number;
  fields?: Readonly<Record<string, Readonly<{
    observedRecords: number;
    eligibleRecords: number;
    ratio: number;
  }>>>;
}>;
