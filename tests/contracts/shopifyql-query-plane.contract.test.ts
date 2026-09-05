import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  compileShopifyQLQuery,
  searchShopifyQLCatalogue,
  ShopifyQLPolicyError,
} from "../../connectors/shopify/shopifyql-query.js";
import {
  auditShopifyQLPrivacyRegistry,
  classifyShopifyQLPrivacyField,
  classifyShopifyQLPrivacyMatchField,
  SHOPIFYQL_EXPLICIT_DENIED_DIMENSION_NAMES,
  SHOPIFYQL_PRIVACY_POLICY_VERSION,
  SHOPIFYQL_PRIVACY_REVIEWED_CLASSIFICATION_SHA256,
  SHOPIFYQL_PRIVACY_REVIEWED_COUNTS,
  SHOPIFYQL_PRIVACY_REVIEWED_REGISTRY_SHA256,
} from "../../connectors/shopify/shopifyql-privacy-policy.js";
import { loadShopifyQLSchemaRegistry } from "../../connectors/shopify/shopifyql-registry.js";
import { signInternalRequest } from "../../packages/security/src/index.js";
import {
  shopifyQLCatalogueInvocationSchema,
  shopifyQLInvocationSchema,
  shopifyQLQueryInputSchema,
} from "../../packages/shopifyql/src/contract.js";
import { ShopifyQLWorkerHttpHandler } from "../../services/sync-workers/src/shopifyql-http.js";
import { ShopifyQLRuntimeStore } from "../../services/sync-workers/src/shopifyql-store.js";

const IDS = Object.freeze({
  request: "01J00000000000000000000001",
  tenant: "01J00000000000000000000002",
  otherTenant: "01J00000000000000000000003",
  conversation: "01J00000000000000000000004",
  turn: "01J00000000000000000000005",
  connection: "01J00000000000000000000006",
  actor: "00000000-0000-4000-8000-000000000001",
});

function base(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    topic: "Official report contract",
    schema: "sales",
    fields: ["total_sales"],
    timeWindow: { since: "2026-07-01", until: "2026-07-31" },
    limit: 100,
    ...overrides,
  };
}

function policyCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof ShopifyQLPolicyError);
    return error.code;
  }
  assert.fail("expected ShopifyQL policy failure");
}

test("all 2,327 official static fields are classified and every allowed field is executable", () => {
  let allowed = 0;
  let denied = 0;
  for (const schema of loadShopifyQLSchemaRegistry().schemas) {
    for (const metric of schema.metrics) {
      assert.equal(classifyShopifyQLPrivacyField({ kind: "metric", ...metric }).disposition, "allowed");
      compileShopifyQLQuery(base({ schema: schema.name, fields: [metric.name], limit: 1 }));
      allowed += 1;
    }
    for (const dimension of schema.dimensions) {
      const input = base({
        schema: schema.name,
        fields: [dimension.name],
        groupBy: [dimension.name],
        limit: 1,
      });
      const privacy = classifyShopifyQLPrivacyField({ kind: "dimension", ...dimension });
      if (privacy.disposition === "allowed") {
        compileShopifyQLQuery(input);
        allowed += 1;
      } else {
        assert.equal(policyCode(() => compileShopifyQLQuery(input)), "field_protected");
        denied += 1;
      }
    }
  }
  assert.deepEqual(
    { allowed, denied },
    {
      allowed: SHOPIFYQL_PRIVACY_REVIEWED_COUNTS.allowedStaticFields,
      denied: SHOPIFYQL_PRIVACY_REVIEWED_COUNTS.deniedStaticFields,
    },
  );
});

