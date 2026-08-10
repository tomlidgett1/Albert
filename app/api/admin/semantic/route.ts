import { createHash } from "node:crypto";
import { ulid } from "ulid";
import { z } from "zod";
import evaluationCorpusJson from "@/evals/v2-evaluation-corpus.json";
import { queryBlockV2Schema } from "@/packages/analytics-v2/src/workspace";
import {
  compileQueryWorkspaceV2,
  SemanticCompilerV2Error,
} from "@/packages/compiler/src/v2";
import { SEMANTIC_V2_ADMIN_FALLBACK } from "@/packages/semantic-registry/src/generated-v2-admin";
import generatedRegistry from "@/packages/semantic-registry/registry/registry.v2.json";
import {
  semanticProfileReceiptDigestV2,
  verifySemanticProfileReceiptAttestationV2,
} from "@/packages/semantic-registry/src/profile-receipt-attestation";
import {
  createSemanticPublicationV2,
  MAX_MEASURE_EXPRESSION_DEPTH_V2,
  MAX_MEASURE_EXPRESSION_NODES_V2,
  measureExpressionComplexityV2,
  semanticRegistryDocumentV2Schema,
  semanticRegistryV2Digest,
  validateSemanticRegistryV2,
  type MeasureExpressionV2,
  type SemanticRegistryDocumentV2,
} from "@/packages/semantic-registry/src/v2";
import { diffSemanticRegistryV2 } from "@/packages/semantic-registry/src/v2-diff";
import {
  planSemanticRelationshipResolutionsV2,
  type RelationshipProfileReceiptV2,
} from "@/scripts/lib/semantic-v2-relationship-resolution";
import { isInternalOperator } from "@/services/control-plane/src/operator-repository";
import {
  ControlPlaneError,
  currentTenantContext,
  requireUser,
} from "@/services/control-plane/src/web-repository";

const sectionSchema = z.enum([
  "overview",
  "sources",
  "relationships",
  "views",
  "measures",
  "topics",
  "context",
  "test_lab",
  "publications",
  "inbox",
  "health",
]);
const evaluationCaseSchema = z
  .object({
    id: z.string().min(1),
    ask: z.string().min(1),
    source: z.enum(["lightspeed", "xero", "lightspeed_xero"]),
    difficulty: z.enum(["easy", "medium", "hard", "adversarial"]),
    questionClass: z.enum([
      "lookup",
      "comparison",
      "diagnosis",
      "recommendation",
      "open_exploration",
    ]),
    expectedTerminalState: z.enum([
      "verified",
      "derived",
      "exploratory",
      "clarification",
      "no_data",
      "unavailable",
    ]),
    visibility: z.enum(["visible", "hidden"]),
    expectedOperator: z.string().nullable(),
    tags: z.array(z.string()),
    thread: z.string().optional(),
    followUpOf: z.string().optional(),
  })
  .passthrough();
const evaluationCorpus = z
  .array(evaluationCaseSchema)
  .length(200)
  .parse(evaluationCorpusJson);
const semanticHealthSchema = z
  .object({
    schemaVersion: z.literal(1),
    windowStart: z.string(),
    generatedAt: z.string(),
    turnCount: z.number().int().nonnegative(),
    answerStates: z.record(z.string(), z.number().int().nonnegative()),
    rates: z.object({
      answerability: z.number().min(0).max(1).nullable(),
      clarification: z.number().min(0).max(1).nullable(),
      unavailable: z.number().min(0).max(1).nullable(),
    }),
    eventKinds: z.record(z.string(), z.number().int().nonnegative()),
    eventReasons: z.array(
      z.object({
        reasonCode: z.string(),
        eventKind: z.string(),
        count: z.number().int().nonnegative(),
      }),
    ),
    topicUsage: z.array(
      z.object({ id: z.string(), count: z.number().int().nonnegative() }),
    ),
    objectUsage: z.array(
      z.object({ id: z.string(), count: z.number().int().nonnegative() }),
    ),
    latency: z.object({
      queryCount: z.number().int().nonnegative(),
      p50Ms: z.number().nonnegative().nullable(),
      p95Ms: z.number().nonnegative().nullable(),
    }),
  })
  .strict();
const profileReceiptSchema = z
  .object({
    schemaVersion: z.literal(2),
    status: z.enum(["complete", "incomplete"]),
    publicationHash: z.string().regex(/^[a-f0-9]{64}$/),
    tenantDigest: z.string().regex(/^[a-f0-9]{64}$/),
    relationshipProfiles: z
      .array(
        z
          .object({
            candidateId: z.string().min(1),
            targets: z
              .array(
                z
                  .object({
                    targetViewId: z.string().min(1),
                    targetFieldId: z.string().min(1),
                    sourceRows: z.number().int().nonnegative(),
                    sourceForeignKeys: z.number().int().nonnegative(),
                    nullForeignKeys: z.number().int().nonnegative(),
                    sampledForeignKeys: z.number().int().nonnegative(),
                    profileCoverageComplete: z.boolean(),
                    orphanRows: z.number().int().nonnegative(),
                    maximumTargetMatches: z.number().int().nonnegative(),
                    ambiguousRows: z.number().int().nonnegative(),
                    duplicateTargetKeyGroups: z.number().int().nonnegative(),
                    recommendedCardinality: z.string().min(1),
                    recommendedDisposition: z.string().min(1),
                  })
                  .passthrough(),
              )
              .default([]),
          })
          .passthrough(),
      )
      .default([]),
    errors: z.array(z.unknown()).default([]),
    attestation: z
      .object({
        algorithm: z.literal("hmac-sha256"),
        keyPurpose: z.literal("semantic-profile-v2"),
        signature: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict(),
  })
  .passthrough();
const relationshipPromotionFields = {
  candidateId: z.string().min(1),
  targetViewId: z.string().min(1),
  targetFieldId: z.string().min(1),
  cardinality: z.literal("many_to_one"),
  optional: z.boolean(),
  temporalBehavior: z.enum([
    "current",
    "effective_dated",
    "as_of",
    "not_applicable",
  ]),
  profileReceiptHash: z.string().regex(/^[a-f0-9]{64}$/),
  topicIds: z.array(z.string().min(1)).max(20).default([]),
  notes: z.string().min(1).max(2000),
} as const;
const relationshipRejectionFields = {
  candidateId: z.string().min(1),
  reason: z.string().trim().min(10).max(2000),
  evidence: z.array(z.string().trim().min(3).max(1000)).min(1).max(20),
} as const;
const relationshipDecisionSchema = z.discriminatedUnion("disposition", [
  z
    .object({ disposition: z.literal("promote"), ...relationshipPromotionFields })
    .strict(),
  z
    .object({ disposition: z.literal("reject"), ...relationshipRejectionFields })
    .strict(),
]);
type RelationshipPromotionInput = Readonly<{
  candidateId: string;
  targetViewId: string;
  targetFieldId: string;
  cardinality: "many_to_one";
  optional: boolean;
  temporalBehavior: "current" | "effective_dated" | "as_of" | "not_applicable";
  profileReceiptHash: string;
  topicIds: readonly string[];
  notes: string;
}>;
type RelationshipRejectionInput = Readonly<{
  candidateId: string;
  reason: string;
  evidence: readonly string[];
}>;
const mutationSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("create_draft"),
      name: z.string().min(1).max(160),
    })
    .strict(),
  z
    .object({
      action: z.literal("register_profile_receipt"),
      receipt: z.unknown(),
    })
    .strict(),
  z
    .object({
      action: z.literal("promote_relationship_candidate"),
      draftId: z.string().min(1),
      expectedRevision: z.number().int().positive(),
      ...relationshipPromotionFields,
    })
    .strict(),
  z
    .object({
      action: z.literal("reject_relationship_candidate"),
      draftId: z.string().min(1),
      expectedRevision: z.number().int().positive(),
      ...relationshipRejectionFields,
    })
    .strict(),
  z
    .object({
      action: z.literal("batch_relationship_decisions"),
      draftId: z.string().min(1),
      expectedRevision: z.number().int().positive(),
      decisions: z
        .array(relationshipDecisionSchema)
        .min(1)
        .max(100)
        .refine(
          (decisions) =>
            new Set(decisions.map(({ candidateId }) => candidateId)).size ===
            decisions.length,
          "A relationship candidate may appear only once in a batch.",
        ),
    })
    .strict(),
  z
    .object({
      action: z.literal("update_object"),
      draftId: z.string().min(1),
      expectedRevision: z.number().int().positive(),
      objectType: z.enum([
        "sourceObject",
        "field",
        "view",
        "dimension",
        "measure",
        "relationship",
        "relationshipCandidate",
        "topic",
        "businessContext",
      ]),
      objectId: z.string().min(1),
      parentId: z.string().min(1).optional(),
      changes: z.record(z.string(), z.unknown()),
      changeSummary: z.string().min(1).max(1000),
    })
    .strict(),
  z
    .object({
      action: z.literal("validate_draft"),
      draftId: z.string().min(1),
      expectedRevision: z.number().int().positive(),
    })
    .strict(),
  z
    .object({
      action: z.literal("review_object"),
      draftId: z.string().min(1),
      expectedRevision: z.number().int().positive(),
      objectId: z.string().min(1),
      riskTier: z.enum(["tier_1", "tier_2", "tier_3"]),
      disposition: z.enum(["approved", "changes_requested", "sampled"]),
      notes: z.string().max(2000).nullable().default(null),
    })
    .strict(),
  z
    .object({
      action: z.literal("publish_draft"),
      draftId: z.string().min(1),
      expectedRevision: z.number().int().positive(),
      validationId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      action: z.literal("activate_publication"),
      publicationHash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  z.object({ action: z.literal("rollback_publication") }).strict(),
  z
    .object({
      action: z.literal("set_business_context_value"),
      contextKey: z.string().regex(/^[a-z][a-z0-9_.]{0,159}$/),
      expectedVersion: z.number().int().nonnegative(),
      value: z.unknown(),
      source: z.enum(["operator", "tenant_confirmation"]),
      evidence: z.array(z.record(z.string(), z.unknown())).max(20).default([]),
    })
    .strict(),
  z
    .object({
      action: z.literal("preview_topic_context"),
      topicId: z.string().min(1),
      question: z.string().trim().min(1).max(2_000),
      draftId: z.string().min(1).optional(),
      expectedRevision: z.number().int().positive().optional(),
    })
    .strict(),
]);

