import { createHash } from "node:crypto";
import { z } from "zod";
import type { RegistryDocument } from "./schema.js";

export const SEMANTIC_REGISTRY_V2_SCHEMA_VERSION = 2 as const;

export const semanticObjectStateSchema = z.enum([
  "verified",
  "derived",
  "exploratory",
  "unsupported",
  "deprecated",
]);
export type SemanticObjectStateV2 = z.infer<typeof semanticObjectStateSchema>;

export const fieldDispositionSchema = z.enum([
  "dimension",
  "measure_input",
  "key",
  "time_role",
  "status_filter",
  "descriptive_metadata",
  "technical_lineage",
  "sensitive_metadata",
  "unsupported",
  "deprecated",
]);
export type FieldDispositionV2 = z.infer<typeof fieldDispositionSchema>;

export const sourceFieldV2Schema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_.]*$/),
    name: z.string().min(1),
    physicalName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    dataType: z.string().min(1),
    description: z.string().min(1),
    disposition: fieldDispositionSchema,
    semanticState: semanticObjectStateSchema,
    nullable: z.boolean().default(true),
    primaryKey: z.boolean().default(false),
    pii: z.boolean().default(false),
    evidence: z.array(z.string().min(1)).default([]),
    unsupportedReason: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((field, context) => {
    if (field.disposition === "unsupported" && !field.unsupportedReason) {
      context.addIssue({
        code: "custom",
        message: "Unsupported fields require a reason.",
        path: ["unsupportedReason"],
      });
    }
    if (
      field.disposition === "unsupported" &&
      field.semanticState !== "unsupported"
    )
      context.addIssue({
        code: "custom",
        message: "Unsupported fields must have Unsupported semantic state.",
        path: ["semanticState"],
      });
    if (
      field.disposition === "deprecated" &&
      field.semanticState !== "deprecated"
    )
      context.addIssue({
        code: "custom",
        message: "Deprecated fields must have Deprecated semantic state.",
        path: ["semanticState"],
      });
    if (
      !["unsupported", "deprecated"].includes(field.disposition) &&
      ["unsupported", "deprecated"].includes(field.semanticState)
    )
      context.addIssue({
        code: "custom",
        message:
          "Queryable field dispositions cannot have Unsupported or Deprecated semantic state.",
        path: ["semanticState"],
      });
  });
export type SourceFieldV2 = z.infer<typeof sourceFieldV2Schema>;

export const sourceObjectV2Schema = z
  .object({
    id: z.string().regex(/^(lightspeed|xero)\.[a-z0-9_]+$/),
    connector: z.enum(["lightspeed", "xero"]),
    domain: z.string().regex(/^[a-z][a-z0-9_]*$/),
    physicalTable: z
      .string()
      .regex(/^source_(lightspeed|xero)\.[a-z_][a-z0-9_]*$/),
    mappingVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    label: z.string().min(1),
    description: z.string().min(1),
    grain: z.string().min(1),
    primaryKey: z.array(z.string().min(1)).min(1),
    additivity: z.enum([
      "additive",
      "semi_additive",
      "non_additive",
      "not_applicable",
    ]),
    additivityAxis: z.string().min(1).nullable().default(null),
    semanticState: semanticObjectStateSchema,
    fields: z.array(sourceFieldV2Schema).min(1),
  })
  .strict();
export type SourceObjectV2 = z.infer<typeof sourceObjectV2Schema>;

export const relationshipV2Schema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_.]*$/),
    fromViewId: z.string().min(1),
    toViewId: z.string().min(1),
    fromFieldId: z.string().min(1),
    toFieldId: z.string().min(1),
    cardinality: z.enum([
      "one_to_one",
      "many_to_one",
      "one_to_many",
      "many_to_many",
    ]),
    optional: z.boolean(),
    supportedDirections: z.array(z.enum(["from_to", "to_from"])).min(1),
    temporalBehavior: z.enum([
      "current",
      "effective_dated",
      "as_of",
      "not_applicable",
    ]),
    semanticState: semanticObjectStateSchema,
    evidence: z.array(z.string().min(1)).default([]),
    unsupportedReason: z.string().min(1).optional(),
  })
  .strict();
export type RelationshipV2 = z.infer<typeof relationshipV2Schema>;

export const relationshipCandidateTargetV2Schema = z
  .object({
    viewId: z.string().min(1),
    fieldId: z.string().min(1),
    matchKind: z.enum([
      "exact_key_name",
      "role_prefixed_key",
      "self_parent_key",
      "documented",
    ]),
  })
  .strict();
export type RelationshipCandidateTargetV2 = z.infer<
  typeof relationshipCandidateTargetV2Schema
>;

export const relationshipCandidateV2Schema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_.]*$/),
    fromViewId: z.string().min(1),
    fromFieldId: z.string().min(1),
    targets: z.array(relationshipCandidateTargetV2Schema).default([]),
    candidateViewIds: z.array(z.string().min(1)).default([]),
    disposition: z.enum(["verified", "rejected", "unresolved"]),
    reason: z.string().min(1),
    evidence: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type RelationshipCandidateV2 = z.infer<
  typeof relationshipCandidateV2Schema
>;

export const semanticViewV2Schema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_.]*$/),
    label: z.string().min(1),
    description: z.string().min(1),
    sourceObjectId: z.string().min(1).optional(),
    physicalTable: z
      .string()
      .regex(/^(source_lightspeed|source_xero|core|mart)\.[a-z_][a-z0-9_]*$/),
    grain: z.string().min(1),
    primaryKey: z.array(z.string().min(1)).min(1),
    tenantField: z
      .string()
      .regex(/^[a-z_][a-z0-9_]*$/)
      .default("tenant_id"),
    connectionField: z
      .string()
      .regex(/^[a-z_][a-z0-9_]*$/)
      .optional(),
    mappingVersion: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
    activeRecordFilter: z
      .object({
        field: z.string().regex(/^[a-z_][a-z0-9_]*$/),
        value: z.boolean(),
      })
      .strict()
      .optional(),
    temporalAvailability: z
      .enum(["historical", "snapshot", "current_only"])
      .default("historical"),
    snapshotPolicy: z
      .object({
        timeFieldId: z.string().min(1),
        entityFieldIds: z.array(z.string().min(1)).min(1),
        tieBreakerFieldIds: z.array(z.string().min(1)).min(1),
      })
      .strict()
      .optional(),
    physicalFields: z
      .array(
        z
          .object({
            id: z.string().min(1),
            physicalName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
            dataType: z.string().min(1),
            semanticState: semanticObjectStateSchema,
          })
          .strict(),
      )
      .default([]),
    dimensionIds: z.array(z.string().min(1)).default([]),
    measureIds: z.array(z.string().min(1)).default([]),
    relationshipIds: z.array(z.string().min(1)).default([]),
    timeRoleIds: z.array(z.string().min(1)).default([]),
    semanticState: semanticObjectStateSchema,
  })
  .strict();
export type SemanticViewV2 = z.infer<typeof semanticViewV2Schema>;

export const dimensionV2Schema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_.]*$/),
    viewId: z.string().min(1),
    fieldId: z.string().min(1),
    label: z.string().min(1),
    description: z.string().min(1),
    synonyms: z.array(z.string().min(1)).default([]),
    dataType: z.string().min(1),
    conformedKey: z
      .string()
      .regex(/^[a-z][a-z0-9_.]*$/)
      .optional(),
    timeRole: z
      .enum([
        "event",
        "posted",
        "completed",
        "created",
        "updated",
        "snapshot",
        "none",
      ])
      .default("none"),
    semanticState: semanticObjectStateSchema,
  })
  .strict();
