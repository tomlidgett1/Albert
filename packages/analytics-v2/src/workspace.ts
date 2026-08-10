import { createHash } from "node:crypto";
import { z } from "zod";
import {
  semanticFilterContractV2Schema,
  type SemanticRegistryDocumentV2,
} from "../../semantic-registry/src/v2.js";

export const semanticScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type SemanticScalar = z.infer<typeof semanticScalarSchema>;

export const semanticFilterV2Schema = semanticFilterContractV2Schema;
export type SemanticFilterV2 = z.infer<typeof semanticFilterV2Schema>;

const boundedSemanticTimeRangeV2Schema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("absolute"), from: z.string().datetime(), to: z.string().datetime() }).strict(),
    z.object({ type: z.enum(["today", "yesterday", "week_to_date", "month_to_date", "quarter_to_date", "year_to_date", "last_complete_week", "last_complete_month", "last_complete_quarter", "last_complete_year"]) }).strict(),
    z.object({ type: z.literal("last_n_complete_days"), count: z.number().int().min(1).max(3660) }).strict(),
    z.object({ type: z.literal("last_n_complete_weeks"), count: z.number().int().min(1).max(520) }).strict(),
    z.object({ type: z.literal("last_n_complete_months"), count: z.number().int().min(1).max(120) }).strict(),
]);

export const semanticTimeSelectionV2Schema = z.union([
  z.object({ dimensionId: z.string().min(1), range: boundedSemanticTimeRangeV2Schema }).strict(),
  z.object({ range: z.object({ type: z.literal("current_snapshot") }).strict() }).strict(),
]);
export type SemanticTimeSelectionV2 = z.infer<typeof semanticTimeSelectionV2Schema>;

export const semanticComparisonV2Schema = z.object({
  kind: z.enum(["prior_period", "prior_week", "prior_month", "prior_year", "custom"]),
  customRange: boundedSemanticTimeRangeV2Schema.optional(),
}).strict();
export type SemanticComparisonV2 = z.infer<typeof semanticComparisonV2Schema>;

export const semanticSortV2Schema = z.object({
  fieldId: z.string().min(1),
  direction: z.enum(["asc", "desc"]),
  nulls: z.enum(["first", "last"]).default("last"),
}).strict();

export const queryBlockV2Schema = z.object({
  id: z.string().min(1),
  topicIds: z.array(z.string().min(1)).min(1).max(3),
  rootViewId: z.string().min(1),
  dimensionIds: z.array(z.string().min(1)).max(12).default([]),
  measureIds: z.array(z.string().min(1)).min(1).max(20),
  filters: z.array(semanticFilterV2Schema).max(30).default([]),
  time: semanticTimeSelectionV2Schema,
  comparison: semanticComparisonV2Schema.optional(),
  sort: z.array(semanticSortV2Schema).max(8).default([]),
  limit: z.number().int().min(1).max(1000).default(100),
  parameters: z.record(z.string(), semanticScalarSchema).default({}),
}).strict();
export type QueryBlockV2 = z.infer<typeof queryBlockV2Schema>;