test("the privacy review is exact, exhaustive, and pinned to the official registry digest", () => {
  const registry = loadShopifyQLSchemaRegistry();
  assert.equal(registry.source.registrySha256, SHOPIFYQL_PRIVACY_REVIEWED_REGISTRY_SHA256);
  assert.equal(SHOPIFYQL_PRIVACY_POLICY_VERSION, "2026-07-direct-identifiers-v1");
  assert.deepEqual(auditShopifyQLPrivacyRegistry(registry), {
    classificationSha256: SHOPIFYQL_PRIVACY_REVIEWED_CLASSIFICATION_SHA256,
    counts: SHOPIFYQL_PRIVACY_REVIEWED_COUNTS,
    reviewed: true,
  });

  const metrics = registry.schemas.flatMap(({ metrics }) => metrics);
  const dimensions = registry.schemas.flatMap(({ dimensions }) => dimensions);
  const matchFields = registry.schemas.flatMap(({ matchConditions }) =>
    matchConditions.flatMap(({ fields }) => fields)
  );
  const allowedMetrics = metrics.filter((field) =>
    classifyShopifyQLPrivacyField({ kind: "metric", ...field }).disposition === "allowed"
  );
  const deniedMetrics = metrics.filter((field) =>
    classifyShopifyQLPrivacyField({ kind: "metric", ...field }).disposition === "denied"
  );
  const allowedDimensions = dimensions.filter((field) =>
    classifyShopifyQLPrivacyField({ kind: "dimension", ...field }).disposition === "allowed"
  );
  const deniedDimensions = dimensions.filter((field) =>
    classifyShopifyQLPrivacyField({ kind: "dimension", ...field }).disposition === "denied"
  );
  const allowedMatchConditionFields = matchFields.filter((field) =>
    classifyShopifyQLPrivacyMatchField(field).disposition === "allowed"
  );
  const deniedMatchConditionFields = matchFields.filter((field) =>
    classifyShopifyQLPrivacyMatchField(field).disposition === "denied"
  );

  assert.deepEqual({
    staticFields: metrics.length + dimensions.length,
    allowedStaticFields: allowedMetrics.length + allowedDimensions.length,
    deniedStaticFields: deniedMetrics.length + deniedDimensions.length,
    allowedMetrics: allowedMetrics.length,
    deniedMetrics: deniedMetrics.length,
    allowedDimensions: allowedDimensions.length,
    deniedDimensions: deniedDimensions.length,
    matchConditionFields: matchFields.length,
    allowedMatchConditionFields: allowedMatchConditionFields.length,
    deniedMatchConditionFields: deniedMatchConditionFields.length,
    deniedQueryableMetafieldPatterns: registry.schemas.flatMap(
      ({ queryableMetafieldPatterns }) => queryableMetafieldPatterns,
    ).length,
  }, SHOPIFYQL_PRIVACY_REVIEWED_COUNTS);

  const explicitNames = Object.values(SHOPIFYQL_EXPLICIT_DENIED_DIMENSION_NAMES).flat();
  assert.equal(new Set(explicitNames).size, explicitNames.length, "review list contains duplicate names");
  assert.ok(explicitNames.every((name) => dimensions.some((field) => field.name === name)));
  assert.ok(dimensions.filter(({ type }) => type === "IDENTITY").every((field) =>
    classifyShopifyQLPrivacyField({ kind: "dimension", ...field }).disposition === "denied"
  ));
  assert.ok(matchFields.filter(({ type }) => type === "IDENTITY").every((field) =>
    classifyShopifyQLPrivacyMatchField(field).disposition === "denied"
  ));
  assert.ok(dimensions.filter(({ type }) =>
    ["MINUTE_TIMESTAMP", "SECOND_TIMESTAMP", "TIMESTAMP"].includes(type)
  ).every((field) =>
    classifyShopifyQLPrivacyField({ kind: "dimension", ...field }).disposition === "denied"
  ));
  assert.ok([
    "abandoned_checkout_date",
    "customer_account_status",
    "customer_added_date",
    "customer_amount_spent",
    "customer_email_subscription_status",
    "customer_first_order_date",
    "customer_language",
    "customer_last_order_date",
    "customer_number_of_orders",
    "customer_sms_subscription_status",
    "first_order_date",
    "last_order_date",
  ].every((name) => dimensions.filter((field) => field.name === name).every((field) =>
    classifyShopifyQLPrivacyField({ kind: "dimension", ...field }).disposition === "denied"
  )));
});

