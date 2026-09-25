import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  compileShopifyAdminQuery,
  searchShopifyAdminCatalogue,
  ShopifyAdminPolicyError,
} from "../../connectors/shopify/admin-query.js";
import { loadShopifyAdminSchemaRegistry } from "../../connectors/shopify/schema-registry.js";
import { signInternalRequest } from "../../packages/security/src/index.js";
import {
  shopifyAdminCatalogueInvocationSchema,
  shopifyAdminInvocationSchema,
  shopifyAdminQueryInputSchema,
  shopifyAdminToolQueryInputSchema,
} from "../../packages/shopify-admin/src/contract.js";
import { flattenShopifyAdminResult } from "../../packages/albert-v3/src/engine/tools.js";
import { ShopifyAdminWorkerHttpHandler } from "../../services/sync-workers/src/shopify-admin-http.js";
import { ShopifyAdminRuntimeStore } from "../../services/sync-workers/src/shopify-admin-store.js";
import { ShopifyQLRuntimeStore } from "../../services/sync-workers/src/shopifyql-store.js";

const IDS = Object.freeze({
  request: "01J00000000000000000000001",
  tenant: "01J00000000000000000000002",
  otherTenant: "01J00000000000000000000003",
  conversation: "01J00000000000000000000004",
  turn: "01J00000000000000000000005",
  connection: "01J00000000000000000000006",
  otherConnection: "01J00000000000000000000007",
  actor: "00000000-0000-4000-8000-000000000001",
});

function product(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    topic: "Exact product details",
    rootField: "product",
    arguments: [{ name: "id", value: { kind: "id", value: "gid://shopify/Product/1" } }],
    select: [{ field: "id" }, { field: "title" }],
    ...overrides,
  };
}

function code(run: () => unknown): string | undefined {
  try { run(); } catch (error) {
    assert.ok(error instanceof ShopifyAdminPolicyError);
    return error.code;
  }
  return undefined;
}

test("registry compiler admits exact lookups, bounded connections, typed inputs and union fragments", () => {
  const exact = compileShopifyAdminQuery(product());
  assert.equal(exact.apiVersion, "2026-07");
  assert.equal(exact.registrySha256, "af1c631f6197bf9a32b541d3c81626990ae490acd7950418abeb3d545b8d4c6b");
  assert.deepEqual(exact.requiredScopes, ["read_products"]);
  assert.equal(exact.requiresLevel2, false);
  assert.match(exact.query, /result: product\(id: \$v0\) \{ id title \}/u);
  assert.deepEqual(exact.variables, { v0: "gid://shopify/Product/1" });

  const connection = compileShopifyAdminQuery({
    topic: "Product catalogue",
    rootField: "products",
    arguments: [{ name: "first", value: { kind: "int", value: 5 } }],
    select: [
      { field: "nodes", select: [{ field: "id" }, { field: "title" }] },
      { field: "pageInfo", select: [{ field: "hasNextPage" }, { field: "endCursor" }] },
    ],
  });
  assert.match(connection.query, /products\(first: \$v0\)/u);

  const union = compileShopifyAdminQuery({
    topic: "Discount type",
    rootField: "discountNode",
    arguments: [{ name: "id", value: { kind: "id", value: "gid://shopify/DiscountNode/1" } }],
    select: [{
      field: "discount",
      on: [
        { type: "DiscountCodeBasic", select: [{ field: "title" }] },
        { type: "DiscountAutomaticBasic", select: [{ field: "title" }] },
      ],
    }],
  });
  assert.match(union.query, /__typename \.\.\. on DiscountCodeBasic/u);
  assert.match(union.query, /\.\.\. on DiscountAutomaticBasic/u);
});

test("protected values are definition-answerable but fail closed before live execution", () => {
  assert.equal(code(() => compileShopifyAdminQuery({
    topic: "Customer email",
    rootField: "customer",
    arguments: [{ name: "id", value: { kind: "id", value: "gid://shopify/Customer/1" } }],
    select: [{ field: "id" }, { field: "email" }],
  })), "protected_live_execution_unavailable");
  const found = searchShopifyAdminCatalogue({ query: "email", type: "Customer", limit: 12 }) as {
    fields: readonly Readonly<Record<string, unknown>>[];
  };
  assert.ok(found.fields.some(({ path, protected: protectedValue }) => path === "Customer.email" && protectedValue === true));
});