export const queryWorkspaceV2Schema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  publicationHash: z.string().regex(/^[a-f0-9]{64}$/),
  overlayVersion: z.string().min(1).max(120),
  revision: z.number().int().positive(),
  questionId: z.string().min(1),
  derivedFrom: z.object({ workspaceId: z.string().min(1), revision: z.number().int().positive() }).strict().optional(),
  blocks: z.array(queryBlockV2Schema).min(1).max(16),
  status: z.enum(["draft", "validated", "executed", "failed"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();
export type QueryWorkspaceV2 = z.infer<typeof queryWorkspaceV2Schema>;

const blockIdSchema = z.object({ blockId: z.string().min(1) });
export const workspacePatchOperationV2Schema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("add_block"), block: queryBlockV2Schema }).strict(),
  z.object({ op: z.literal("replace_block"), block: queryBlockV2Schema }).strict(),
  z.object({ op: z.literal("remove_block"), ...blockIdSchema.shape }).strict(),
  z.object({ op: z.literal("select_topics"), ...blockIdSchema.shape, topicIds: z.array(z.string().min(1)).min(1).max(3) }).strict(),
  z.object({ op: z.literal("set_root_view"), ...blockIdSchema.shape, rootViewId: z.string().min(1) }).strict(),
  z.object({ op: z.literal("add_dimension"), ...blockIdSchema.shape, dimensionId: z.string().min(1) }).strict(),
  z.object({ op: z.literal("remove_dimension"), ...blockIdSchema.shape, dimensionId: z.string().min(1) }).strict(),
  z.object({ op: z.literal("add_measure"), ...blockIdSchema.shape, measureId: z.string().min(1) }).strict(),
  z.object({ op: z.literal("remove_measure"), ...blockIdSchema.shape, measureId: z.string().min(1) }).strict(),
  z.object({ op: z.literal("set_filters"), ...blockIdSchema.shape, filters: z.array(semanticFilterV2Schema).max(30) }).strict(),
  z.object({ op: z.literal("set_time"), ...blockIdSchema.shape, time: semanticTimeSelectionV2Schema }).strict(),
  z.object({ op: z.literal("set_comparison"), ...blockIdSchema.shape, comparison: semanticComparisonV2Schema.nullable() }).strict(),
  z.object({ op: z.literal("set_sort"), ...blockIdSchema.shape, sort: z.array(semanticSortV2Schema).max(8) }).strict(),
  z.object({ op: z.literal("set_limit"), ...blockIdSchema.shape, limit: z.number().int().min(1).max(1000) }).strict(),
  z.object({ op: z.literal("set_parameters"), ...blockIdSchema.shape, parameters: z.record(z.string(), semanticScalarSchema) }).strict(),
]);
export type WorkspacePatchOperationV2 = z.infer<typeof workspacePatchOperationV2Schema>;

export const workspacePatchV2Schema = z.object({
  expectedRevision: z.number().int().positive(),
  operations: z.array(workspacePatchOperationV2Schema).min(1).max(50),
}).strict();
export type WorkspacePatchV2 = z.infer<typeof workspacePatchV2Schema>;

export class WorkspaceConflictError extends Error {
  constructor(readonly expectedRevision: number, readonly actualRevision: number) {
    super(`Workspace revision conflict: expected ${expectedRevision}, current revision is ${actualRevision}.`);
    this.name = "WorkspaceConflictError";
  }
}

