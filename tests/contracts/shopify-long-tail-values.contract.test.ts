import assert from "node:assert/strict";
import test from "node:test";

import {
  SHOPIFY_ADMIN_FIELD_VALUE_AVAILABILITY,
  SHOPIFY_ADMIN_FIELD_VALUE_AVAILABILITY_COUNTS,
} from "../../connectors/shopify/field-value-availability.js";
import {
  extractShopifyPage,
  SHOPIFY_FIELD_CATALOGUE_STREAMS,
  shopifyDefinitionRegistrySha256,
} from "../../connectors/shopify/extract.js";
import {
  SHOPIFY_METAFIELD_DEFINITION_OWNER_TYPES,
  SHOPIFY_METAFIELD_OWNER_POLICIES,
  SHOPIFY_METAFIELD_VALUE_OWNER_TYPES,
} from "../../connectors/shopify/queries.js";
import { loadShopifyAdminSchemaRegistry } from "../../connectors/shopify/schema-registry.js";

const NOW = Date.parse("2026-08-12T12:00:00.000Z");

test("every official Admin field and metafield owner has one exact value-availability disposition", () => {
  const registry = loadShopifyAdminSchemaRegistry();
  const officialPaths = registry.types.flatMap((type) =>
    (type.fields ?? []).map((field) => `${type.name}.${field.name}`),
  );
  assert.equal(SHOPIFY_ADMIN_FIELD_VALUE_AVAILABILITY.length, 9_291);
  assert.deepEqual(
    new Set(SHOPIFY_ADMIN_FIELD_VALUE_AVAILABILITY.map(({ schemaPath }) => schemaPath)),
    new Set(officialPaths),
  );
  assert.equal(
    Object.values(SHOPIFY_ADMIN_FIELD_VALUE_AVAILABILITY_COUNTS).reduce((sum, count) => sum + count, 0),
    9_291,
  );
  for (const count of Object.values(SHOPIFY_ADMIN_FIELD_VALUE_AVAILABILITY_COUNTS)) {
    assert.ok(count > 0, "every availability class must be backed by an official field");
  }

  const ownerEnum = registry.types.find(({ name }) => name === "MetafieldOwnerType");
  assert.ok(ownerEnum?.enumValues);
  assert.equal(ownerEnum.enumValues.length, 26);
  assert.deepEqual(
    new Set(SHOPIFY_METAFIELD_OWNER_POLICIES.map(({ ownerType }) => ownerType)),
    new Set(ownerEnum.enumValues.map(({ name }) => name)),
  );
  assert.equal(SHOPIFY_METAFIELD_DEFINITION_OWNER_TYPES.length, 8);
  assert.deepEqual(SHOPIFY_METAFIELD_VALUE_OWNER_TYPES, SHOPIFY_METAFIELD_DEFINITION_OWNER_TYPES);
  assert.equal(
    SHOPIFY_METAFIELD_OWNER_POLICIES.filter(({ liveCoverage }) => liveCoverage === "definition_only").length,
    18,
  );
});

test("availability distinguishes observed leaves, structural selections, metafields, arguments and writes", () => {
  const byPath = new Map(SHOPIFY_ADMIN_FIELD_VALUE_AVAILABILITY.map((entry) => [entry.schemaPath, entry]));
  assert.deepEqual(
    {
      availability: byPath.get("Product.title")?.availability,
      observationForm: byPath.get("Product.title")?.observationForm,
    },
    { availability: "observed_curated", observationForm: "literal_leaf" },
  );
  assert.deepEqual(
    {
      availability: byPath.get("Product.category")?.availability,
      observationForm: byPath.get("Product.category")?.observationForm,
    },
    { availability: "observed_curated", observationForm: "structural_composite" },
  );
  assert.equal(byPath.get("Metafield.value")?.availability, "generic_metafield_ingested");
  assert.equal(byPath.get("Metafield.value")?.protected, true);
  assert.equal(byPath.get("Metafield.owner")?.observationForm, "structural_composite");
  assert.equal(byPath.get("Mutation.productCreate")?.availability, "read_only_mutation_excluded");
  assert.equal(byPath.get("QueryRoot.products")?.availability, "query_entrypoint_only");
  assert.equal(byPath.get("HasPublishedTranslations.translations")?.availability, "requires_runtime_arguments");
  assert.equal(byPath.get("Translation.value")?.availability, "runtime_observation_required");
});

test("metafield definitions paginate by definition cursor and then owner type", async () => {
  const calls: Readonly<Record<string, unknown>>[] = [];
  const first = await extractShopifyPage({
    stream: "shopify_metafield_definitions",
    mode: "initial",
    now: () => NOW,
    readAllOrders: false,
    call: async (_query, variables) => {
      calls.push(variables);
      return {
        data: {
          metafieldDefinitions: {
            edges: [{
              cursor: "definition-1",
              node: {
                __typename: "MetafieldDefinition",
                id: "gid://shopify/MetafieldDefinition/1",
                name: "Material",
                namespace: "custom",
                key: "material",
                ownerType: "SHOP",
                type: { name: "single_line_text_field", category: "TEXT" },
                access: { admin: "MERCHANT_READ_WRITE", storefront: "NONE", customerAccount: "NONE" },
                capabilities: {}, constraints: null, validations: [],
                validationStatus: "ALL_VALID", pinnedPosition: null,
                useAsCollectionCondition: false, metafieldsCount: 2,
              },
            }],
            pageInfo: { hasNextPage: true, endCursor: "definition-1" },
          },
        },
        errors: [],
      };
    },
  });
  assert.deepEqual(calls[0], { ownerType: "SHOP", first: 100, after: null });
  assert.equal(first.records.length, 1);
  assert.equal(first.records[0]?.normalized?.fields.namespace, "custom");
  assert.equal(first.records[0]?.normalized?.fields.typeName, "single_line_text_field");
  assert.deepEqual(JSON.parse(first.nextCursor?.value ?? ""), {
    version: 1, ownerTypeIndex: 0, after: "definition-1",
  });
});

