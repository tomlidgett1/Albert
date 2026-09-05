import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  SHOPIFY_ADMIN_GRAPHQL_SCHEMA_REGISTRY,
  SHOPIFY_ADMIN_GRAPHQL_SCHEMA_VERSION,
  indexShopifyAdminSchemaRegistry,
  loadShopifyAdminSchemaRegistry,
  shopifyGraphQLField,
  shopifyGraphQLNamedType,
  type ShopifyGraphQLField,
  type ShopifyGraphQLInputValue,
  type ShopifyGraphQLType,
} from "../../connectors/shopify/schema-registry.js";

const registry = SHOPIFY_ADMIN_GRAPHQL_SCHEMA_REGISTRY;
const index = indexShopifyAdminSchemaRegistry();

function assertSortedUnique(values: readonly string[], context: string): void {
  const expected = [...new Set(values)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  assert.deepEqual(values, expected, `${context} is not sorted and unique`);
}

function allFields(): readonly ShopifyGraphQLField[] {
  return registry.types.flatMap((type) => type.fields ?? []);
}

function allInputFields(): readonly ShopifyGraphQLInputValue[] {
  return registry.types.flatMap((type) => type.inputFields ?? []);
}

function requiredType(name: string): ShopifyGraphQLType {
  const type = index.typesByName.get(name);
  assert.ok(type, `missing Shopify schema type ${name}`);
  return type;
}

function requireFields(typeName: string, names: readonly string[]): void {
  const type = requiredType(typeName);
  assert.ok(type.fields, `${typeName} has no fields`);
  const actual = new Set(type.fields.map(({ name }) => name));
  for (const name of names) assert.ok(actual.has(name), `${typeName}.${name} is missing`);
}

test("the committed registry is the compact deterministic 2026-07 Shopify schema", async () => {
  assert.strictEqual(loadShopifyAdminSchemaRegistry(), registry);
  assert.equal(registry.registryVersion, 1);
  assert.equal(registry.apiVersion, SHOPIFY_ADMIN_GRAPHQL_SCHEMA_VERSION);
  assert.deepEqual(registry.source, {
    provider: "Shopify",
    api: "Admin GraphQL API",
    apiVersion: "2026-07",
    introspectionUrl: "https://shopify.dev/admin-graphql-direct-proxy/2026-07",
    documentationUrl: "https://shopify.dev/docs/api/admin-graphql/2026-07",
    proxyDocumentationUrl:
      "https://shopify.dev/docs/api/shopify-app-remix/v3/guide-graphql-types",
    standardIntrospectionTypesIncluded: false,
    schemaSha256: registry.source.schemaSha256,
  });
  assert.match(registry.source.schemaSha256, /^[a-f0-9]{64}$/u);

  const schemaContent = {
    schemaDescription: registry.schemaDescription,
    roots: registry.roots,
    directives: registry.directives,
    types: registry.types,
  };
  const hash = createHash("sha256")
    .update(JSON.stringify(schemaContent), "utf8")
    .digest("hex");
  assert.equal(hash, registry.source.schemaSha256);

  const artifact = await readFile(
    new URL(
      "../../connectors/shopify/generated/admin-graphql-2026-07.json",
      import.meta.url,
    ),
    "utf8",
  );
  assert.equal(artifact, `${JSON.stringify(registry)}\n`, "registry is not compact canonical JSON");
});

test("registry counts are recomputed from the graph rather than trusted metadata", () => {
  const fields = allFields();
  const inputFields = allInputFields();
  const fieldArguments = fields.flatMap(({ args }) => args);
  const directiveArguments = registry.directives.flatMap(({ args }) => args);
  const enumValues = registry.types.flatMap(({ enumValues }) => enumValues ?? []);
  const typeKinds = Object.fromEntries(
    (["SCALAR", "OBJECT", "INTERFACE", "UNION", "ENUM", "INPUT_OBJECT"] as const).map(
      (kind) => [kind, registry.types.filter((type) => type.kind === kind).length],
    ),
  );

  assert.equal(registry.counts.types, registry.types.length);
  assert.equal(registry.counts.excludedStandardIntrospectionTypes, 8);
  assert.ok(registry.types.every(({ name }) => !name.startsWith("__")));
  assert.deepEqual(registry.counts.typeKinds, typeKinds);
  assert.equal(registry.counts.fields, fields.length);
  assert.equal(
    registry.counts.objectFields,
    registry.types
      .filter(({ kind }) => kind === "OBJECT")
      .reduce((total, type) => total + (type.fields?.length ?? 0), 0),
  );
  assert.equal(
    registry.counts.interfaceFields,
    registry.types
      .filter(({ kind }) => kind === "INTERFACE")
      .reduce((total, type) => total + (type.fields?.length ?? 0), 0),
  );
  assert.equal(registry.counts.inputFields, inputFields.length);
  assert.equal(registry.counts.fieldArguments, fieldArguments.length);
  assert.equal(registry.counts.directives, registry.directives.length);
  assert.equal(registry.counts.directiveArguments, directiveArguments.length);
  assert.equal(registry.counts.enumValues, enumValues.length);
  assert.equal(
    registry.counts.deprecatedFields,
    fields.filter(({ isDeprecated }) => isDeprecated).length,
  );
  assert.equal(
    registry.counts.deprecatedInputFields,
    inputFields.filter(({ isDeprecated }) => isDeprecated).length,
  );
  assert.equal(
    registry.counts.deprecatedFieldArguments,
    fieldArguments.filter(({ isDeprecated }) => isDeprecated).length,
  );
  assert.equal(
    registry.counts.deprecatedEnumValues,
    enumValues.filter(({ isDeprecated }) => isDeprecated).length,
  );
  assert.equal(
    registry.counts.protectedTypes,
    registry.types.filter(({ isProtected }) => isProtected).length,
  );
  assert.equal(
    registry.counts.protectedFields,
    fields.filter(({ isProtected }) => isProtected).length,
  );
  assert.equal(
    registry.counts.accessRestrictedTypes,
    registry.types.filter(({ accessRestricted }) => accessRestricted).length,
  );
  assert.equal(
    registry.counts.accessRestrictedFields,
    fields.filter(({ accessRestricted }) => accessRestricted).length,
  );
  assert.equal(registry.counts.queryRootFields, registry.roots.query.fields.length);
  assert.equal(
    registry.counts.queryRootConnectionFields,
    registry.roots.query.connectionFields.length,
  );
  assert.equal(
    registry.counts.mutationRootFields,
    registry.roots.mutation?.fields.length ?? 0,
  );
  assert.equal(
    registry.counts.subscriptionRootFields,
    registry.roots.subscription?.fields.length ?? 0,
  );
  assert.equal(
    registry.counts.privatelyDocumentedTypes,
    registry.types.filter(({ isPrivatelyDocumented }) => isPrivatelyDocumented).length,
  );
  assert.equal(
    registry.counts.privatelyDocumentedFields,
    fields.filter(({ isPrivatelyDocumented }) => isPrivatelyDocumented).length,
  );
});

test("every type edge is deterministic and resolves inside the registry", () => {
  assertSortedUnique(registry.types.map(({ name }) => name), "types");
  assertSortedUnique(registry.directives.map(({ name }) => name), "directives");
  assert.equal(index.typesByName.size, registry.types.length);

  const assertTypeRef = (typeRef: string, context: string) => {
    assert.match(typeRef, /^(?:[_A-Za-z][_0-9A-Za-z]*|\[(?:[_A-Za-z][_0-9A-Za-z]*|\[(?:[_A-Za-z][_0-9A-Za-z]*!?)+\])!?\])!?$/u, `${context} has an invalid type ref`);
    const named = shopifyGraphQLNamedType(typeRef);
    assert.ok(index.typesByName.has(named), `${context} points to missing type ${named}`);
  };

  for (const type of registry.types) {
    if (type.fields) {
      assertSortedUnique(type.fields.map(({ name }) => name), `${type.name}.fields`);
      assertSortedUnique(type.interfaces ?? [], `${type.name}.interfaces`);
      for (const implemented of type.interfaces ?? []) {
        assert.equal(requiredType(implemented).kind, "INTERFACE");
      }
      for (const field of type.fields) {
        assertTypeRef(field.type, `${type.name}.${field.name}`);
        assertSortedUnique(field.args.map(({ name }) => name), `${type.name}.${field.name}.args`);
        for (const argument of field.args) {
          assertTypeRef(argument.type, `${type.name}.${field.name}(${argument.name})`);
          if (!argument.isDeprecated) assert.equal(argument.deprecationReason, undefined);
        }
        if (!field.isDeprecated) assert.equal(field.deprecationReason, undefined);
      }
    }
    if (type.inputFields) {
      assertSortedUnique(type.inputFields.map(({ name }) => name), `${type.name}.inputFields`);
      for (const field of type.inputFields) assertTypeRef(field.type, `${type.name}.${field.name}`);
    }
    if (type.enumValues) {
      assertSortedUnique(type.enumValues.map(({ name }) => name), `${type.name}.enumValues`);
    }
    if (type.possibleTypes) {
      assertSortedUnique(type.possibleTypes, `${type.name}.possibleTypes`);
      for (const possible of type.possibleTypes) {
        assert.equal(requiredType(possible).kind, "OBJECT", `${type.name} has non-object ${possible}`);
      }
    }
  }

  for (const directive of registry.directives) {
    assertSortedUnique(directive.locations, `@${directive.name}.locations`);
    assertSortedUnique(directive.args.map(({ name }) => name), `@${directive.name}.args`);
    for (const argument of directive.args) assertTypeRef(argument.type, `@${directive.name}(${argument.name})`);
  }
});

test("QueryRoot exposes a traversable inventory of every top-level connection", () => {
  assert.equal(index.queryRoot.name, "QueryRoot");
  assert.deepEqual(
    registry.roots.query.fields,
    index.queryRoot.fields?.map(({ name }) => name),
  );
  assertSortedUnique(registry.roots.query.fields, "QueryRoot root fields");
  assertSortedUnique(
    registry.roots.query.connectionFields.map(({ name }) => name),
    "QueryRoot connection fields",
  );
  assert.ok(registry.roots.query.connectionFields.length > 90);

  for (const connection of registry.roots.query.connectionFields) {
    const rootField = shopifyGraphQLField(index, "QueryRoot", connection.name);
    assert.ok(rootField, `QueryRoot.${connection.name} is missing`);
    assert.equal(shopifyGraphQLNamedType(rootField.type), connection.connectionType);
    const connectionType = requiredType(connection.connectionType);
    assert.equal(connectionType.kind, "OBJECT");
    assert.ok(connectionType.fields?.some(({ name }) => name === "pageInfo"));
    if (connection.nodeType) assert.ok(index.typesByName.has(connection.nodeType));
  }
});

test("the schema contains Shopify's complete analytics domains and access metadata", () => {
  assert.ok(registry.types.length > 3_000);
  assert.ok(registry.counts.fields > 9_000);
  assert.ok(registry.counts.enumValues > 5_000);
  assert.ok(registry.counts.protectedTypes > 50);
  assert.ok(registry.counts.deprecatedFields > 300);

  requireFields("Order", [
    "attribution",
    "currentSubtotalPriceSet",
    "currentTotalDiscountsSet",
    "currentTotalPriceSet",
    "currentTotalTaxSet",
    "displayFinancialStatus",
    "displayFulfillmentStatus",
    "fulfillments",
    "lineItems",
    "refunds",
    "transactions",
  ]);
  requireFields("Refund", ["refundLineItems", "totalRefundedSet", "transactions"]);
  requireFields("Product", ["category", "options", "status", "variants"]);
  requireFields("ProductVariant", ["inventoryItem", "price", "selectedOptions"]);
  requireFields("InventoryItem", ["inventoryLevels", "tracked", "unitCost"]);
  requireFields("Customer", ["amountSpent", "numberOfOrders", "orders"]);
  requireFields("CustomerJourneySummary", ["firstVisit", "lastVisit", "moments"]);
  requireFields("Market", ["catalogs", "currencySettings", "regions"]);
  requireFields("Company", ["contacts", "locations", "orders"]);
  requireFields("Return", ["returnLineItems", "status"]);
  requireFields("SubscriptionContract", ["billingPolicy", "deliveryPolicy", "lines"]);
  requireFields("GiftCard", ["balance", "customer", "initialValue"]);
  requireFields("Metaobject", ["definition", "fields", "handle"]);
  requireFields("ShopifyPaymentsAccount", ["balance", "disputes", "payouts"]);
  requireFields("ShopifyPaymentsPayout", ["gross", "net", "status", "transactionType"]);
  requireFields("ShopifyPaymentsDispute", ["amount", "status", "type"]);
  requireFields("StaffMember", ["active", "email", "name"]);

  const queryFields = new Set(registry.roots.query.fields);
  for (const name of [
    "catalogs",
    "companies",
    "customers",
    "giftCards",
    "inventoryItems",
    "locations",
    "markets",
    "metaobjects",
    "orders",
    "products",
    "shopifyPaymentsAccount",
    "shopifyqlQuery",
    "subscriptionContracts",
  ]) {
    assert.ok(queryFields.has(name), `QueryRoot.${name} is missing`);
  }

  const order = requiredType("Order");
  assert.equal(order.isProtected, true);
  assert.match(order.requiredAccess ?? "", /read_orders/u);
  assert.equal(shopifyGraphQLField(index, "Order", "email")?.isProtected, true);
  assert.equal(shopifyGraphQLField(index, "Order", "email")?.protectedContent, "email");
  assert.match(requiredType("Product").requiredAccess ?? "", /read_products/u);
  assert.match(requiredType("MarketingActivity").requiredAccess ?? "", /read_marketing_events/u);
  assert.match(requiredType("ShopifyPaymentsAccount").requiredAccess ?? "", /read_shopify_payments/u);
});