type AdminItem = Record<string, unknown>;

function verifyProfileReceiptAttestation(
  receipt: z.infer<typeof profileReceiptSchema>,
): void {
  const secret = process.env.ALBERT_SEMANTIC_PROFILE_SIGNING_SECRET?.trim();
  if (!secret || secret.length < 32)
    throw new ControlPlaneError(
      "Semantic profiling attestation is not configured.",
      503,
    );
  if (!verifySemanticProfileReceiptAttestationV2(receipt, secret)) {
    throw new ControlPlaneError(
      "The semantic profiling receipt attestation is invalid.",
      422,
    );
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function matches(item: AdminItem, query: string): boolean {
  if (!query) return true;
  return [
    item.id,
    item.label,
    item.description,
    item.domain,
    item.connector,
    item.layer,
    item.semanticState,
    item.disposition,
  ].some((value) => text(value).includes(query));
}

function lexicalTokens(value: string): Set<string> {
  return new Set(value.toLowerCase().match(/[a-z0-9]+/gu) ?? []);
}

function lexicalScore(
  question: Set<string>,
  values: readonly string[],
): number {
  const candidate = lexicalTokens(values.join(" "));
  let score = 0;
  for (const token of question)
    if (candidate.has(token))
      score += token.length > 5 ? 3 : token.length > 3 ? 2 : 1;
  return score;
}

function page(
  items: readonly AdminItem[],
  query: string,
  offset: number,
  limit: number,
) {
  const filtered = items.filter((item) => matches(item, query));
  return {
    items: filtered.slice(offset, offset + limit),
    total: filtered.length,
    offset,
    limit,
  };
}

function countBy<T>(
  values: readonly T[],
  key: (value: T) => string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[key(value)] = (counts[key(value)] ?? 0) + 1;
  return counts;
}

function evaluationCorpusSummary(query: string) {
  const visible = evaluationCorpus.filter(({ visibility }) => visibility === "visible");
  const normalized = query.trim().toLowerCase();
  const matching = visible.filter((item) =>
    !normalized
      ? true
      : [
          item.id,
          item.ask,
          item.source,
          item.difficulty,
          item.questionClass,
          item.expectedTerminalState,
          item.expectedOperator ?? "",
          ...item.tags,
        ].some((value) => value.toLowerCase().includes(normalized)),
  );
  return Object.freeze({
    total: evaluationCorpus.length,
    visible: visible.length,
    hidden: evaluationCorpus.length - visible.length,
    allocations: Object.freeze({
      source: countBy(evaluationCorpus, ({ source }) => source),
      difficulty: countBy(evaluationCorpus, ({ difficulty }) => difficulty),
      questionClass: countBy(
        evaluationCorpus,
        ({ questionClass }) => questionClass,
      ),
      terminalState: countBy(
        evaluationCorpus,
        ({ expectedTerminalState }) => expectedTerminalState,
      ),
    }),
    runtimePolicy: Object.freeze({
      model: "gpt-5.6-luna",
      reasoningEffort: "max",
      fastMode: false,
      proMode: false,
      maximumExecutions: 200,
      deputyAllowed: false,
    }),
    matchingVisibleCount: matching.length,
    cases: Object.freeze(
      matching.slice(0, 40).map((item) =>
        Object.freeze({
          id: item.id,
          ask: item.ask,
          source: item.source,
          difficulty: item.difficulty,
          questionClass: item.questionClass,
          expectedTerminalState: item.expectedTerminalState,
          expectedOperator: item.expectedOperator,
          tags: item.tags,
          thread: item.thread ?? null,
          followUpOf: item.followUpOf ?? null,
        }),
      ),
    ),
  });
}

async function loadSemanticHealth() {
  const { supabase } = await requireUser();
  const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000).toISOString();
  const { data, error } = await supabase.rpc(
    "albert_semantic_v2_admin_health",
    { p_since: since },
  );
  if (error?.code === "PGRST202" || error?.code === "42883")
    return Object.freeze({
      available: false as const,
      reason: "Deploy migration 0103 to enable aggregate V2 runtime health.",
    });
  if (error)
    throw new ControlPlaneError("Semantic runtime health could not be loaded.", 503);
  return Object.freeze({
    available: true as const,
    summary: semanticHealthSchema.parse(data),
  });
}

async function persistenceSummary() {
  const { supabase } = await requireUser();
  const control = supabase.schema("control_plane");
  const [
    drafts,
    active,
    publications,
    qualifications,
    validations,
    reviews,
    profileReceipts,
    contextValues,
    runtimeEvents,
  ] = await Promise.all([
    control
      .from("semantic_v2_drafts")
      .select("draft_id,name,revision,status,manifest_hash,updated_at", {
        count: "exact",
      })
      .order("updated_at", { ascending: false })
      .limit(30),
    control
      .from("semantic_v2_active_publication")
      .select("publication_hash,previous_publication_hash,activated_at")
      .eq("singleton", true)
      .maybeSingle(),
    control
      .from("semantic_v2_publications")
      .select(
        "publication_hash,registry_version,object_counts,source_draft_id,source_draft_revision,created_at",
      )
      .order("created_at", { ascending: false })
      .limit(30),
    control
      .from("semantic_v2_activation_qualifications")
      .select("publication_hash,commit_sha,status,created_at")
      .order("created_at", { ascending: false })
      .limit(30),
    control
      .from("semantic_v2_validation_reports")
      .select(
        "validation_id,draft_id,draft_revision,manifest_hash,status,issues,deterministic_test_receipt,created_at",
      )
      .order("created_at", { ascending: false })
      .limit(60),
    control
      .from("semantic_v2_object_reviews")
      .select(
        "draft_id,draft_revision,object_id,risk_tier,disposition,reviewer_id,created_at",
      )
      .order("created_at", { ascending: false })
      .limit(500),
    control
      .from("semantic_v2_profile_receipts")
      .select(
        "profile_receipt_hash,publication_hash,tenant_digest,status,created_at",
      )
      .order("created_at", { ascending: false })
      .limit(100),
    control
      .from("business_context_v2")
      .select("context_id,context_key,version,value,source,evidence,valid_from")
      .is("valid_to", null)
      .order("context_key")
      .limit(500),
    control
      .from("semantic_runtime_events_v2")
      .select(
        "event_id,turn_id,publication_hash,event_kind,reason_code,question_digest,topic_ids,object_ids,detail,created_at",
      )
      .order("created_at", { ascending: false })
      .limit(500),
  ]);
  const responses = [
    drafts,
    active,
    publications,
    qualifications,
    validations,
    reviews,
    profileReceipts,
    contextValues,
    runtimeEvents,
  ];
  const unavailable = responses.some(
    ({ error }) => error?.code === "42P01" || error?.code === "PGRST205",
  );
  if (unavailable)
    return {
      available: false,
      drafts: [],
      publications: [],
      qualifications: [],
      validations: [],
      reviews: [],
      profileReceipts: [],
      contextValues: [],
      runtimeEvents: [],
      active: null,
    };
  if (responses.some(({ error }) => error))
    throw new ControlPlaneError(
      "Semantic authoring state could not be loaded.",
      503,
    );
  return {
    available: true,
    drafts: drafts.data ?? [],
    draftCount: drafts.count ?? 0,
    publications: publications.data ?? [],
    qualifications: qualifications.data ?? [],
    validations: validations.data ?? [],
    reviews: reviews.data ?? [],
    profileReceipts: profileReceipts.data ?? [],
    contextValues: contextValues.data ?? [],
    runtimeEvents: runtimeEvents.data ?? [],
    active: active.data ?? null,
  };
}

async function relationshipResolutionEvidence(
  document: SemanticRegistryDocumentV2,
  publicationHash: string,
): Promise<ReadonlyMap<string, Record<string, unknown>>> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase
    .schema("control_plane")
    .from("semantic_v2_profile_receipts")
    .select("profile_receipt_hash,publication_hash,status,artifact,created_at")
    .eq("publication_hash", publicationHash)
    .eq("status", "complete")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error?.code === "42P01" || error?.code === "PGRST205") return new Map();
  if (error)
    throw new ControlPlaneError(
      "Relationship profiling evidence could not be loaded.",
      503,
    );
  if (!data) return new Map();
  const receipt = profileReceiptSchema.parse(data.artifact);
  const resolutions = planSemanticRelationshipResolutionsV2(
    document,
    receipt as unknown as RelationshipProfileReceiptV2,
  );
  return new Map(
    resolutions.map((resolution) => [
      resolution.candidateId,
      {
        ...resolution,
        profileReceiptHash: data.profile_receipt_hash,
        profilePublicationHash: data.publication_hash,
        profiledAt: data.created_at,
      },
    ]),
  );
}

