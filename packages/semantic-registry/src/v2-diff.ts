import { createHash } from "node:crypto";

import type { SemanticRegistryDocumentV2 } from "./v2.js";

export type SemanticObjectTypeV2 =
  | "sourceObject"
  | "field"
  | "view"
  | "dimension"
  | "measure"
  | "relationship"
  | "relationshipCandidate"
  | "topic"
  | "businessContext";

export type SemanticDiffSeverityV2 = "high" | "medium" | "low";
export type SemanticDiffChangeV2 = Readonly<{
  objectType: SemanticObjectTypeV2;
  objectId: string;
  parentId: string | null;
  operation: "added" | "removed" | "changed";
  changedFields: readonly string[];
  severity: SemanticDiffSeverityV2;
  requiredReviewTier: "tier_1" | "tier_2" | "tier_3";
  reason: string;
}>;

export type SemanticRegistryDiffV2 = Readonly<{
  schemaVersion: 1;
  baseManifestHash: string;
  candidateManifestHash: string;
  diffHash: string;
  summary: Readonly<{
    added: number;
    removed: number;
    changed: number;
    high: number;
    medium: number;
    low: number;
    byObjectType: Readonly<Record<string, number>>;
  }>;
  changes: readonly SemanticDiffChangeV2[];
}>;

type FlatObject = Readonly<{
  objectType: SemanticObjectTypeV2;
  objectId: string;
  parentId: string | null;
  value: Readonly<Record<string, unknown>>;
}>;

const HIGH_IMPACT_FIELDS: Readonly<
  Partial<Record<SemanticObjectTypeV2, ReadonlySet<string>>>
> = Object.freeze({
  sourceObject: new Set([
    "physicalTable",
    "primaryKey",
    "grain",
    "additivity",
    "additivityAxis",
  ]),
  field: new Set([
    "physicalName",
    "dataType",
    "disposition",
    "semanticState",
    "primaryKey",
    "pii",
  ]),
  view: new Set([
    "sourceObjectId",
    "physicalTable",
    "grain",
    "primaryKey",
    "tenantField",
    "connectionField",
    "activeRecordFilter",
    "snapshotPolicy",
    "temporalAvailability",
  ]),
  measure: new Set([
    "viewId",
    "grain",
    "unit",
    "aggregation",
    "additivity",
    "currencyFieldId",
    "expression",
    "semanticState",
    "authority",
    "riskTier",
  ]),
  relationship: new Set([
    "fromViewId",
    "toViewId",
    "fromFieldId",
    "toFieldId",
    "cardinality",
    "optional",
    "supportedDirections",
    "temporalBehavior",
    "semanticState",
  ]),
  relationshipCandidate: new Set([
    "fromViewId",
    "fromFieldId",
    "targets",
    "candidateViewIds",
    "disposition",
  ]),
  topic: new Set([
    "layer",
    "defaultRootViewId",
    "viewIds",
    "relationshipIds",
    "dimensionIds",
    "measureIds",
    "defaultFilters",
    "alignOnDimensionIds",
    "semanticState",
  ]),
  businessContext: new Set(["valueType", "source", "semanticState"]),
});

const METADATA_FIELDS = new Set([
  "label",
  "description",
  "synonyms",
  "sampleQuestions",
  "ambiguityNotes",
  "unsupportedQuestions",
  "aiContext",
  "evidence",
  "reason",
  "unsupportedReason",
]);

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stable(entry)]),
    );
  return value;
}

function digest(value: unknown): string {
  const serialized = JSON.stringify(stable(value));
  return createHash("sha256")
    .update(serialized === undefined ? "undefined" : serialized)
    .digest("hex");
}

function flatten(document: SemanticRegistryDocumentV2): readonly FlatObject[] {
  const topLevel = [
    ["sourceObject", document.sourceObjects],
    ["view", document.views],
    ["dimension", document.dimensions],
    ["measure", document.measures],
    ["relationship", document.relationships],
    ["relationshipCandidate", document.relationshipCandidates],
    ["topic", document.topics],
    ["businessContext", document.businessContext],
  ] as const;
  return [
    ...topLevel.flatMap(([objectType, values]) =>
      values.map((value) => ({
        objectType,
        objectId: value.id,
        parentId: null,
        value: value as unknown as Readonly<Record<string, unknown>>,
      })),
    ),
    ...document.sourceObjects.flatMap((source) =>
      source.fields.map((field) => ({
        objectType: "field" as const,
        objectId: field.id,
        parentId: source.id,
        value: field as unknown as Readonly<Record<string, unknown>>,
      })),
    ),
  ];
}

