import { createHash } from "node:crypto";

import { z } from "zod";

import {
  ConnectorError,
  type RawSourceRecord,
  type ReconciliationRequest,
  type SyncCursor,
  type SyncPage,
  type SyncRange,
} from "../../packages/connector-sdk/src/index.js";
import { buildShopifyFieldIndex } from "./field-index.js";
import { SHOPIFY_API_VERSION } from "./manifest.js";
import {
  SHOPIFY_DELETION_EVENTS_QUERY,
  SHOPIFY_QUERIES,
  SHOPIFY_METAFIELD_DEFINITION_OWNER_TYPES,
  SHOPIFY_METAFIELD_OWNER_POLICIES,
  SHOPIFY_METAFIELD_VALUE_OWNER_TYPES,
  type ShopifyMetafieldOwnerPolicy,
} from "./queries.js";
import {
  loadShopifyAdminSchemaRegistry,
  indexShopifyAdminSchemaRegistry,
  shopifyGraphQLField,
  shopifyGraphQLNamedType,
  type ShopifyGraphQLEnumValue,
  type ShopifyGraphQLField,
  type ShopifyGraphQLInputValue,
  type ShopifyGraphQLType,
} from "./schema-registry.js";
import {
  loadShopifyQLSchemaRegistry,
  type ShopifyQLField,
  type ShopifyQLMatchCondition,
  type ShopifyQLMatchExpression,
  type ShopifyQLMatchField,
  type ShopifyQLSchema,
  type ShopifyQLUndocumentedSchema,
} from "./shopifyql-registry.js";
import { SHOPIFY_ADMIN_FIELD_VALUE_AVAILABILITY } from "./field-value-availability.js";
import { SHOPIFY_STREAM_FIELDS, type ShopifyStreamId } from "./streams.js";

type JsonObject = Record<string, unknown>;
type PromotedShopifyStream = Exclude<ShopifyStreamId, "shopify_fields">;
type ShopifyDefinition =
  | Readonly<{ kind: "admin"; type: ShopifyGraphQLType; field: ShopifyGraphQLField }>
  | Readonly<{ kind: "admin_input_field"; type: ShopifyGraphQLType; field: ShopifyGraphQLInputValue }>
  | Readonly<{
      kind: "admin_field_argument";
      type: ShopifyGraphQLType;
      parentField: ShopifyGraphQLField;
      argument: ShopifyGraphQLInputValue;
    }>
  | Readonly<{ kind: "admin_enum_value"; type: ShopifyGraphQLType; value: ShopifyGraphQLEnumValue }>
  | Readonly<{
      kind: "shopifyql_field";
      role: "metric" | "dimension";
      schema: ShopifyQLSchema;
      field: ShopifyQLField;
    }>
  | Readonly<{
      kind: "shopifyql_match";
      schema: ShopifyQLSchema;
      expression: ShopifyQLMatchExpression;
    }>
  | Readonly<{
      kind: "shopifyql_match_field";
      schema: ShopifyQLSchema;
      condition: ShopifyQLMatchCondition;
      field: ShopifyQLMatchField;
    }>
  | Readonly<{ kind: "shopifyql_from_only"; schema: ShopifyQLUndocumentedSchema }>
  | Readonly<{ kind: "metafield_owner_policy"; policy: ShopifyMetafieldOwnerPolicy }>;

type ShopifyQlDefinition =
  | Extract<ShopifyDefinition, Readonly<{ kind: "shopifyql_field" }>>
  | Extract<ShopifyDefinition, Readonly<{ kind: "shopifyql_match" }>>
  | Extract<ShopifyDefinition, Readonly<{ kind: "shopifyql_match_field" }>>
  | Extract<ShopifyDefinition, Readonly<{ kind: "shopifyql_from_only" }>>;

export type ShopifyGraphqlResult = Readonly<{
  data: JsonObject;
  errors: readonly Readonly<{ message: string; path?: readonly (string | number)[] }>[];
}>;

export type ShopifyGraphqlCall = (
  query: string,
  variables: Readonly<Record<string, unknown>>,
) => Promise<ShopifyGraphqlResult>;

const cursorSchema = z.object({
  version: z.literal(1),
  after: z.string().nullable().optional(),
  parentAfter: z.string().nullable().optional(),
  childAfter: z.string().nullable().optional(),
  catalogueStream: z.number().int().nonnegative().optional(),
  catalogueCursor: z.string().nullable().optional(),
  catalogueWatermark: z.string().datetime({ offset: true }).optional(),
  registryOffset: z.number().int().nonnegative().optional(),
  registryComplete: z.boolean().optional(),
  registrySha256: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
  ownerTypeIndex: z.number().int().nonnegative().optional(),
  definitionAfter: z.string().nullable().optional(),
  valueAfter: z.string().nullable().optional(),
  deletionEventPhase: z.literal(true).optional(),
  deletionEventAfter: z.string().nullable().optional(),
  deletionEventFrom: z.string().datetime({ offset: true }).optional(),
  deletionEventTo: z.string().datetime({ offset: true }).optional(),
  deletionEventWatermark: z.string().datetime({ offset: true }).optional(),
  resourceWatermark: z.string().datetime({ offset: true }).optional(),
  deletionContinuity: z.enum(["prior_generation_verified", "prior_generation_unproven"]).optional(),
  skipDeletionEventPoll: z.literal(true).optional(),
  collectionScanId: z.string().regex(/^[0-9a-f]{64}$/u).optional(),
  collectionOrderId: z.string().min(1).optional(),
}).strict();

type CursorState = z.infer<typeof cursorSchema>;
type DeletionEventStream = Extract<PromotedShopifyStream,
  | "shopify_products"
  | "shopify_product_variants"
  | "shopify_customers"
  | "shopify_orders"
  | "shopify_discounts"
>;
type AuthoritativeOrderChildStream = Extract<PromotedShopifyStream,
  | "shopify_order_lines"
  | "shopify_transactions"
  | "shopify_refund_lines"
  | "shopify_fulfillments"
  | "shopify_returns"
>;

const DELETION_EVENT_SUBJECTS: Readonly<Record<DeletionEventStream, Readonly<{
  subjectType: "PRODUCT" | "PRODUCT_VARIANT" | "CUSTOMER" | "ORDER" | "DISCOUNT_NODE";
  sourceObjectType: "Product" | "ProductVariant" | "Customer" | "Order" | "DiscountNode";
}>>> = Object.freeze({
  shopify_products: { subjectType: "PRODUCT", sourceObjectType: "Product" },
  shopify_product_variants: { subjectType: "PRODUCT_VARIANT", sourceObjectType: "ProductVariant" },
  shopify_customers: { subjectType: "CUSTOMER", sourceObjectType: "Customer" },
  shopify_orders: { subjectType: "ORDER", sourceObjectType: "Order" },
  shopify_discounts: { subjectType: "DISCOUNT_NODE", sourceObjectType: "DiscountNode" },
});
const ORDER_CHILD_COLLECTIONS: Readonly<Record<AuthoritativeOrderChildStream, Readonly<{
  sourceObjectType:
    | "OrderLineCollection"
    | "OrderTransactionCollection"
    | "RefundLineCollection"
    | "FulfillmentCollection"
    | "ReturnCollection";
}>>> = Object.freeze({
  shopify_order_lines: { sourceObjectType: "OrderLineCollection" },
  shopify_transactions: { sourceObjectType: "OrderTransactionCollection" },
  shopify_refund_lines: { sourceObjectType: "RefundLineCollection" },
  shopify_fulfillments: { sourceObjectType: "FulfillmentCollection" },
  shopify_returns: { sourceObjectType: "ReturnCollection" },
});
const FIELD_VALUE_AVAILABILITY = new Map(
  SHOPIFY_ADMIN_FIELD_VALUE_AVAILABILITY.map((entry) => [entry.schemaPath, entry]),
);
export const SHOPIFY_FIELD_CATALOGUE_STREAMS = Object.freeze(
  Object.keys(SHOPIFY_QUERIES) as Exclude<ShopifyStreamId, "shopify_fields">[],
);

export async function extractShopifyPage(input: Readonly<{
  stream: ShopifyStreamId;
  mode: "initial" | "incremental" | "reconciliation";
  range?: SyncRange;
  cursor?: SyncCursor;
  reconciliationPhase?: ReconciliationRequest["phase"];
  call: ShopifyGraphqlCall;
  now: () => number;
  readAllOrders: boolean;
}>): Promise<SyncPage> {
  if (input.stream === "shopify_fields") return extractFieldCatalogue(input);
  const stream: PromotedShopifyStream = input.stream;
  const state = decodeCursor(input.cursor);
  if (state.deletionEventPhase) {
    try {
      return await extractDeletionEventPage({ ...input, stream }, state);
    } catch (error) {
      if (error instanceof ConnectorError && (
        error.code === "CAPABILITY_UNAVAILABLE" ||
        error.code === "REMOTE_RESPONSE_INVALID" ||
        error.code === "CURSOR_INVALID"
      )) {
        throw new ConnectorError(error.code,error.message,{
          retryable: false,cause: error,
          details: {
            ...error.details,stream,
            reason: "shopify_deletion_feed_unavailable",
            eventRetentionDays: 365,
          },
        });
      }
      throw error;
    }
  }
  // Continuity is a publication safety precondition, not a terminal-page
  // quality check. Reject an unprovable ledger before making the resource
  // request so stale rows can be hidden immediately instead of remaining
  // visible throughout a potentially long snapshot walk.
  assertDeletionContinuityPreflight({ ...input, stream }, state);
  const plan = SHOPIFY_QUERIES[stream];
  const search = searchFilter(input.stream, input.mode, input.range, input.cursor);
  const variables: Record<string, unknown> = {};
  if (plan.shape === "metafield_definitions") {
    variables.ownerType = metafieldOwnerType(input.stream, state);
    variables.first = 100;
    variables.after = state.after ?? null;
  } else if (plan.shape === "metafield_values") {
    variables.ownerType = metafieldOwnerType(input.stream, state);
    variables.definitionAfter = state.definitionAfter ?? null;
    variables.valueAfter = state.valueAfter ?? null;
  } else if (plan.shape === "connection") {
    variables.first = directPageSize(stream);
    variables.after = state.after ?? null;
    if (supportsSearch(stream)) variables.query = search;
  } else if (plan.shape === "nested_connection") {
    variables.parentAfter = state.parentAfter ?? null;
    variables.childAfter = state.childAfter ?? null;
    if (supportsSearch(stream)) variables.query = search;
  } else if (plan.shape === "nested_list" || plan.shape === "refund_lines") {
    variables.first = plan.shape === "refund_lines" ? 3 : 5;
    variables.after = state.after ?? null;
    variables.query = search;
  }

  const response = await input.call(plan.query, variables);
  if (plan.shape === "single") {
    const node = object(response.data.shop);
    const records = node ? [recordFor(stream, node, undefined, input.now)] : [];
    return terminalPage(input, records, input.now);
  }
  if (plan.shape === "metafield_definitions") {
    return metafieldDefinitionPage(input, response.data[plan.root], state);
  }
  if (plan.shape === "metafield_values") {
    return metafieldValuePage(input, response.data[plan.root], state);
  }
  if (plan.shape === "connection") {
    return directConnectionPage({ ...input, stream }, response.data[plan.root], state);
  }
  if (plan.shape === "nested_connection") {
    return nestedConnectionPage({ ...input, stream }, response.data[plan.root], state);
  }
  if (plan.shape === "refund_lines") {
    return refundLinesPage({ ...input, stream }, response.data[plan.root], state);
  }
  return nestedListPage({ ...input, stream }, response.data[plan.root], state);
}