export type DimensionV2 = z.infer<typeof dimensionV2Schema>;

const scalarSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export const semanticFilterOperatorV2Schema = z.enum([
  "eq",
  "neq",
  "in",
  "not_in",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "is_null",
  "is_not_null",
]);

export const semanticFilterContractV2Schema = z
  .object({
    fieldId: z.string().min(1),
    op: semanticFilterOperatorV2Schema,
    values: z.array(scalarSchema).max(100).default([]),
  })
  .strict()
  .superRefine((filter, context) => {
    if (
      ["is_null", "is_not_null"].includes(filter.op) &&
      filter.values.length !== 0
    ) {
      context.addIssue({
        code: "custom",
        message: `${filter.op} does not accept values.`,
        path: ["values"],
      });
    } else if (
      ["in", "not_in"].includes(filter.op) &&
      filter.values.length === 0
    ) {
      context.addIssue({
        code: "custom",
        message: `${filter.op} requires at least one value.`,
        path: ["values"],
      });
    } else if (
      !["is_null", "is_not_null", "in", "not_in"].includes(filter.op) &&
      filter.values.length !== 1
    ) {
      context.addIssue({
        code: "custom",
        message: `${filter.op} requires exactly one value.`,
        path: ["values"],
      });
    }
    if (filter.op === "contains" && typeof filter.values[0] !== "string") {
      context.addIssue({
        code: "custom",
        message: "contains requires one string value.",
        path: ["values"],
      });
    }
    if (
      !["is_null", "is_not_null"].includes(filter.op) &&
      filter.values.some((value) => value === null)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Null filter values are ambiguous; use is_null or is_not_null.",
        path: ["values"],
      });
    }
  });
export type SemanticFilterContractV2 = z.infer<
  typeof semanticFilterContractV2Schema
>;

export type MeasureExpressionV2 =
  | { op: "field"; fieldId: string }
  | { op: "literal"; value: string }
  | { op: "metric"; measureId: string }
  | {
      op: "aggregate";
      fn:
        | "sum"
        | "avg"
        | "count"
        | "count_distinct"
        | "min"
        | "max"
        | "last_value"
        | "percentile";
      fieldId?: string;
      percentile?: number;
      filter?: {
        fieldId: string;
        comparator:
          | "eq"
          | "neq"
          | "in"
          | "not_in"
          | "gt"
          | "gte"
          | "lt"
          | "lte"
          | "is_null"
          | "is_not_null";
        values: z.infer<typeof scalarSchema>[];
      };
    }
  | {
      op: "binary";
      fn: "add" | "subtract" | "multiply" | "divide";
      left: MeasureExpressionV2;
      right: MeasureExpressionV2;
    }
  | { op: "coalesce"; values: MeasureExpressionV2[] }
  | {
      op: "conditional";
      fieldId: string;
      comparator:
        | "eq"
        | "neq"
        | "in"
        | "not_in"
        | "gt"
        | "gte"
        | "lt"
        | "lte"
        | "is_null"
        | "is_not_null";
      values?: z.infer<typeof scalarSchema>[];
      then: MeasureExpressionV2;
      otherwise: MeasureExpressionV2;
    }
  | { op: "weighted_average"; valueFieldId: string; weightFieldId: string };

export const MAX_MEASURE_EXPRESSION_DEPTH_V2 = 8;
export const MAX_MEASURE_EXPRESSION_NODES_V2 = 64;

export function measureExpressionComplexityV2(expression: unknown): Readonly<{
  nodes: number;
  depth: number;
}> {
  const pending: Array<Readonly<{ value: unknown; depth: number }>> = [
    { value: expression, depth: 1 },
  ];
  let nodes = 0;
  let depth = 0;
  while (pending.length) {
    const current = pending.pop()!;
    nodes += 1;
    depth = Math.max(depth, current.depth);
    if (
      !current.value ||
      typeof current.value !== "object" ||
      Array.isArray(current.value)
    )
      continue;
    const node = current.value as Record<string, unknown>;
    const children =
      node.op === "binary"
        ? [node.left, node.right]
        : node.op === "coalesce" && Array.isArray(node.values)
          ? node.values
          : node.op === "conditional"
            ? [node.then, node.otherwise]
            : [];
    for (const child of children)
      pending.push({ value: child, depth: current.depth + 1 });
    if (
      nodes > MAX_MEASURE_EXPRESSION_NODES_V2 ||
      depth > MAX_MEASURE_EXPRESSION_DEPTH_V2
    )
      break;
  }
  return Object.freeze({ nodes, depth });
}

export const measureExpressionV2Schema: z.ZodType<MeasureExpressionV2> = z.lazy(
  () =>
    z.discriminatedUnion("op", [
      z.object({ op: z.literal("field"), fieldId: z.string().min(1) }).strict(),
      z.object({ op: z.literal("literal"), value: z.string() }).strict(),
      z
        .object({ op: z.literal("metric"), measureId: z.string().min(1) })
        .strict(),
      z
        .object({
          op: z.literal("aggregate"),
          fn: z.enum([
            "sum",
            "avg",
            "count",
            "count_distinct",
            "min",
            "max",
            "last_value",
            "percentile",
          ]),
          fieldId: z.string().min(1).optional(),
          percentile: z.number().gt(0).lt(1).optional(),
          filter: z
            .object({
              fieldId: z.string().min(1),
              comparator: z.enum([
                "eq",
                "neq",
                "in",
                "not_in",
                "gt",
                "gte",
                "lt",
                "lte",
                "is_null",
                "is_not_null",
              ]),
              values: z.array(scalarSchema).max(100).default([]),
            })
            .strict()
            .optional(),
        })
        .strict(),
      z
        .object({
          op: z.literal("binary"),
          fn: z.enum(["add", "subtract", "multiply", "divide"]),
          left: measureExpressionV2Schema,
          right: measureExpressionV2Schema,
        })
        .strict(),
      z
        .object({
          op: z.literal("coalesce"),
          values: z.array(measureExpressionV2Schema).min(1).max(8),
        })
        .strict(),
      z
        .object({
          op: z.literal("conditional"),
          fieldId: z.string().min(1),
          comparator: z.enum([
            "eq",
            "neq",
            "in",
            "not_in",
            "gt",
            "gte",
            "lt",
            "lte",
            "is_null",
            "is_not_null",
          ]),
          values: z.array(scalarSchema).max(100).optional(),
          then: measureExpressionV2Schema,
          otherwise: measureExpressionV2Schema,
        })
        .strict(),
      z
        .object({
          op: z.literal("weighted_average"),
          valueFieldId: z.string().min(1),
          weightFieldId: z.string().min(1),
        })
        .strict(),
    ]),
);

export const measureV2Schema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_.]*$/),
    viewId: z.string().min(1),
    label: z.string().min(1),
    description: z.string().min(1),
    synonyms: z.array(z.string().min(1)).default([]),
    grain: z.string().min(1),
    unit: z.enum([
      "currency",
      "units",
      "count",
      "ratio",
      "percent",
      "hours",
      "days",
      "currency_per_unit",
    ]),
    aggregation: z.enum([
      "sum",
      "count",
      "count_distinct",
      "average",
      "ratio",
      "last_value",
      "derived",
    ]),
    additivity: z.enum(["additive", "semi_additive", "non_additive"]),
    currencyFieldId: z.string().min(1).optional(),
    expression: measureExpressionV2Schema,
    semanticState: semanticObjectStateSchema,
    authority: z.string().min(1),
    riskTier: z.enum(["tier_1", "tier_2", "tier_3"]),
    testIds: z.array(z.string().min(1)).default([]),
  })
  .strict();