function documentSection(
  document: SemanticRegistryDocumentV2,
  section: z.infer<typeof sectionSchema>,
): readonly AdminItem[] {
  if (section === "sources")
    return document.sourceObjects.map((source) => ({
      ...source,
      fieldCount: source.fields.length,
    })) as unknown as readonly AdminItem[];
  if (section === "relationships")
    return [
      ...document.relationships,
      ...document.relationshipCandidates,
    ] as unknown as readonly AdminItem[];
  if (section === "views")
    return document.views.map((view) => ({
      ...view,
      dimensions: document.dimensions
        .filter(({ viewId }) => viewId === view.id)
        .map((item) => ({ ...item, _objectType: "dimension" })),
      measures: document.measures
        .filter(({ viewId }) => viewId === view.id)
        .map((item) => ({ ...item, _objectType: "measure" })),
      relationships: document.relationships
        .filter(
          ({ fromViewId, toViewId }) =>
            fromViewId === view.id || toViewId === view.id,
        )
        .map((item) => ({ ...item, _objectType: "relationship" })),
    })) as unknown as readonly AdminItem[];
  if (section === "measures")
    return document.measures as unknown as readonly AdminItem[];
  if (section === "topics" || section === "test_lab")
    return document.topics.map((topic) => ({
      ...topic,
      measureCount: topic.measureIds.length,
      dimensionCount: topic.dimensionIds.length,
    })) as unknown as readonly AdminItem[];
  if (section === "context")
    return document.businessContext as unknown as readonly AdminItem[];
  if (section === "inbox")
    return document.relationshipCandidates as unknown as readonly AdminItem[];
  return [];
}

function expressionReferences(expression: MeasureExpressionV2): Readonly<{
  fieldIds: readonly string[];
  measureIds: readonly string[];
}> {
  const fieldIds = new Set<string>();
  const measureIds = new Set<string>();
  const pending: MeasureExpressionV2[] = [expression];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.op === "field") fieldIds.add(node.fieldId);
    else if (node.op === "metric") measureIds.add(node.measureId);
    else if (node.op === "aggregate") {
      if (node.fieldId) fieldIds.add(node.fieldId);
      if (node.filter) fieldIds.add(node.filter.fieldId);
    } else if (node.op === "binary") pending.push(node.left, node.right);
    else if (node.op === "coalesce") pending.push(...node.values);
    else if (node.op === "conditional") {
      fieldIds.add(node.fieldId);
      pending.push(node.then, node.otherwise);
    } else if (node.op === "weighted_average") {
      fieldIds.add(node.valueFieldId);
      fieldIds.add(node.weightFieldId);
    }
  }
  return Object.freeze({
    fieldIds: Object.freeze([...fieldIds].sort()),
    measureIds: Object.freeze([...measureIds].sort()),
  });
}

function measureAuthoringContext(
  document: SemanticRegistryDocumentV2,
  measureId: string,
) {
  const measure = document.measures.find(({ id }) => id === measureId);
  if (!measure)
    throw new ControlPlaneError(`Measure ${measureId} was not found.`, 404);
  const view = document.views.find(({ id }) => id === measure.viewId);
  if (!view)
    throw new ControlPlaneError(
      `Measure ${measureId} references missing view ${measure.viewId}.`,
      409,
    );
  const source = view.sourceObjectId
    ? document.sourceObjects.find(({ id }) => id === view.sourceObjectId)
    : null;
  const fieldById = new Map<
    string,
    {
      id: string;
      label: string;
      dataType: string;
      semanticState: string;
      disposition: string;
    }
  >();
  for (const field of source?.fields ?? [])
    fieldById.set(field.id, {
      id: field.id,
      label: field.name,
      dataType: field.dataType,
      semanticState: field.semanticState,
      disposition: field.disposition,
    });
  for (const field of view.physicalFields)
    if (!fieldById.has(field.id))
      fieldById.set(field.id, {
        id: field.id,
        label: field.physicalName,
        dataType: field.dataType,
        semanticState: field.semanticState,
        disposition: "physical_field",
      });
  const direct = expressionReferences(measure.expression);
  const sameViewMeasures = document.measures
    .filter(({ viewId }) => viewId === view.id)
    .map((item) => ({
      id: item.id,
      label: item.label,
      unit: item.unit,
      aggregation: item.aggregation,
      semanticState: item.semanticState,
      selected: item.id === measure.id,
    }))
    .sort((left, right) => left.label.localeCompare(right.label));
  const dependents = document.measures
    .filter(
      (candidate) =>
        candidate.id !== measure.id &&
        expressionReferences(candidate.expression).measureIds.includes(
          measure.id,
        ),
    )
    .map(({ id, label, viewId }) => ({ id, label, viewId }))
    .sort((left, right) => left.label.localeCompare(right.label));
  return Object.freeze({
    measureId: measure.id,
    view: {
      id: view.id,
      label: view.label,
      grain: view.grain,
      temporalAvailability: view.temporalAvailability,
    },
    fields: Object.freeze(
      [...fieldById.values()].sort((left, right) =>
        left.label.localeCompare(right.label),
      ),
    ),
    measures: Object.freeze(sameViewMeasures),
    dependencies: direct,
    dependents: Object.freeze(dependents),
    topics: Object.freeze(
      document.topics
        .filter(({ measureIds }) => measureIds.includes(measure.id))
        .map(({ id, label, layer }) => ({ id, label, layer }))
        .sort((left, right) => left.label.localeCompare(right.label)),
    ),
    limits: {
      maximumNodes: MAX_MEASURE_EXPRESSION_NODES_V2,
      maximumDepth: MAX_MEASURE_EXPRESSION_DEPTH_V2,
    },
  });
}

function topicAuthoringContext(
  document: SemanticRegistryDocumentV2,
  topicId: string,
) {
  const topic = document.topics.find(({ id }) => id === topicId);
  if (!topic)
    throw new ControlPlaneError(`Topic ${topicId} was not found.`, 404);
  const selectedViews = new Set(topic.viewIds);
  const selectedDimensions = new Set(topic.dimensionIds);
  const selectedMeasures = new Set(topic.measureIds);
  const selectedRelationships = new Set(topic.relationshipIds);
  const alignedDimensions = new Set(topic.alignOnDimensionIds);
  const viewsById = new Map(document.views.map((view) => [view.id, view]));
  return Object.freeze({
    topicId: topic.id,
    layer: topic.layer,
    views: Object.freeze(
      document.views
        .map((view) => ({
          id: view.id,
          label: view.label,
          grain: view.grain,
          temporalAvailability: view.temporalAvailability,
          semanticState: view.semanticState,
          selected: selectedViews.has(view.id),
          root: topic.defaultRootViewId === view.id,
        }))
        .sort((left, right) => left.label.localeCompare(right.label)),
    ),
    dimensions: Object.freeze(
      document.dimensions
        .map((dimension) => ({
          id: dimension.id,
          label: dimension.label,
          viewId: dimension.viewId,
          viewLabel:
            viewsById.get(dimension.viewId)?.label ?? dimension.viewId,
          dataType: dimension.dataType,
          timeRole: dimension.timeRole,
          conformedKey: dimension.conformedKey ?? null,
          semanticState: dimension.semanticState,
          selected: selectedDimensions.has(dimension.id),
          aligned: alignedDimensions.has(dimension.id),
        }))
        .sort((left, right) =>
          left.viewLabel.localeCompare(right.viewLabel) ||
          left.label.localeCompare(right.label),
        ),
    ),
    measures: Object.freeze(
      document.measures
        .map((measure) => ({
          id: measure.id,
          label: measure.label,
          viewId: measure.viewId,
          viewLabel: viewsById.get(measure.viewId)?.label ?? measure.viewId,
          unit: measure.unit,
          aggregation: measure.aggregation,
          semanticState: measure.semanticState,
          selected: selectedMeasures.has(measure.id),
        }))
        .sort((left, right) =>
          left.viewLabel.localeCompare(right.viewLabel) ||
          left.label.localeCompare(right.label),
        ),
    ),
    relationships: Object.freeze(
      document.relationships
        .map((relationship) => ({
          id: relationship.id,
          fromViewId: relationship.fromViewId,
          fromViewLabel:
            viewsById.get(relationship.fromViewId)?.label ??
            relationship.fromViewId,
          toViewId: relationship.toViewId,
          toViewLabel:
            viewsById.get(relationship.toViewId)?.label ??
            relationship.toViewId,
          cardinality: relationship.cardinality,
          semanticState: relationship.semanticState,
          selected: selectedRelationships.has(relationship.id),
        }))
        .sort((left, right) =>
          left.fromViewLabel.localeCompare(right.fromViewLabel) ||
          left.toViewLabel.localeCompare(right.toViewLabel),
        ),
    ),
    impact: {
      defaultFilters: topic.defaultFilters.length,
      sampleQuestions: topic.sampleQuestions.length,
      ambiguityNotes: topic.ambiguityNotes.length,
      unsupportedQuestions: topic.unsupportedQuestions.length,
      reviewTier: topic.layer === "composite" ? "tier_1" : "tier_3",
    },
  });
}