function assertDeletionContinuityPreflight(
  input: Parameters<typeof extractShopifyPage>[0] & Readonly<{ stream: PromotedShopifyStream }>,
  state: CursorState,
): void {
  const subject = deletionEventSubject(input.stream);
  if (!subject) return;
  if (state.deletionContinuity === "prior_generation_unproven") {
    throw deletionContinuityUnavailable(
      input.stream,
      "shopify_deletion_continuity_unproven",
      "Shopify deletion continuity cannot be proven for the prior connection generation. Disconnect the store, wait for verified local deletion to complete, reconnect it, and explicitly start ingestion.",
    );
  }
  if (input.mode === "incremental" && !state.deletionEventWatermark) {
    throw deletionContinuityUnavailable(
      input.stream,
      "shopify_deletion_watermark_missing",
      "Shopify deletion continuity is missing from this legacy cursor. Disconnect the store, wait for verified local deletion to complete, reconnect it, and explicitly start ingestion.",
    );
  }

  const lower = state.deletionEventWatermark ?? (
    input.mode === "reconciliation" && input.reconciliationPhase === "late_edits"
      ? input.range?.from
      : undefined
  );
  const upper = input.mode === "reconciliation"
    ? input.range?.to
    : new Date(input.now()).toISOString();
  if (lower && upper && Date.parse(lower) < Date.parse(upper) - 365 * 86_400_000) {
    throw deletionContinuityUnavailable(
      input.stream,
      "shopify_deletion_retention_gap",
      "Shopify retains events for only one year, so this deletion gap cannot be proven complete. Disconnect the store, wait for verified local deletion to complete, reconnect it, and explicitly start ingestion.",
    );
  }
}

function deletionContinuityUnavailable(
  stream: PromotedShopifyStream,
  reason:
    | "shopify_deletion_continuity_unproven"
    | "shopify_deletion_watermark_missing"
    | "shopify_deletion_retention_gap",
  message: string,
): ConnectorError {
  return new ConnectorError("CAPABILITY_UNAVAILABLE", message, {
    retryable: false,
    details: { stream, reason, eventRetentionDays: 365 },
  });
}

async function extractDeletionEventPage(
  input: Parameters<typeof extractShopifyPage>[0] & Readonly<{ stream: PromotedShopifyStream }>,
  state: CursorState,
): Promise<SyncPage> {
  const subject = deletionEventSubject(input.stream);
  if (!subject || !state.deletionEventFrom || !state.deletionEventTo) {
    throw new ConnectorError(
      "CURSOR_INVALID",
      "The Shopify deletion-event cursor is incomplete or targets an unsupported stream.",
    );
  }
  const response = await input.call(SHOPIFY_DELETION_EVENTS_QUERY, {
    first: 100,
    after: state.deletionEventAfter ?? null,
    query: deletionEventFilter(subject.subjectType, state.deletionEventFrom, state.deletionEventTo),
  });
  const events = connectionValue(response.data.events, `${input.stream}.events`);
  const records = events.edges.map(({ node }) => deletionEventRecord(
    input.stream as DeletionEventStream,
    subject,
    node,
    state.deletionEventFrom!,
    state.deletionEventTo!,
  ));
  if (events.hasNextPage) {
    if (!events.endCursor || events.endCursor === state.deletionEventAfter) {
      return blocked(records, "Shopify returned a non-advancing deletion-event cursor.");
    }
    return {
      records,
      hasMore: true,
      nextCursor: cursor({
        version: 1,
        deletionEventPhase: true,
        deletionEventAfter: events.endCursor,
        deletionEventFrom: state.deletionEventFrom,
        deletionEventTo: state.deletionEventTo,
        ...(state.deletionEventWatermark
          ? { deletionEventWatermark: state.deletionEventWatermark }
          : {}),
        ...(state.resourceWatermark ? { resourceWatermark: state.resourceWatermark } : {}),
      }, input.cursor?.sourceUpdatedAt),
    };
  }
  return completedPage(
    input,
    records,
    input.now,
    state.resourceWatermark ?? input.cursor?.sourceUpdatedAt,
    { version: 1, deletionEventWatermark: state.deletionEventTo },
  );
}

function deletionEventSubject(
  stream: PromotedShopifyStream,
): (typeof DELETION_EVENT_SUBJECTS)[DeletionEventStream] | null {
  return stream in DELETION_EVENT_SUBJECTS
    ? DELETION_EVENT_SUBJECTS[stream as DeletionEventStream]
    : null;
}

function authoritativeOrderChildStream(
  stream: PromotedShopifyStream,
): stream is AuthoritativeOrderChildStream {
  return stream in ORDER_CHILD_COLLECTIONS;
}

function deletionEventFilter(
  subjectType: (typeof DELETION_EVENT_SUBJECTS)[DeletionEventStream]["subjectType"],
  from: string,
  to: string,
): string {
  const lower = shopifySearchInstant(from);
  const upper = shopifySearchInstant(to);
  if (Date.parse(lower) > Date.parse(upper)) {
    throw new ConnectorError("CURSOR_INVALID", "The Shopify deletion-event window is reversed.");
  }
  return `action:destroy comments:false subject_type:${subjectType} created_at:>='${lower}' created_at:<='${upper}'`;
}

function deletionEventRecord(
  stream: DeletionEventStream,
  expected: (typeof DELETION_EVENT_SUBJECTS)[DeletionEventStream],
  node: JsonObject,
  from: string,
  to: string,
): RawSourceRecord {
  const eventId = string(node.id);
  const action = string(node.action);
  const createdAt = string(node.createdAt);
  const subjectId = string(node.subjectId);
  const subjectType = string(node.subjectType);
  const createdAtMs = createdAt ? Date.parse(createdAt) : Number.NaN;
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (
    !eventId || action !== "destroy" || !createdAt || !Number.isFinite(Date.parse(createdAt)) ||
    !subjectId || subjectType !== expected.subjectType ||
    !Number.isFinite(fromMs) || !Number.isFinite(toMs) ||
    createdAtMs < fromMs || createdAtMs > toMs
  ) {
    throw new ConnectorError(
      "REMOTE_RESPONSE_INVALID",
      `Shopify returned an invalid ${expected.subjectType} destroy event.`,
    );
  }
  const occurredAt = new Date(createdAt).toISOString();
  const allowed = new Set(SHOPIFY_STREAM_FIELDS[stream].map((field) => field.name));
  const fields = Object.fromEntries(Object.entries({
    id: subjectId,
    rawNode: node,
  }).filter(([field]) => allowed.has(field)));
  return {
    sourceObjectType: expected.sourceObjectType,
    sourceRecordId: subjectId,
    sourceUpdatedAt: occurredAt,
    payload: node,
    payloadHash: hash(node),
    normalized: {
      schemaVersion: `${SHOPIFY_API_VERSION}.1`,
      fields,
      tombstone: true,
    },
    deletionSignal: { kind: "verified_vendor_delete_feed" },
  };
}

function metafieldOwnerTypes(stream: ShopifyStreamId): readonly string[] {
  return stream === "shopify_metafield_definitions"
    ? SHOPIFY_METAFIELD_DEFINITION_OWNER_TYPES
    : SHOPIFY_METAFIELD_VALUE_OWNER_TYPES;
}

function metafieldOwnerType(stream: ShopifyStreamId, state: CursorState): string {
  const ownerType = metafieldOwnerTypes(stream)[state.ownerTypeIndex ?? 0];
  if (!ownerType) {
    throw new ConnectorError("CURSOR_INVALID", "The Shopify metafield cursor names an unsupported owner type.");
  }
  return ownerType;
}

function metafieldDefinitionPage(
  input: Parameters<typeof extractShopifyPage>[0],
  rawConnection: unknown,
  state: CursorState,
): SyncPage {
  const connection = connectionValue(rawConnection, input.stream);
  const ownerTypeIndex = state.ownerTypeIndex ?? 0;
  const records = connection.edges.map(({ node }) => recordFor(
    "shopify_metafield_definitions",
    node,
    undefined,
    input.now,
  ));
  if (connection.hasNextPage) {
    if (!connection.endCursor || connection.endCursor === state.after) {
      return blocked(records, "Shopify returned a non-advancing metafield-definition cursor.");
    }
    return {
      records,
      hasMore: true,
      nextCursor: cursor({ version: 1, ownerTypeIndex, after: connection.endCursor }, input.cursor?.sourceUpdatedAt),
    };
  }
  if (ownerTypeIndex + 1 < SHOPIFY_METAFIELD_DEFINITION_OWNER_TYPES.length) {
    return {
      records,
      hasMore: true,
      nextCursor: cursor({ version: 1, ownerTypeIndex: ownerTypeIndex + 1, after: null }, input.cursor?.sourceUpdatedAt),
    };
  }
  return terminalPage(input, records, input.now, latestUpdate(records, input.cursor?.sourceUpdatedAt));
}