test("protected fields fail closed in every compiler clause and metafields never execute", () => {
  const selected = base({
    schema: "customers",
    fields: ["customer_email"],
    groupBy: ["customer_email"],
  });
  assert.equal(policyCode(() => compileShopifyQLQuery(selected)), "field_protected");
  assert.equal(policyCode(() => compileShopifyQLQuery(base({
    schema: "customers", fields: ["total_number_of_orders"], groupBy: ["customer_email"],
  }))), "field_protected");
  assert.equal(policyCode(() => compileShopifyQLQuery(base({
    schema: "customers", fields: ["total_number_of_orders"], timeseries: "customer_email",
  }))), "query_ir_invalid");
  assert.equal(policyCode(() => compileShopifyQLQuery(base({
    schema: "customers",
    fields: ["total_number_of_orders"],
    where: [{ field: "customer_email", operator: "equals", values: ["customer@example.com"] }],
  }))), "field_protected");
  assert.equal(policyCode(() => compileShopifyQLQuery(base({
    schema: "store_credit_transactions",
    fields: ["debited_store_credit_value"],
    groupBy: ["customer_email"],
    having: [{ field: "customer_email", operator: "equals", values: ["customer@example.com"] }],
  }))), "field_protected");
  assert.equal(policyCode(() => compileShopifyQLQuery(base({
    schema: "store_credit_transactions",
    fields: ["customer_id"],
    groupBy: ["customer_id"],
    orderBy: [{ field: "customer_id", direction: "asc" }],
  }))), "field_protected");
  assert.equal(policyCode(() => compileShopifyQLQuery(base({
    schema: "sales",
    matches: [{
      expression: "customer.products_purchased",
      operator: "matches",
      conditions: [{ field: "id", operator: "equals", values: [123] }],
    }],
  }))), "match_condition_protected");
  assert.equal(policyCode(() => compileShopifyQLQuery(base({
    schema: "customers",
    fields: ["customer.metafields.profile.email"],
    groupBy: ["customer.metafields.profile.email"],
  }))), "field_protected");
});

test("catalogue search preserves protected definitions and marks them non-executable", () => {
  const result = searchShopifyQLCatalogue({
    schema: "customers",
    query: "customer email address",
    limit: 30,
  }) as {
    fields: readonly Readonly<Record<string, unknown>>[];
    privacyPolicy: Readonly<Record<string, unknown>>;
  };
  const customerEmail = result.fields.find(({ name }) => name === "customer_email");
  assert.ok(customerEmail);
  assert.equal(customerEmail.description, "Email address of the customer");
  assert.deepEqual(customerEmail.privacy, {
    disposition: "denied",
    reason: "natural_person_or_customer_identifier",
    explanation: "The value can directly name or contact a customer, staff member, or customer company.",
  });
  assert.deepEqual(result.privacyPolicy.reviewedCounts, SHOPIFYQL_PRIVACY_REVIEWED_COUNTS);
});

test("every one of 2,327 ShopifyQL fields is deterministically discoverable with its privacy decision", () => {
  const registry = loadShopifyQLSchemaRegistry();
  let discovered = 0;
  for (const schema of registry.schemas) {
    for (const [kind, fields] of [
      ["metric", schema.metrics],
      ["dimension", schema.dimensions],
    ] as const) {
      for (const field of fields) {
        const qualifiedName = `${schema.name}.${field.name}`;
        const result = searchShopifyQLCatalogue({
          query: qualifiedName,
          schema: schema.name,
          limit: 1,
        }) as {
          fields: readonly Readonly<{
            schema: string;
            name: string;
            kind: "metric" | "dimension";
            privacy: ReturnType<typeof classifyShopifyQLPrivacyField>;
          }>[];
        };
        assert.deepEqual(result.fields[0], {
          schema: schema.name,
          name: field.name,
          kind,
          type: field.type,
          description: field.description,
          formula: field.formula ?? null,
          deprecated: field.isDeprecated,
          deprecationReason: field.deprecationReason ?? null,
          privacy: classifyShopifyQLPrivacyField({ kind, ...field }),
        }, `exact ShopifyQL field omitted ${qualifiedName}`);
        discovered += 1;
      }
    }
  }
  assert.equal(discovered, 2_327);
});

test("the golden report uses exact registry names, typed literals and generated timeseries order", () => {
  const compiled = compileShopifyQLQuery(base({
    topic: "Daily online-store sales",
    where: [{ field: "sales_channel", operator: "equals", values: ["Online Store"] }],
    timeseries: "day",
    modifiers: ["totals"],
    orderBy: [{ field: "day", direction: "asc" }],
  }));
  assert.equal(compiled.registrySha256, "54670253f05752b8a1123de2d373d16e42d0003e9aa7b93ac60027859d050bdd");
  assert.equal(compiled.query, `FROM sales
SHOW total_sales
WHERE (sales_channel = 'Online Store')
TIMESERIES day
WITH TOTALS
SINCE 2026-07-01
UNTIL 2026-07-31
ORDER BY day ASC
LIMIT 100`);
});