export type MeasureV2 = z.infer<typeof measureV2Schema>;

export const topicV2Schema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_.]*$/),
    layer: z.enum(["source_domain", "business", "composite"]),
    label: z.string().min(1),
    description: z.string().min(1),
    aiContext: z.string().min(1),
    defaultRootViewId: z.string().min(1),
    viewIds: z.array(z.string().min(1)).min(1),
    relationshipIds: z.array(z.string().min(1)).default([]),
    dimensionIds: z.array(z.string().min(1)).default([]),
    measureIds: z.array(z.string().min(1)).default([]),
    defaultFilters: z.array(semanticFilterContractV2Schema).default([]),
    freshnessMinutes: z.number().int().positive(),
    sampleQuestions: z.array(z.string().min(1)).min(1),
    ambiguityNotes: z.array(z.string().min(1)).default([]),
    unsupportedQuestions: z.array(z.string().min(1)).default([]),
    alignOnDimensionIds: z.array(z.string().min(1)).default([]),
    semanticState: semanticObjectStateSchema,
  })
  .strict();
export type TopicV2 = z.infer<typeof topicV2Schema>;

export const businessContextDefinitionV2Schema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_.]*$/),
    label: z.string().min(1),
    description: z.string().min(1),
    valueType: z.enum([
      "string",
      "number",
      "boolean",
      "date",
      "currency",
      "string_list",
    ]),
    source: z.enum([
      "system",
      "lightspeed",
      "xero",
      "operator",
      "tenant_confirmation",
    ]),
    semanticState: semanticObjectStateSchema,
  })
  .strict();

export const semanticRegistryDocumentV2Schema = z
  .object({
    schemaVersion: z.literal(SEMANTIC_REGISTRY_V2_SCHEMA_VERSION),
    registryVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    sourceObjects: z.array(sourceObjectV2Schema),
    views: z.array(semanticViewV2Schema),
    dimensions: z.array(dimensionV2Schema),
    measures: z.array(measureV2Schema),
    relationships: z.array(relationshipV2Schema),
    relationshipCandidates: z.array(relationshipCandidateV2Schema).default([]),
    topics: z.array(topicV2Schema),
    businessContext: z.array(businessContextDefinitionV2Schema).default([]),
  })
  .strict();
export type SemanticRegistryDocumentV2 = z.infer<
  typeof semanticRegistryDocumentV2Schema
>;

export type RegistryValidationIssueV2 = Readonly<{
  code: string;
  objectId: string;
  message: string;
}>;

function duplicates(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    else seen.add(value);
  }
  return [...repeated].sort();
}