test("compiler excludes raw languages, mutations, generic nodes, raw payloads and unclassified metafield literals", () => {
  assert.equal(shopifyAdminQueryInputSchema.safeParse({ ...product(), graphql: "mutation { productDelete }" }).success, false);
  assert.equal(shopifyAdminQueryInputSchema.safeParse({ ...product(), query: "{ shop { name } }" }).success, false);
  assert.equal(shopifyAdminQueryInputSchema.safeParse({ ...product(), token: "secret" }).success, false);
  assert.equal(shopifyAdminQueryInputSchema.safeParse({ ...product(), shopDomain: "shop.myshopify.com" }).success, false);
  assert.equal(shopifyAdminQueryInputSchema.safeParse({ ...product(), url: "https://shop.myshopify.com" }).success, false);
  assert.equal(code(() => compileShopifyAdminQuery({ ...product(), rootField: "productDelete" })), "root_field_unknown");
  assert.equal(code(() => compileShopifyAdminQuery({
    topic: "Generic node", rootField: "node",
    arguments: [{ name: "id", value: { kind: "id", value: "gid://shopify/Product/1" } }],
    on: [{ type: "Product", select: [{ field: "title" }] }],
  })), "raw_node_lookup_excluded");
  assert.equal(code(() => compileShopifyAdminQuery({
    topic: "Metafield literal", rootField: "product",
    arguments: [{ name: "id", value: { kind: "id", value: "gid://shopify/Product/1" } }],
    select: [{
      field: "metafield",
      arguments: [{ name: "key", value: { kind: "string", value: "secret" } }],
      select: [{ field: "value" }],
    }],
  })), "protected_live_execution_unavailable");
  assert.equal(code(() => compileShopifyAdminQuery({
    topic: "Transaction raw receipt", rootField: "order",
    arguments: [{ name: "id", value: { kind: "id", value: "gid://shopify/Order/1" } }],
    select: [{ field: "transactions", arguments: [{ name: "first", value: { kind: "int", value: 1 } }], select: [{ field: "receiptJson" }] }],
  })), "protected_live_execution_unavailable");
  assert.equal(code(() => compileShopifyAdminQuery({
    topic: "Opaque product search", rootField: "products",
    arguments: [
      { name: "first", value: { kind: "int", value: 5 } },
      { name: "query", value: { kind: "string", value: "title:*" } },
    ],
    select: [{ field: "nodes", select: [{ field: "id" }] }],
  })), "opaque_search_query_excluded");
});

test("credential-bearing Admin members and objects can be defined but never reach the model", () => {
  const cases = [
    { topic: "Analytics token", rootField: "shop", select: [{ field: "analyticsToken" }] },
    { topic: "App API key", rootField: "app", select: [{ field: "apiKey" }] },
    {
      topic: "Discount app key", rootField: "appDiscountType",
      arguments: [{ name: "functionId", value: { kind: "string", value: "function-1" } }],
      select: [{ field: "appKey" }],
    },
    {
      topic: "Storefront tokens", rootField: "shop",
      select: [{
        field: "storefrontAccessTokens",
        arguments: [{ name: "first", value: { kind: "int", value: 1 } }],
        select: [{ field: "nodes", select: [{ field: "accessToken" }] }],
      }],
    },
    {
      topic: "Shop Pay receipt", rootField: "shopPayPaymentRequestReceipt",
      arguments: [{ name: "token", value: { kind: "string", value: "receipt-1" } }],
      select: [{ field: "token" }],
    },
  ];
  cases.forEach((input) => assert.equal(
    code(() => compileShopifyAdminQuery(input)),
    "credential_bearing_member_excluded",
  ));
  const definitions = searchShopifyAdminCatalogue({ query: "API key", type: "App", limit: 12 }) as {
    fields: readonly Readonly<Record<string, unknown>>[];
  };
  assert.ok(definitions.fields.some(({ path }) => path === "App.apiKey"));
});