function relationshipGraphData(
  document: SemanticRegistryDocumentV2,
  resolutionEvidence: ReadonlyMap<string, Record<string, unknown>>,
) {
  const viewGroup = (viewId: string) => {
    if (viewId.startsWith("source.lightspeed.")) return "Lightspeed";
    if (viewId.startsWith("source.xero.")) return "Xero";
    if (viewId.startsWith("commerce")) return "Commerce";
    if (viewId.startsWith("finance")) return "Finance";
    return viewId.split(".")[0] ?? "Other";
  };
  const objects: AdminItem[] = [
    ...document.relationships.map((relationship) => ({
      ...relationship,
      _objectType: "relationship",
    })),
    ...document.relationshipCandidates.map((candidate) => ({
      ...candidate,
      _objectType: "relationshipCandidate",
      ...(resolutionEvidence.has(candidate.id)
        ? { profileResolution: resolutionEvidence.get(candidate.id) }
        : {}),
    })),
  ];
  const edges = [
    ...document.relationships.map((relationship) => ({
      id: `edge.${relationship.id}`,
      objectId: relationship.id,
      fromViewId: relationship.fromViewId,
      toViewId: relationship.toViewId,
      fromFieldId: relationship.fromFieldId,
      toFieldId: relationship.toFieldId,
      kind: "relationship" as const,
      status: "supported" as const,
      cardinality: relationship.cardinality,
      matchKind: null,
    })),
    ...document.relationshipCandidates.flatMap((candidate) => {
      const targets = candidate.targets.length
        ? candidate.targets
        : candidate.candidateViewIds.map((viewId) => ({
            viewId,
            fieldId: "unresolved",
            matchKind: "documented" as const,
          }));
      return targets.map((target, index) => ({
        id: `edge.${candidate.id}.${index}`,
        objectId: candidate.id,
        fromViewId: candidate.fromViewId,
        toViewId: target.viewId,
        fromFieldId: candidate.fromFieldId,
        toFieldId: target.fieldId,
        kind: "candidate" as const,
        status: candidate.disposition,
        cardinality: null,
        matchKind: target.matchKind,
      }));
    }),
  ];
  return Object.freeze({
    nodes: Object.freeze(
      document.views
        .map((view) => ({
          id: view.id,
          label: view.label,
          grain: view.grain,
          group: viewGroup(view.id),
          semanticState: view.semanticState,
        }))
        .sort((left, right) =>
          left.group.localeCompare(right.group) ||
          left.label.localeCompare(right.label),
        ),
    ),
    edges: Object.freeze(edges),
    objects: Object.freeze(objects),
    counts: {
      views: document.views.length,
      supported: document.relationships.length,
      unresolved: document.relationshipCandidates.filter(
        ({ disposition }) => disposition === "unresolved",
      ).length,
      rejected: document.relationshipCandidates.filter(
        ({ disposition }) => disposition === "rejected",
      ).length,
      conflicts: document.relationshipCandidates.filter(
        ({ targets, candidateViewIds }) =>
          new Set([
            ...targets.map(({ viewId }) => viewId),
            ...candidateViewIds,
          ]).size > 1,
      ).length,
      fanoutWarnings: document.relationships.filter(({ cardinality }) =>
        ["one_to_many", "many_to_many"].includes(cardinality),
      ).length,
    },
  });
}

function documentOverview(document: SemanticRegistryDocumentV2) {
  const fields = document.sourceObjects.flatMap(
    ({ fields: sourceFields }) => sourceFields,
  );
  const semanticObjects = [
    ...document.sourceObjects,
    ...fields,
    ...document.views,
    ...document.dimensions,
    ...document.measures,
    ...document.relationships,
    ...document.topics,
  ];
  const semanticStateCounts = Object.fromEntries(
    ["verified", "derived", "exploratory", "unsupported", "deprecated"].map(
      (state) => [
        state,
        semanticObjects.filter((item) => item.semanticState === state).length,
      ],
    ),
  );
  const fieldDispositionCounts = Object.fromEntries(
    [...new Set(fields.map(({ disposition }) => disposition))]
      .sort()
      .map((disposition) => [
        disposition,
        fields.filter((field) => field.disposition === disposition).length,
      ]),
  );
  const physicalMapping = {
    materialized: fields.filter(
      ({ disposition }) =>
        disposition !== "unsupported" && disposition !== "deprecated",
    ).length,
    unsupported: fields.filter(
      ({ disposition }) => disposition === "unsupported",
    ).length,
    aliased: fields.filter(
      ({ name, physicalName, disposition }) =>
        name !== physicalName &&
        disposition !== "unsupported" &&
        disposition !== "deprecated",
    ).length,
  };
  const connector = (id: "lightspeed" | "xero") => ({
    objects: document.sourceObjects.filter(
      ({ connector: sourceConnector }) => sourceConnector === id,
    ).length,
    fields: document.sourceObjects
      .filter(({ connector: sourceConnector }) => sourceConnector === id)
      .reduce((total, source) => total + source.fields.length, 0),
  });
  return {
    publicationHash: semanticRegistryV2Digest(document),
    registryVersion: document.registryVersion,
    objectCounts: {
      sourceObjects: document.sourceObjects.length,
      fields: fields.length,
      views: document.views.length,
      dimensions: document.dimensions.length,
      measures: document.measures.length,
      relationships: document.relationships.length,
      relationshipCandidates: document.relationshipCandidates.length,
      topics: document.topics.length,
    },
    semanticStateCounts,
    fieldDispositionCounts,
    physicalMapping,
    sourceConnectorCounts: {
      lightspeed: connector("lightspeed"),
      xero: connector("xero"),
    },
    unresolvedRelationships: document.relationshipCandidates.filter(
      ({ disposition }) => disposition === "unresolved",
    ).length,
    topicLayers: Object.fromEntries(
      ["source_domain", "business", "composite"].map((layer) => [
        layer,
        document.topics.filter((topic) => topic.layer === layer).length,
      ]),
    ),
  };
}

function replaceObject(
  document: SemanticRegistryDocumentV2,
  input: Extract<z.infer<typeof mutationSchema>, { action: "update_object" }>,
): SemanticRegistryDocumentV2 {
  const clone = structuredClone(document);
  const allowed: Readonly<Record<typeof input.objectType, readonly string[]>> =
    {
      sourceObject: [
        "label",
        "description",
        "grain",
        "additivity",
        "additivityAxis",
        "semanticState",
      ],
      field: [
        "description",
        "disposition",
        "semanticState",
        "nullable",
        "pii",
        "unsupportedReason",
      ],
      view: [
        "label",
        "description",
        "grain",
        "primaryKey",
        "temporalAvailability",
        "snapshotPolicy",
        "dimensionIds",
        "measureIds",
        "relationshipIds",
        "timeRoleIds",
        "semanticState",
      ],
      dimension: [
        "label",
        "description",
        "synonyms",
        "dataType",
        "timeRole",
        "semanticState",
      ],
      measure: [
        "label",
        "description",
        "synonyms",
        "grain",
        "unit",
        "aggregation",
        "additivity",
        "currencyFieldId",
        "expression",
        "semanticState",
        "authority",
        "riskTier",
        "testIds",
      ],
      relationship: [
        "fromViewId",
        "toViewId",
        "fromFieldId",
        "toFieldId",
        "cardinality",
        "optional",
        "supportedDirections",
        "temporalBehavior",
        "semanticState",
        "evidence",
        "unsupportedReason",
      ],
      relationshipCandidate: [
        "targets",
        "candidateViewIds",
        "disposition",
        "reason",
        "evidence",
      ],
      topic: [
        "label",
        "description",
        "aiContext",
        "defaultRootViewId",
        "viewIds",
        "relationshipIds",
        "dimensionIds",
        "measureIds",
        "defaultFilters",
        "freshnessMinutes",
        "sampleQuestions",
        "ambiguityNotes",
        "unsupportedQuestions",
        "alignOnDimensionIds",
        "semanticState",
      ],
      businessContext: [
        "label",
        "description",
        "valueType",
        "source",
        "semanticState",
      ],
    };
  const unexpected = Object.keys(input.changes).filter(
    (key) => !allowed[input.objectType].includes(key),
  );
  if (unexpected.length)
    throw new ControlPlaneError(
      `These properties cannot be edited: ${unexpected.join(", ")}.`,
      400,
    );
  let candidate: Record<string, unknown> | undefined;
  if (input.objectType === "field") {
    const parent = clone.sourceObjects.find(({ id }) => id === input.parentId);
    candidate = parent?.fields.find(
      ({ id }) => id === input.objectId,
    ) as unknown as Record<string, unknown> | undefined;
  } else {
    const collections = {
      sourceObject: clone.sourceObjects,
      view: clone.views,
      dimension: clone.dimensions,
      measure: clone.measures,
      relationship: clone.relationships,
      relationshipCandidate: clone.relationshipCandidates,
      topic: clone.topics,
      businessContext: clone.businessContext,
    } as const;
    candidate = collections[input.objectType].find(
      ({ id }) => id === input.objectId,
    ) as unknown as Record<string, unknown> | undefined;
  }
  if (!candidate)
    throw new ControlPlaneError(
      `Semantic object ${input.objectId} was not found in the draft.`,
      404,
    );
  const normalizedChanges = { ...input.changes };
  if (
    input.objectType === "measure" &&
    normalizedChanges.currencyFieldId === null
  ) {
    delete candidate.currencyFieldId;
    delete normalizedChanges.currencyFieldId;
  }
  if (
    input.objectType === "relationshipCandidate" &&
    [
      "disposition",
      "evidence",
      "fromViewId",
      "fromFieldId",
      "targets",
      "candidateViewIds",
    ].some((key) => Object.hasOwn(input.changes, key))
  )
    throw new ControlPlaneError(
      "Relationship candidate identity, evidence, and disposition may only change through the governed promotion or rejection workflows.",
      422,
    );
  if (
    input.objectType === "measure" &&
    Object.hasOwn(normalizedChanges, "expression")
  ) {
    const complexity = measureExpressionComplexityV2(
      normalizedChanges.expression,
    );
    if (
      complexity.nodes > MAX_MEASURE_EXPRESSION_NODES_V2 ||
      complexity.depth > MAX_MEASURE_EXPRESSION_DEPTH_V2
    )
      throw new ControlPlaneError(
        `Measure expressions are limited to ${MAX_MEASURE_EXPRESSION_NODES_V2} nodes and depth ${MAX_MEASURE_EXPRESSION_DEPTH_V2}.`,
        422,
      );
  }
  Object.assign(candidate, normalizedChanges);
  return semanticRegistryDocumentV2Schema.parse(clone);
}