export function validateSemanticRegistryV2(
  document: SemanticRegistryDocumentV2,
): readonly RegistryValidationIssueV2[] {
  const issues: RegistryValidationIssueV2[] = [];
  const collections = [
    ["source_object", document.sourceObjects],
    ["view", document.views],
    ["dimension", document.dimensions],
    ["measure", document.measures],
    ["relationship", document.relationships],
    ["relationship_candidate", document.relationshipCandidates],
    ["topic", document.topics],
    ["business_context", document.businessContext],
  ] as const;
  for (const [kind, objects] of collections) {
    for (const id of duplicates(objects.map(({ id }) => id))) {
      issues.push({
        code: "DUPLICATE_ID",
        objectId: id,
        message: `Duplicate ${kind} id ${id}.`,
      });
    }
  }

  const sourceIds = new Set(document.sourceObjects.map(({ id }) => id));
  const views = new Map(document.views.map((view) => [view.id, view]));
  const dimensionIds = new Set(document.dimensions.map(({ id }) => id));
  const sourceById = new Map(
    document.sourceObjects.map((source) => [source.id, source]),
  );
  const dimensionsById = new Map(
    document.dimensions.map((dimension) => [dimension.id, dimension]),
  );
  const measuresById = new Map(
    document.measures.map((measure) => [measure.id, measure]),
  );
  const relationshipsById = new Map(
    document.relationships.map((relationship) => [
      relationship.id,
      relationship,
    ]),
  );
  const fieldIdsForView = (view: SemanticViewV2): Set<string> =>
    new Set([
      ...view.physicalFields.flatMap(({ id, physicalName }) => [
        id,
        physicalName,
      ]),
      ...(view.sourceObjectId
        ? (sourceById
            .get(view.sourceObjectId)
            ?.fields.flatMap(({ id, name, physicalName }) => [
              id,
              name,
              physicalName,
            ]) ?? [])
        : []),
    ]);
  const hasViewField = (viewId: string, fieldId: string): boolean => {
    const view = views.get(viewId);
    return Boolean(view && fieldIdsForView(view).has(fieldId));
  };

  for (const source of document.sourceObjects) {
    const fields = new Map(source.fields.map((field) => [field.name, field]));
    const physicalOwners = new Map<string, string>();
    const attachedViews = document.views.filter(
      ({ sourceObjectId }) => sourceObjectId === source.id,
    );
    for (const field of source.fields) {
      const materialized = !["unsupported", "deprecated"].includes(
        field.disposition,
      );
      if (materialized) {
        const owner = physicalOwners.get(field.physicalName);
        if (owner)
          issues.push({
            code: "DUPLICATE_SOURCE_PHYSICAL_FIELD",
            objectId: field.id,
            message: `${field.id} and ${owner} both expose ${source.physicalTable}.${field.physicalName}.`,
          });
        else physicalOwners.set(field.physicalName, field.id);
        if (
          !attachedViews.some((view) =>
            view.physicalFields.some(({ id }) => id === field.id),
          )
        )
          issues.push({
            code: "UNEXPOSED_MATERIALIZED_SOURCE_FIELD",
            objectId: field.id,
            message: `Materialized source field ${field.id} is absent from every attached view physical-field contract.`,
          });
      }
    }
    for (const view of attachedViews) {
      if (view.mappingVersion !== source.mappingVersion)
        issues.push({
          code: "SOURCE_VIEW_MAPPING_VERSION_DRIFT",
          objectId: view.id,
          message: `${view.id} must pin mapping version ${source.mappingVersion} for ${source.id}.`,
        });
      for (const physicalField of view.physicalFields) {
        const field = source.fields.find(({ id }) => id === physicalField.id);
        if (!field)
          issues.push({
            code: "UNKNOWN_SOURCE_VIEW_PHYSICAL_FIELD",
            objectId: view.id,
            message: `${physicalField.id} is not declared by ${source.id}.`,
          });
        else if (["unsupported", "deprecated"].includes(field.disposition))
          issues.push({
            code: "UNQUERYABLE_SOURCE_VIEW_PHYSICAL_FIELD",
            objectId: physicalField.id,
            message: `${field.id} is ${field.disposition} and cannot be physically exposed by ${view.id}.`,
          });
        else if (physicalField.physicalName !== field.physicalName)
          issues.push({
            code: "SOURCE_VIEW_PHYSICAL_NAME_DRIFT",
            objectId: physicalField.id,
            message: `${view.id} maps ${field.id} to ${physicalField.physicalName}, but the source contract requires ${field.physicalName}.`,
          });
      }
    }
    for (const key of source.primaryKey) {
      const field = fields.get(key);
      if (!field)
        issues.push({
          code: "UNKNOWN_SOURCE_KEY",
          objectId: source.id,
          message: `Primary key field ${key} is not declared.`,
        });
      else if (!field.primaryKey)
        issues.push({
          code: "INCONSISTENT_SOURCE_KEY",
          objectId: field.id,
          message: "The source primary key and field primaryKey flag disagree.",
        });
    }
  }

  for (const candidate of document.relationshipCandidates) {
    if (!views.has(candidate.fromViewId))
      issues.push({
        code: "ORPHAN_RELATIONSHIP_CANDIDATE",
        objectId: candidate.id,
        message: `Unknown source view ${candidate.fromViewId}.`,
      });
    else if (!hasViewField(candidate.fromViewId, candidate.fromFieldId))
      issues.push({
        code: "ORPHAN_RELATIONSHIP_CANDIDATE_FIELD",
        objectId: candidate.id,
        message: `Unknown candidate source field ${candidate.fromFieldId}.`,
      });
    for (const viewId of candidate.candidateViewIds)
      if (!views.has(viewId))
        issues.push({
          code: "ORPHAN_RELATIONSHIP_CANDIDATE",
          objectId: candidate.id,
          message: `Unknown candidate view ${viewId}.`,
        });
    const targetKeys = new Set<string>();
    for (const target of candidate.targets) {
      const key = `${target.viewId}:${target.fieldId}`;
      if (targetKeys.has(key))
        issues.push({
          code: "DUPLICATE_RELATIONSHIP_CANDIDATE_TARGET",
          objectId: candidate.id,
          message: `Candidate target ${key} is declared more than once.`,
        });
      targetKeys.add(key);
      const targetView = views.get(target.viewId);
      if (!targetView)
        issues.push({
          code: "ORPHAN_RELATIONSHIP_CANDIDATE_TARGET",
          objectId: candidate.id,
          message: `Unknown candidate target view ${target.viewId}.`,
        });
      else if (!hasViewField(target.viewId, target.fieldId))
        issues.push({
          code: "ORPHAN_RELATIONSHIP_CANDIDATE_TARGET_FIELD",
          objectId: candidate.id,
          message: `Unknown candidate target field ${target.fieldId}.`,
        });
      else {
        const targetSource = targetView.sourceObjectId
          ? sourceById.get(targetView.sourceObjectId)
          : undefined;
        const targetField = targetSource?.fields.find(
          ({ id }) => id === target.fieldId,
        );
        const sourceView = views.get(candidate.fromViewId);
        const candidateSource = sourceView?.sourceObjectId
          ? sourceById.get(sourceView.sourceObjectId)
          : undefined;
        const sourceField = candidateSource?.fields.find(
          ({ id }) => id === candidate.fromFieldId,
        );
        if (
          !targetField ||
          !targetSource?.primaryKey.includes(targetField.name)
        )
          issues.push({
            code: "NON_KEY_RELATIONSHIP_CANDIDATE_TARGET",
            objectId: candidate.id,
            message: `Candidate target ${target.fieldId} is not a declared source primary key.`,
          });
        else if (sourceField && sourceField.dataType !== targetField.dataType)
          issues.push({
            code: "RELATIONSHIP_CANDIDATE_TYPE_MISMATCH",
            objectId: candidate.id,
            message: `${candidate.fromFieldId} (${sourceField.dataType}) cannot join ${target.fieldId} (${targetField.dataType}).`,
          });
      }
      if (!candidate.candidateViewIds.includes(target.viewId))
        issues.push({
          code: "RELATIONSHIP_CANDIDATE_TARGET_VIEW_MISMATCH",
          objectId: candidate.id,
          message: `Candidate target ${target.fieldId} is not represented in candidateViewIds.`,
        });
    }
    for (const viewId of candidate.candidateViewIds)
      if (!candidate.targets.some((target) => target.viewId === viewId))
        issues.push({
          code: "RELATIONSHIP_CANDIDATE_VIEW_WITHOUT_TARGET_KEY",
          objectId: candidate.id,
          message: `Candidate view ${viewId} has no explicit target key.`,
        });
    if (candidate.disposition === "verified") {
      const promoted = document.relationships.filter(
        (relationship) =>
          relationship.fromViewId === candidate.fromViewId &&
          relationship.fromFieldId === candidate.fromFieldId &&
          candidate.targets.some(
            (target) =>
              target.viewId === relationship.toViewId &&
              target.fieldId === relationship.toFieldId,
          ),
      );
      if (promoted.length !== 1)
        issues.push({
          code: "UNPROVEN_VERIFIED_RELATIONSHIP_CANDIDATE",
          objectId: candidate.id,
          message:
            "A verified candidate must map to exactly one promoted relationship.",
        });
      if (
        !candidate.evidence.some((item) =>
          /^profile_receipt:[a-f0-9]{64}$/u.test(item),
        )
      )
        issues.push({
          code: "MISSING_RELATIONSHIP_PROFILE_RECEIPT",
          objectId: candidate.id,
          message:
            "Verified relationship candidates require immutable live-profile receipt evidence.",
        });
    }
    if (candidate.disposition === "rejected") {
      const promoted = document.relationships.filter(
        (relationship) =>
          relationship.fromViewId === candidate.fromViewId &&
          relationship.fromFieldId === candidate.fromFieldId &&
          candidate.targets.some(
            (target) =>
              target.viewId === relationship.toViewId &&
              target.fieldId === relationship.toFieldId,
          ),
      );
      if (promoted.length > 0)
        issues.push({
          code: "REJECTED_RELATIONSHIP_CANDIDATE_IS_PROMOTED",
          objectId: candidate.id,
          message:
            "A rejected candidate cannot retain a promoted relationship.",
        });
      if (
        !candidate.evidence.some((item) =>
          /^(operator_review|profile_receipt):[a-f0-9]{64}$/u.test(item),
        )
      )
        issues.push({
          code: "MISSING_RELATIONSHIP_REJECTION_REVIEW",
          objectId: candidate.id,
          message:
            "Rejected relationship candidates require an immutable operator-review or live-profile receipt reference.",
        });
    }
  }

  for (const view of document.views) {
    if (view.sourceObjectId && !sourceIds.has(view.sourceObjectId))
      issues.push({
        code: "ORPHAN_SOURCE",
        objectId: view.id,
        message: `Unknown source object ${view.sourceObjectId}.`,
      });
    if (
      view.sourceObjectId &&
      sourceById.get(view.sourceObjectId)?.physicalTable !== view.physicalTable
    )
      issues.push({
        code: "SOURCE_VIEW_TABLE_MISMATCH",
        objectId: view.id,
        message: "Source view physical table does not match its source object.",
      });
    for (const key of view.primaryKey)
      if (!hasViewField(view.id, key))
        issues.push({
          code: "UNKNOWN_VIEW_KEY",
          objectId: view.id,
          message: `Unknown primary key field ${key}.`,
        });
    for (const id of view.dimensionIds) {
      const dimension = dimensionsById.get(id);
      if (!dimension)
        issues.push({
          code: "ORPHAN_DIMENSION",
          objectId: view.id,
          message: `Unknown dimension ${id}.`,
        });
      else if (dimension.viewId !== view.id)
        issues.push({
          code: "CROSS_VIEW_DIMENSION_MEMBERSHIP",
          objectId: view.id,
          message: `Dimension ${id} belongs to ${dimension.viewId}.`,
        });
    }
    for (const id of view.measureIds) {
      const measure = measuresById.get(id);
      if (!measure)
        issues.push({
          code: "ORPHAN_MEASURE",
          objectId: view.id,
          message: `Unknown measure ${id}.`,
        });
      else if (measure.viewId !== view.id)
        issues.push({
          code: "CROSS_VIEW_MEASURE_MEMBERSHIP",
          objectId: view.id,
          message: `Measure ${id} belongs to ${measure.viewId}.`,
        });
    }
    for (const id of view.relationshipIds) {
      const relationship = relationshipsById.get(id);
      if (!relationship)
        issues.push({
          code: "ORPHAN_RELATIONSHIP",
          objectId: view.id,
          message: `Unknown relationship ${id}.`,
        });
      else if (
        relationship.fromViewId !== view.id &&
        relationship.toViewId !== view.id
      )
        issues.push({
          code: "UNRELATED_VIEW_RELATIONSHIP",
          objectId: view.id,
          message: `Relationship ${id} does not touch this view.`,
        });
    }
    for (const id of view.timeRoleIds) {
      const dimension = dimensionsById.get(id);
      if (
        !dimension ||
        dimension.viewId !== view.id ||
        dimension.timeRole === "none"
      )
        issues.push({
          code: "INVALID_VIEW_TIME_ROLE",
          objectId: view.id,
          message: `${id} is not a time role on this view.`,
        });
    }
    if (view.snapshotPolicy) {
      const sourceFields = view.sourceObjectId
        ? (document.sourceObjects
            .find(({ id }) => id === view.sourceObjectId)
            ?.fields.map(({ id }) => id) ?? [])
        : [];
      const availableFields = new Set([
        ...view.physicalFields.map(({ id }) => id),
        ...sourceFields,
      ]);
      for (const fieldId of [
        view.snapshotPolicy.timeFieldId,
        ...view.snapshotPolicy.entityFieldIds,
        ...view.snapshotPolicy.tieBreakerFieldIds,
      ]) {
        if (!availableFields.has(fieldId))
          issues.push({
            code: "UNKNOWN_SNAPSHOT_FIELD",
            objectId: view.id,
            message: `Unknown snapshot-policy field ${fieldId}.`,
          });
      }
    }
    if (view.temporalAvailability === "snapshot" && !view.snapshotPolicy) {
      issues.push({
        code: "MISSING_SNAPSHOT_POLICY",
        objectId: view.id,
        message: "Snapshot views require an audited latest-per-entity policy.",
      });
    }
    if (view.temporalAvailability === "current_only" && view.snapshotPolicy) {
      issues.push({
        code: "CURRENT_ONLY_WITH_SNAPSHOT_POLICY",
        objectId: view.id,
        message:
          "Current-only views cannot claim historical snapshot semantics.",
      });
    }
  }
  for (const dimension of document.dimensions) {
    const view = views.get(dimension.viewId);
    if (!view)
      issues.push({
        code: "ORPHAN_DIMENSION_VIEW",
        objectId: dimension.id,
        message: `Unknown dimension view ${dimension.viewId}.`,
      });
    else if (!hasViewField(view.id, dimension.fieldId))
      issues.push({
        code: "UNKNOWN_DIMENSION_FIELD",
        objectId: dimension.id,
        message: `Unknown field ${dimension.fieldId} on ${view.id}.`,
      });
    else if (view.sourceObjectId) {
      const field = sourceById
        .get(view.sourceObjectId)
        ?.fields.find(
          ({ id, name, physicalName }) =>
            dimension.fieldId === id ||
            dimension.fieldId === name ||
            dimension.fieldId === physicalName,
        );
      if (field && (field.pii || field.disposition === "sensitive_metadata")) {
        issues.push({
          code: "SENSITIVE_DIMENSION_EXPOSURE",
          objectId: dimension.id,
          message: `Sensitive source field ${field.id} cannot be exposed as a queryable dimension.`,
        });
      }
    }
  }
  const containsLastValue = (
    expression: MeasureExpressionV2,
    stack = new Set<string>(),
  ): boolean => {
    if (expression.op === "aggregate") return expression.fn === "last_value";
    if (expression.op === "metric") {
      if (stack.has(expression.measureId)) return false;
      const dependency = document.measures.find(
        ({ id }) => id === expression.measureId,
      );
      return dependency
        ? containsLastValue(
            dependency.expression,
            new Set([...stack, expression.measureId]),
          )
        : false;
    }
    if (expression.op === "binary")
      return (
        containsLastValue(expression.left, stack) ||
        containsLastValue(expression.right, stack)
      );
    if (expression.op === "coalesce")
      return expression.values.some((value) => containsLastValue(value, stack));
    if (expression.op === "conditional")
      return (
        containsLastValue(expression.then, stack) ||
        containsLastValue(expression.otherwise, stack)
      );
    return false;
  };
  for (const measure of document.measures) {
    const expressionComplexity = measureExpressionComplexityV2(
      measure.expression,
    );
    if (
      expressionComplexity.nodes > MAX_MEASURE_EXPRESSION_NODES_V2 ||
      expressionComplexity.depth > MAX_MEASURE_EXPRESSION_DEPTH_V2
    ) {
      issues.push({
        code: "MEASURE_EXPRESSION_COMPLEXITY_EXCEEDED",
        objectId: measure.id,
        message: `Measure expressions are limited to ${MAX_MEASURE_EXPRESSION_NODES_V2} nodes and depth ${MAX_MEASURE_EXPRESSION_DEPTH_V2}; found ${expressionComplexity.nodes} nodes at depth ${expressionComplexity.depth}.`,
      });
      continue;
    }
    const view = views.get(measure.viewId);
    if (!view) {
      issues.push({
        code: "ORPHAN_MEASURE_VIEW",
        objectId: measure.id,
        message: `Unknown measure view ${measure.viewId}.`,
      });
      continue;
    }
    if (
      containsLastValue(measure.expression) &&
      view.temporalAvailability !== "snapshot"
    ) {
      issues.push({
        code: "LAST_VALUE_REQUIRES_SNAPSHOT_VIEW",
        objectId: measure.id,
        message:
          "Last-value measures require a snapshot view with an audited policy.",
      });
    }
    if (
      measure.currencyFieldId &&
      !hasViewField(measure.viewId, measure.currencyFieldId)
    )
      issues.push({
        code: "UNKNOWN_CURRENCY_FIELD",
        objectId: measure.id,
        message: `Unknown currency field ${measure.currencyFieldId}.`,
      });
    if (
      measure.aggregation === "last_value" &&
      measure.additivity !== "semi_additive"
    )
      issues.push({
        code: "INVALID_MEASURE_ADDITIVITY",
        objectId: measure.id,
        message: "Last-value measures must be semi-additive.",
      });
    if (
      ["average", "ratio"].includes(measure.aggregation) &&
      measure.additivity === "additive"
    )
      issues.push({
        code: "INVALID_MEASURE_ADDITIVITY",
        objectId: measure.id,
        message: `${measure.aggregation} measures cannot be additive.`,
      });
  }
  const validateExpression = (
    measure: MeasureV2,
    expression: MeasureExpressionV2,
    stack: readonly string[],
  ): void => {
    const assertField = (fieldId: string) => {
      if (!hasViewField(measure.viewId, fieldId))
        issues.push({
          code: "UNKNOWN_MEASURE_FIELD",
          objectId: measure.id,
          message: `Unknown expression field ${fieldId} on ${measure.viewId}.`,
        });
    };
    const assertPredicate = (
      comparator:
        | "eq"
        | "neq"
        | "in"
        | "not_in"
        | "gt"
        | "gte"
        | "lt"
        | "lte"
        | "is_null"
        | "is_not_null",
      values: readonly z.infer<typeof scalarSchema>[],
    ) => {
      if (
        ["is_null", "is_not_null"].includes(comparator) &&
        values.length !== 0
      )
        issues.push({
          code: "INVALID_MEASURE_PREDICATE",
          objectId: measure.id,
          message: `${comparator} does not accept values.`,
        });
      else if (["in", "not_in"].includes(comparator) && values.length === 0)
        issues.push({
          code: "INVALID_MEASURE_PREDICATE",
          objectId: measure.id,
          message: `${comparator} requires at least one value.`,
        });
      else if (
        !["is_null", "is_not_null", "in", "not_in"].includes(comparator) &&
        values.length !== 1
      )
        issues.push({
          code: "INVALID_MEASURE_PREDICATE",
          objectId: measure.id,
          message: `${comparator} requires exactly one value.`,
        });
      if (
        !["is_null", "is_not_null"].includes(comparator) &&
        values.some((value) => value === null)
      )
        issues.push({
          code: "INVALID_MEASURE_PREDICATE",
          objectId: measure.id,
          message: "Null predicate values require is_null or is_not_null.",
        });
    };
    if (expression.op === "field") assertField(expression.fieldId);
    else if (expression.op === "aggregate") {
      if (expression.fn !== "count" || expression.fieldId) {
        if (!expression.fieldId)
          issues.push({
            code: "MISSING_AGGREGATE_FIELD",
            objectId: measure.id,
            message: `${expression.fn} requires a field.`,
          });
        else assertField(expression.fieldId);
      }
      if (expression.fn === "percentile" && expression.percentile === undefined)
        issues.push({
          code: "MISSING_PERCENTILE",
          objectId: measure.id,
          message: "Percentile expressions require a percentile.",
        });
      if (expression.filter) {
        assertField(expression.filter.fieldId);
        assertPredicate(expression.filter.comparator, expression.filter.values);
      }
    } else if (expression.op === "metric") {
      const dependency = measuresById.get(expression.measureId);
      if (!dependency)
        issues.push({
          code: "UNKNOWN_MEASURE_DEPENDENCY",
          objectId: measure.id,
          message: `Unknown dependency ${expression.measureId}.`,
        });
      else if (dependency.viewId !== measure.viewId)
        issues.push({
          code: "CROSS_GRAIN_MEASURE_DEPENDENCY",
          objectId: measure.id,
          message: `Dependency ${dependency.id} belongs to ${dependency.viewId}.`,
        });
      else if (stack.includes(dependency.id))
        issues.push({
          code: "MEASURE_DEPENDENCY_CYCLE",
          objectId: measure.id,
          message: `Dependency cycle ${[...stack, dependency.id].join(" -> ")}.`,
        });
      else
        validateExpression(measure, dependency.expression, [
          ...stack,
          dependency.id,
        ]);
    } else if (expression.op === "binary") {
      validateExpression(measure, expression.left, stack);
      validateExpression(measure, expression.right, stack);
    } else if (expression.op === "coalesce") {
      for (const value of expression.values)
        validateExpression(measure, value, stack);
    } else if (expression.op === "conditional") {
      assertField(expression.fieldId);
      assertPredicate(expression.comparator, expression.values ?? []);
      validateExpression(measure, expression.then, stack);
      validateExpression(measure, expression.otherwise, stack);
    } else if (expression.op === "weighted_average") {
      assertField(expression.valueFieldId);
      assertField(expression.weightFieldId);
    }
  };
  for (const measure of document.measures)
    validateExpression(measure, measure.expression, [measure.id]);
  for (const relationship of document.relationships) {
    if (
      !relationship.evidence.some((item) =>
        /^profile_receipt:[a-f0-9]{64}$/u.test(item),
      )
    ) {
      issues.push({
        code: "MISSING_RELATIONSHIP_PROFILE_RECEIPT",
        objectId: relationship.id,
        message:
          "Supported relationships require immutable live-profile receipt evidence.",
      });
    }
    if (
      !views.has(relationship.fromViewId) ||
      !views.has(relationship.toViewId)
    )
      issues.push({
        code: "ORPHAN_RELATIONSHIP_VIEW",
        objectId: relationship.id,
        message: "Relationship references an unknown view.",
      });
    else {
      if (!hasViewField(relationship.fromViewId, relationship.fromFieldId))
        issues.push({
          code: "UNKNOWN_RELATIONSHIP_FIELD",
          objectId: relationship.id,
          message: `Unknown source field ${relationship.fromFieldId}.`,
        });
      if (!hasViewField(relationship.toViewId, relationship.toFieldId))
        issues.push({
          code: "UNKNOWN_RELATIONSHIP_FIELD",
          objectId: relationship.id,
          message: `Unknown target field ${relationship.toFieldId}.`,
        });
      if (
        Boolean(views.get(relationship.fromViewId)?.connectionField) !==
        Boolean(views.get(relationship.toViewId)?.connectionField)
      )
        issues.push({
          code: "INCOMPATIBLE_RELATIONSHIP_SCOPE",
          objectId: relationship.id,
          message:
            "Relationships may not directly cross connection-scoped and unscoped views.",
        });
    }
    if (
      ["one_to_many", "many_to_many"].includes(relationship.cardinality) &&
      relationship.semanticState === "verified"
    ) {
      issues.push({
        code: "UNSAFE_VERIFIED_FANOUT",
        objectId: relationship.id,
        message: "Fan-out relationships cannot be directly Verified.",
      });
    }
    if (["effective_dated", "as_of"].includes(relationship.temporalBehavior)) {
      issues.push({
        code: "TEMPORAL_JOIN_CONTRACT_REQUIRED",
        objectId: relationship.id,
        message:
          "Effective-dated and as-of relationships require an audited temporal-key contract before publication.",
      });
    }
  }
  for (const topic of document.topics) {
    if (!views.has(topic.defaultRootViewId))
      issues.push({
        code: "UNKNOWN_TOPIC_ROOT",
        objectId: topic.id,
        message: `Unknown root view ${topic.defaultRootViewId}.`,
      });
    else if (!topic.viewIds.includes(topic.defaultRootViewId))
      issues.push({
        code: "UNEXPOSED_TOPIC_ROOT",
        objectId: topic.id,
        message: "The Topic root view must be included in viewIds.",
      });
    for (const id of topic.viewIds)
      if (!views.has(id))
        issues.push({
          code: "ORPHAN_TOPIC_VIEW",
          objectId: topic.id,
          message: `Unknown view ${id}.`,
        });
    for (const id of topic.dimensionIds) {
      const dimension = dimensionsById.get(id);
      if (!dimension)
        issues.push({
          code: "ORPHAN_TOPIC_DIMENSION",
          objectId: topic.id,
          message: `Unknown dimension ${id}.`,
        });
      else if (!topic.viewIds.includes(dimension.viewId))
        issues.push({
          code: "UNEXPOSED_TOPIC_DIMENSION_VIEW",
          objectId: topic.id,
          message: `Dimension ${id} belongs to a view outside the Topic.`,
        });
    }
    for (const id of topic.measureIds) {
      const measure = measuresById.get(id);
      if (!measure)
        issues.push({
          code: "ORPHAN_TOPIC_MEASURE",
          objectId: topic.id,
          message: `Unknown measure ${id}.`,
        });
      else if (!topic.viewIds.includes(measure.viewId))
        issues.push({
          code: "UNEXPOSED_TOPIC_MEASURE_VIEW",
          objectId: topic.id,
          message: `Measure ${id} belongs to a view outside the Topic.`,
        });
    }
    for (const id of topic.relationshipIds) {
      const relationship = relationshipsById.get(id);
      if (!relationship)
        issues.push({
          code: "ORPHAN_TOPIC_RELATIONSHIP",
          objectId: topic.id,
          message: `Unknown relationship ${id}.`,
        });
      else if (
        !topic.viewIds.includes(relationship.fromViewId) ||
        !topic.viewIds.includes(relationship.toViewId)
      )
        issues.push({
          code: "UNEXPOSED_TOPIC_RELATIONSHIP_VIEW",
          objectId: topic.id,
          message: `Relationship ${id} leaves the Topic view set.`,
        });
    }
    const joinParent = new Map<string, string>();
    const joinRoot = (viewId: string): string => {
      const parent = joinParent.get(viewId);
      if (!parent) {
        joinParent.set(viewId, viewId);
        return viewId;
      }
      if (parent === viewId) return viewId;
      const root = joinRoot(parent);
      joinParent.set(viewId, root);
      return root;
    };
    for (const id of topic.relationshipIds) {
      const relationship = relationshipsById.get(id);
      if (!relationship) continue;
      const fromRoot = joinRoot(relationship.fromViewId);
      const toRoot = joinRoot(relationship.toViewId);
      if (fromRoot === toRoot)
        issues.push({
          code: "AMBIGUOUS_TOPIC_JOIN_PATH",
          objectId: topic.id,
          message: `Relationship ${id} creates a second semantic path inside the Topic.`,
        });
      else joinParent.set(toRoot, fromRoot);
    }
    for (const filter of topic.defaultFilters)
      if (!topic.dimensionIds.includes(filter.fieldId))
        issues.push({
          code: "UNEXPOSED_TOPIC_FILTER",
          objectId: topic.id,
          message: `Default filter ${filter.fieldId} is not an exposed dimension.`,
        });
    for (const id of topic.alignOnDimensionIds) {
      if (!dimensionIds.has(id))
        issues.push({
          code: "ORPHAN_TOPIC_ALIGNMENT",
          objectId: topic.id,
          message: `Unknown alignment dimension ${id}.`,
        });
      else if (!topic.dimensionIds.includes(id))
        issues.push({
          code: "UNEXPOSED_TOPIC_ALIGNMENT",
          objectId: topic.id,
          message: `Alignment dimension ${id} is not exposed by the Topic.`,
        });
    }
    if (topic.layer === "composite") {
      if (topic.viewIds.length < 2)
        issues.push({
          code: "COMPOSITE_REQUIRES_MULTIPLE_VIEWS",
          objectId: topic.id,
          message:
            "Composite Topics require at least two independently aggregated views.",
        });
      const alignmentDimensions = topic.alignOnDimensionIds
        .map((id) =>
          document.dimensions.find((dimension) => dimension.id === id),
        )
        .filter(Boolean);
      const alignmentViews = new Set(
        alignmentDimensions.map((dimension) => dimension?.viewId),
      );
      if (alignmentViews.size < 2)
        issues.push({
          code: "COMPOSITE_REQUIRES_ALIGNMENT",
          objectId: topic.id,
          message:
            "Composite Topics require conformed alignment dimensions from at least two independent views.",
        });
      const alignedKeys = new Map<string, Set<string>>();
      for (const dimension of alignmentDimensions) {
        if (!dimension?.conformedKey)
          issues.push({
            code: "ALIGNMENT_REQUIRES_CONFORMED_KEY",
            objectId: topic.id,
            message: `Alignment dimension ${dimension?.id ?? "unknown"} has no conformed key.`,
          });
        else
          alignedKeys.set(
            dimension.conformedKey,
            new Set([
              ...(alignedKeys.get(dimension.conformedKey) ?? []),
              dimension.viewId,
            ]),
          );
      }
      if (
        ![...alignedKeys.values()].some(
          (alignedViews) => alignedViews.size >= 2,
        )
      )
        issues.push({
          code: "COMPOSITE_REQUIRES_SHARED_KEY",
          objectId: topic.id,
          message:
            "Composite Topics require at least one conformed key shared by independent views.",
        });
    }
  }
  return Object.freeze(issues);
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stable(entry)]),
    );
  }
  return value;
}