function metafieldValuePage(
  input: Parameters<typeof extractShopifyPage>[0],
  rawConnection: unknown,
  state: CursorState,
): SyncPage {
  const definitions = connectionValue(rawConnection, input.stream);
  const ownerTypeIndex = state.ownerTypeIndex ?? 0;
  const definition = definitions.edges[0];
  if (!definition) {
    if (ownerTypeIndex + 1 < SHOPIFY_METAFIELD_VALUE_OWNER_TYPES.length) {
      return {
        records: [],
        hasMore: true,
        nextCursor: cursor({
          version: 1,
          ownerTypeIndex: ownerTypeIndex + 1,
          definitionAfter: null,
          valueAfter: null,
        }, input.cursor?.sourceUpdatedAt),
      };
    }
    return terminalPage(input, [], input.now, input.cursor?.sourceUpdatedAt);
  }
  const values = connectionValue(definition.node.metafields, `${input.stream}.metafields`);
  const records = values.edges.map(({ node }) => recordFor(
    "shopify_metafield_values",
    node,
    string(definition.node.id) ?? undefined,
    input.now,
    { definition: definition.node },
  ));
  const latest = latestUpdate(
    records,
    state.resourceWatermark ?? input.cursor?.sourceUpdatedAt,
  );
  if (values.hasNextPage) {
    if (!values.endCursor || values.endCursor === state.valueAfter) {
      return blocked(records, "Shopify returned a non-advancing metafield-value cursor.");
    }
    return {
      records,
      hasMore: true,
      nextCursor: cursor({
        version: 1,
        ownerTypeIndex,
        definitionAfter: state.definitionAfter ?? null,
        valueAfter: values.endCursor,
      }, input.cursor?.sourceUpdatedAt),
    };
  }
  if (definitions.hasNextPage) {
    if (!definition.cursor || definition.cursor === state.definitionAfter) {
      return blocked(records, "Shopify returned a non-advancing metafield-definition parent cursor.");
    }
    return {
      records,
      hasMore: true,
      nextCursor: cursor({
        version: 1,
        ownerTypeIndex,
        definitionAfter: definition.cursor,
        valueAfter: null,
      }, input.cursor?.sourceUpdatedAt),
    };
  }
  if (ownerTypeIndex + 1 < SHOPIFY_METAFIELD_VALUE_OWNER_TYPES.length) {
    return {
      records,
      hasMore: true,
      nextCursor: cursor({
        version: 1,
        ownerTypeIndex: ownerTypeIndex + 1,
        definitionAfter: null,
        valueAfter: null,
      }, input.cursor?.sourceUpdatedAt),
    };
  }
  return terminalPage(input, records, input.now, latest);
}

function directConnectionPage(
  input: Parameters<typeof extractShopifyPage>[0] & Readonly<{ stream: PromotedShopifyStream }>,
  rawConnection: unknown,
  state: CursorState,
): SyncPage {
  const connection = connectionValue(rawConnection, input.stream);
  const records = connection.edges.map(({ node }) => recordFor(input.stream, node, undefined, input.now));
  const latest = latestUpdate(
    records,
    state.resourceWatermark ?? input.cursor?.sourceUpdatedAt,
  );
  if (connection.hasNextPage) {
    const after = connection.endCursor;
    if (!after || after === state.after) return blocked(records, "Shopify returned a non-advancing connection cursor.");
    // A vendor cursor is valid only for the exact result set that created it.
    // Hold the incremental lower bound fixed until the final page, then commit
    // the newly observed watermark atomically with terminal completion.
    return {
      records,
      hasMore: true,
      nextCursor: cursor(
        resourcePageState(state, { after }, latest),
        input.cursor?.sourceUpdatedAt,
      ),
    };
  }
  return terminalPage(input, records, input.now, latest);
}

function nestedConnectionPage(
  input: Parameters<typeof extractShopifyPage>[0] & Readonly<{ stream: PromotedShopifyStream }>,
  rawConnection: unknown,
  state: CursorState,
): SyncPage {
  const parent = connectionValue(rawConnection, input.stream);
  const parentEdge = parent.edges[0];
  if (!parentEdge) {
    return terminalPage(
      input,
      [],
      input.now,
      state.resourceWatermark ?? input.cursor?.sourceUpdatedAt,
    );
  }
  const childName = childConnectionName(input.stream);
  const child = connectionValue(parentEdge.node[childName], `${input.stream}.${childName}`);
  const orderChildCollection = authoritativeOrderChildStream(input.stream)
    ? orderChildCollectionIdentity(input, state, parentEdge.node)
    : null;
  if (input.stream === "shopify_returns" && child.edges.some(({ node }) =>
    [node.exchangeLineItems, node.returnLineItems, node.refunds].some((value) =>
      connectionSelectedCount(value) >= 250
    )
  )) {
    rejectIncompleteNestedSelection(
      input.stream,
      "A Shopify return reached the maximum nested selection size; the page is not complete and requires a narrower reconciliation query.",
    );
  }
  const records = child.edges.map(({ node }) => recordFor(
    input.stream,
    node,
    string(parentEdge.node.id) ?? undefined,
    input.now,
    {
      parent: parentEdge.node,
      ...(input.stream === "shopify_inventory_levels"
        ? { variantId: path(parentEdge.node, "variant", "id") }
        : {}),
      ...(orderChildCollection
        ? {
            collectionScanId: orderChildCollection.scanId,
            collectionUpdatedAt: orderChildCollection.updatedAt,
          }
        : {}),
    },
  ));
  const latest = latestUpdate(
    records,
    latestUpdate(
      [],
      string(parentEdge.node.updatedAt) ??
        state.resourceWatermark ??
        input.cursor?.sourceUpdatedAt,
    ),
  );
  if (child.hasNextPage) {
    if (!child.endCursor || child.endCursor === state.childAfter) {
      return blocked(records, "Shopify returned a non-advancing nested connection cursor.");
    }
    return {
      records,
      hasMore: true,
      nextCursor: cursor(resourcePageState(state, {
        parentAfter: state.parentAfter ?? null,
        childAfter: child.endCursor,
        ...(orderChildCollection ? {
          collectionScanId: orderChildCollection.scanId,
          collectionOrderId: orderChildCollection.orderId,
        } : {}),
      }, latest), input.cursor?.sourceUpdatedAt),
    };
  }
  if (parent.hasNextPage) {
    if (!parentEdge.cursor || parentEdge.cursor === state.parentAfter) {
      return blocked(records, "Shopify returned a non-advancing parent connection cursor.");
    }
    return {
      records: orderChildCollection
        ? [...records, orderChildCollectionRecord(input.stream as AuthoritativeOrderChildStream, orderChildCollection, parentEdge.node)]
        : records,
      hasMore: true,
      nextCursor: cursor(resourcePageState(
        state,
        { parentAfter: parentEdge.cursor, childAfter: null },
        latest,
      ), input.cursor?.sourceUpdatedAt),
    };
  }
  return terminalPage(
    input,
    orderChildCollection
      ? [...records, orderChildCollectionRecord(input.stream as AuthoritativeOrderChildStream, orderChildCollection, parentEdge.node)]
      : records,
    input.now,
    latest,
  );
}

function orderChildCollectionIdentity(
  input: Parameters<typeof extractShopifyPage>[0],
  state: CursorState,
  parent: JsonObject,
): Readonly<{ orderId: string; scanId: string; updatedAt: string }> {
  const orderId = string(parent.id);
  const updatedAt = string(parent.updatedAt);
  if (!orderId || !updatedAt || !Number.isFinite(Date.parse(updatedAt))) {
    throw new ConnectorError(
      "REMOTE_RESPONSE_INVALID",
      "Shopify returned an order without the identity and update time required for authoritative line replacement.",
    );
  }
  if (state.collectionOrderId && state.collectionOrderId !== orderId) {
    throw new ConnectorError(
      "CURSOR_INVALID",
      "The Shopify order-line collection cursor changed parent order.",
    );
  }
  const normalizedUpdatedAt = new Date(updatedAt).toISOString();
  const scanId = createHash("sha256").update(JSON.stringify({
    version: 1,
    stream: input.stream,
    orderId,
    updatedAt: normalizedUpdatedAt,
  }), "utf8").digest("hex");
  if (state.collectionScanId && state.collectionScanId !== scanId) {
    throw new ConnectorError(
      "CURSOR_INVALID",
      "The Shopify order-line collection cursor no longer matches its frozen order version.",
    );
  }
  return { orderId, scanId, updatedAt: normalizedUpdatedAt };
}

function orderChildCollectionRecord(
  stream: AuthoritativeOrderChildStream,
  collection: Readonly<{ orderId: string; scanId: string; updatedAt: string }>,
  parent: JsonObject,
): RawSourceRecord {
  const definition = ORDER_CHILD_COLLECTIONS[stream];
  const sourceRecordId = `${collection.orderId}:albert-${stream}-collection`;
  const payload = Object.freeze({
    kind: "albert_shopify_order_child_collection",
    stream,
    orderId: collection.orderId,
    collectionScanId: collection.scanId,
    complete: true,
    parentUpdatedAt: collection.updatedAt,
    parentCursorEvidence: parent,
  });
  return rawRecord(
    stream,
    definition.sourceObjectType,
    sourceRecordId,
    payload,
    {
      id: sourceRecordId,
      orderId: collection.orderId,
      collectionScanId: collection.scanId,
      collectionComplete: true,
      rawNode: payload,
    },
    collection.updatedAt,
  );
}

function nestedListPage(
  input: Parameters<typeof extractShopifyPage>[0] & Readonly<{ stream: PromotedShopifyStream }>,
  rawConnection: unknown,
  state: CursorState,
): SyncPage {
  const parents = connectionValue(rawConnection, input.stream);
  const childName = childConnectionName(input.stream);
  const childSelectionCapped = parents.edges.some(({ node: parent }) => {
    const children = Array.isArray(parent[childName]) ? parent[childName] : [];
    return children.length >= 250;
  });
  if (childSelectionCapped) {
    rejectIncompleteNestedSelection(
      input.stream,
      `A Shopify ${childName} selection reached the 250-record maximum; the page is not complete and requires a narrower reconciliation query.`,
    );
  }
  const records: RawSourceRecord[] = [];
  for (const { node: parent } of parents.edges) {
    const children = Array.isArray(parent[childName]) ? parent[childName] : [];
    const collectionStream = authoritativeOrderChildStream(input.stream)
      ? input.stream
      : null;
    const collection = collectionStream
      ? orderChildCollectionIdentity(input, state, parent)
      : null;
    for (const value of children) {
      const child = object(value);
      if (child) records.push(recordFor(
        input.stream,
        child,
        string(parent.id) ?? undefined,
        input.now,
        {
          parent,
          ...(collection ? {
            collectionScanId: collection.scanId,
            collectionUpdatedAt: collection.updatedAt,
          } : {}),
        },
      ));
    }
    if (collection && collectionStream) {
      records.push(orderChildCollectionRecord(collectionStream, collection, parent));
    }
  }
  const latest = latestUpdate(
    records,
    state.resourceWatermark ?? input.cursor?.sourceUpdatedAt,
  );
  if (parents.hasNextPage) {
    if (!parents.endCursor || parents.endCursor === state.after) {
      return blocked(records, "Shopify returned a non-advancing order cursor.");
    }
    return {
      records,
      hasMore: true,
      nextCursor: cursor(
        resourcePageState(state, { after: parents.endCursor }, latest),
        input.cursor?.sourceUpdatedAt,
      ),
    };
  }
  return terminalPage(input, records, input.now, latest);
}