function changedFields(
  base: Readonly<Record<string, unknown>>,
  candidate: Readonly<Record<string, unknown>>,
): readonly string[] {
  return [...new Set([...Object.keys(base), ...Object.keys(candidate)])]
    .filter((key) => key !== "id")
    .filter((key) => digest(base[key]) !== digest(candidate[key]))
    .sort();
}

function classify(
  objectType: SemanticObjectTypeV2,
  operation: SemanticDiffChangeV2["operation"],
  fields: readonly string[],
): Pick<SemanticDiffChangeV2, "severity" | "requiredReviewTier" | "reason"> {
  if (operation === "removed")
    return {
      severity: "high",
      requiredReviewTier: "tier_1",
      reason:
        "Removing a semantic object can invalidate saved questions, Topics, dependencies, evidence, or historical replay.",
    };
  if (
    operation === "added" &&
    ["sourceObject", "view", "measure", "relationship"].includes(objectType)
  )
    return {
      severity: "high",
      requiredReviewTier: "tier_1",
      reason:
        "This object can change executable query scope, grain, calculations, or join behavior.",
    };
  if (fields.some((field) => HIGH_IMPACT_FIELDS[objectType]?.has(field)))
    return {
      severity: "high",
      requiredReviewTier: "tier_1",
      reason:
        "The change touches executable semantics, grain, identity, authority, classification, or Topic membership.",
    };
  if (fields.length > 0 && fields.every((field) => METADATA_FIELDS.has(field)))
    return {
      severity: "low",
      requiredReviewTier: "tier_3",
      reason:
        "Only descriptive or routing metadata changed; executable semantics are unchanged.",
    };
  return {
    severity: "medium",
    requiredReviewTier: "tier_2",
    reason:
      "The change is not executable high risk, but it may affect discoverability, defaults, validation, or operator behavior.",
  };
}

export function diffSemanticRegistryV2(
  base: SemanticRegistryDocumentV2,
  candidate: SemanticRegistryDocumentV2,
): SemanticRegistryDiffV2 {
  const baseObjects = new Map(
    flatten(base).map((item) => [`${item.objectType}:${item.objectId}`, item]),
  );
  const candidateObjects = new Map(
    flatten(candidate).map((item) => [
      `${item.objectType}:${item.objectId}`,
      item,
    ]),
  );
  const keys = [
    ...new Set([...baseObjects.keys(), ...candidateObjects.keys()]),
  ].sort();
  const changes = keys.flatMap((key): SemanticDiffChangeV2[] => {
    const before = baseObjects.get(key);
    const after = candidateObjects.get(key);
    const item = after ?? before!;
    const operation = !before ? "added" : !after ? "removed" : "changed";
    const fields =
      before && after ? changedFields(before.value, after.value) : [];
    if (before && after && fields.length === 0) return [];
    return [
      {
        objectType: item.objectType,
        objectId: item.objectId,
        parentId: item.parentId,
        operation,
        changedFields: fields,
        ...classify(item.objectType, operation, fields),
      },
    ];
  });
  const byObjectType: Record<string, number> = {};
  for (const change of changes)
    byObjectType[change.objectType] =
      (byObjectType[change.objectType] ?? 0) + 1;
  const summary = {
    added: changes.filter(({ operation }) => operation === "added").length,
    removed: changes.filter(({ operation }) => operation === "removed").length,
    changed: changes.filter(({ operation }) => operation === "changed").length,
    high: changes.filter(({ severity }) => severity === "high").length,
    medium: changes.filter(({ severity }) => severity === "medium").length,
    low: changes.filter(({ severity }) => severity === "low").length,
    byObjectType: Object.fromEntries(
      Object.entries(byObjectType).sort(([left], [right]) =>
        left.localeCompare(right),
      ),
    ),
  };
  const baseManifestHash = digest(base);
  const candidateManifestHash = digest(candidate);
  return Object.freeze({
    schemaVersion: 1,
    baseManifestHash,
    candidateManifestHash,
    diffHash: digest({ baseManifestHash, candidateManifestHash, changes }),
    summary: Object.freeze(summary),
    changes: Object.freeze(changes),
  });
}