test("MATCHES parameters are unique, comma-separated, registry-typed and dates are unquoted", () => {
  const compiled = compileShopifyQLQuery(base({
    schema: "customers",
    fields: ["total_number_of_orders"],
    matches: [{
      expression: "orders_placed",
      operator: "matches",
      conditions: [
        { field: "date", operator: "greater_than", values: ["2026-01-01"] },
        { field: "count", operator: "greater_than", values: [1] },
      ],
    }],
  }));
  assert.match(compiled.query, /orders_placed MATCHES \(date > 2026-01-01, count > 1\)/u);
  assert.doesNotMatch(compiled.query, /MATCHES \([^)]*\b(?:AND|OR)\b/u);
  assert.equal(policyCode(() => compileShopifyQLQuery(base({
    schema: "customers",
    fields: ["total_number_of_orders"],
    matches: [{
      expression: "orders_placed",
      operator: "matches",
      conditions: [
        { field: "date", operator: "greater_than", values: ["2026-01-01"] },
        { field: "date", operator: "less_than", values: ["2026-02-01"] },
      ],
    }],
  }))), "match_condition_duplicate");
});

test("within-distance requirements are enforced and precise coordinates fail closed", () => {
  assert.equal(policyCode(() => compileShopifyQLQuery(base({
    schema: "customers",
    fields: ["total_number_of_orders"],
    matches: [{
      expression: "within_distance",
      operator: "matches",
      conditions: [{ field: "distance_km", operator: "less_than", values: [10] }],
    }],
  }))), "match_required_conditions_missing");

  assert.equal(policyCode(() => compileShopifyQLQuery(base({
    schema: "customers",
    fields: ["total_number_of_orders"],
    matches: [{
      expression: "within_distance",
      operator: "matches",
      conditions: [
        { field: "coordinates", operator: "equals", values: ["-37.8136,144.9631"] },
        { field: "distance_km", operator: "less_than_or_equal", values: [10] },
      ],
    }],
  }))), "match_condition_protected");
});

test("compiler fails closed on fabricated grammar, unsafe types and aggregation mistakes", () => {
  assert.equal(policyCode(() => compileShopifyQLQuery(base({ schema: "unknown" }))), "schema_unknown");
  assert.equal(policyCode(() => compileShopifyQLQuery(base({ schema: "shopify_tax_ca_transactions" }))), "schema_fields_undocumented");
  assert.equal(policyCode(() => compileShopifyQLQuery(base({ fields: ["not_a_field"] }))), "field_unknown");
  assert.equal(policyCode(() => compileShopifyQLQuery(base({ fields: ["sales_channel"] }))), "show_dimension_not_grouped");
  assert.equal(policyCode(() => compileShopifyQLQuery(base({
    where: [{ field: "day", operator: "equals", values: ["2026-02-30"] }],
  }))), "time_window_invalid");
  assert.equal(policyCode(() => compileShopifyQLQuery(base({
    where: [{ field: "sales_channel", operator: "equals", values: [12] }],
  }))), "literal_type_invalid");
  assert.equal(policyCode(() => compileShopifyQLQuery(base({
    having: [{ field: "total_sales", operator: "greater_than", values: [10] }],
  }))), "having_requires_aggregation");
  assert.equal(policyCode(() => compileShopifyQLQuery(base({
    timeWindow: { since: "2025-01-01", until: "2026-07-31" },
  }))), "time_window_too_wide");
});

test("the strict tool contract admits neither raw query languages nor elevated roles", () => {
  assert.equal(shopifyQLQueryInputSchema.safeParse({ ...base(), query: "FROM sales; DROP TABLE x" }).success, false);
  assert.equal(shopifyQLQueryInputSchema.safeParse({ ...base(), graphql: "query { shop { id } }" }).success, false);
  assert.equal(shopifyQLQueryInputSchema.safeParse({ ...base(), where: [{
    field: "sales_channel", operator: "equals", values: ["x' OR 1=1 --"], raw: "SQL",
  }] }).success, false);
  for (const role of ["bookkeeper", "internal_operator", "viewer"]) {
    assert.equal(shopifyQLInvocationSchema.safeParse({
      requestId: IDS.request,
      tenantId: IDS.tenant,
      actorId: IDS.actor,
      role,
      conversationId: IDS.conversation,
      turnId: IDS.turn,
      input: base(),
    }).success, false);
  }
  const escaped = compileShopifyQLQuery(base({
    where: [{ field: "sales_channel", operator: "equals", values: ["O'Reilly"] }],
  }));
  assert.match(escaped.query, /sales_channel = 'O''Reilly'/u);
});