function refundLinesPage(
  input: Parameters<typeof extractShopifyPage>[0] & Readonly<{ stream: PromotedShopifyStream }>,
  rawConnection: unknown,
  state: CursorState,
): SyncPage {
  const orders = connectionValue(rawConnection, input.stream);
  const nestedSelectionCapped = orders.edges.some(({ node: order }) => {
    const refunds = Array.isArray(order.refunds) ? order.refunds : [];
    return refunds.length >= 250 || refunds.some((refundValue) => {
      const refund = object(refundValue);
      return refund ? connectionSelectedCount(refund.refundLineItems) >= 250 : false;
    });
  });
  if (nestedSelectionCapped) {
    rejectIncompleteNestedSelection(
      input.stream,
      "A Shopify refund or refund-line selection reached the 250-record maximum; the page is not complete and requires a narrower reconciliation query.",
    );
  }
  const records: RawSourceRecord[] = [];
  for (const { node: order } of orders.edges) {
    const collection = orderChildCollectionIdentity(input, state, order);
    const refunds = Array.isArray(order.refunds) ? order.refunds : [];
    for (const refundValue of refunds) {
      const refund = object(refundValue);
      if (!refund) continue;
      const lines = connectionValue(refund.refundLineItems, `${input.stream}.refundLineItems`);
      for (const { node } of lines.edges) {
        records.push(recordFor(input.stream, {
          ...node,
          refundId: refund.id,
          orderId: order.id,
          refundedAt: refund.processedAt ?? refund.createdAt,
        }, string(refund.id) ?? undefined, input.now, {
          parent: order,
          collectionScanId: collection.scanId,
          collectionUpdatedAt: collection.updatedAt,
        }));
      }
    }
    records.push(orderChildCollectionRecord("shopify_refund_lines", collection, order));
  }
  const latest = latestUpdate(
    records,
    state.resourceWatermark ?? input.cursor?.sourceUpdatedAt,
  );
  if (orders.hasNextPage) {
    if (!orders.endCursor || orders.endCursor === state.after) {
      return blocked(records, "Shopify returned a non-advancing refund order cursor.");
    }
    return {
      records,
      hasMore: true,
      nextCursor: cursor(
        resourcePageState(state, { after: orders.endCursor }, latest),
        input.cursor?.sourceUpdatedAt,
      ),
    };
  }
  return terminalPage(input, records, input.now, latest);
}

/**
 * The exhaustive field stream replays all promoted versioned queries and
 * emits one typed observation per scalar leaf. The generated schema registry
 * separately dispositions every 2026-07 field, including fields unavailable
 * to this installation. This stream makes every value that Shopify returned
 * directly filterable without exposing arbitrary SQL or relying on JSON text.
 */
async function extractFieldCatalogue(
  input: Parameters<typeof extractShopifyPage>[0],
): Promise<SyncPage> {
  const state = decodeCursor(input.cursor);
  const registrySha256 = shopifyDefinitionRegistrySha256();
  if (!state.registryComplete || state.registrySha256 !== registrySha256) {
    return extractSchemaDefinitions(
      input,
      state.registrySha256 === registrySha256 ? state.registryOffset ?? 0 : 0,
    );
  }
  const catalogue = SHOPIFY_FIELD_CATALOGUE_STREAMS;
  const index = state.catalogueStream ?? 0;
  const selected = catalogue[index];
  if (!selected) return terminalPage(input, [], input.now, input.cursor?.sourceUpdatedAt);
  const scanWatermark = input.cursor?.sourceUpdatedAt;
  const nestedCursor = state.catalogueCursor
    ? { value: state.catalogueCursor, ...(scanWatermark ? { sourceUpdatedAt: scanWatermark } : {}) }
    : scanWatermark
      ? cursor({ version: 1 }, scanWatermark)
      : undefined;
  const page = await extractShopifyPage({ ...input, stream: selected, cursor: nestedCursor });
  const observedAt = new Date(input.now()).toISOString();
  // Merchant-defined metafields have no trustworthy semantic classification.
  // Treat every leaf replayed from the value stream as unclassified sensitive
  // data, including helper leaves such as owner IDs. This prevents a future
  // schema metadata change from making arbitrary literals public in Cube.
  const unclassifiedMetafieldObservation = selected === "shopify_metafield_values";
  const observations: RawSourceRecord[] = [];
  for (const source of page.records) {
    if (Object.values(ORDER_CHILD_COLLECTIONS).some(
      ({ sourceObjectType }) => sourceObjectType === source.sourceObjectType,
    )) continue;
    for (const leaf of buildShopifyFieldIndex(source.payload)) {
      const fieldName = leaf.schemaPath.split(".").at(-1)?.replace(/\[\]$/u, "") ?? leaf.schemaPath;
      const sourceRecordId = `${selected}:${source.sourceRecordId}:${leaf.pointer || "$"}`;
      const registryField = observedFieldMetadata(source.sourceObjectType, leaf.schemaPath);
      const fields = {
        id: sourceRecordId,
        definitionKind: "observed_value",
        schemaPath: `${source.sourceObjectType}.${leaf.schemaPath}`,
        rootField: SHOPIFY_QUERIES[selected].root,
        objectType: source.sourceObjectType,
        graphqlId: source.sourceRecordId,
        parentGraphqlId: observedParentGraphqlId(selected, source),
        fieldName,
        fieldType: leaf.valueKind,
        valueKind: leaf.valueKind,
        valueForm: "leaf",
        observationForm: "literal_leaf",
        ordinal: leaf.ordinal,
        jsonPointer: leaf.pointer,
        stringValue: leaf.stringValue,
        numericValue: leaf.numericValue,
        booleanValue: leaf.booleanValue,
        datetimeValue: leaf.datetimeValue,
        jsonValue: { value: leaf.jsonValue },
        nodePayload: source.payload,
        apiVersion: SHOPIFY_API_VERSION,
        requiredScopes: requiredScopesFromAccess(registryField?.requiredAccess),
        requiredAccess: registryField?.requiredAccess ?? null,
        fieldArguments: registryField?.field.args ?? [],
        description: registryField?.field.description ?? null,
        protectedDataLevel: unclassifiedMetafieldObservation
          ? "unclassified_metafield_data"
          : registryField
            ? registryField.protected
              ? registryField.protectedSubject ?? "protected_customer_data"
              : "none"
            : "unresolved",
        availability: unclassifiedMetafieldObservation
          ? "generic_metafield_ingested"
          : "available",
        availabilityReason: unclassifiedMetafieldObservation
          ? "Observed merchant-defined metafield data is unclassified sensitive data and is always redacted from Cube."
          : registryField
            ? null
            : "The observed path could not be mapped safely to one schema field; its value remains redacted.",
        deprecated: registryField?.field.isDeprecated ?? false,
        deprecationReason: registryField?.field.deprecationReason ?? null,
        documentationUrl: loadShopifyAdminSchemaRegistry().source.documentationUrl,
        schemaSha256: loadShopifyAdminSchemaRegistry().source.schemaSha256,
        observedAt,
      };
      observations.push(rawRecord("shopify_fields", "GraphQLFieldObservation", sourceRecordId, fields, fields, source.sourceUpdatedAt));
    }
  }
  const catalogueWatermark = latestUpdate(
    observations,
    state.catalogueWatermark ?? scanWatermark,
  );
  if (page.hasMore && !page.nextCursor) {
    return {
      records: observations,
      hasMore: true,
      nextCursor: null,
      paginationBlock: page.paginationBlock ?? {
        code: "pagination_not_advancing",
        detail: `The ${selected} field-catalogue scan cannot advance safely.`,
      },
    };
  }
  if (page.hasMore && page.nextCursor) {
    return {
      records: observations,
      hasMore: true,
      nextCursor: cursor({
        version: 1,
        registryComplete: true,
        registrySha256,
        catalogueStream: index,
        catalogueCursor: page.nextCursor.value,
        ...(catalogueWatermark ? { catalogueWatermark } : {}),
      }, scanWatermark),
    };
  }
  const nextIndex = index + 1;
  if (nextIndex < catalogue.length) {
    return {
      records: observations,
      hasMore: true,
      nextCursor: cursor({
        version: 1,
        registryComplete: true,
        registrySha256,
        catalogueStream: nextIndex,
        catalogueCursor: null,
        ...(catalogueWatermark ? { catalogueWatermark } : {}),
      }, scanWatermark),
    };
  }
  return terminalPage(input, observations, input.now, catalogueWatermark);
}

function observedParentGraphqlId(
  stream: PromotedShopifyStream,
  source: RawSourceRecord,
): string | null {
  const fields = source.normalized?.fields;
  const directParent = fields && typeof fields === "object"
    ? fields.orderId ?? fields.productId ?? fields.ownerId
    : null;
  if (typeof directParent === "string" && directParent.trim()) return directParent;
  const payloadParent = object(source.payload)?.__parentId;
  if (typeof payloadParent === "string" && payloadParent.trim()) return payloadParent;
  return [
    "shopify_products", "shopify_customers", "shopify_orders", "shopify_discounts",
  ].includes(stream) ? source.sourceRecordId : null;
}

function observedFieldMetadata(
  rootType: string,
  schemaPath: string,
): Readonly<{
  field: ShopifyGraphQLField;
  requiredAccess?: string;
  protected: boolean;
  protectedSubject?: string;
}> | null {
  if (schemaPath.endsWith(".__typename") || schemaPath === "__typename") {
    return null;
  }
  const index = indexShopifyAdminSchemaRegistry();
  let currentType = index.typesByName.get(rootType);
  if (!currentType) return null;
  let protectedPath = Boolean(currentType.isProtected);
  let protectedSubject = currentType.protectedSubject ?? currentType.protectedContent;
  let requiredAccess = currentType.requiredAccess;
  let resolved: ShopifyGraphQLField | undefined;
  for (const rawSegment of schemaPath.split(".")) {
    const segment = rawSegment.replace(/\[\]$/u, "");
    if (segment === "__typename") continue;
    resolved = shopifyGraphQLField(index, currentType.name, segment);
    if (!resolved) return null;
    protectedPath ||= Boolean(resolved.isProtected);
    protectedSubject ??= resolved.protectedSubject ?? resolved.protectedContent;
    requiredAccess = resolved.requiredAccess ?? requiredAccess;
    const nextType = index.typesByName.get(shopifyGraphQLNamedType(resolved.type));
    if (nextType) {
      currentType = nextType;
      protectedPath ||= Boolean(nextType.isProtected);
      protectedSubject ??= nextType.protectedSubject ?? nextType.protectedContent;
      requiredAccess = nextType.requiredAccess ?? requiredAccess;
    }
  }
  return resolved ? {
    field: resolved,
    ...(requiredAccess ? { requiredAccess } : {}),
    protected: protectedPath,
    ...(protectedSubject ? { protectedSubject } : {}),
  } : null;
}

/**
 * Materialise the official schema itself beside runtime values. This makes a
 * field answerable even when the installation lacks its scope, plan, staff
 * permission, protected-data approval, or required caller arguments. A
 * definition-only row can never be mistaken for an observed null value.
 */
