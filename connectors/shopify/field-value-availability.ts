import {
  loadShopifyAdminSchemaRegistry,
  shopifyGraphQLNamedType,
  type ShopifyGraphQLField,
  type ShopifyGraphQLType,
} from "./schema-registry.js";
import {
  SHOPIFY_CURATED_QUERY_FIELDS,
  SHOPIFY_METAFIELD_QUERY_FIELDS,
  shopifySelectionValueForm,
} from "./query-field-selections.js";

export type ShopifyFieldValueAvailability =
  | "observed_curated"
  | "generic_metafield_ingested"
  | "runtime_observation_required"
  | "protected_approval_required"
  | "app_ownership_limited"
  | "access_restricted"
  | "requires_runtime_arguments"
  | "privately_documented"
  | "query_entrypoint_only"
  | "read_only_mutation_excluded";

export type ShopifyFieldValueAvailabilityEntry = Readonly<{
  schemaPath: string;
  parentType: string;
  fieldName: string;
  fieldType: string;
  valueForm: "leaf" | "composite";
  observationForm: "literal_leaf" | "structural_composite" | "not_selected";
  availability: ShopifyFieldValueAvailability;
  reason: string;
  requiredArguments: readonly string[];
  requiredScopes: readonly string[];
  protected: boolean;
  deprecated: boolean;
}>;

const GENERIC_METAFIELD_FIELDS = new Set([
  "Metafield.compareDigest", "Metafield.createdAt", "Metafield.definition",
  "Metafield.id", "Metafield.jsonValue", "Metafield.key",
  "Metafield.legacyResourceId", "Metafield.namespace", "Metafield.owner",
  "Metafield.ownerType", "Metafield.sizeInBytes", "Metafield.type",
  "Metafield.updatedAt", "Metafield.value",
  "MetafieldDefinition.access", "MetafieldDefinition.capabilities",
  "MetafieldDefinition.constraints", "MetafieldDefinition.description",
  "MetafieldDefinition.id", "MetafieldDefinition.key",
  "MetafieldDefinition.metafields", "MetafieldDefinition.metafieldsCount",
  "MetafieldDefinition.name", "MetafieldDefinition.namespace",
  "MetafieldDefinition.ownerType", "MetafieldDefinition.pinnedPosition",
  "MetafieldDefinition.type", "MetafieldDefinition.useAsCollectionCondition",
  "MetafieldDefinition.validationStatus", "MetafieldDefinition.validations",
  "MetafieldAccess.admin", "MetafieldAccess.customerAccount", "MetafieldAccess.storefront",
  "MetafieldCapabilities.adminFilterable", "MetafieldCapabilities.analyticsQueryable",
  "MetafieldCapabilities.cartToOrderCopyable", "MetafieldCapabilities.smartCollectionCondition",
  "MetafieldCapabilities.uniqueValues",
  "MetafieldCapabilityAdminFilterable.eligible", "MetafieldCapabilityAdminFilterable.enabled",
  "MetafieldCapabilityAdminFilterable.status",
  "MetafieldCapabilityAnalyticsQueryable.eligible", "MetafieldCapabilityAnalyticsQueryable.enabled",
  "MetafieldCapabilityCartToOrderCopyable.eligible", "MetafieldCapabilityCartToOrderCopyable.enabled",
  "MetafieldCapabilitySmartCollectionCondition.eligible", "MetafieldCapabilitySmartCollectionCondition.enabled",
  "MetafieldCapabilityUniqueValues.eligible", "MetafieldCapabilityUniqueValues.enabled",
  "MetafieldDefinitionConstraints.key",
  "MetafieldDefinitionType.category", "MetafieldDefinitionType.name",
  "MetafieldDefinitionValidation.name", "MetafieldDefinitionValidation.type",
  "MetafieldDefinitionValidation.value",
  "Node.id",
]);

const PAGINATION_ARGUMENTS = new Set(["first", "after", "last", "before", "reverse", "query"]);

function requiredArguments(field: ShopifyGraphQLField): readonly string[] {
  return field.args
    .filter((argument) => argument.type.endsWith("!") && argument.defaultValue === null)
    .map((argument) => argument.name)
    .filter((name) => !PAGINATION_ARGUMENTS.has(name));
}

function requiredScopes(type: ShopifyGraphQLType, field: ShopifyGraphQLField): readonly string[] {
  const text = `${type.requiredAccess ?? ""} ${field.requiredAccess ?? ""}`;
  return [...new Set(text.match(/\bread_[a-z0-9_]+\b/gu) ?? [])].sort();
}

function appOwnershipLimited(type: ShopifyGraphQLType, field: ShopifyGraphQLField): boolean {
  const text = `${type.description ?? ""} ${field.description ?? ""} ${type.requiredAccess ?? ""} ${field.requiredAccess ?? ""}`;
  return /(?:owned|created|provided|managed) by (?:this|the requesting|your) app|app-owned|current app(?:lication)? only/iu.test(text);
}