type FakeResult = { rows: Record<string, unknown>[] };

class RejectingMembershipDb {
  readonly calls: string[] = [];
  async transaction<T>(work: (client: this) => Promise<T>): Promise<T> { return work(this); }
  async query(sql: string): Promise<FakeResult> {
    this.calls.push(sql);
    if (sql.includes("from control_plane.memberships")) return { rows: [] };
    throw new Error("authorization must stop after membership denial");
  }
}

test("catalogue and query authorization deny cross-tenant actors and signed-role mismatches before data access", async () => {
  for (const operation of ["catalogue", "query"] as const) {
    const db = new RejectingMembershipDb();
    const store = new ShopifyQLRuntimeStore(db as never);
    await assert.rejects(
      operation === "catalogue"
        ? store.authorizeCatalogue({
            requestId: IDS.request, tenantId: IDS.otherTenant, actorId: IDS.actor,
            role: "owner", conversationId: IDS.conversation, turnId: IDS.turn,
            searchDigest: "a".repeat(64),
          })
        : store.reserve({
            requestId: IDS.request, tenantId: IDS.otherTenant, actorId: IDS.actor,
            role: "manager", conversationId: IDS.conversation, turnId: IDS.turn,
            registrySha256: "a".repeat(64), queryDigest: "b".repeat(64),
            schema: "sales", since: "2026-07-01", until: "2026-07-31", rowLimit: 100,
            appClientIdSha256: "c".repeat(64),
          }),
      /shopifyql_actor_not_authorized/u,
    );
    assert.equal(db.calls.length, 1);
  }
});

class ConcurrentLedgerDb {
  count = 5;
  inserted = 0;
  readonly order: string[] = [];
  private tail: Promise<void> = Promise.resolve();
  private release: (() => void) | undefined;