function rejectRelationshipCandidate(
  document: SemanticRegistryDocumentV2,
  input: RelationshipRejectionInput,
  reviewerId: string,
): SemanticRegistryDocumentV2 {
  const clone = structuredClone(document);
  const candidate = clone.relationshipCandidates.find(
    ({ id }) => id === input.candidateId,
  );
  if (!candidate)
    throw new ControlPlaneError(
      `Relationship candidate ${input.candidateId} was not found.`,
      404,
    );
  if (candidate.disposition !== "unresolved")
    throw new ControlPlaneError(
      `Relationship candidate ${input.candidateId} is already ${candidate.disposition}.`,
      409,
    );
  const promoted = clone.relationships.find(
    (relationship) =>
      relationship.fromViewId === candidate.fromViewId &&
      relationship.fromFieldId === candidate.fromFieldId &&
      candidate.targets.some(
        (target) =>
          target.viewId === relationship.toViewId &&
          target.fieldId === relationship.toFieldId,
      ),
  );
  if (promoted)
    throw new ControlPlaneError(
      `${input.candidateId} cannot be rejected while ${promoted.id} exists.`,
      409,
    );
  const reviewerDigest = createHash("sha256")
    .update("semantic-v2-relationship-review\0")
    .update(reviewerId)
    .digest("hex");
  candidate.disposition = "rejected";
  candidate.reason = input.reason;
  candidate.evidence = [
    ...candidate.evidence,
    `operator_review:${reviewerDigest}`,
    ...input.evidence.map((item) => `review_evidence:${item}`),
  ];
  return semanticRegistryDocumentV2Schema.parse(clone);
}

function promoteRelationshipCandidate(
  document: SemanticRegistryDocumentV2,
  input: RelationshipPromotionInput,
): Readonly<{ document: SemanticRegistryDocumentV2; relationshipId: string }> {
  const clone = structuredClone(document);
  const candidate = clone.relationshipCandidates.find(
    ({ id }) => id === input.candidateId,
  );
  if (!candidate)
    throw new ControlPlaneError(
      `Relationship candidate ${input.candidateId} was not found.`,
      404,
    );
  if (candidate.disposition !== "unresolved")
    throw new ControlPlaneError(
      `Relationship candidate ${input.candidateId} is already ${candidate.disposition}.`,
      409,
    );
  const candidateTarget = candidate.targets.find(
    ({ viewId, fieldId }) =>
      viewId === input.targetViewId && fieldId === input.targetFieldId,
  );
  if (!candidateTarget)
    throw new ControlPlaneError(
      `${input.targetViewId}:${input.targetFieldId} is not an explicit target for ${input.candidateId}.`,
      400,
    );
  const fromView = clone.views.find(({ id }) => id === candidate.fromViewId);
  const targetView = clone.views.find(({ id }) => id === input.targetViewId);
  if (!fromView || !targetView)
    throw new ControlPlaneError(
      "The relationship candidate references an unknown view.",
      400,
    );
  const source = fromView.sourceObjectId
    ? clone.sourceObjects.find(({ id }) => id === fromView.sourceObjectId)
    : undefined;
  const target = targetView.sourceObjectId
    ? clone.sourceObjects.find(({ id }) => id === targetView.sourceObjectId)
    : undefined;
  const sourceField =
    source?.fields.find(({ id }) => id === candidate.fromFieldId) ??
    fromView.physicalFields.find(({ id }) => id === candidate.fromFieldId);
  if (!sourceField)
    throw new ControlPlaneError(
      `Candidate source field ${candidate.fromFieldId} no longer exists.`,
      400,
    );
  const targetField = target?.fields.find(
    ({ id }) => id === candidateTarget.fieldId,
  );
  if (!target || !targetField || !target.primaryKey.includes(targetField.name))
    throw new ControlPlaneError(
      `The explicit target ${input.targetFieldId} is not a primary key for ${input.targetViewId}.`,
      400,
    );
  const relationshipId = input.candidateId.replace(
    /^candidate\./u,
    "relationship.",
  );
  if (clone.relationships.some(({ id }) => id === relationshipId))
    throw new ControlPlaneError(
      `Relationship ${relationshipId} already exists.`,
      409,
    );
  clone.relationships.push({
    id: relationshipId,
    fromViewId: candidate.fromViewId,
    toViewId: input.targetViewId,
    fromFieldId: candidate.fromFieldId,
    toFieldId: targetField.id,
    cardinality: input.cardinality,
    optional: input.optional,
    supportedDirections: ["from_to"],
    temporalBehavior: input.temporalBehavior,
    semanticState: "exploratory",
    evidence: [
      `profile_receipt:${input.profileReceiptHash}`,
      `candidate_match:${candidateTarget.matchKind}`,
      input.notes,
    ],
  });
  fromView.relationshipIds = [
    ...new Set([...fromView.relationshipIds, relationshipId]),
  ];
  targetView.relationshipIds = [
    ...new Set([...targetView.relationshipIds, relationshipId]),
  ];
  for (const topicId of input.topicIds) {
    const topic = clone.topics.find(({ id }) => id === topicId);
    if (!topic)
      throw new ControlPlaneError(`Topic ${topicId} was not found.`, 400);
    if (
      !topic.viewIds.includes(fromView.id) ||
      !topic.viewIds.includes(targetView.id)
    )
      throw new ControlPlaneError(
        `Topic ${topicId} must expose both relationship views before the join is enabled.`,
        400,
      );
    topic.relationshipIds = [
      ...new Set([...topic.relationshipIds, relationshipId]),
    ];
  }
  candidate.disposition = "verified";
  candidate.reason = `Promoted to ${relationshipId}; the relationship remains Exploratory until risk-tier review and publication qualification pass.`;
  candidate.evidence = [
    ...candidate.evidence,
    `profile_receipt:${input.profileReceiptHash}`,
    input.notes,
  ];
  return Object.freeze({
    document: semanticRegistryDocumentV2Schema.parse(clone),
    relationshipId,
  });
}

async function loadDraft(draftId: string, expectedRevision: number) {
  const { supabase, user } = await requireUser();
  const { data, error } = await supabase
    .schema("control_plane")
    .from("semantic_v2_drafts")
    .select(
      "draft_id,base_publication_hash,revision,manifest,manifest_hash,status",
    )
    .eq("draft_id", draftId)
    .maybeSingle();
  if (error)
    throw new ControlPlaneError("The semantic draft could not be loaded.", 503);
  if (!data)
    throw new ControlPlaneError("The semantic draft was not found.", 404);
  if (data.revision !== expectedRevision)
    throw new ControlPlaneError(
      `Draft revision conflict. Current revision is ${data.revision}.`,
      409,
    );
  return {
    supabase,
    user,
    row: data,
    document: semanticRegistryDocumentV2Schema.parse(data.manifest),
  };
}

type LoadedSemanticDraft = Awaited<ReturnType<typeof loadDraft>>;