function extractSchemaDefinitions(
  input: Parameters<typeof extractShopifyPage>[0],
  offset: number,
): SyncPage {
  const registry = loadShopifyAdminSchemaRegistry();
  const shopifyQlRegistry = loadShopifyQLSchemaRegistry();
  const definitions: ShopifyDefinition[] = [
    ...registry.types.flatMap((type) =>
      (type.fields ?? []).map((field): ShopifyDefinition => ({ kind: "admin", type, field })),
    ),
    ...registry.types.flatMap((type) =>
      (type.inputFields ?? []).map((field): ShopifyDefinition => ({
        kind: "admin_input_field", type, field,
      })),
    ),
    ...registry.types.flatMap((type) =>
      (type.fields ?? []).flatMap((parentField) =>
        parentField.args.map((argument): ShopifyDefinition => ({
          kind: "admin_field_argument", type, parentField, argument,
        })),
      ),
    ),
    ...registry.types.flatMap((type) =>
      (type.enumValues ?? []).map((value): ShopifyDefinition => ({
        kind: "admin_enum_value", type, value,
      })),
    ),
    ...shopifyQlRegistry.schemas.flatMap((schema): ShopifyDefinition[] => [
      ...schema.metrics.map((field): ShopifyDefinition => ({
        kind: "shopifyql_field", role: "metric", schema, field,
      })),
      ...schema.dimensions.map((field): ShopifyDefinition => ({
        kind: "shopifyql_field", role: "dimension", schema, field,
      })),
      ...schema.matches.map((expression): ShopifyDefinition => ({
        kind: "shopifyql_match", schema, expression,
      })),
      ...schema.matchConditions.flatMap((condition) =>
        condition.fields.map((field): ShopifyDefinition => ({
          kind: "shopifyql_match_field", schema, condition, field,
        })),
      ),
    ]),
    ...shopifyQlRegistry.undocumentedSchemas.map((schema): ShopifyDefinition => ({
      kind: "shopifyql_from_only", schema,
    })),
    ...SHOPIFY_METAFIELD_OWNER_POLICIES.map((policy): ShopifyDefinition => ({
      kind: "metafield_owner_policy", policy,
    })),
  ];
  const pageSize = 250;
  const selected = definitions.slice(offset, offset + pageSize);
  const observedAt = new Date(input.now()).toISOString();
  const records = selected.map((definition) => {
    if (definition.kind === "metafield_owner_policy") {
      return metafieldOwnerPolicyRecord(definition.policy, registry, observedAt);
    }
    if (
      definition.kind === "admin_input_field"
      || definition.kind === "admin_field_argument"
      || definition.kind === "admin_enum_value"
    ) {
      return adminQueryConstructionDefinitionRecord(definition, registry, observedAt);
    }
    if (definition.kind !== "admin") {
      return shopifyQlDefinitionRecord(definition, shopifyQlRegistry, observedAt);
    }
    const { type, field } = definition;
    const schemaPath = `${type.name}.${field.name}`;
    const sourceRecordId = `schema:${schemaPath}`;
    const availability = schemaFieldAvailability(type, field);
    const valueAvailability = FIELD_VALUE_AVAILABILITY.get(schemaPath);
    if (!valueAvailability) throw new Error(`Shopify field availability missing for ${schemaPath}`);
    const requiredScopes = requiredScopesFromAccess(field.requiredAccess ?? type.requiredAccess);
    const fields = {
      id: sourceRecordId,
      definitionKind: "schema_field",
      schemaPath,
      rootField: type.name === registry.roots.query.type ? field.name : null,
      objectType: type.name,
      graphqlId: null,
      parentGraphqlId: null,
      fieldName: field.name,
      fieldType: field.type,
      valueKind: schemaValueKind(field.type, registry.types),
      valueForm: valueAvailability.valueForm,
      observationForm: valueAvailability.observationForm,
      ordinal: 0,
      jsonPointer: null,
      stringValue: null,
      numericValue: null,
      booleanValue: null,
      datetimeValue: null,
      jsonValue: null,
      nodePayload: { type: type.name, field },
      apiVersion: registry.apiVersion,
      requiredScopes,
      requiredAccess: field.requiredAccess ?? type.requiredAccess ?? null,
      fieldArguments: field.args,
      description: field.description,
      protectedDataLevel: field.isProtected
        ? field.protectedSubject ?? field.protectedContent ?? "protected_customer_data"
        : type.isProtected
          ? type.protectedSubject ?? type.protectedContent ?? "protected_customer_data"
          : "none",
      availability: availability.state,
      availabilityReason: availability.reason,
      deprecated: field.isDeprecated,
      deprecationReason: field.deprecationReason ?? null,
      documentationUrl: registry.source.documentationUrl,
      schemaSha256: registry.source.schemaSha256,
      observedAt,
    };
    return rawRecord("shopify_fields", "GraphQLSchemaField", sourceRecordId, fields, fields, observedAt);
  });
  const nextOffset = offset + selected.length;
  if (nextOffset < definitions.length) {
    return {
      records,
      hasMore: true,
      nextCursor: cursor(
        {
          version: 1,
          registryOffset: nextOffset,
          registryComplete: false,
          registrySha256: shopifyDefinitionRegistrySha256(),
        },
        input.cursor?.sourceUpdatedAt,
      ),
    };
  }
  return {
    records,
    hasMore: true,
    nextCursor: cursor(
      {
        version: 1,
        registryComplete: true,
        registrySha256: shopifyDefinitionRegistrySha256(),
        catalogueStream: 0,
        catalogueCursor: null,
      },
      input.cursor?.sourceUpdatedAt,
    ),
  };
}

function metafieldOwnerPolicyRecord(
  policy: ShopifyMetafieldOwnerPolicy,
  registry: ReturnType<typeof loadShopifyAdminSchemaRegistry>,
  observedAt: string,
): RawSourceRecord {
  const schemaPath = `MetafieldOwnerType.${policy.ownerType}`;
  const sourceRecordId = `schema:${schemaPath}`;
  const fields = {
    id: sourceRecordId,
    definitionKind: "metafield_owner_policy",
    schemaPath,
    rootField: "metafieldDefinitions",
    objectType: "MetafieldOwnerType",
    graphqlId: null,
    parentGraphqlId: null,
    fieldName: policy.ownerType,
    fieldType: "MetafieldOwnerType",
    valueKind: "string",
    valueForm: "leaf",
    observationForm: "not_selected",
    ordinal: 0,
    jsonPointer: null,
    stringValue: null,
    numericValue: null,
    booleanValue: null,
    datetimeValue: null,
    jsonValue: null,
    nodePayload: policy,
    apiVersion: registry.apiVersion,
    requiredScopes: policy.requiredScopes,
    requiredAccess: policy.reason,
    fieldArguments: [],
    description: policy.reason,
    protectedDataLevel: policy.ownerType === "CUSTOMER" ? "protected_customer_data" : "none",
    availability: policy.liveCoverage === "default_read_surface"
      ? "generic_metafield_ingested"
      : "definition_only",
    availabilityReason: policy.reason,
    deprecated: false,
    deprecationReason: null,
    documentationUrl: "https://shopify.dev/docs/api/admin-graphql/2026-07/enums/MetafieldOwnerType",
    schemaSha256: registry.source.schemaSha256,
    observedAt,
  };
  return rawRecord("shopify_fields", "MetafieldOwnerPolicy", sourceRecordId, fields, fields, observedAt);
}

function adminQueryConstructionDefinitionRecord(
  definition: Extract<ShopifyDefinition, Readonly<{
    kind: "admin_input_field" | "admin_field_argument" | "admin_enum_value";
  }>>,
  registry: ReturnType<typeof loadShopifyAdminSchemaRegistry>,
  observedAt: string,
): RawSourceRecord {
  const isArgument = definition.kind === "admin_field_argument";
  const isEnum = definition.kind === "admin_enum_value";
  const member = isArgument
    ? definition.argument
    : isEnum
      ? definition.value
      : definition.field;
  const schemaPath = isArgument
    ? `${definition.type.name}.${definition.parentField.name}(${member.name})`
    : `${definition.type.name}.${member.name}`;
  const sourceRecordId = `schema:${definition.kind}:${schemaPath}`;
  const requiredAccess = isArgument
    ? definition.parentField.requiredAccess ?? definition.type.requiredAccess
    : definition.type.requiredAccess;
  const protectedDataLevel = definition.type.isProtected
    ? definition.type.protectedSubject ?? definition.type.protectedContent ?? "protected_customer_data"
    : "none";
  const definitionKind = isArgument
    ? "schema_field_argument"
    : isEnum
      ? "schema_enum_value"
      : "schema_input_field";
  const fieldType = isEnum
    ? definition.type.name
    : (member as ShopifyGraphQLInputValue).type;
  const fields = {
    id: sourceRecordId,
    definitionKind,
    schemaPath,
    rootField: isArgument && definition.type.name === registry.roots.query.type
      ? definition.parentField.name
      : null,
    objectType: definition.type.name,
    graphqlId: null,
    parentGraphqlId: null,
    fieldName: member.name,
    fieldType,
    valueKind: isEnum ? "string" : schemaValueKind(fieldType, registry.types),
    valueForm: "leaf",
    observationForm: "not_selected",
    ordinal: 0,
    jsonPointer: null,
    stringValue: null,
    numericValue: null,
    booleanValue: null,
    datetimeValue: null,
    jsonValue: null,
    nodePayload: definition,
    apiVersion: registry.apiVersion,
    requiredScopes: requiredScopesFromAccess(requiredAccess),
    requiredAccess: requiredAccess ?? null,
    fieldArguments: [],
    description: member.description,
    protectedDataLevel,
    availability: "definition_only",
    availabilityReason: isArgument
      ? "GraphQL field argument definition used to construct a query; it is never a merchant store-value observation."
      : isEnum
        ? "GraphQL enum option definition used to construct or interpret a query; it is never a merchant store-value observation."
        : "GraphQL input-object field definition used to construct a query; it is never a merchant store-value observation.",
    deprecated: member.isDeprecated,
    deprecationReason: member.deprecationReason ?? null,
    documentationUrl: registry.source.documentationUrl,
    schemaSha256: registry.source.schemaSha256,
    observedAt,
  };
  const sourceObjectType = isArgument
    ? "GraphQLFieldArgument"
    : isEnum
      ? "GraphQLEnumValue"
      : "GraphQLInputField";
  return rawRecord("shopify_fields", sourceObjectType, sourceRecordId, fields, fields, observedAt);
}