export function semanticRegistryV2Digest(
  document: SemanticRegistryDocumentV2,
): string {
  return createHash("sha256")
    .update(JSON.stringify(stable(document)))
    .digest("hex");
}

export type SemanticPublicationV2 = Readonly<{
  schemaVersion: 2;
  registryVersion: string;
  publicationHash: string;
  objectCounts: Readonly<
    Record<
      | "sourceObjects"
      | "fields"
      | "views"
      | "dimensions"
      | "measures"
      | "relationships"
      | "relationshipCandidates"
      | "topics",
      number
    >
  >;
  manifest: SemanticRegistryDocumentV2;
}>;

export function createSemanticPublicationV2(
  input: unknown,
): SemanticPublicationV2 {
  const manifest = semanticRegistryDocumentV2Schema.parse(input);
  const issues = validateSemanticRegistryV2(manifest);
  if (issues.length)
    throw new Error(
      `Semantic registry V2 is invalid: ${issues.map((issue) => `${issue.code}:${issue.objectId}`).join(", ")}`,
    );
  return Object.freeze({
    schemaVersion: 2,
    registryVersion: manifest.registryVersion,
    publicationHash: semanticRegistryV2Digest(manifest),
    objectCounts: Object.freeze({
      sourceObjects: manifest.sourceObjects.length,
      fields: manifest.sourceObjects.reduce(
        (total, source) => total + source.fields.length,
        0,
      ),
      views: manifest.views.length,
      dimensions: manifest.dimensions.length,
      measures: manifest.measures.length,
      relationships: manifest.relationships.length,
      relationshipCandidates: manifest.relationshipCandidates.length,
      topics: manifest.topics.length,
    }),
    manifest,
  });
}