async function requirePromotionProfile(
  loaded: LoadedSemanticDraft,
  input: RelationshipPromotionInput,
  cache: Map<string, z.infer<typeof profileReceiptSchema>>,
): Promise<void> {
  let receipt = cache.get(input.profileReceiptHash);
  if (!receipt) {
    const profileRow = await loaded.supabase
      .schema("control_plane")
      .from("semantic_v2_profile_receipts")
      .select("publication_hash,status,artifact")
      .eq("profile_receipt_hash", input.profileReceiptHash)
      .maybeSingle();
    if (profileRow.error)
      throw new ControlPlaneError(
        "The profiling receipt could not be verified.",
        503,
      );
    if (!profileRow.data)
      throw new ControlPlaneError(
        "Register the immutable profiling receipt before promoting this relationship.",
        422,
      );
    receipt = profileReceiptSchema.parse(profileRow.data.artifact);
    const expectedProfilePublication =
      loaded.row.base_publication_hash ??
      SEMANTIC_V2_ADMIN_FALLBACK.publicationHash;
    if (
      profileRow.data.status !== "complete" ||
      receipt.status !== "complete" ||
      receipt.errors.length > 0
    )
      throw new ControlPlaneError(
        "Relationship promotion requires a complete, error-free profiling receipt.",
        422,
      );
    if (
      profileRow.data.publication_hash !== expectedProfilePublication ||
      receipt.publicationHash !== expectedProfilePublication
    )
      throw new ControlPlaneError(
        "The profiling receipt was produced for a different base publication.",
        409,
      );
    cache.set(input.profileReceiptHash, receipt);
  }
  const candidateProfile = receipt.relationshipProfiles.find(
    ({ candidateId }) => candidateId === input.candidateId,
  );
  const targetProfile = candidateProfile?.targets.find(
    ({ targetViewId, targetFieldId }) =>
      targetViewId === input.targetViewId &&
      targetFieldId === input.targetFieldId,
  );
  if (
    !targetProfile ||
    targetProfile.sampledForeignKeys < 1 ||
    targetProfile.sampledForeignKeys <= targetProfile.orphanRows ||
    targetProfile.maximumTargetMatches !== 1 ||
    targetProfile.ambiguousRows > 0 ||
    targetProfile.duplicateTargetKeyGroups > 0 ||
    targetProfile.recommendedCardinality !== "many_to_one" ||
    targetProfile.recommendedDisposition !== "review_candidate"
  )
    throw new ControlPlaneError(
      "The registered profile does not prove a safe many-to-one target for this candidate.",
      422,
    );
  if (
    !input.optional &&
    (!targetProfile.profileCoverageComplete ||
      targetProfile.nullForeignKeys > 0 ||
      targetProfile.orphanRows > 0)
  )
    throw new ControlPlaneError(
      "A required relationship needs complete source-key coverage with zero null keys and zero orphan rows.",
      422,
    );
}

async function diffDraftFromBase(
  loaded: Awaited<ReturnType<typeof loadDraft>>,
) {
  let baseDocument: SemanticRegistryDocumentV2;
  if (loaded.row.base_publication_hash) {
    const { data, error } = await loaded.supabase
      .schema("control_plane")
      .from("semantic_v2_publications")
      .select("artifact")
      .eq("publication_hash", loaded.row.base_publication_hash)
      .maybeSingle();
    if (error)
      throw new ControlPlaneError(
        "The draft base publication could not be loaded for review.",
        503,
      );
    if (!data)
      throw new ControlPlaneError(
        "The draft base publication is missing; publication review cannot continue.",
        409,
      );
    const artifact = z
      .object({ manifest: semanticRegistryDocumentV2Schema })
      .passthrough()
      .parse(data.artifact);
    baseDocument = artifact.manifest;
    if (
      createSemanticPublicationV2(baseDocument).publicationHash !==
      loaded.row.base_publication_hash
    )
      throw new ControlPlaneError(
        "The draft base publication failed its content-addressed integrity check.",
        409,
      );
  } else {
    const { data, error } = await loaded.supabase
      .schema("control_plane")
      .from("semantic_v2_draft_revisions")
      .select("manifest,manifest_hash,revision")
      .eq("draft_id", loaded.row.draft_id)
      .order("revision", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error)
      throw new ControlPlaneError(
        "The initial draft revision could not be loaded for review.",
        503,
      );
    if (!data)
      throw new ControlPlaneError(
        "The initial draft revision is missing; publication review cannot continue.",
        409,
      );
    baseDocument = semanticRegistryDocumentV2Schema.parse(data.manifest);
    if (semanticRegistryV2Digest(baseDocument) !== data.manifest_hash)
      throw new ControlPlaneError(
        "The initial draft revision failed its manifest integrity check.",
        409,
      );
  }
  return diffSemanticRegistryV2(baseDocument, loaded.document);
}

export async function GET(request: Request) {
  try {
    if (!(await isInternalOperator()))
      return Response.json(
        { error: "Internal operator access is required." },
        { status: 403 },
      );
    const url = new URL(request.url);
    const section = sectionSchema
      .catch("overview")
      .parse(url.searchParams.get("section") ?? "overview");
    const query = (url.searchParams.get("q") ?? "")
      .trim()
      .toLowerCase()
      .slice(0, 200);
    const objectId = (url.searchParams.get("objectId") ?? "").trim();
    if (objectId.length > 240)
      throw new ControlPlaneError("Semantic object id is too long.", 400);
    const offset = Math.max(
      0,
      Number.parseInt(url.searchParams.get("offset") ?? "0", 10) || 0,
    );
    const limit = Math.min(
      200,
      Math.max(
        1,
        Number.parseInt(url.searchParams.get("limit") ?? "60", 10) || 60,
      ),
    );
    const draftId = url.searchParams.get("draftId")?.trim();
    const draftRevision = Number.parseInt(
      url.searchParams.get("draftRevision") ?? "",
      10,
    );
    if (draftId && (!Number.isInteger(draftRevision) || draftRevision < 1))
      throw new ControlPlaneError(
        "Draft reads require the exact positive draft revision.",
        400,
      );
    const loadedDraft = draftId
      ? await loadDraft(draftId, draftRevision)
      : null;
    const document = loadedDraft
      ? loadedDraft.document
      : semanticRegistryDocumentV2Schema.parse(generatedRegistry);
    const persistence = await persistenceSummary();
    const overview = draftId
      ? documentOverview(document)
      : {
          ...documentOverview(document),
          publicationHash: SEMANTIC_V2_ADMIN_FALLBACK.publicationHash,
          semanticStateCounts: SEMANTIC_V2_ADMIN_FALLBACK.semanticStateCounts,
          fieldDispositionCounts:
            SEMANTIC_V2_ADMIN_FALLBACK.fieldDispositionCounts,
          sourceConnectorCounts:
            SEMANTIC_V2_ADMIN_FALLBACK.sourceConnectorCounts,
        };
    const profilePublicationHash =
      loadedDraft?.row.base_publication_hash ??
      SEMANTIC_V2_ADMIN_FALLBACK.publicationHash;
    const resolutionEvidence =
      section === "relationships" || section === "inbox"
        ? await relationshipResolutionEvidence(document, profilePublicationHash)
        : new Map<string, Record<string, unknown>>();
    const draftDiff =
      section === "publications" && loadedDraft
        ? await diffDraftFromBase(loadedDraft)
        : null;
    const authoringContext =
      section === "measures" && objectId
        ? measureAuthoringContext(document, objectId)
        : null;
    const topicContext =
      section === "topics" && objectId
        ? topicAuthoringContext(document, objectId)
        : null;
    const relationshipGraph =
      section === "relationships"
        ? relationshipGraphData(document, resolutionEvidence)
        : null;
    const semanticHealth = section === "health" ? await loadSemanticHealth() : null;
    const evaluationCorpusPayload =
      section === "test_lab" ? evaluationCorpusSummary(query) : null;
    const withResolutionEvidence = (item: AdminItem): AdminItem => {
      const itemId = typeof item.id === "string" ? item.id : null;
      return {
        ...item,
        ...(itemId && resolutionEvidence.has(itemId)
          ? { profileResolution: resolutionEvidence.get(itemId) }
          : {}),
      };
    };
    const sectionItems =
      section === "inbox"
        ? [
            ...persistence.runtimeEvents.map((event) => ({
              id: `runtime.${event.event_id}`,
              label: `${String(event.event_kind).replaceAll("_", " ")} · ${event.reason_code}`,
              description:
                "A privacy-preserving V2 runtime event. The user question is represented only by a digest.",
              disposition: "runtime_event",
              semanticState: "exploratory",
              ...event,
            })),
            ...documentSection(document, section).map(withResolutionEvidence),
          ]
        : documentSection(document, section).map(withResolutionEvidence);
    return Response.json(
      {
        section,
        overview,
        persistence,
        catalogue: {
          mode: draftId ? "draft" : "generated",
          draftId: draftId ?? null,
          revision: draftId ? draftRevision : null,
        },
        authoringContext,
        topicAuthoringContext: topicContext,
        relationshipGraph,
        semanticHealth,
        evaluationCorpus: evaluationCorpusPayload,
        draftDiff,
        ...(section === "overview" ||
        section === "health" ||
        section === "publications"
          ? {}
          : page(sectionItems, query, offset, limit)),
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    const status = error instanceof ControlPlaneError ? error.status : 503;
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Semantic administration could not be loaded.",
      },
      { status },
    );
  }
}