function shopifyQlDefinitionRecord(
  definition: ShopifyQlDefinition,
  registry: ReturnType<typeof loadShopifyQLSchemaRegistry>,
  observedAt: string,
): RawSourceRecord {
  const common = {
    apiVersion: registry.apiVersion,
    requiredScopes: [registry.access.requiredScope],
    requiredAccess: registry.access.description,
    fieldArguments: [],
    protectedDataLevel: `level_${registry.access.protectedCustomerDataLevel}`,
    availability: "definition_only",
    availabilityReason: registry.access.executionDescription,
    schemaSha256: registry.source.registrySha256,
    observedAt,
  };

  if (definition.kind === "shopifyql_from_only") {
    const schemaPath = `ShopifyQL.${definition.schema.name}`;
    const sourceRecordId = `schema:${schemaPath}`;
    const fields = {
      ...common,
      id: sourceRecordId,
      definitionKind: "shopifyql_from_only_schema",
      schemaPath,
      rootField: definition.schema.name,
      objectType: "ShopifyQLSchema",
      graphqlId: null,
      parentGraphqlId: null,
      fieldName: definition.schema.name,
      fieldType: "FROM_SCHEMA",
      valueKind: "json",
      valueForm: "composite",
      observationForm: "not_selected",
      ordinal: 0,
      jsonPointer: null,
      stringValue: null,
      numericValue: null,
      booleanValue: null,
      datetimeValue: null,
      jsonValue: null,
      nodePayload: definition.schema,
      description: definition.schema.description,
      availability: "from_only_documentation_gap",
      availabilityReason: "Shopify lists this FROM name as queryable but publishes no field-reference page. Albert records the gap and does not fabricate columns.",
      deprecated: false,
      deprecationReason: null,
      documentationUrl: registry.schemaIndex.sourceUrl,
    };
    return rawRecord("shopify_fields", "ShopifyQLFromSchema", sourceRecordId, fields, fields, observedAt);
  }

  if (definition.kind === "shopifyql_field") {
    const schemaPath = `ShopifyQL.${definition.schema.name}.${definition.role}s.${definition.field.name}`;
    const sourceRecordId = `schema:${schemaPath}`;
    const fields = {
      ...common,
      id: sourceRecordId,
      definitionKind: `shopifyql_${definition.role}`,
      schemaPath,
      rootField: definition.schema.name,
      objectType: `ShopifyQL:${definition.schema.name}`,
      graphqlId: null,
      parentGraphqlId: null,
      fieldName: definition.field.name,
      fieldType: definition.field.type,
      valueKind: shopifyQlValueKind(definition.field.type),
      valueForm: "leaf",
      observationForm: "not_selected",
      ordinal: 0,
      jsonPointer: null,
      stringValue: null,
      numericValue: null,
      booleanValue: null,
      datetimeValue: null,
      jsonValue: null,
      nodePayload: { role: definition.role, schema: definition.schema.name, field: definition.field },
      description: definition.field.description,
      deprecated: definition.field.isDeprecated,
      deprecationReason: definition.field.deprecationReason ?? null,
      documentationUrl: definition.schema.sourceUrl,
    };
    return rawRecord("shopify_fields", "ShopifyQLSchemaField", sourceRecordId, fields, fields, observedAt);
  }

  if (definition.kind === "shopifyql_match") {
    const schemaPath = `ShopifyQL.${definition.schema.name}.matches.${definition.expression.name}`;
    const sourceRecordId = `schema:${schemaPath}`;
    const fields = {
      ...common,
      id: sourceRecordId,
      definitionKind: "shopifyql_match_expression",
      schemaPath,
      rootField: definition.schema.name,
      objectType: `ShopifyQL:${definition.schema.name}`,
      graphqlId: null,
      parentGraphqlId: null,
      fieldName: definition.expression.name,
      fieldType: definition.expression.type,
      valueKind: "json",
      valueForm: "composite",
      observationForm: "not_selected",
      ordinal: 0,
      jsonPointer: null,
      stringValue: null,
      numericValue: null,
      booleanValue: null,
      datetimeValue: null,
      jsonValue: null,
      nodePayload: { schema: definition.schema.name, expression: definition.expression },
      description: definition.expression.description,
      deprecated: false,
      deprecationReason: null,
      documentationUrl: definition.schema.sourceUrl,
    };
    return rawRecord("shopify_fields", "ShopifyQLMatchExpression", sourceRecordId, fields, fields, observedAt);
  }

  const schemaPath = `ShopifyQL.${definition.schema.name}.matchConditions.${definition.condition.name}.${definition.field.name}`;
  const sourceRecordId = `schema:${schemaPath}`;
  const fields = {
    ...common,
    id: sourceRecordId,
    definitionKind: "shopifyql_match_condition_field",
    schemaPath,
    rootField: definition.schema.name,
    objectType: definition.condition.name,
    graphqlId: null,
    parentGraphqlId: null,
    fieldName: definition.field.name,
    fieldType: definition.field.type,
    valueKind: shopifyQlValueKind(definition.field.type),
    valueForm: "leaf",
    observationForm: "not_selected",
    ordinal: 0,
    jsonPointer: null,
    stringValue: null,
    numericValue: null,
    booleanValue: null,
    datetimeValue: null,
    jsonValue: null,
    nodePayload: {
      schema: definition.schema.name,
      condition: { name: definition.condition.name, description: definition.condition.description },
      field: definition.field,
    },
    description: definition.field.description,
    deprecated: false,
    deprecationReason: null,
    documentationUrl: definition.schema.sourceUrl,
  };
  return rawRecord("shopify_fields", "ShopifyQLMatchConditionField", sourceRecordId, fields, fields, observedAt);
}

function shopifyQlValueKind(type: string): string {
  if (type === "BOOLEAN") return "boolean";
  if (["DECIMAL", "FLOAT", "INTEGER", "MONEY", "PERCENTAGE"].includes(type)) return "numeric";
  if (type.includes("TIMESTAMP") || type === "DATE") return "datetime";
  return "string";
}

function schemaFieldAvailability(
  type: ShopifyGraphQLType,
  field: ShopifyGraphQLField,
): Readonly<{ state: string; reason: string }> {
  const disposition = FIELD_VALUE_AVAILABILITY.get(`${type.name}.${field.name}`);
  if (!disposition) throw new Error(`Shopify field availability missing for ${type.name}.${field.name}`);
  return { state: disposition.availability, reason: disposition.reason };
}

function requiredScopesFromAccess(requiredAccess: string | undefined): readonly string[] {
  return [...new Set(requiredAccess?.match(/\bread_[a-z0-9_]+\b/gu) ?? [])].sort();
}

function schemaValueKind(
  typeRef: string,
  types: readonly ShopifyGraphQLType[],
): string {
  const name = shopifyGraphQLNamedType(typeRef);
  if (name === "Boolean") return "boolean";
  if (["Int", "Float", "Decimal", "UnsignedInt64"].includes(name)) return "numeric";
  if (["Date", "DateTime", "TimeWithoutTimezone"].includes(name)) return "datetime";
  const kind = types.find((type) => type.name === name)?.kind;
  return kind === "SCALAR" || kind === "ENUM" ? "string" : "json";
}

function recordFor(
  stream: Exclude<ShopifyStreamId, "shopify_fields">,
  node: JsonObject,
  parentId: string | undefined,
  now: () => number,
  context?: Readonly<Record<string, unknown>>,
): RawSourceRecord {
  const typename = string(node.__typename) ?? sourceType(stream);
  const sourceRecordId = string(node.id) ?? `${parentId ?? "shop"}:${hash(node)}`;
  // Shopify's discountNodes connection wraps the timestamps that drive its
  // UPDATED_AT ordering on the nested discount union rather than exposing
  // them on DiscountNode itself. Keep the durable watermark on that vendor
  // timestamp; falling back to ingestion time can advance the next scan past
  // an edit committed while the request is in flight.
  const timestampNode = stream === "shopify_discounts"
    ? object(node.discount) ?? node
    : node;
  // Mutable child collections are versioned by the parent Order observation,
  // not by the child's creation timestamp. Without this override an unchanged
  // retained child would keep its previous typed-staging collection_scan_id;
  // the new completion marker could then misclassify it as absent and retire
  // it. The parent update time is the frozen version of the complete list.
  const collectionUpdatedAt = string(context?.collectionUpdatedAt);
  const sourceUpdatedAt = collectionUpdatedAt && Number.isFinite(Date.parse(collectionUpdatedAt))
    ? new Date(collectionUpdatedAt).toISOString()
    : sourceTimestamp(timestampNode, context?.parent, now);
  const fields = normalizeNode(stream, node, parentId, context, now);
  return rawRecord(stream, typename, sourceRecordId, node, fields, sourceUpdatedAt);
}

function rawRecord(
  stream: ShopifyStreamId,
  sourceObjectType: string,
  sourceRecordId: string,
  payload: unknown,
  fields: Readonly<Record<string, unknown>>,
  sourceUpdatedAt?: string,
): RawSourceRecord {
  const allowed = new Set(SHOPIFY_STREAM_FIELDS[stream].map((field) => field.name));
  const projected = Object.fromEntries(Object.entries(fields).filter(([field]) => allowed.has(field)));
  return {
    sourceObjectType,
    sourceRecordId,
    ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
    payload,
    payloadHash: hash(payload),
    normalized: { schemaVersion: `${SHOPIFY_API_VERSION}.1`, fields: projected, tombstone: false },
  };
}