test("metafield values page every literal within one definition before advancing its parent", async () => {
  const page = await extractShopifyPage({
    stream: "shopify_metafield_values",
    mode: "initial",
    now: () => NOW,
    readAllOrders: false,
    call: async (_query, variables) => {
      assert.deepEqual(variables, { ownerType: "SHOP", definitionAfter: null, valueAfter: null });
      return {
        data: {
          metafieldDefinitions: {
            edges: [{
              cursor: "definition-1",
              node: {
                id: "gid://shopify/MetafieldDefinition/1",
                ownerType: "SHOP", namespace: "custom", key: "reorder_point",
                metafields: {
                  edges: [{
                    cursor: "value-1",
                    node: {
                      __typename: "Metafield", id: "gid://shopify/Metafield/1",
                      legacyResourceId: "1", namespace: "custom", key: "reorder_point",
                      type: "number_decimal", value: "12.50", jsonValue: 12.5,
                      sizeInBytes: 5, compareDigest: "digest",
                      createdAt: "2026-08-10T00:00:00Z", updatedAt: "2026-08-11T00:00:00Z",
                      ownerType: "SHOP", owner: { __typename: "Shop", id: "gid://shopify/Shop/1" },
                      definition: { id: "gid://shopify/MetafieldDefinition/1" },
                    },
                  }],
                  pageInfo: { hasNextPage: true, endCursor: "value-1" },
                },
              },
            }],
            pageInfo: { hasNextPage: true, endCursor: "definition-1" },
          },
        },
        errors: [],
      };
    },
  });
  assert.equal(page.records.length, 1);
  assert.equal(page.records[0]?.normalized?.fields.ownerId, "gid://shopify/Shop/1");
  assert.equal(page.records[0]?.normalized?.fields.numericValue, "12.50");
  assert.equal(page.records[0]?.normalized?.fields.value, "12.50");
  assert.deepEqual(JSON.parse(page.nextCursor?.value ?? ""), {
    version: 1, ownerTypeIndex: 0, definitionAfter: null, valueAfter: "value-1",
  });
  assert.ok(SHOPIFY_FIELD_CATALOGUE_STREAMS.includes("shopify_metafield_definitions"));
  assert.ok(SHOPIFY_FIELD_CATALOGUE_STREAMS.includes("shopify_metafield_values"));
});

test("field EAV retains metafield observations privately but classifies every leaf as sensitive", async () => {
  const catalogueStream = SHOPIFY_FIELD_CATALOGUE_STREAMS.indexOf("shopify_metafield_values");
  assert.ok(catalogueStream >= 0);
  const page = await extractShopifyPage({
    stream: "shopify_fields",
    mode: "initial",
    now: () => NOW,
    readAllOrders: false,
    cursor: {
      value: JSON.stringify({
        version: 1,
        registryComplete: true,
        registrySha256: shopifyDefinitionRegistrySha256(),
        catalogueStream,
        catalogueCursor: null,
      }),
    },
    call: async (_query, variables) => {
      assert.deepEqual(variables, { ownerType: "SHOP", definitionAfter: null, valueAfter: null });
      return {
        data: {
          metafieldDefinitions: {
            edges: [{
              cursor: "definition-1",
              node: {
                id: "gid://shopify/MetafieldDefinition/1",
                ownerType: "SHOP", namespace: "private", key: "unclassified_secret",
                metafields: {
                  edges: [{
                    cursor: "value-1",
                    node: {
                      __typename: "Metafield", id: "gid://shopify/Metafield/1",
                      legacyResourceId: "1", namespace: "private", key: "unclassified_secret",
                      type: "single_line_text_field", value: "must-never-reach-public-cube",
                      jsonValue: "must-never-reach-public-cube", sizeInBytes: 28,
                      compareDigest: "digest", createdAt: "2026-08-10T00:00:00Z",
                      updatedAt: "2026-08-11T00:00:00Z", ownerType: "SHOP",
                      owner: { __typename: "Shop", id: "gid://shopify/Shop/1" },
                      definition: { id: "gid://shopify/MetafieldDefinition/1" },
                    },
                  }],
                  pageInfo: { hasNextPage: false, endCursor: "value-1" },
                },
              },
            }],
            pageInfo: { hasNextPage: false, endCursor: "definition-1" },
          },
        },
        errors: [],
      };
    },
  });

  assert.ok(page.records.length > 0);
  for (const record of page.records) {
    assert.equal(record.normalized?.fields.protectedDataLevel, "unclassified_metafield_data");
    assert.equal(record.normalized?.fields.availability, "generic_metafield_ingested");
    assert.match(String(record.normalized?.fields.availabilityReason), /always redacted from Cube/u);
  }
  const literal = page.records.find(({ normalized }) => normalized?.fields.schemaPath === "Metafield.value");
  assert.equal(literal?.normalized?.fields.stringValue, "must-never-reach-public-cube");
});