export function importRegistryV1(
  document: RegistryDocument,
): SemanticRegistryDocumentV2 {
  const factSemanticState = (
    factId: string,
  ): "verified" | "derived" | "exploratory" => {
    const evidenceTier = document.facts.find(({ id }) => id === factId)
      ?.evidenceTier;
    return evidenceTier !== undefined && evidenceTier >= 3
      ? "verified"
      : evidenceTier !== undefined && evidenceTier >= 1
        ? "derived"
        : "exploratory";
  };
  const currencyFieldForFact = (factId: string): string | undefined => {
    const fact = document.facts.find(({ id }) => id === factId);
    return fact?.fields.find(
      (field) => field === "currency" || field === "currency_code",
    );
  };
  return semanticRegistryDocumentV2Schema.parse({
    schemaVersion: 2,
    registryVersion: document.registryVersion,
    sourceObjects: [],
    views: document.facts.map((fact) => ({
      id: fact.id,
      label: fact.id.replaceAll("_", " "),
      description: `Imported V1 fact ${fact.id}.`,
      physicalTable: fact.table,
      grain: `one ${fact.grainKey} per row`,
      primaryKey: [fact.grainKey],
      temporalAvailability: fact.snapshotFields.length
        ? "snapshot"
        : "historical",
      ...(fact.snapshotFields.length
        ? {
            snapshotPolicy: {
              timeFieldId:
                fact.timeFields.find((field) => /snapshot/u.test(field)) ??
                fact.timeFields[0],
              entityFieldIds: fact.snapshotEntityKeys,
              tieBreakerFieldIds: [fact.grainKey],
            },
          }
        : {}),
      physicalFields: fact.fields.map((field) => ({
        id: field,
        physicalName: field,
        dataType: "unknown",
        semanticState:
          fact.evidenceTier >= 3
            ? "verified"
            : fact.evidenceTier >= 1
              ? "derived"
              : "exploratory",
      })),
      dimensionIds: [
        ...fact.joins.map((join) => `${fact.id}.${join.dimension}`),
        ...fact.timeFields.map((field) => `${fact.id}.${field}`),
        ...(currencyFieldForFact(fact.id)
          ? [`${fact.id}.${currencyFieldForFact(fact.id)}`]
          : []),
      ],
      measureIds: document.metrics
        .filter((metric) => metric.baseFact === fact.id)
        .map(({ id }) => id),
      relationshipIds: [],
      timeRoleIds: fact.timeFields.map((field) => `${fact.id}.${field}`),
      semanticState:
        fact.evidenceTier >= 3
          ? "verified"
          : fact.evidenceTier >= 1
            ? "derived"
            : "exploratory",
    })),
    dimensions: document.facts.flatMap((fact) => [
      ...fact.joins.map((join) => ({
        id: `${fact.id}.${join.dimension}`,
        viewId: fact.id,
        fieldId: join.factKey,
        label: join.dimension.replaceAll("_", " "),
        description: `Imported V1 dimension ${join.dimension}.`,
        synonyms: [],
        dataType: "text",
        conformedKey: join.dimension,
        timeRole: "none" as const,
        semanticState: factSemanticState(fact.id),
      })),
      ...fact.timeFields.map((field) => ({
        id: `${fact.id}.${field}`,
        viewId: fact.id,
        fieldId: field,
        label: field.replaceAll("_", " "),
        description: `Imported V1 time role ${field}.`,
        synonyms: [],
        dataType: field.endsWith("_date") ? "date" : "timestamp",
        conformedKey: `calendar.${field}`,
        timeRole: "event" as const,
        semanticState: factSemanticState(fact.id),
      })),
      ...(currencyFieldForFact(fact.id)
        ? [
            {
              id: `${fact.id}.${currencyFieldForFact(fact.id)}`,
              viewId: fact.id,
              fieldId: currencyFieldForFact(fact.id)!,
              label: "currency",
              description:
                "Currency code governing monetary values on this fact grain.",
              synonyms: ["currency code"],
              dataType: "text" as const,
              conformedKey: "finance.currency",
              timeRole: "none" as const,
              semanticState: factSemanticState(fact.id),
            },
          ]
        : []),
    ]),
    measures: document.metrics.map((metric) => ({
      id: metric.id,
      viewId: metric.baseFact,
      label: metric.label,
      description: metric.description,
      synonyms: metric.synonyms,
      grain: metric.grain,
      unit: metric.unit,
      aggregation: metric.aggregation,
      ...(metric.unit.startsWith("currency") &&
      currencyFieldForFact(metric.baseFact)
        ? { currencyFieldId: currencyFieldForFact(metric.baseFact) }
        : {}),
      additivity:
        metric.aggregation === "sum"
          ? "additive"
          : metric.aggregation === "last_value"
            ? "semi_additive"
            : "non_additive",
      expression: convertV1Calculation(metric.calculation),
      semanticState: factSemanticState(metric.baseFact),
      authority: metric.authority,
      riskTier:
        metric.unit === "currency" || metric.aggregation === "ratio"
          ? "tier_1"
          : "tier_2",
      testIds: metric.tests.map(
        (test, index) => `${metric.id}.test_${index + 1}.${test.kind}`,
      ),
    })),
    relationships: [],
    relationshipCandidates: [],
    topics: document.topics.map((topic) => ({
      id: topic.id,
      layer: topic.composite ? "composite" : "business",
      label: topic.label,
      description: topic.description,
      aiContext: topic.aiContext,
      defaultRootViewId: topic.baseFacts[0],
      viewIds: topic.baseFacts,
      relationshipIds: [],
      dimensionIds: topic.approvedDimensions
        .flatMap((dimension) =>
          topic.baseFacts.flatMap((factId) => {
            const fact = document.facts.find(({ id }) => id === factId);
            if (!fact) return [];
            if (fact.timeFields.includes(dimension))
              return [`${factId}.${dimension}`];
            const join = fact.joins.find(
              (candidate) =>
                candidate.dimension === dimension ||
                Object.hasOwn(candidate.fields, dimension),
            );
            return join ? [`${factId}.${join.dimension}`] : [];
          }),
        )
        .concat(
          topic.baseFacts.flatMap((factId) =>
            currencyFieldForFact(factId)
              ? [`${factId}.${currencyFieldForFact(factId)}`]
              : [],
          ),
        )
        .filter((id, index, all) => all.indexOf(id) === index),
      measureIds: topic.metrics,
      defaultFilters: topic.defaultFilters.map((filter) => ({
        fieldId: filter.field,
        op: filter.op,
        values: filter.values,
      })),
      freshnessMinutes: topic.freshnessMinutes,
      sampleQuestions: topic.sampleQuestions,
      ambiguityNotes: [],
      unsupportedQuestions: [],
      alignOnDimensionIds: topic.alignOn,
      semanticState: topic.baseFacts.every(
        (factId) => factSemanticState(factId) === "verified",
      )
        ? "verified"
        : "derived",
    })),
    businessContext: [],
  });
}