function normalizeNode(
  stream: Exclude<ShopifyStreamId, "shopify_fields">,
  node: JsonObject,
  parentId?: string,
  context?: Readonly<Record<string, unknown>>,
  now: () => number = Date.now,
): Readonly<Record<string, unknown>> {
  const base = { ...node, rawNode: node };
  switch (stream) {
    case "shopify_shop": return {
      ...base,
      primaryDomainHost: path(node, "primaryDomain", "host"),
      planDisplayName: path(node, "plan", "displayName"),
    };
    case "shopify_locations": return { ...base, active: node.isActive };
    case "shopify_products": return {
      ...base,
      categoryId: path(node, "category", "id"),
      categoryName: path(node, "category", "fullName"),
      seoTitle: path(node, "seo", "title"), seoDescription: path(node, "seo", "description"),
    };
    case "shopify_product_variants": return {
      ...base,
      productId: path(node, "product", "id") ?? parentId,
      categoryId: path(context?.parent, "category", "id"),
      categoryName: path(context?.parent, "category", "fullName"),
    };
    case "shopify_customers": return { ...base, amountSpent: money(node.amountSpent) };
    case "shopify_orders": return normalizeOrder(base);
    case "shopify_order_lines": return {
      ...base,
      orderId: parentId,
      collectionScanId: context?.collectionScanId,
      collectionComplete: false,
      locationId: path(context?.parent, "retailLocation", "id"),
      customerId: path(context?.parent, "customer", "id"),
      channelName: path(context?.parent, "channel", "name"),
      sourceName: path(context?.parent, "sourceName"),
      orderCreatedAt: path(context?.parent, "createdAt"),
      orderProcessedAt: path(context?.parent, "processedAt"),
      orderClosedAt: path(context?.parent, "closedAt"),
      orderCancelledAt: path(context?.parent, "cancelledAt"),
      orderFinancialStatus: path(context?.parent, "displayFinancialStatus"),
      orderFulfillmentStatus: path(context?.parent, "displayFulfillmentStatus"),
      currencyCode: path(context?.parent, "currencyCode"),
      taxesIncluded: path(context?.parent, "taxesIncluded"),
      orderTest: path(context?.parent, "test"),
      productId: path(node, "product", "id"), variantId: path(node, "variant", "id"),
      originalUnitPriceAmount: shopMoney(node.originalUnitPriceSet),
      discountedUnitPriceAmount: shopMoney(node.discountedUnitPriceSet),
      originalTotalAmount: shopMoney(node.originalTotalSet),
      discountedTotalAmount: discountedLineTotal(node),
      totalDiscountAmount: sumMoneyList(node.discountAllocations) ?? shopMoney(node.totalDiscountSet),
      totalTaxAmount: sumMoneyList(node.taxLines),
    };
    case "shopify_transactions": return {
      ...base,
      orderId: parentId, parentTransactionId: path(node, "parentTransaction", "id"),
      collectionScanId: context?.collectionScanId,
      collectionComplete: false,
      locationId: path(context?.parent, "retailLocation", "id"),
      channelName: path(context?.parent, "channel", "name"),
      sourceName: path(context?.parent, "sourceName"),
      amount: shopMoney(node.amountSet), currencyCode: path(node, "amountSet", "shopMoney", "currencyCode"),
      maximumRefundable: money(node.maximumRefundableV2),
    };
    case "shopify_refund_lines": {
      const subtotal = shopMoney(node.subtotalSet);
      const tax = shopMoney(node.totalTaxSet);
      return {
        ...base,
        refundId: node.refundId ?? parentId,
        orderId: node.orderId,
        collectionScanId: context?.collectionScanId,
        collectionComplete: false,
        lineItemId: path(node, "lineItem", "id"), variantId: path(node, "lineItem", "variant", "id"),
        locationId: path(node, "location", "id"),
        orderLocationId: path(context?.parent, "retailLocation", "id"),
        currencyCode: path(context?.parent, "currencyCode"),
        subtotalAmount: subtotal, taxAmount: tax, totalAmount: sumDecimal(subtotal, tax),
      };
    }
    case "shopify_inventory_levels": {
      const quantities = Object.fromEntries((Array.isArray(node.quantities) ? node.quantities : [])
        .map(object).filter((item): item is JsonObject => Boolean(item))
        .map((item) => [String(item.name), item.quantity]));
      return {
        ...base,
        inventoryItemId: parentId, variantId: context?.variantId, locationId: path(node, "location", "id"),
        available: quantities.available, incoming: quantities.incoming, onHand: quantities.on_hand,
        committed: quantities.committed, reserved: quantities.reserved, damaged: quantities.damaged,
        safetyStock: quantities.safety_stock, qualityControl: quantities.quality_control,
      };
    }
    case "shopify_fulfillments": return {
      ...base, orderId: parentId, locationId: path(node, "location", "id"),
      collectionScanId: context?.collectionScanId,
      collectionComplete: false,
      serviceHandle: path(node, "service", "handle"),
    };
    case "shopify_returns": return {
      ...base, orderId: path(node, "order", "id") ?? parentId,
      collectionScanId: context?.collectionScanId,
      collectionComplete: false,
      updatedAt: node.closedAt ?? node.createdAt,
      exchangeLineItemCount: connectionNodeCount(node.exchangeLineItems),
      returnLineItemCount: connectionNodeCount(node.returnLineItems), refundCount: connectionNodeCount(node.refunds),
    };
    case "shopify_discounts": {
      const discount = object(node.discount) ?? {};
      return {
        ...discount, id: node.id, typename: discount.__typename,
        totalSales: money(discount.totalSales), rawNode: node,
      };
    }
    case "shopify_metafield_definitions": return {
      ...base,
      typeName: path(node, "type", "name"),
      typeCategory: path(node, "type", "category"),
      adminAccess: path(node, "access", "admin"),
      storefrontAccess: path(node, "access", "storefront"),
      customerAccountAccess: path(node, "access", "customerAccount"),
      capabilities: node.capabilities,
      constraints: node.constraints,
      validations: node.validations,
      observedAt: new Date(now()).toISOString(),
    };
    case "shopify_metafield_values": {
      const typedValue = metafieldTypedValue(node.type, node.value, node.jsonValue);
      return {
        ...base,
        definitionId: path(node, "definition", "id") ?? parentId,
        ownerId: path(node, "owner", "id"),
        ownerGraphqlType: path(node, "owner", "__typename"),
        metafieldType: node.type,
        ...typedValue,
      };
    }
  }
}

function metafieldTypedValue(
  type: unknown,
  value: unknown,
  jsonValue: unknown,
): Readonly<Record<string, unknown>> {
  const typeName = string(type)?.toLowerCase() ?? "";
  const text = string(value);
  if (typeName === "boolean" && (text === "true" || text === "false")) {
    return { booleanValue: text === "true" };
  }
  if (["number_integer", "number_decimal"].includes(typeName) && text !== null && /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(text)) {
    return { numericValue: text };
  }
  if (["date", "date_time"].includes(typeName) && text !== null && Number.isFinite(Date.parse(text))) {
    return { datetimeValue: new Date(text).toISOString() };
  }
  return { jsonValue };
}

function normalizeOrder(node: JsonObject): Readonly<Record<string, unknown>> {
  return {
    ...node,
    customerId: path(node, "customer", "id"), locationId: path(node, "retailLocation", "id"),
    appId: path(node, "app", "id"), channelName: path(node, "channel", "name"),
    subtotalAmount: shopMoney(node.subtotalPriceSet), totalDiscountsAmount: shopMoney(node.totalDiscountsSet),
    totalShippingAmount: shopMoney(node.totalShippingPriceSet), totalTaxAmount: shopMoney(node.totalTaxSet),
    totalRefundedAmount: shopMoney(node.totalRefundedSet), totalOutstandingAmount: shopMoney(node.totalOutstandingSet),
    totalPriceAmount: shopMoney(node.totalPriceSet), currentSubtotalAmount: shopMoney(node.currentSubtotalPriceSet),
    currentTotalDiscountsAmount: shopMoney(node.currentTotalDiscountsSet), currentTotalTaxAmount: shopMoney(node.currentTotalTaxSet),
    currentTotalPriceAmount: shopMoney(node.currentTotalPriceSet),
  };
}

function searchFilter(
  stream: ShopifyStreamId,
  mode: "initial" | "incremental" | "reconciliation",
  range: SyncRange | undefined,
  cursorValue: SyncCursor | undefined,
): string | null {
  if (!supportsSearch(stream)) return null;
  if (mode === "incremental" && cursorValue?.sourceUpdatedAt) {
    return `updated_at:>='${shopifySearchInstant(cursorValue.sourceUpdatedAt)}'`;
  }
  // Initial snapshot streams must enumerate the whole current resource set.
  // Applying the coordinator's recent commerce window to products/customers
  // would silently turn a declared complete snapshot into a 31-day sample.
  if (range && (mode === "reconciliation" || historyStream(stream))) {
    return `updated_at:>='${shopifySearchInstant(range.from)}' updated_at:<='${shopifySearchInstant(range.to)}'`;
  }
  return null;
}

function shopifySearchInstant(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new ConnectorError("CURSOR_INVALID", "The Shopify time boundary is not a valid ISO instant.");
  }
  return new Date(timestamp).toISOString();
}

function historyStream(stream: ShopifyStreamId): boolean {
  return [
    "shopify_orders", "shopify_order_lines", "shopify_transactions",
    "shopify_refund_lines", "shopify_fulfillments", "shopify_returns",
  ].includes(stream);
}

function supportsSearch(stream: ShopifyStreamId): boolean {
  return [
    "shopify_products", "shopify_product_variants", "shopify_customers", "shopify_orders",
    "shopify_order_lines", "shopify_transactions", "shopify_refund_lines", "shopify_fulfillments",
    "shopify_returns", "shopify_discounts",
  ].includes(stream);
}

function directPageSize(stream: ShopifyStreamId): number {
  if (stream === "shopify_orders") return 50;
  if (stream === "shopify_discounts") return 50;
  return 100;
}

function childConnectionName(stream: ShopifyStreamId): string {
  if (stream === "shopify_product_variants") return "variants";
  if (stream === "shopify_order_lines") return "lineItems";
  if (stream === "shopify_transactions") return "transactions";
  if (stream === "shopify_inventory_levels") return "inventoryLevels";
  if (stream === "shopify_fulfillments") return "fulfillments";
  if (stream === "shopify_returns") return "returns";
  throw new ConnectorError("CONFIGURATION_INVALID", `No Shopify child connection for ${stream}.`);
}

function sourceType(stream: ShopifyStreamId): string {
  return stream.replace(/^shopify_/u, "").split("_").map((part) =>
    part.charAt(0).toUpperCase() + part.slice(1)
  ).join("");
}

function terminalPage(
  input: Parameters<typeof extractShopifyPage>[0],
  records: readonly RawSourceRecord[],
  now: () => number,
  watermark?: string,
): SyncPage {
  const state = decodeCursor(input.cursor);
  const subject = input.stream === "shopify_fields"
    ? null
    : deletionEventSubject(input.stream as PromotedShopifyStream);
  if (subject && state.deletionContinuity === "prior_generation_unproven") {
    throw deletionContinuityUnavailable(
      input.stream as PromotedShopifyStream,
      "shopify_deletion_continuity_unproven",
      "Shopify deletion continuity cannot be proven for the prior connection generation. Disconnect the store, wait for verified local deletion to complete, reconnect it, and explicitly start ingestion.",
    );
  }
  if (
    subject && input.mode === "incremental" &&
    !state.deletionEventWatermark
  ) {
    throw deletionContinuityUnavailable(
      input.stream as PromotedShopifyStream,
      "shopify_deletion_watermark_missing",
      "Shopify deletion continuity is missing from this legacy cursor. Disconnect the store, wait for verified local deletion to complete, reconnect it, and explicitly start ingestion.",
    );
  }
  const shouldPollDeletionEvents = subject !== null && !state.skipDeletionEventPoll && (
    input.mode !== "reconciliation" || input.reconciliationPhase === "late_edits"
  );
  if (shouldPollDeletionEvents) {
    const upper = input.mode === "reconciliation"
      ? input.range?.to
      : new Date(now()).toISOString();
    const resourceWatermark = watermark ?? input.cursor?.sourceUpdatedAt ?? upper;
    const lower = input.mode === "initial"
      // The manual activation job captures its authorization boundary in
      // range.to. Events before that user action are not needed to reconcile
      // the point-in-time snapshot taken after first activation. A verified
      // prior-generation watermark instead catches deletes while disconnected.
      ? state.deletionEventWatermark ?? input.range?.to
      : input.mode === "reconciliation"
        ? input.range?.from
        : state.deletionEventWatermark;
    if (!lower || !upper) {
      throw new ConnectorError(
        "CONFIGURATION_INVALID",
        "Shopify deletion-event polling requires a closed activation or reconciliation window.",
      );
    }
    // Validate and freeze the exact result set before Shopify issues an opaque
    // cursor. Resource and deletion watermarks deliberately never share a
    // field: committing one cannot skip the other after a crash.
    deletionEventFilter(subject.subjectType, lower, upper);
    if (Date.parse(lower) < Date.parse(upper) - 365 * 86_400_000) {
      throw deletionContinuityUnavailable(
        input.stream as PromotedShopifyStream,
        "shopify_deletion_retention_gap",
        "Shopify retains events for only one year, so this deletion gap cannot be proven complete. Disconnect the store, wait for verified local deletion to complete, reconnect it, and explicitly start ingestion.",
      );
    }
    return {
      records,
      hasMore: true,
      nextCursor: cursor({
        version: 1,
        deletionEventPhase: true,
        deletionEventAfter: null,
        deletionEventFrom: lower,
        deletionEventTo: upper,
        ...(state.deletionEventWatermark
          ? { deletionEventWatermark: state.deletionEventWatermark }
          : {}),
        ...(resourceWatermark ? { resourceWatermark } : {}),
      }, input.cursor?.sourceUpdatedAt),
    };
  }
  return completedPage(
    input,
    records,
    now,
    watermark,
    state.deletionEventWatermark
      ? { version: 1, deletionEventWatermark: state.deletionEventWatermark }
      : { version: 1 },
  );
}