test("compiler enforces argument subjects, forward pagination, field/depth/node limits and registered fragments", () => {
  assert.equal(code(() => compileShopifyAdminQuery(product({
    arguments: [{ name: "id", value: { kind: "id", value: "gid://shopify/Customer/1" } }],
  }))), "argument_gid_type_invalid");
  assert.equal(code(() => compileShopifyAdminQuery({
    topic: "Unbounded list", rootField: "products", select: [{ field: "nodes", select: [{ field: "id" }] }],
  })), "connection_first_required");
  assert.equal(code(() => compileShopifyAdminQuery({
    topic: "Backward list", rootField: "products",
    arguments: [{ name: "last", value: { kind: "int", value: 5 } }],
    select: [{ field: "nodes", select: [{ field: "id" }] }],
  })), "backward_pagination_unsupported");
  assert.equal(code(() => compileShopifyAdminQuery({
    topic: "Fabricated union", rootField: "discountNode",
    arguments: [{ name: "id", value: { kind: "id", value: "gid://shopify/DiscountNode/1" } }],
    select: [{ field: "discount", on: [{ type: "Product", select: [{ field: "id" }] }] }],
  })), "fragment_type_invalid");
});

test("registry access alternatives are OR groups while independent requirements remain AND", () => {
  const compiled = compileShopifyAdminQuery({
    topic: "Catalog operation status",
    rootField: "catalogOperations",
    select: [{ field: "id" }, { field: "status" }],
  });
  assert.deepEqual(compiled.requiredScopes, ["read_products", "read_publications"]);
  assert.deepEqual(compiled.requiredScopeGroups, [["read_products", "read_publications"]]);
});

test("Admin scalar strings retain exact decimal and unsigned-integer precision", () => {
  const leaves = flattenShopifyAdminResult({
    money: "99999999999999999999.990000000000000001",
    unsigned: "18446744073709551615",
    native: 12.5,
  });
  assert.deepEqual(leaves, [
    { path: "result.money", value: "99999999999999999999.990000000000000001", numericValue: null },
    { path: "result.unsigned", value: "18446744073709551615", numericValue: null },
    { path: "result.native", value: "12.5", numericValue: 12.5 },
  ]);
});

test("catalogue is official definition metadata and exposes access/protection without merchant data", () => {
  const found = searchShopifyAdminCatalogue({ query: "customer email", type: "Customer", limit: 12 });
  assert.equal(found.apiVersion, "2026-07");
  assert.equal((found as { registrySha256: string }).registrySha256, "af1c631f6197bf9a32b541d3c81626990ae490acd7950418abeb3d545b8d4c6b");
  const fields = (found as { fields: readonly Readonly<Record<string, unknown>>[] }).fields;
  assert.ok(fields.some(({ path, protected: protectedValue }) => path === "Customer.email" && protectedValue === true));
  assert.equal(JSON.stringify(found).includes("myshopify.com"), false);
});

test("every one of 9,291 Admin output fields is deterministically discoverable by exact identity", () => {
  const registry = loadShopifyAdminSchemaRegistry();
  let discovered = 0;
  for (const type of registry.types) {
    for (const field of type.fields ?? []) {
      const schemaPath = `${type.name}.${field.name}`;
      const byPath = searchShopifyAdminCatalogue({
        query: schemaPath,
        type: type.name,
        limit: 1,
      }) as { fields: readonly Readonly<{ path: string }> [] };
      assert.equal(byPath.fields[0]?.path, schemaPath, `exact path omitted ${schemaPath}`);

      const byName = searchShopifyAdminCatalogue({
        query: field.name,
        type: type.name,
        limit: 1,
      }) as { fields: readonly Readonly<{ path: string }> [] };
      assert.equal(byName.fields[0]?.path, schemaPath, `exact field name omitted ${schemaPath}`);
      discovered += 1;
    }
  }
  assert.equal(discovered, 9_291);
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

test("catalogue and query authorization deny cross-tenant actors before connection or approval access", async () => {
  for (const operation of ["catalogue", "query"] as const) {
    const db = new RejectingMembershipDb();
    const store = new ShopifyAdminRuntimeStore(db as never);
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
            registrySha256: "a".repeat(64), queryDigest: "b".repeat(64), rootField: "product",
            selectedFieldCount: 3, requiredScopes: ["read_products"], requiredScopeGroups: [["read_products"]], requiresLevel2: false,
            appClientIdSha256: "c".repeat(64),
          }),
      /shopify_admin_actor_not_authorized/u,
    );
    assert.equal(db.calls.length, 1);
  }
});