function convertV1Calculation(
  calculation: RegistryDocument["metrics"][number]["calculation"],
): MeasureExpressionV2 {
  switch (calculation.op) {
    case "field":
      return { op: "field", fieldId: calculation.field };
    case "literal":
      return { op: "literal", value: calculation.value };
    case "metric":
      return { op: "metric", measureId: calculation.metric };
    case "sum":
    case "avg":
    case "count":
    case "count_distinct":
    case "last_value":
    case "min":
    case "max":
      return {
        op: "aggregate",
        fn: calculation.op,
        ...(calculation.field ? { fieldId: calculation.field } : {}),
        ...(calculation.filter
          ? {
              filter: {
                fieldId: calculation.filter.field,
                comparator: calculation.filter.op,
                values: calculation.filter.values,
              },
            }
          : {}),
      };
    case "add":
    case "subtract":
    case "multiply":
    case "divide":
      return {
        op: "binary",
        fn: calculation.op,
        left: convertV1Calculation(calculation.left),
        right: convertV1Calculation(calculation.right),
      };
    case "conditional":
      return {
        op: "conditional",
        fieldId: calculation.condition.field,
        comparator: calculation.condition.op,
        values: calculation.condition.values,
        then: convertV1Calculation(calculation.value),
        otherwise: convertV1Calculation(calculation.otherwise),
      };
  }
}