export class WorkspaceValidationError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Workspace is invalid: ${issues.join("; ")}`);
    this.name = "WorkspaceValidationError";
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function blockIndex(blocks: readonly QueryBlockV2[], blockId: string): number {
  const index = blocks.findIndex(({ id }) => id === blockId);
  if (index < 0) throw new WorkspaceValidationError([`Unknown query block ${blockId}.`]);
  return index;
}

export function applyWorkspacePatchV2(
  workspaceInput: QueryWorkspaceV2,
  patchInput: WorkspacePatchV2,
  now = new Date().toISOString(),
): QueryWorkspaceV2 {
  const workspace = queryWorkspaceV2Schema.parse(workspaceInput);
  const patch = workspacePatchV2Schema.parse(patchInput);
  if (workspace.status === "executed") throw new WorkspaceValidationError(["Executed workspace revisions are immutable; derive a follow-up revision first."]);
  if (patch.expectedRevision !== workspace.revision) throw new WorkspaceConflictError(patch.expectedRevision, workspace.revision);
  const blocks = structuredClone(workspace.blocks) as QueryBlockV2[];

  for (const operation of patch.operations) {
    if (operation.op === "add_block") {
      if (blocks.some(({ id }) => id === operation.block.id)) throw new WorkspaceValidationError([`Block ${operation.block.id} already exists.`]);
      blocks.push(operation.block);
      continue;
    }
    if (operation.op === "replace_block") {
      blocks[blockIndex(blocks, operation.block.id)] = operation.block;
      continue;
    }
    const index = blockIndex(blocks, operation.blockId);
    if (operation.op === "remove_block") {
      blocks.splice(index, 1);
      continue;
    }
    const block = blocks[index]!;
    if (operation.op === "select_topics") block.topicIds = unique(operation.topicIds);
    else if (operation.op === "set_root_view") block.rootViewId = operation.rootViewId;
    else if (operation.op === "add_dimension") block.dimensionIds = unique([...block.dimensionIds, operation.dimensionId]);
    else if (operation.op === "remove_dimension") block.dimensionIds = block.dimensionIds.filter((id) => id !== operation.dimensionId);
    else if (operation.op === "add_measure") block.measureIds = unique([...block.measureIds, operation.measureId]);
    else if (operation.op === "remove_measure") block.measureIds = block.measureIds.filter((id) => id !== operation.measureId);
    else if (operation.op === "set_filters") block.filters = operation.filters;
    else if (operation.op === "set_time") block.time = operation.time;
    else if (operation.op === "set_comparison") block.comparison = operation.comparison ?? undefined;
    else if (operation.op === "set_sort") block.sort = operation.sort;
    else if (operation.op === "set_limit") block.limit = operation.limit;
    else if (operation.op === "set_parameters") block.parameters = operation.parameters;
  }
  return queryWorkspaceV2Schema.parse({
    ...workspace,
    revision: workspace.revision + 1,
    blocks,
    status: "draft",
    updatedAt: now,
  });
}

export function validateWorkspaceAgainstRegistryV2(
  workspace: QueryWorkspaceV2,
  registry: SemanticRegistryDocumentV2,
): readonly string[] {
  const topics = new Map(registry.topics.map((topic) => [topic.id, topic]));
  const views = new Map(registry.views.map((view) => [view.id, view]));
  const dimensions = new Map(registry.dimensions.map((dimension) => [dimension.id, dimension]));
  const measures = new Map(registry.measures.map((measure) => [measure.id, measure]));
  const issues: string[] = [];
  const duplicateBlockIds = workspace.blocks.filter((block, index, blocks) => blocks.findIndex(({ id }) => id === block.id) !== index).map(({ id }) => id);
  for (const id of unique(duplicateBlockIds)) issues.push(`Workspace contains duplicate query block ${id}.`);
  for (const block of workspace.blocks) {
    const blockTopics = block.topicIds.map((id) => topics.get(id));
    for (let index = 0; index < blockTopics.length; index += 1) if (!blockTopics[index]) issues.push(`${block.id}: unknown Topic ${block.topicIds[index]}.`);
    for (const topic of blockTopics) if (topic && ["unsupported", "deprecated"].includes(topic.semanticState)) issues.push(`${block.id}: Topic ${topic.id} is ${topic.semanticState}.`);
    const root = views.get(block.rootViewId);
    if (!root) issues.push(`${block.id}: unknown root view ${block.rootViewId}.`);
    else if (["unsupported", "deprecated"].includes(root.semanticState)) issues.push(`${block.id}: root view ${root.id} is ${root.semanticState}.`);
    for (const topic of blockTopics) if (topic && !topic.viewIds.includes(block.rootViewId)) issues.push(`${block.id}: root view ${block.rootViewId} is not available in Topic ${topic.id}.`);
    for (const id of block.dimensionIds) {
      const dimension = dimensions.get(id);
      if (!dimension) issues.push(`${block.id}: unknown dimension ${id}.`);
      else if (["unsupported", "deprecated"].includes(dimension.semanticState)) issues.push(`${block.id}: dimension ${id} is ${dimension.semanticState}.`);
      else if (!blockTopics.some((topic) => topic?.dimensionIds.includes(id))) issues.push(`${block.id}: dimension ${id} is not exposed by a selected Topic.`);
    }
    for (const id of block.measureIds) {
      const measure = measures.get(id);
      if (!measure) issues.push(`${block.id}: unknown measure ${id}.`);
      else if (["unsupported", "deprecated"].includes(measure.semanticState)) issues.push(`${block.id}: measure ${id} is ${measure.semanticState}.`);
      else if (!blockTopics.some((topic) => topic?.measureIds.includes(id))) issues.push(`${block.id}: measure ${id} is not exposed by a selected Topic.`);
    }
    for (const filter of block.filters) {
      if (!dimensions.has(filter.fieldId)) issues.push(`${block.id}: filter references unknown dimension ${filter.fieldId}.`);
      else if (["unsupported", "deprecated"].includes(dimensions.get(filter.fieldId)!.semanticState)) issues.push(`${block.id}: filter dimension ${filter.fieldId} is ${dimensions.get(filter.fieldId)!.semanticState}.`);
      else if (!blockTopics.some((topic) => topic?.dimensionIds.includes(filter.fieldId))) issues.push(`${block.id}: filter dimension ${filter.fieldId} is not exposed by a selected Topic.`);
    }
    if (block.time.range.type === "current_snapshot") {
      if (block.comparison) issues.push(`${block.id}: current snapshots cannot be compared to a historical period.`);
    } else if (!("dimensionId" in block.time) || !dimensions.has(block.time.dimensionId)) {
      issues.push(`${block.id}: time selection references unknown dimension ${"dimensionId" in block.time ? block.time.dimensionId : "missing"}.`);
    } else {
      const timeDimensionId = block.time.dimensionId;
      const timeDimension = dimensions.get(timeDimensionId)!;
      if (!blockTopics.some((topic) => topic?.dimensionIds.includes(timeDimensionId))) issues.push(`${block.id}: time dimension ${timeDimensionId} is not exposed by a selected Topic.`);
      if (timeDimension.timeRole === "none") issues.push(`${block.id}: ${timeDimensionId} is not a governed time role.`);
      if (block.time.range.type === "absolute" && Date.parse(block.time.range.from) >= Date.parse(block.time.range.to)) issues.push(`${block.id}: absolute time range must end after it starts.`);
    }
    if (block.comparison?.kind === "custom" && !block.comparison.customRange) issues.push(`${block.id}: custom comparisons require a custom range.`);
    if (block.comparison?.kind !== "custom" && block.comparison?.customRange) issues.push(`${block.id}: only custom comparisons may provide a custom range.`);
    if (block.comparison?.customRange?.type === "absolute" && Date.parse(block.comparison.customRange.from) >= Date.parse(block.comparison.customRange.to)) issues.push(`${block.id}: custom comparison range must end after it starts.`);
    for (const sort of block.sort) if (![...block.dimensionIds, ...block.measureIds].includes(sort.fieldId)) issues.push(`${block.id}: sort ${sort.fieldId} is not selected.`);
    if (Object.keys(block.parameters).length > 0) issues.push(`${block.id}: semantic parameters are not executable in this publication; use governed dimensions, filters, or business context.`);
    if (block.measureIds.length === 0) issues.push(`${block.id}: at least one measure is required.`);
  }
  return Object.freeze(issues);
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => [key, stable(entry)]));
  return value;
}

export function queryWorkspaceV2Digest(workspace: QueryWorkspaceV2): string {
  const reusable = {
    tenantId: workspace.tenantId,
    publicationHash: workspace.publicationHash,
    overlayVersion: workspace.overlayVersion,
    blocks: workspace.blocks,
  };
  return createHash("sha256").update(JSON.stringify(stable(reusable))).digest("hex");
}

export function deriveFollowUpWorkspaceV2(
  executed: QueryWorkspaceV2,
  input: Readonly<{ questionId: string; now?: string }>,
): QueryWorkspaceV2 {
  if (executed.status !== "executed") throw new WorkspaceValidationError(["Only an executed workspace can seed a follow-up."]);
  const now = input.now ?? new Date().toISOString();
  return queryWorkspaceV2Schema.parse({
    ...executed,
    questionId: input.questionId,
    derivedFrom: { workspaceId: executed.id, revision: executed.revision },
    revision: executed.revision + 1,
    status: "draft",
    createdAt: executed.createdAt,
    updatedAt: now,
  });
}