function completedPage(
  input: Parameters<typeof extractShopifyPage>[0],
  records: readonly RawSourceRecord[],
  now: () => number,
  watermark?: string,
  finalState: CursorState = { version: 1 },
): SyncPage {
  const nextCursor = cursor(
    input.stream === "shopify_fields"
      ? {
          version: 1,
          registryComplete: true,
          registrySha256: shopifyDefinitionRegistrySha256(),
          catalogueStream: 0,
          catalogueCursor: null,
        }
      : finalState,
    watermark ?? latestUpdate(records),
  );
  if (input.mode !== "initial") return { records, hasMore: false, nextCursor };
  const strategy = input.stream === "shopify_shop" || [
    "shopify_locations", "shopify_products", "shopify_product_variants", "shopify_customers",
    "shopify_inventory_levels", "shopify_discounts", "shopify_metafield_definitions",
    "shopify_metafield_values", "shopify_fields",
  ].includes(input.stream) ? "snapshot" : "history";
  if (strategy === "snapshot") {
    const at = new Date(now()).toISOString();
    return {
      records, hasMore: false, nextCursor,
      coverage: { boundaryKind: "snapshot_at", lowerBound: at, verification: "point_in_time", detail: `Complete ${SHOPIFY_API_VERSION} snapshot for fields available to this installation.` },
    };
  }
  const lowerBound = input.readAllOrders
    ? input.range?.from ?? "1970-01-01T00:00:00.000Z"
    : new Date(now() - 60 * 86_400_000).toISOString();
  return {
    records, hasMore: false, nextCursor,
    coverage: input.readAllOrders
      ? { boundaryKind: "verified_oldest", lowerBound, verification: "exhaustive_vendor_scan", detail: "Order history scanned to the requested lower boundary with read_all_orders granted." }
      : { boundaryKind: "vendor_retention", lowerBound, verification: "vendor_reported", detail: "Shopify limits this installation to the latest 60 days because read_all_orders is not granted." },
  };
}

export function shopifyDefinitionRegistrySha256(): string {
  const admin = loadShopifyAdminSchemaRegistry().source.schemaSha256;
  const shopifyQl = loadShopifyQLSchemaRegistry().source.registrySha256;
  return createHash("sha256")
    .update(`${admin}:${shopifyQl}:field-value-availability-v1:${JSON.stringify(SHOPIFY_METAFIELD_OWNER_POLICIES)}`, "utf8")
    .digest("hex");
}

function connectionValue(raw: unknown, label: string): Readonly<{
  edges: readonly Readonly<{ cursor: string | null; node: JsonObject }>[];
  hasNextPage: boolean;
  endCursor: string | null;
}> {
  const value = object(raw);
  if (!value) throw new ConnectorError("REMOTE_RESPONSE_INVALID", `Shopify omitted ${label}.`);
  const pageInfo = object(value.pageInfo);
  const edges = (Array.isArray(value.edges) ? value.edges : []).map((edgeValue) => {
    const edge = object(edgeValue);
    const node = object(edge?.node);
    if (!node) throw new ConnectorError("REMOTE_RESPONSE_INVALID", `Shopify returned an invalid ${label} edge.`);
    return { cursor: string(edge?.cursor), node };
  });
  if (!pageInfo || typeof pageInfo.hasNextPage !== "boolean") {
    // Some child selections use nodes only and are never paginated by this helper.
    if (Array.isArray(value.nodes)) {
      return {
        edges: value.nodes.map((node) => ({ cursor: null, node: object(node) ?? {} })),
        hasNextPage: false,
        endCursor: null,
      };
    }
    throw new ConnectorError("REMOTE_RESPONSE_INVALID", `Shopify returned invalid ${label} pageInfo.`);
  }
  return { edges, hasNextPage: pageInfo.hasNextPage, endCursor: string(pageInfo.endCursor) };
}

function decodeCursor(cursorValue: SyncCursor | undefined): CursorState {
  if (!cursorValue?.value) return { version: 1 };
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(cursorValue.value));
    if (parsed.success) return parsed.data;
  } catch {
    // handled by the fail-closed error below
  }
  throw new ConnectorError("CURSOR_INVALID", "The Shopify cursor is malformed or belongs to another connector version.");
}

function cursor(state: CursorState, sourceUpdatedAt?: string): SyncCursor {
  return { value: JSON.stringify(state), ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}) };
}

/**
 * Shopify opaque cursors are valid only for the frozen resource result set,
 * while destroy events use a second result set and watermark. Persist both
 * watermarks through every resource page without advancing the public source
 * watermark until the event phase has also completed.
 */
function resourcePageState(
  state: CursorState,
  pagination: Partial<CursorState>,
  resourceWatermark?: string,
): CursorState {
  return {
    version: 1,
    ...pagination,
    ...(state.deletionEventWatermark
      ? { deletionEventWatermark: state.deletionEventWatermark }
      : {}),
    ...(state.deletionContinuity
      ? { deletionContinuity: state.deletionContinuity }
      : {}),
    ...(state.skipDeletionEventPoll ? { skipDeletionEventPoll: true as const } : {}),
    ...(resourceWatermark ? { resourceWatermark } : {}),
  };
}

function blocked(records: readonly RawSourceRecord[], detail: string): SyncPage {
  return { records, hasMore: true, nextCursor: null, paginationBlock: { code: "pagination_not_advancing", detail } };
}

function rejectIncompleteNestedSelection(stream: PromotedShopifyStream, detail: string): never {
  throw new ConnectorError("REMOTE_RESPONSE_INVALID", detail, {
    retryable: false,
    details: { stream, reason: "nested_selection_capped" },
  });
}

function latestUpdate(records: readonly RawSourceRecord[], seed?: string): string | undefined {
  return records.reduce<string | undefined>((latest, record) => {
    if (!record.sourceUpdatedAt) return latest;
    return !latest || Date.parse(record.sourceUpdatedAt) > Date.parse(latest) ? record.sourceUpdatedAt : latest;
  }, seed);
}

function sourceTimestamp(node: JsonObject, parent: unknown, now: () => number): string {
  const parentNode = object(parent);
  for (const candidate of [
    node.updatedAt,
    node.processedAt,
    node.createdAt,
    node.closedAt,
    node.refundedAt,
    parentNode?.updatedAt,
    parentNode?.processedAt,
    parentNode?.createdAt,
  ]) {
    if (typeof candidate === "string" && Number.isFinite(Date.parse(candidate))) return new Date(candidate).toISOString();
  }
  return new Date(now()).toISOString();
}

function connectionNodeCount(value: unknown): number {
  const record = object(value);
  return Array.isArray(record?.nodes) ? record.nodes.length : 0;
}

function connectionSelectedCount(value: unknown): number {
  const record = object(value);
  if (Array.isArray(record?.nodes)) return record.nodes.length;
  if (Array.isArray(record?.edges)) return record.edges.length;
  return 0;
}

function shopMoney(value: unknown): unknown {
  return money(pathObject(value, "shopMoney"));
}

function money(value: unknown): unknown {
  const record = object(value);
  return record?.amount ?? null;
}

function sumMoneyList(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  return value.reduce<string | null>((total, item) => {
    const entry = object(item);
    // TaxLine exposes priceSet while DiscountAllocation exposes
    // allocatedAmountSet. Supporting both prevents order-level/code/app
    // discounts from disappearing from line economics.
    const amountSet = entry?.priceSet ?? entry?.allocatedAmountSet;
    return sumDecimal(total, shopMoney(amountSet));
  }, null);
}

function sumDecimal(left: unknown, right: unknown): string | null {
  const l = decimalParts(left);
  const r = decimalParts(right);
  if (!l && !r) return null;
  const scale = Math.max(l?.scale ?? 0, r?.scale ?? 0);
  const total = (l ? l.integer * 10n ** BigInt(scale - l.scale) : 0n)
    + (r ? r.integer * 10n ** BigInt(scale - r.scale) : 0n);
  const negative = total < 0n;
  const absolute = (negative ? -total : total).toString().padStart(scale + 1, "0");
  return `${negative ? "-" : ""}${scale ? `${absolute.slice(0, -scale)}.${absolute.slice(-scale)}` : absolute}`;
}

function discountedLineTotal(node: JsonObject): string | null {
  const allocations = sumMoneyList(node.discountAllocations);
  const original = shopMoney(node.originalTotalSet);
  return allocations === null ? stringOrNull(shopMoney(node.discountedTotalSet)) : subtractDecimal(original, allocations);
}

function subtractDecimal(left: unknown, right: unknown): string | null {
  const r = decimalParts(right);
  if (!r) return stringOrNull(left);
  const signed = `${r.integer < 0n ? "" : "-"}${(r.integer < 0n ? -r.integer : r.integer).toString()}${r.scale ? `e-${r.scale}` : ""}`;
  return sumDecimal(left, decimalFromExponent(signed));
}

function decimalFromExponent(value: string): string {
  const match = /^(-?)(\d+)(?:e-(\d+))?$/u.exec(value);
  if (!match) return value;
  const scale = Number(match[3] ?? 0);
  const digits = match[2]!.padStart(scale + 1, "0");
  return `${match[1]}${scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits}`;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" || typeof value === "number" ? String(value) : null;
}

function decimalParts(value: unknown): { integer: bigint; scale: number } | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(String(value));
  if (!match) return null;
  const fraction = match[3] ?? "";
  return { integer: BigInt(`${match[1]}${match[2]}${fraction}`), scale: fraction.length };
}

function path(value: unknown, ...segments: string[]): unknown {
  let current = value;
  for (const segment of segments) {
    const record = object(current);
    if (!record) return null;
    current = record[segment];
  }
  return current ?? null;
}

function pathObject(value: unknown, ...segments: string[]): JsonObject | null {
  return object(path(value, ...segments));
}

function object(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value) ?? "null", "utf8").digest("hex");
}