function classify(
  type: ShopifyGraphQLType,
  field: ShopifyGraphQLField,
): Readonly<{ availability: ShopifyFieldValueAvailability; reason: string }> {
  const path = `${type.name}.${field.name}`;
  const args = requiredArguments(field);
  if (type.name === "Mutation") {
    return {
      availability: "read_only_mutation_excluded",
      reason: "Albert never invokes Shopify Admin API mutations; the output definition remains searchable.",
    };
  }
  if (type.name === "QueryRoot") {
    return {
      availability: "query_entrypoint_only",
      reason: "QueryRoot is a planner entrypoint, not a merchant-owned field value; returned object fields carry observations.",
    };
  }
  if (field.isPrivatelyDocumented || type.isPrivatelyDocumented) {
    return {
      availability: "privately_documented",
      reason: "Shopify marks this member privately documented, so Albert does not issue an unsupported public selection.",
    };
  }
  if (SHOPIFY_CURATED_QUERY_FIELDS.has(path)) {
    return {
      availability: "observed_curated",
      reason: "Selected by a committed, schema-validated ingestion query. A value is present only when Shopify returned it for this installation.",
    };
  }
  if (args.length > 0) {
    return {
      availability: "requires_runtime_arguments",
      reason: `A value is meaningful only with caller-supplied arguments: ${args.join(", ")}.`,
    };
  }
  if (appOwnershipLimited(type, field)) {
    return {
      availability: "app_ownership_limited",
      reason: "Shopify limits this member to resources owned or created by the requesting app; Albert never implies store-wide coverage.",
    };
  }
  if (field.accessRestricted || type.accessRestricted) {
    return {
      availability: "access_restricted",
      reason: field.accessRestrictedReason ?? type.accessRestrictedReason ?? "Shopify restricts this member beyond ordinary OAuth scope access.",
    };
  }
  if (GENERIC_METAFIELD_FIELDS.has(path) || SHOPIFY_METAFIELD_QUERY_FIELDS.has(path)) {
    return {
      availability: "generic_metafield_ingested",
      reason: "Selected by Albert's bounded, cursor-paginated metafield definition/value ingestion for supported owner types; protected and unclassified literals remain redacted in Cube.",
    };
  }
  if (field.isProtected || type.isProtected) {
    return {
      availability: "protected_approval_required",
      reason: "Store values require Shopify protected-customer-data approval and remain redacted unless an approved governed surface exposes them.",
    };
  }
  return {
    availability: "runtime_observation_required",
    reason: "The definition is searchable. A merchant value exists in Albert only when an approved versioned query actually observed it.",
  };
}

/**
 * Exact machine-readable disposition for every Admin GraphQL 2026-07 output
 * field. This is intentionally computed from the pinned registry so a schema
 * upgrade cannot retain a stale hand-maintained coverage count.
 */
export const SHOPIFY_ADMIN_FIELD_VALUE_AVAILABILITY: readonly ShopifyFieldValueAvailabilityEntry[] =
  Object.freeze(loadShopifyAdminSchemaRegistry().types.flatMap((type) =>
    (type.fields ?? []).map((field) => {
      const classification = classify(type, field);
      const namedType = shopifyGraphQLNamedType(field.type);
      const outputType = loadShopifyAdminSchemaRegistry().types.find(({ name }) => name === namedType);
      return Object.freeze({
        schemaPath: `${type.name}.${field.name}`,
        parentType: type.name,
        fieldName: field.name,
        fieldType: field.type,
        valueForm: outputType && ["OBJECT", "INTERFACE", "UNION"].includes(outputType.kind)
          ? "composite" as const
          : "leaf" as const,
        observationForm: SHOPIFY_CURATED_QUERY_FIELDS.has(`${type.name}.${field.name}`)
          ? shopifySelectionValueForm(outputType)
          : SHOPIFY_METAFIELD_QUERY_FIELDS.has(`${type.name}.${field.name}`)
            ? shopifySelectionValueForm(outputType)
            : "not_selected" as const,
        ...classification,
        requiredArguments: requiredArguments(field),
        requiredScopes: requiredScopes(type, field),
        protected: Boolean(field.isProtected || type.isProtected),
        deprecated: field.isDeprecated,
      });
    }),
  ));

export const SHOPIFY_ADMIN_FIELD_VALUE_AVAILABILITY_COUNTS = Object.freeze(
  SHOPIFY_ADMIN_FIELD_VALUE_AVAILABILITY.reduce<Record<ShopifyFieldValueAvailability, number>>(
    (counts, entry) => ({ ...counts, [entry.availability]: counts[entry.availability] + 1 }),
    {
      generic_metafield_ingested: 0,
      observed_curated: 0,
      runtime_observation_required: 0,
      protected_approval_required: 0,
      app_ownership_limited: 0,
      access_restricted: 0,
      requires_runtime_arguments: 0,
      privately_documented: 0,
      query_entrypoint_only: 0,
      read_only_mutation_excluded: 0,
    },
  ),
);