class ApprovalDb {
  readonly calls: string[] = [];
  async transaction<T>(work: (client: this) => Promise<T>): Promise<T> { return work(this); }
  async query(sql: string): Promise<FakeResult> {
    this.calls.push(sql);
    if (sql.includes("from control_plane.memberships")) return { rows: [{ role: "owner" }] };
    if (sql.includes("shopify_protected_data_approvals")) return { rows: [] };
    throw new Error("protected lookup must stop before connection access");
  }
}

test("durable Level-2 approval is conditional but mandatory before protected connection access", async () => {
  const db = new ApprovalDb();
  const store = new ShopifyAdminRuntimeStore(db as never);
  await assert.rejects(store.reserve({
    requestId: IDS.request, tenantId: IDS.tenant, actorId: IDS.actor, role: "owner",
    conversationId: IDS.conversation, turnId: IDS.turn,
    registrySha256: "a".repeat(64), queryDigest: "b".repeat(64), rootField: "customer",
    selectedFieldCount: 3, requiredScopes: ["read_customers"], requiredScopeGroups: [["read_customers"]], requiresLevel2: true,
    appClientIdSha256: "c".repeat(64),
  }), /shopify_admin_level2_approval_required/u);
  assert.equal(db.calls.some((sql) => sql.includes("from control_plane.connections")), false);
});

class MultiStoreDb {
  readonly calls: Readonly<{ sql: string; parameters: readonly unknown[] }>[] = [];
  catalogueReceipt = true;
  async transaction<T>(work: (client: this) => Promise<T>): Promise<T> { return work(this); }
  async query(sql: string, parameters: readonly unknown[] = []): Promise<FakeResult> {
    (this.calls as { sql: string; parameters: readonly unknown[] }[]).push({ sql, parameters });
    if (sql.includes("from control_plane.memberships")) return { rows: [{ role: "owner" }] };
    if (sql.includes("select true as present") && sql.includes("shopify_admin_catalogue_searches")) {
      return { rows: this.catalogueReceipt ? [{ present: true }] : [] };
    }
    if (sql.includes("shopify_protected_data_approvals")) return { rows: [{ evidence_digest: "d".repeat(64) }] };
    if (sql.includes("token.secret_reference")) {
      const selected = parameters[1];
      const choices = [
        {
          connection_id: IDS.connection, connection_generation: 3, display_name: "Melbourne",
          external_account_reference: "redacted-store-a", secret_reference: "vault:a",
          granted_scopes: ["read_products", "read_reports"],
        },
        {
          connection_id: IDS.otherConnection, connection_generation: 4, display_name: "Sydney",
          external_account_reference: "redacted-store-b", secret_reference: "vault:b",
          granted_scopes: ["read_products", "read_reports"],
        },
      ];
      return { rows: selected === null ? choices : choices.filter(({ connection_id }) => connection_id === selected) };
    }
    if (sql.includes("select connection.connection_id") && !sql.includes("token.secret_reference")) {
      return { rows: [
        { connection_id: IDS.connection, connection_generation: 3, display_name: "Melbourne" },
        { connection_id: IDS.otherConnection, connection_generation: 4, display_name: "Sydney" },
      ] };
    }
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [{}] };
    if (sql.includes("count(*)")) return { rows: [{ total: 0 }] };
    if (sql.includes("insert into control_plane.shopify_admin_catalogue_searches")) {
      return { rows: [{ request_id: IDS.request }] };
    }
    if (sql.includes("insert into control_plane.shopify_admin_query_executions")) {
      return { rows: [{ request_id: IDS.request }] };
    }
    if (sql.includes("insert into control_plane.shopifyql_query_executions")) {
      return { rows: [{ request_id: IDS.request }] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }
}

function storeReservation(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    requestId: IDS.request, tenantId: IDS.tenant, actorId: IDS.actor, role: "owner" as const,
    conversationId: IDS.conversation, turnId: IDS.turn,
    registrySha256: "a".repeat(64), queryDigest: "b".repeat(64), rootField: "product",
    selectedFieldCount: 3, requiredScopes: ["read_products"],
    requiredScopeGroups: [["read_products"]], requiresLevel2: false,
    appClientIdSha256: "c".repeat(64),
    ...overrides,
  };
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

class AdminActivationFenceDb {
  state: "pre_start" | "active" | "blocked" = "pre_start";
  readonly calls: string[] = [];