  async transaction<T>(work: (client: this) => Promise<T>): Promise<T> {
    try { return await work(this); } finally { this.release?.(); this.release = undefined; }
  }
  async query(sql: string): Promise<FakeResult> {
    if (sql.includes("from control_plane.memberships")) return { rows: [{ role: "owner" }] };
    if (sql.includes("shopify_protected_data_approvals")) return { rows: [{ evidence_digest: "d".repeat(64) }] };
    if (sql.includes("from control_plane.connections connection")) return { rows: [{
      connection_id: IDS.connection, connection_generation: 1, display_name: "Store",
      external_account_reference: "shop.example", secret_reference: "vault:shopify",
      granted_scopes: ["read_reports"],
    }] };
    if (sql.includes("pg_advisory_xact_lock")) {
      this.order.push("lock");
      const previous = this.tail;
      let unlock!: () => void;
      this.tail = new Promise<void>((resolve) => { unlock = resolve; });
      await previous;
      this.release = unlock;
      return { rows: [{}] };
    }
    if (sql.includes("count(*)")) { this.order.push("count"); return { rows: [{ total: this.count }] }; }
    if (sql.includes("insert into control_plane.shopifyql_query_executions")) {
      this.order.push("insert"); this.count += 1; this.inserted += 1;
      return { rows: [{ request_id: IDS.request }] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }
}

function assertManualShopifyActivationFence(sql: string): void {
  assert.match(sql, /connection\.ingestion_start_mode='manual'/u);
  assert.match(sql, /connection\.ingestion_activated_at is not null/u);
  assert.match(
    sql,
    /connection\.ingestion_activated_generation=connection\.connection_generation/u,
  );
  assert.match(sql, /connection\.ingestion_blocked_reason is null/u);
  assert.match(
    sql,
    /not exists \([\s\S]*from control_plane\.readiness readiness[\s\S]*readiness\.state='blocked'/u,
  );
}

class ShopifyQLActivationFenceDb {
  state: "pre_start" | "active" | "blocked" = "pre_start";
  readonly calls: string[] = [];

  async transaction<T>(work: (client: this) => Promise<T>): Promise<T> { return work(this); }

  async query(sql: string, parameters: readonly unknown[] = []): Promise<FakeResult> {
    this.calls.push(sql);
    if (sql.includes("from control_plane.memberships")) return { rows: [{ role: "owner" }] };
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [{}] };
    if (sql.includes("count(*)")) return { rows: [{ total: 0 }] };
    if (sql.includes("insert into control_plane.shopifyql_catalogue_searches")) {
      return { rows: [{ request_id: IDS.request }] };
    }
    if (sql.includes("insert into control_plane.shopifyql_query_executions")) {
      return { rows: [{ request_id: IDS.request }] };
    }
    if (
      sql.includes("from control_plane.connections connection") ||
      sql.includes("update control_plane.shopifyql_query_executions")
    ) {
      assertManualShopifyActivationFence(sql);
      if (sql.includes("update control_plane.shopifyql_query_executions")) {
        assert.match(sql, /execution\.actor_id=\$11::uuid[\s\S]*execution\.actor_role=\$12/u);
        if (this.state !== "active" && parameters[4] !== "failed") return { rows: [] };
        return { rows: [{ request_id: IDS.request }] };
      }
      if (this.state !== "active") return { rows: [] };
      return { rows: [{
        connection_id: IDS.connection,
        connection_generation: 9,
        display_name: "Activated reports store",
        external_account_reference: "redacted-vendor-reference",
        secret_reference: "vault:opaque-reference",
        granted_scopes: ["read_reports"],
      }] };
    }
    if (sql.includes("from control_plane.shopify_protected_data_approvals")) {
      return { rows: [{ evidence_digest: "d".repeat(64) }] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }
}

test("ShopifyQL definitions stay offline pre-Start while reserve, execution binding and completion require active consent", async () => {
  const db = new ShopifyQLActivationFenceDb();
  const store = new ShopifyQLRuntimeStore(db as never);
  await store.authorizeCatalogue({
    requestId: IDS.request, tenantId: IDS.tenant, actorId: IDS.actor, role: "owner",
    conversationId: IDS.conversation, turnId: IDS.turn, searchDigest: "f".repeat(64),
  });
  assert.equal(
    db.calls.some((sql) => sql.includes("from control_plane.connections connection")),
    false,
    "the pinned definition catalogue must not require or read a merchant connection",
  );

  const reserve = () => store.reserve({
    requestId: IDS.request, tenantId: IDS.tenant, actorId: IDS.actor, role: "owner" as const,
    conversationId: IDS.conversation, turnId: IDS.turn,
    registrySha256: "a".repeat(64), queryDigest: "b".repeat(64), schema: "sales",
    since: "2026-08-01", until: "2026-08-12", rowLimit: 10,
    appClientIdSha256: "c".repeat(64),
  });
  await assert.rejects(reserve(), /shopifyql_connection_not_found/u);

  db.state = "active";
  const binding = await reserve();
  await store.assertCurrent(binding);
  await store.complete({
    requestId: IDS.request,
    binding,
    status: "succeeded",
    rowCount: 1,
    responseBytes: 64,
    responseDigest: "e".repeat(64),
    durationMs: 10,
  });

  db.state = "blocked";
  await assert.rejects(store.assertCurrent(binding), /shopifyql_binding_stale/u);
  await assert.rejects(store.complete({
    requestId: IDS.request,
    binding,
    status: "succeeded",
    rowCount: 1,
    responseBytes: 64,
    responseDigest: "e".repeat(64),
    durationMs: 11,
  }), /shopifyql_binding_stale/u);
  await store.complete({
    requestId: IDS.request,
    binding,
    status: "failed",
    rowCount: 0,
    responseBytes: 0,
    durationMs: 12,
    errorCode: "shopifyql_binding_stale",
  });
});

test("the advisory transaction lock serializes parallel per-turn reservations before count and insert", async () => {
  const db = new ConcurrentLedgerDb();
  const store = new ShopifyQLRuntimeStore(db as never);
  const reserve = (requestId: string) => store.reserve({
    requestId, tenantId: IDS.tenant, actorId: IDS.actor, role: "owner",
    conversationId: IDS.conversation, turnId: IDS.turn,
    registrySha256: "a".repeat(64), queryDigest: "b".repeat(64), schema: "sales",
    since: "2026-07-01", until: "2026-07-31", rowLimit: 100,
    appClientIdSha256: "c".repeat(64),
  });
  const outcomes = await Promise.allSettled([
    reserve("01J00000000000000000000007"),
    reserve("01J00000000000000000000008"),
  ]);
  assert.equal(outcomes.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(outcomes.filter(({ status }) => status === "rejected").length, 1);
  assert.equal(db.inserted, 1, "parallel calls exceeded the six-per-turn slot ceiling");
  assert.deepEqual(db.order, ["lock", "lock", "count", "insert", "count"]);
});

test("the signed production worker route still reauthorizes catalogue callers", async () => {
  const signingSecret = "q".repeat(48);
  let authorized = false;
  const store = {
    async authorizeCatalogue() { authorized = true; throw new Error("shopifyql_actor_not_authorized"); },
  };
  const handler = new ShopifyQLWorkerHttpHandler({
    signingSecret,
    shopifyClientId: "shopify-app",
    store: store as never,
    connectors: {} as never,
    control: {} as never,
  });
  const invocation = shopifyQLCatalogueInvocationSchema.parse({
    requestId: IDS.request, tenantId: IDS.otherTenant, actorId: IDS.actor, role: "owner",
    conversationId: IDS.conversation, turnId: IDS.turn,
    input: { query: "traffic", limit: 12 },
  });
  const body = JSON.stringify(invocation);
  const signed = await signInternalRequest({
    method: "POST", path: "/v1/shopifyql/catalogue", body, secret: signingSecret,
  });
  const response = await handler.handle(new Request("https://sync.internal/v1/shopifyql/catalogue", {
    method: "POST", headers: { "content-type": "application/json", ...signed }, body,
  }));
  assert.equal(response.status, 403);
  assert.equal(authorized, true);

  const unsigned = await handler.handle(new Request("https://sync.internal/v1/shopifyql/catalogue", {
    method: "POST", body,
  }));
  assert.equal(unsigned.status, 401);
});

test("the real V3 web route, engine, tools and worker form one production-callable path", async () => {
  const files = await Promise.all([
    readFile(new URL("../../app/api/v3-conversation/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../../packages/albert-v3/src/engine/engine.ts", import.meta.url), "utf8"),
    readFile(new URL("../../packages/albert-v3/src/engine/tools.ts", import.meta.url), "utf8"),
    readFile(new URL("../../services/sync-workers/src/main.ts", import.meta.url), "utf8"),
    readFile(new URL("../../services/sync-workers/src/shopifyql-http.ts", import.meta.url), "utf8"),
  ]);
  const [route, engine, tools, worker, shopifyQLHttp] = files;
  assert.match(route!, /actorId:\s*auth\.user\.id/u);
  assert.match(route!, /role:\s*tenant\.role/u);
  assert.match(route!, /SYNC_WORKER_INTERNAL_URL/u);
  assert.match(route!, /ALBERT_SHOPIFYQL_SIGNING_SECRET/u);
  assert.match(engine!, /new ShopifyQLClient/u);
  assert.match(tools!, /name:\s*"search_shopifyql_catalogue"/u);
  assert.match(tools!, /name:\s*"run_shopifyql_query"/u);
  assert.match(worker!, /pathname\.startsWith\("\/v1\/shopifyql\/"\)/u);
  assert.match(worker!, /shopifyQLStore\.ready\(\)/u);
  assert.match(
    shopifyQLHttp!,
    /store\.assertCurrent\(binding\)[\s\S]*execute_shopifyql[\s\S]*store\.assertCurrent\(binding\)/u,
    "ShopifyQL execution must revalidate activation immediately before and after the vendor read",
  );
});

test("migration 0133 is Supabase-auth compatible and has least-privilege FORCE-RLS ACLs", async () => {
  const sql = await readFile(new URL(
    "../../infra/migrations/control-plane/0133_m6_governed_shopifyql_query_plane.sql",
    import.meta.url,
  ), "utf8");
  assert.doesNotMatch(sql, /REFERENCES\s+auth\.users/iu);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/gu);
  assert.match(sql, /shopify_pcd_migration_owner_access[\s\S]*FOR ALL TO albert_control_migration_owner/iu);
  assert.match(sql, /REVOKE ALL[\s\S]*service_role/iu);
  assert.doesNotMatch(sql, /GRANT\s+(?:INSERT|UPDATE|ALL)[\s\S]{0,120}\b(?:anon|authenticated|service_role)\b/iu);
  assert.match(sql, /approval_evidence_digest/iu);
  assert.match(sql, /CHECK \(\(until_date-since_date\)\+1 BETWEEN 1 AND 366\)/iu);
});