export async function POST(request: Request) {
  try {
    if (!(await isInternalOperator()))
      return Response.json(
        { error: "Internal operator access is required." },
        { status: 403 },
      );
    const input = mutationSchema.parse(await request.json());
    if (input.action === "create_draft") {
      const { supabase } = await requireUser();
      const draftId = ulid();
      const active = await supabase
        .schema("control_plane")
        .from("semantic_v2_active_publication")
        .select("publication_hash")
        .eq("singleton", true)
        .maybeSingle();
      if (active.error && active.error.code !== "PGRST116")
        throw new ControlPlaneError(
          "The active publication could not be checked.",
          503,
        );
      const document =
        semanticRegistryDocumentV2Schema.parse(generatedRegistry);
      const { data, error } = active.data
        ? await supabase.rpc("albert_semantic_v2_create_draft_from_active", {
            p_draft_id: draftId,
            p_name: input.name,
          })
        : await supabase.rpc("albert_semantic_v2_create_draft", {
            p_draft_id: draftId,
            p_name: input.name,
            p_manifest: document,
            p_manifest_hash: semanticRegistryV2Digest(document),
          });
      if (error)
        throw new ControlPlaneError(
          "The semantic draft could not be created.",
          error.code === "40001" ? 409 : 503,
        );
      return Response.json({ draft: data }, { status: 201 });
    }
    if (input.action === "register_profile_receipt") {
      const receipt = profileReceiptSchema.parse(input.receipt);
      verifyProfileReceiptAttestation(receipt);
      const profileReceiptHash = semanticProfileReceiptDigestV2(receipt);
      const { supabase, user } = await requireUser();
      const { error } = await supabase
        .schema("control_plane")
        .from("semantic_v2_profile_receipts")
        .insert({
          profile_receipt_hash: profileReceiptHash,
          publication_hash: receipt.publicationHash,
          tenant_digest: receipt.tenantDigest,
          status: receipt.status,
          artifact: receipt,
          created_by: user.id,
        });
      if (error && error.code !== "23505")
        throw new ControlPlaneError(
          "The immutable profiling receipt could not be registered.",
          503,
        );
      return Response.json(
        {
          profileReceipt: {
            profileReceiptHash,
            publicationHash: receipt.publicationHash,
            status: receipt.status,
          },
        },
        { status: error?.code === "23505" ? 200 : 201 },
      );
    }
    if (input.action === "activate_publication") {
      const { supabase } = await requireUser();
      const releaseSha = process.env.ALBERT_RELEASE_SHA?.trim();
      if (!releaseSha || !/^[a-f0-9]{40}$/u.test(releaseSha))
        throw new ControlPlaneError(
          "Activation requires the exact deployed 40-character release SHA.",
          409,
        );
      const { data, error } = await supabase.rpc(
        "albert_semantic_v2_activate_publication",
        { p_publication_hash: input.publicationHash, p_commit_sha: releaseSha },
      );
      if (error)
        throw new ControlPlaneError(
          error.code === "23514"
            ? "Activation is blocked until the exact publication has a passing deterministic and model-evaluation qualification."
            : "The semantic publication could not be activated.",
          error.code === "23514" ? 409 : 503,
        );
      return Response.json({ activation: data });
    }
    if (input.action === "rollback_publication") {
      const { supabase } = await requireUser();
      const { data, error } = await supabase.rpc(
        "albert_semantic_v2_rollback_publication",
      );
      if (error)
        throw new ControlPlaneError(
          error.code === "P0002"
            ? "No previous semantic publication is available for rollback."
            : "The semantic publication could not be rolled back.",
          error.code === "P0002" ? 409 : 503,
        );
      return Response.json({ activation: data });
    }
    if (input.action === "set_business_context_value") {
      if (input.value === undefined)
        throw new ControlPlaneError(
          "Business context requires a JSON value.",
          400,
        );
      const { supabase } = await requireUser();
      const { data, error } = await supabase.rpc(
        "albert_semantic_v2_set_business_context",
        {
          p_context_id: ulid(),
          p_context_key: input.contextKey,
          p_expected_version: input.expectedVersion,
          p_value: input.value,
          p_source: input.source,
          p_evidence: input.evidence,
        },
      );
      if (error)
        throw new ControlPlaneError(
          error.code === "40001"
            ? "The business-context value changed in another session. Refresh before saving."
            : "The business-context value could not be saved.",
          error.code === "40001" ? 409 : 503,
        );
      return Response.json({ businessContext: data });
    }
    if (input.action === "preview_topic_context") {
      if (
        (input.draftId === undefined) !==
        (input.expectedRevision === undefined)
      )
        throw new ControlPlaneError(
          "A draft preview requires both draft id and revision.",
          400,
        );
      const document = input.draftId
        ? (await loadDraft(input.draftId, input.expectedRevision!)).document
        : semanticRegistryDocumentV2Schema.parse(generatedRegistry);
      const topic = document.topics.find(({ id }) => id === input.topicId);
      if (!topic)
        throw new ControlPlaneError(
          `Topic ${input.topicId} was not found.`,
          404,
        );
      const tokens = lexicalTokens(input.question);
      const measures = document.measures
        .filter(({ id }) => topic.measureIds.includes(id))
        .map((measure) => ({
          ...measure,
          score: lexicalScore(tokens, [
            measure.label,
            measure.description,
            ...measure.synonyms,
          ]),
        }))
        .sort(
          (left, right) =>
            right.score - left.score || left.id.localeCompare(right.id),
        )
        .slice(0, 20)
        .map(({ expression, ...measure }) => {
          void expression;
          return measure;
        });
      const dimensions = document.dimensions
        .filter(({ id }) => topic.dimensionIds.includes(id))
        .map((dimension) => ({
          ...dimension,
          score: lexicalScore(tokens, [
            dimension.label,
            dimension.description,
            ...dimension.synonyms,
          ]),
        }))
        .sort(
          (left, right) =>
            right.score - left.score || left.id.localeCompare(right.id),
        )
        .slice(0, 24);
      const rootView = document.views.find(
        ({ id }) => id === topic.defaultRootViewId,
      );
      const timeDimension =
        dimensions.find(({ timeRole }) => timeRole !== "none") ??
        document.dimensions.find(
          ({ id, timeRole }) =>
            topic.dimensionIds.includes(id) && timeRole !== "none",
        );
      const candidateMeasure = measures[0]
        ? document.measures.find(({ id }) => id === measures[0]!.id)
        : null;
      const candidateRoot = candidateMeasure
        ? document.views.find(({ id }) => id === candidateMeasure.viewId)
        : rootView;
      const candidateTimeDimension = candidateRoot
        ? dimensions.find(
            ({ timeRole, viewId }) =>
              timeRole !== "none" && viewId === candidateRoot.id,
          ) ??
          document.dimensions.find(
            ({ id, timeRole, viewId }) =>
              topic.dimensionIds.includes(id) &&
              timeRole !== "none" &&
              viewId === candidateRoot.id,
          )
        : timeDimension;
      const candidateBlock =
        candidateMeasure &&
        candidateRoot &&
        (candidateRoot.temporalAvailability === "current_only" ||
          candidateTimeDimension)
          ? queryBlockV2Schema.parse({
              id: "admin-preview-block",
              topicIds: [topic.id],
              rootViewId: candidateRoot.id,
              measureIds: [candidateMeasure.id],
              dimensionIds: [],
              time:
                candidateRoot.temporalAvailability === "current_only"
                  ? { range: { type: "current_snapshot" } }
                  : {
                      dimensionId: candidateTimeDimension!.id,
                      range: { type: "last_complete_month" },
                    },
              filters: [],
              sort: [],
              limit: 100,
              parameters: {},
            })
          : null;
      let compiledPlan: Record<string, unknown> | null = null;
      let compilerFailure: Record<string, unknown> | null = null;
      if (candidateBlock) {
        try {
          const tenant = await currentTenantContext();
          if (!tenant)
            throw new ControlPlaneError(
              "Choose an organisation before compiling a Topic preview.",
              409,
            );
          const timestamp = new Date().toISOString();
          const compiled = compileQueryWorkspaceV2(
            {
              id: "admin-preview-workspace",
              tenantId: tenant.tenant_id,
              publicationHash: semanticRegistryV2Digest(document),
              overlayVersion: "admin-preview",
              revision: 1,
              questionId: "admin-preview-question",
              blocks: [candidateBlock],
              status: "draft",
              createdAt: timestamp,
              updatedAt: timestamp,
            },
            document,
            {
              tenantId: tenant.tenant_id,
              now: timestamp,
              timezone: tenant.timezone,
              maxEstimatedCost: 250,
              maxRows: 1_000,
              connectionSet: [],
            },
          );
          compiledPlan = {
            normalizedPlanHash: compiled.normalizedPlanHash,
            publicationHash: compiled.publicationHash,
            budget: compiled.budget,
            alignments: compiled.alignments,
            queries: compiled.queries.map((compiledQuery) => ({
              queryId: compiledQuery.queryId,
              period: compiledQuery.period,
              topicIds: compiledQuery.normalizedPlan.topicIds,
              factViewId: compiledQuery.normalizedPlan.factViewId,
              dimensionIds: compiledQuery.normalizedPlan.dimensionIds,
              measureIds: compiledQuery.normalizedPlan.measureIds,
              relationshipIds: compiledQuery.normalizedPlan.joins.map(
                ({ relationshipId }) => relationshipId,
              ),
              semanticState: compiledQuery.semanticState,
              timeRange: compiledQuery.normalizedPlan.resolvedTime,
              validationEvidence: compiledQuery.validationEvidence,
            })),
            executableSqlDisclosed: false,
          };
        } catch (error) {
          compilerFailure = {
            code:
              error instanceof SemanticCompilerV2Error
                ? error.code
                : "PREVIEW_UNAVAILABLE",
            message:
              error instanceof Error
                ? error.message
                : "The deterministic compiler preview failed.",
            ...(error instanceof SemanticCompilerV2Error
              ? { details: error.details }
              : {}),
          };
        }
      }
      return Response.json({
        preview: {
          question: input.question,
          publicationHash: semanticRegistryV2Digest(document),
          topic: {
            id: topic.id,
            label: topic.label,
            layer: topic.layer,
            description: topic.description,
            aiContext: topic.aiContext,
            semanticState: topic.semanticState,
            routingScore: lexicalScore(tokens, [
              topic.label,
              topic.description,
              topic.aiContext,
              ...topic.sampleQuestions,
            ]),
          },
          measures,
          dimensions,
          ambiguityNotes: topic.ambiguityNotes,
          unsupportedQuestions: topic.unsupportedQuestions,
          candidateBlock,
          compiledPlan,
          compilerFailure,
          modelEvaluationTriggered: false,
        },
      });
    }
    const loaded = await loadDraft(input.draftId, input.expectedRevision);
    if (input.action === "batch_relationship_decisions") {
      let document = loaded.document;
      const profileCache = new Map<
        string,
        z.infer<typeof profileReceiptSchema>
      >();
      const promoted: Array<{
        candidateId: string;
        relationshipId: string;
      }> = [];
      const rejected: string[] = [];
      for (const decision of input.decisions) {
        if (decision.disposition === "promote") {
          await requirePromotionProfile(loaded, decision, profileCache);
          const promotion = promoteRelationshipCandidate(document, decision);
          document = promotion.document;
          promoted.push({
            candidateId: decision.candidateId,
            relationshipId: promotion.relationshipId,
          });
        } else {
          document = rejectRelationshipCandidate(
            document,
            decision,
            loaded.user.id,
          );
          rejected.push(decision.candidateId);
        }
      }
      const manifestHash = semanticRegistryV2Digest(document);
      const { data, error } = await loaded.supabase.rpc(
        "albert_semantic_v2_replace_draft",
        {
          p_draft_id: input.draftId,
          p_expected_revision: input.expectedRevision,
          p_manifest: document,
          p_manifest_hash: manifestHash,
          p_change_summary: `Applied relationship review batch: ${promoted.length} promoted, ${rejected.length} rejected.`,
        },
      );
      if (error)
        throw new ControlPlaneError(
          error.code === "40001"
            ? "The draft changed in another session. Refresh before applying this relationship review batch."
            : "The relationship review batch could not be applied.",
          error.code === "40001" ? 409 : 503,
        );
      return Response.json({
        draft: data,
        batch: {
          promoted,
          rejected,
          count: promoted.length + rejected.length,
        },
      });
    }
    if (input.action === "reject_relationship_candidate") {
      const document = rejectRelationshipCandidate(
        loaded.document,
        input,
        loaded.user.id,
      );
      const manifestHash = semanticRegistryV2Digest(document);
      const { data, error } = await loaded.supabase.rpc(
        "albert_semantic_v2_replace_draft",
        {
          p_draft_id: input.draftId,
          p_expected_revision: input.expectedRevision,
          p_manifest: document,
          p_manifest_hash: manifestHash,
          p_change_summary: `Rejected ${input.candidateId}: ${input.reason}`,
        },
      );
      if (error)
        throw new ControlPlaneError(
          error.code === "40001"
            ? "The draft changed in another session. Refresh before rejecting this relationship."
            : "The relationship candidate could not be rejected.",
          error.code === "40001" ? 409 : 503,
        );
      return Response.json({ draft: data, candidateId: input.candidateId });
    }
    if (input.action === "promote_relationship_candidate") {
      await requirePromotionProfile(loaded, input, new Map());
      const promoted = promoteRelationshipCandidate(loaded.document, input);
      const manifestHash = semanticRegistryV2Digest(promoted.document);
      const { data, error } = await loaded.supabase.rpc(
        "albert_semantic_v2_replace_draft",
        {
          p_draft_id: input.draftId,
          p_expected_revision: input.expectedRevision,
          p_manifest: promoted.document,
          p_manifest_hash: manifestHash,
          p_change_summary: `Promoted ${input.candidateId} to ${promoted.relationshipId} from live profile ${input.profileReceiptHash}.`,
        },
      );
      if (error)
        throw new ControlPlaneError(
          error.code === "40001"
            ? "The draft changed in another session. Refresh before promoting this relationship."
            : "The relationship candidate could not be promoted.",
          error.code === "40001" ? 409 : 503,
        );
      return Response.json({
        draft: data,
        relationshipId: promoted.relationshipId,
      });
    }
    if (input.action === "update_object") {
      const document = replaceObject(loaded.document, input);
      const manifestHash = semanticRegistryV2Digest(document);
      const { data, error } = await loaded.supabase.rpc(
        "albert_semantic_v2_replace_draft",
        {
          p_draft_id: input.draftId,
          p_expected_revision: input.expectedRevision,
          p_manifest: document,
          p_manifest_hash: manifestHash,
          p_change_summary: input.changeSummary,
        },
      );
      if (error)
        throw new ControlPlaneError(
          error.code === "40001"
            ? "The draft changed in another session. Refresh and apply the edit again."
            : "The semantic edit could not be saved.",
          error.code === "40001" ? 409 : 503,
        );
      return Response.json({ draft: data, object: input.objectId });
    }
    if (input.action === "review_object") {
      const { data, error } = await loaded.supabase.rpc(
        "albert_semantic_v2_record_review",
        {
          p_review_id: ulid(),
          p_draft_id: input.draftId,
          p_expected_revision: input.expectedRevision,
          p_object_id: input.objectId,
          p_risk_tier: input.riskTier,
          p_disposition: input.disposition,
          p_notes: input.notes,
        },
      );
      if (error)
        throw new ControlPlaneError(
          error.code === "40001"
            ? "The draft changed before the review was recorded."
            : "The review could not be recorded.",
          error.code === "40001" ? 409 : 503,
        );
      return Response.json({ review: data });
    }
    if (input.action === "publish_draft") {
      const publication = createSemanticPublicationV2(loaded.document);
      const { data, error } = await loaded.supabase.rpc(
        "albert_semantic_v2_publish_draft",
        {
          p_draft_id: input.draftId,
          p_expected_revision: input.expectedRevision,
          p_validation_id: input.validationId,
          p_publication_hash: publication.publicationHash,
          p_object_counts: publication.objectCounts,
        },
      );
      if (error)
        throw new ControlPlaneError(
          error.code === "23514"
            ? "Publication is blocked by validation or risk-tier review requirements."
            : "The immutable publication could not be created.",
          error.code === "23514" ? 409 : 503,
        );
      return Response.json({ publication: data });
    }
    const issues = validateSemanticRegistryV2(loaded.document);
    const validationId = ulid();
    const publication =
      issues.length === 0 ? createSemanticPublicationV2(loaded.document) : null;
    const { error } = await loaded.supabase
      .schema("control_plane")
      .from("semantic_v2_validation_reports")
      .insert({
        validation_id: validationId,
        draft_id: input.draftId,
        draft_revision: input.expectedRevision,
        manifest_hash: loaded.row.manifest_hash,
        status: issues.length === 0 ? "passed" : "failed",
        issues,
        deterministic_test_receipt: {
          status: issues.length === 0 ? "passed" : "failed",
          suite: "semantic_authoring_contracts_v2",
          checks: [
            "schema",
            "references",
            "join_paths",
            "grain",
            "additivity",
            "conformed_alignment",
            "content_hash",
          ],
          modelEvaluationTriggered: false,
        },
        created_by: loaded.user.id,
      });
    if (error)
      throw new ControlPlaneError(
        "The validation report could not be persisted.",
        503,
      );
    return Response.json({
      validation: {
        id: validationId,
        status: issues.length === 0 ? "passed" : "failed",
        issues,
        publicationHash: publication?.publicationHash ?? null,
      },
    });
  } catch (error) {
    if (error instanceof z.ZodError)
      return Response.json(
        {
          error: "The semantic administration request is invalid.",
          issues: error.issues,
        },
        { status: 400 },
      );
    const status = error instanceof ControlPlaneError ? error.status : 503;
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Semantic administration failed.",
      },
      { status },
    );
  }
}