  async transaction<T>(work: (client: this) => Promise<T>): Promise<T> { return work(this); }

  async query(sql: string, parameters: readonly unknown[] = []): Promise<FakeResult> {
    this.calls.push(sql);
    if (sql.includes("from control_plane.memberships")) return { rows: [{ role: "owner" }] };
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [{}] };
    if (sql.includes("count(*)")) return { rows: [{ total: 0 }] };
    if (sql.includes("insert into control_plane.shopify_admin_catalogue_searches")) {
      return { rows: [{ request_id: IDS.request }] };
    }
    if (sql.includes("insert into control_plane.shopify_admin_query_executions")) {
      return { rows: [{ request_id: IDS.request }] };
    }
    if (
      sql.includes("from control_plane.connections connection") ||
      sql.includes("update control_plane.shopify_admin_query_executions")
    ) {
      assertManualShopifyActivationFence(sql);
      if (sql.includes("update control_plane.shopify_admin_query_executions")) {
        assert.match(sql, /execution\.actor_id=\$5::uuid and execution\.actor_role=\$6/u);
        if (this.state !== "active" && parameters[9] !== "failed") return { rows: [] };
        return { rows: [{ request_id: IDS.request }] };
      }
      if (this.state !== "active") return { rows: [] };
      if (sql.includes("token.secret_reference")) {
        return { rows: [{
          connection_id: IDS.connection,
          connection_generation: 7,
          display_name: "Activated store",
          external_account_reference: "redacted-vendor-reference",
          secret_reference: "vault:opaque-reference",
          granted_scopes: ["read_products"],
        }] };
      }
      return { rows: [{
        connection_id: IDS.connection,
        connection_generation: 7,
        display_name: "Activated store",
      }] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  }
}

test("Admin definitions stay offline pre-Start while store listing, reservation and result finalization are activation-fenced", async () => {
  const db = new AdminActivationFenceDb();
  const store = new ShopifyAdminRuntimeStore(db as never);
  await store.authorizeCatalogue({
    requestId: IDS.request, tenantId: IDS.tenant, actorId: IDS.actor, role: "owner",
    conversationId: IDS.conversation, turnId: IDS.turn, searchDigest: "f".repeat(64),
  });
  assert.equal(
    db.calls.some((sql) => sql.includes("from control_plane.connections connection")),
    false,
    "the pinned definition catalogue must not require or read a merchant connection",
  );

  assert.deepEqual(await store.listConnections({
    requestId: "01J00000000000000000000009",
    tenantId: IDS.tenant, actorId: IDS.actor, role: "owner",
    conversationId: IDS.conversation, turnId: IDS.turn,
  }), []);
  await assert.rejects(store.reserve(storeReservation()), /shopify_admin_connection_not_found/u);

  db.state = "active";
  assert.deepEqual(await store.listConnections({
    requestId: "01J00000000000000000000010",
    tenantId: IDS.tenant, actorId: IDS.actor, role: "owner",
    conversationId: IDS.conversation, turnId: IDS.turn,
  }), [{
    connectionId: IDS.connection,
    connectionGeneration: 7,
    displayName: "Activated store",
  }]);
  const binding = await store.reserve(storeReservation());
  await store.assertCurrent(binding);
  await store.complete({
    requestId: IDS.request,
    binding,
    status: "succeeded",
    resultLeafCount: 2,
    responseBytes: 64,
    responseDigest: "e".repeat(64),
    scopeEvidenceDigest: "d".repeat(64),
    durationMs: 10,
  });

  db.state = "blocked";
  await assert.rejects(store.assertCurrent(binding), /shopify_admin_binding_stale/u);
  await assert.rejects(store.complete({
    requestId: IDS.request,
    binding,
    status: "succeeded",
    resultLeafCount: 2,
    responseBytes: 64,
    responseDigest: "e".repeat(64),
    scopeEvidenceDigest: "d".repeat(64),
    durationMs: 11,
  }), /shopify_admin_binding_stale/u);
  await store.complete({
    requestId: IDS.request,
    binding,
    status: "failed",
    resultLeafCount: 0,
    responseBytes: 0,
    durationMs: 12,
    errorCode: "shopify_admin_binding_stale",
  });
});

test("multi-store selection is catalogued, exact, tenant-bound and never exposes domains or credentials", async () => {
  const db = new MultiStoreDb();
  const store = new ShopifyAdminRuntimeStore(db as never);
  const stores = await store.listConnections({
    requestId: IDS.request, tenantId: IDS.tenant, actorId: IDS.actor, role: "owner",
    conversationId: IDS.conversation, turnId: IDS.turn,
  });
  assert.deepEqual(stores, [
    { connectionId: IDS.connection, connectionGeneration: 3, displayName: "Melbourne" },
    { connectionId: IDS.otherConnection, connectionGeneration: 4, displayName: "Sydney" },
  ]);
  assert.doesNotMatch(JSON.stringify(stores), /myshopify|vault:|redacted-store/iu);

  await assert.rejects(store.reserve(storeReservation()), /shopify_admin_connection_ambiguous/u);
  const selected = await store.reserve(storeReservation({ connectionId: IDS.connection }));
  assert.equal(selected.connectionId, IDS.connection);

  await assert.rejects(
    store.reserve(storeReservation({ connectionId: "01J00000000000000000000008" })),
    /shopify_admin_connection_not_found/u,
  );
  const connectionCall = db.calls.find(({ sql, parameters }) =>
    sql.includes("token.secret_reference") && parameters[1] === "01J00000000000000000000008"
  );
  assert.deepEqual(connectionCall?.parameters.slice(0, 2), [IDS.tenant, "01J00000000000000000000008"]);

  const uncataloguedDb = new MultiStoreDb();
  uncataloguedDb.catalogueReceipt = false;
  await assert.rejects(
    new ShopifyAdminRuntimeStore(uncataloguedDb as never).reserve(storeReservation({ connectionId: IDS.connection })),
    /shopify_admin_connection_selection_not_catalogued/u,
  );
  assert.equal(uncataloguedDb.calls.some(({ sql }) => sql.includes("token.secret_reference")), false);
});

test("ShopifyQL reuses the same tenant-bound current-turn opaque store attestation", async () => {
  const db = new MultiStoreDb();
  const store = new ShopifyQLRuntimeStore(db as never);
  const selected = await store.reserve({
    requestId: IDS.request, tenantId: IDS.tenant, actorId: IDS.actor, role: "owner",
    conversationId: IDS.conversation, turnId: IDS.turn, connectionId: IDS.otherConnection,
    registrySha256: "a".repeat(64), queryDigest: "b".repeat(64), schema: "sales",
    since: "2026-08-01", until: "2026-08-12", rowLimit: 10,
    appClientIdSha256: "c".repeat(64),
  });
  assert.equal(selected.connectionId, IDS.otherConnection);
  const selectionQuery = db.calls.find(({ sql }) => sql.includes("token.secret_reference"));
  assert.deepEqual(selectionQuery?.parameters.slice(0, 2), [IDS.tenant, IDS.otherConnection]);

  const uncataloguedDb = new MultiStoreDb();
  uncataloguedDb.catalogueReceipt = false;
  await assert.rejects(new ShopifyQLRuntimeStore(uncataloguedDb as never).reserve({
    requestId: IDS.request, tenantId: IDS.tenant, actorId: IDS.actor, role: "owner",
    conversationId: IDS.conversation, turnId: IDS.turn, connectionId: IDS.connection,
    registrySha256: "a".repeat(64), queryDigest: "b".repeat(64), schema: "sales",
    since: "2026-08-01", until: "2026-08-12", rowLimit: 10,
    appClientIdSha256: "c".repeat(64),
  }), /shopifyql_connection_selection_not_catalogued/u);
  assert.equal(uncataloguedDb.calls.some(({ sql }) => sql.includes("shopify_protected_data_approvals")), false);
});

test("signed worker catalogue route reauthorizes and unsigned requests fail", async () => {
  const signingSecret = "a".repeat(48);
  let authorized = false;
  const handler = new ShopifyAdminWorkerHttpHandler({
    signingSecret,
    shopifyClientId: "shopify-app",
    store: { async authorizeCatalogue() { authorized = true; throw new Error("shopify_admin_actor_not_authorized"); } } as never,
    connectors: {} as never,
    control: {} as never,
  });
  const invocation = shopifyAdminCatalogueInvocationSchema.parse({
    requestId: IDS.request, tenantId: IDS.otherTenant, actorId: IDS.actor,
    role: "owner", conversationId: IDS.conversation, turnId: IDS.turn,
    input: { query: "product", limit: 12 },
  });
  const body = JSON.stringify(invocation);
  const signed = await signInternalRequest({ method: "POST", path: "/v1/shopify-admin/catalogue", body, secret: signingSecret });
  const response = await handler.handle(new Request("https://sync.internal/v1/shopify-admin/catalogue", {
    method: "POST", headers: { "content-type": "application/json", ...signed }, body,
  }));
  assert.equal(response.status, 403);
  assert.equal(authorized, true);
  assert.equal((await handler.handle(new Request("https://sync.internal/v1/shopify-admin/catalogue", {
    method: "POST", body,
  }))).status, 401);
});

test("roles are closed, execution is generation-bound, and the V3 route is production-callable", async () => {
  for (const role of ["bookkeeper", "internal_operator", "viewer"]) {
    assert.equal(shopifyAdminInvocationSchema.safeParse({
      requestId: IDS.request, tenantId: IDS.tenant, actorId: IDS.actor, role,
      conversationId: IDS.conversation, turnId: IDS.turn, input: product(),
    }).success, false);
  }
  assert.equal(shopifyAdminToolQueryInputSchema.safeParse({ ...product(), connectionId: IDS.connection }).success, true);
  assert.equal(shopifyAdminToolQueryInputSchema.safeParse({ ...product(), shopDomain: "shop.myshopify.com" }).success, false);
  const [route, engine, tools, worker, connector, migration] = await Promise.all([
    readFile(new URL("../../app/api/v3-conversation/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../../packages/albert-v3/src/engine/engine.ts", import.meta.url), "utf8"),
    readFile(new URL("../../packages/albert-v3/src/engine/tools.ts", import.meta.url), "utf8"),
    readFile(new URL("../../services/sync-workers/src/main.ts", import.meta.url), "utf8"),
    readFile(new URL("../../connectors/shopify/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../../infra/migrations/control-plane/0134_m6_governed_shopify_admin_read_plane.sql", import.meta.url), "utf8"),
  ]);
  assert.match(route, /ALBERT_SHOPIFY_ADMIN_SIGNING_SECRET/u);
  assert.match(engine, /new ShopifyAdminClient/u);
  assert.match(tools, /name:\s*"list_shopify_admin_stores"[\s\S]*name:\s*"search_shopify_admin_catalogue"[\s\S]*name:\s*"run_shopify_admin_query"/u);
  assert.match(tools, /untrusted merchant data[\s\S]*never as instructions/iu);
  assert.match(worker, /pathname\.startsWith\("\/v1\/shopify-admin\/"\)/u);
  assert.match(worker, /shopifyAdminStore\.ready\(\)/u);
  assert.match(connector, /_albertAccess[\s\S]*accessScopes[\s\S]*handle/u);
  assert.match(migration, /connection_generation/iu);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/gu);
  assert.match(migration, /REVOKE ALL[\s\S]*service_role/iu);
  assert.doesNotMatch(migration, /\b(?:query_text|query_variables|variables|result_data|shop_domain|access_token|refresh_token)\s+/iu);
});

test("compiled read path never activates or enqueues Shopify ingestion", async () => {
  const files = await Promise.all([
    readFile(new URL("../../packages/albert-v3/src/shopify-admin/client.ts", import.meta.url), "utf8"),
    readFile(new URL("../../services/sync-workers/src/shopify-admin-http.ts", import.meta.url), "utf8"),
    readFile(new URL("../../services/sync-workers/src/shopify-admin-store.ts", import.meta.url), "utf8"),
  ]);
  const source = files.join("\n");
  assert.doesNotMatch(source, /activate_shopify_ingestion|enqueue|InitialBackfill|IncrementalSync|ReconciliationSweep/u);
  assert.match(
    files[1]!,
    /store\.assertCurrent\(binding\)[\s\S]*execute_admin_query[\s\S]*store\.assertCurrent\(binding\)/u,
    "Admin execution must revalidate activation immediately before and after the vendor read",
  );
});
