import {
  Agent,
  OpenAIProvider,
  Runner,
  Usage,
  assistant,
  tool,
  user,
  type AgentInputItem,
  type ModelProvider,
  type Tool,
} from "@openai/agents";
import { z } from "zod";

import {
  deriveAnswerStateV2,
  findUngroundedClaimNumbersV2,
  groundedClaimV2Schema,
  resolveOperatorOutputPathV2,
  unchangedInsightClaimIdsV2,
  validateClaimEvidenceV2,
  validateRecommendationOperatorEvidenceV2,
  type GroundedClaimV2,
  type ResultEvidenceV2,
  type SemanticTerminalStateV2,
} from "../../../packages/analytics-v2/src/index.js";
import {
  SEMANTIC_V2_TOOL_NAMES,
  parseSemanticV2ToolInput,
  semanticV2ToolInputSchemas,
  type SemanticV2ToolName,
} from "../../../packages/agent/src/semantic-v2-tools.js";
import { buildOpenAIAgentRunConfig } from "../../../packages/agent/src/runtime.js";
import {
  sanitizeAnswerText,
  sanitizeTraceText,
  type AgentRunPreferences,
  type ResolvedConversationSubject,
  type SemanticV2AnswerState,
  type TraceEvent,
  type TraceProvenance,
  type TraceTableColumn,
} from "../../../packages/shared/src/index.js";
import type { AgentToolContext } from "../../../packages/agent/src/semantic-tools.js";
import type { ProviderRunUsage } from "../../../packages/usage-metering/src/index.js";
import { findUngroundedNumbers, redactUngroundedProse } from "./grounding.js";
import {
  verifyOpenAIProviderRuntime,
  type OpenAIProviderRuntimeReceipt,
} from "./provider-runtime-verification.js";
import type { SemanticServiceClient } from "./semantic-client.js";
import type { ContextualConversationMessage } from "./conversation-understanding.js";

type TraceEventInput = TraceEvent extends infer Event
  ? Event extends TraceEvent
    ? Omit<Event, "id" | "sequence" | "occurredAt">
    : never
  : never;

type EmitTraceV2 = ((event: TraceEventInput) => Promise<TraceEvent>) &
  Readonly<{
    drain?: () => Promise<Readonly<{ persisted: number; failed: number }>>;
  }>;

export type RunLiveAlbertV2TurnOptions = Readonly<{
  message: string;
  preferences: AgentRunPreferences;
  tenantId: string;
  role: AgentToolContext["role"];
  conversationId: string;
  turnId: string;
  modelContext: readonly ContextualConversationMessage[];
  abortSignal?: AbortSignal;
  openaiApiKey: string;
  openaiBaseUrl: string;
  semanticServiceUrl: string;
  semanticSigningSecret: string;
  safetyIdentifier: string;
  openaiTracingEnabled?: boolean;
  modelProvider?: ModelProvider;
  semanticClient?: Pick<SemanticServiceClient, "executeV2">;
  onProviderUsage?: (
    usage: ProviderRunUsage,
    providerResponseId: string | null,
  ) => Promise<void>;
  emit: EmitTraceV2;
}>;

export type LiveAlbertV2TurnResult = Readonly<{
  lastResponseId: string;
  analysisLane:
    | "lookup"
    | "comparison"
    | "diagnosis"
    | "recommendation"
    | "open_exploration";
  answerState: SemanticV2AnswerState;
  resultDigest: string;
  usage: Readonly<Record<string, unknown>>;
  providerRuntime: OpenAIProviderRuntimeReceipt | null;
  queryAuditIds: readonly string[];
  semanticV2: Readonly<{
    executionIds: readonly string[];
    publicationHash: string | null;
    claims: readonly GroundedClaimV2[];
    investigationId: string | null;
  }>;
}>;

const resolvedSubjectV2Schema = z
  .object({
    label: z.string().trim().min(1).max(160),
    kind: z.string().trim().min(1).max(80),
    resolvedQuestion: z.string().trim().min(1).max(2_000),
  })
  .strict();

export const finalOutputV2Schema = z
  .object({
    state: z.enum([
      "verified",
      "derived",
      "exploratory",
      "clarification",
      "no_data",
      "unavailable",
    ]),
    text: z.string().trim().min(1).max(12_000),
    claims: z.array(groundedClaimV2Schema).max(12),
    followUps: z.array(z.string().trim().min(1).max(180)).max(2),
    resolvedSubject: resolvedSubjectV2Schema.nullable(),
  })
  .strict();
type FinalOutputV2 = z.infer<typeof finalOutputV2Schema>;

function modelJsonSchemaV2(schema: z.ZodType): Record<string, unknown> {
  const jsonSchema = z.toJSONSchema(schema, {
    io: "input",
  }) as Record<string, unknown>;
  delete jsonSchema.$schema;
  return jsonSchema;
}

function finalOutputTypeV2() {
  const carrier = tool({
    name: "albert_semantic_v2_output",
    description: "Albert Semantic V2 final output contract.",
    parameters: modelJsonSchemaV2(finalOutputV2Schema) as never,
    strict: true,
    execute: async () => ({}),
  });
  return Object.freeze({
    type: "json_schema" as const,
    name: "albert_semantic_v2_output",
    strict: true,
    schema: carrier.parameters as never,
  });
}

type ExecutionQueryRecord = Readonly<{
  executionId: string;
  queryId: string;
  period: "current" | "comparison";
  topicIds: readonly string[];
  dimensionIds: readonly string[];
  measureIds: readonly string[];
  resultColumns: readonly string[];
  timeRange: Readonly<{
    label: string;
    start: string;
    end: string;
    timezone: string;
  }>;
  rows: readonly Readonly<Record<string, unknown>>[];
  evidence: ResultEvidenceV2;
}>;

type OperatorRecord = Readonly<{
  operatorArtifactId: string;
  operatorId: string;
  artifactHash: string;
  publicationHash: string;
  sourceResultIds: readonly string[];
  output: Readonly<Record<string, unknown>>;
  limitations: readonly string[];
}>;

type SemanticContextRecord = Readonly<{
  publicationHash: string;
  overlayVersion: string;
  topics: readonly Readonly<Record<string, unknown>>[];
  tenantContext: Readonly<Record<string, unknown>>;
  priorInsights?: readonly Readonly<Record<string, unknown>>[];
}>;

type V2AgentContext = AgentToolContext &
  Readonly<{
    semantic: Pick<SemanticServiceClient, "executeV2">;
    emit: EmitTraceV2;
    question: string;
    executions: Map<string, ExecutionQueryRecord>;
    operators: Map<string, OperatorRecord>;
    investigation: {
      id: string | null;
      revision: number;
      questionClass: LiveAlbertV2TurnResult["analysisLane"] | null;
      hypothesisStates: Map<string, string>;
    };
    semanticContext: { value: SemanticContextRecord | null };
  }>;

function contextOf(value: { context: unknown }): V2AgentContext {
  return value.context as V2AgentContext;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function recordArray(
  value: unknown,
): readonly Readonly<Record<string, unknown>>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value)
    throw new Error(`${label} is missing from the V2 service response.`);
  return value;
}

function toTraceCell(value: unknown): string | number | null {
  if (value === null || typeof value === "string" || typeof value === "number")
    return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  return JSON.stringify(value);
}

function inferColumn(
  key: string,
  rows: readonly Readonly<Record<string, unknown>>[],
): TraceTableColumn {
  const value = rows.find(
    (row) => row[key] !== null && row[key] !== undefined,
  )?.[key];
  const lower = key.toLowerCase();
  const type: TraceTableColumn["type"] =
    typeof value === "number"
      ? lower.includes("rate") || lower.includes("percent")
        ? "percent"
        : lower.includes("revenue") ||
            lower.includes("cost") ||
            lower.includes("sales") ||
            lower.includes("margin") ||
            lower.includes("profit") ||
            lower.includes("amount")
          ? "currency"
          : "number"
      : typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/u.test(value)
        ? "datetime"
        : typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value)
          ? "date"
          : "string";
  return Object.freeze({
    key,
    label: key.replaceAll("_", " ").replaceAll(".", " · "),
    type,
  });
}

function semanticProvenance(
  context: V2AgentContext,
  query?: ExecutionQueryRecord,
): TraceProvenance {
  const semanticContext = context.semanticContext.value;
  const tenantContext = semanticContext?.tenantContext ?? {};
  const sourceFreshness = recordArray(tenantContext.sourceFreshness).filter(
    ({ connectorId }) => connectorId === "lightspeed" || connectorId === "xero",
  );
  const identity = isRecord(tenantContext.identityGraph)
    ? tenantContext.identityGraph
    : {};
  const timeRange = query?.timeRange ?? {
    label: "Semantic context",
    start: "1970-01-01T00:00:00.000Z",
    end: new Date().toISOString(),
    timezone:
      typeof tenantContext.timezone === "string"
        ? tenantContext.timezone
        : "Australia/Melbourne",
  };
  return Object.freeze({
    sources: Object.freeze(
      sourceFreshness.map((source) =>
        Object.freeze({
          connector: source.connectorId as "lightspeed" | "xero",
          label:
            typeof source.label === "string"
              ? source.label
              : String(source.connectorId),
          dataThrough:
            typeof source.dataThrough === "string"
              ? source.dataThrough
              : timeRange.end,
        }),
      ),
    ),
    timeRange,
    definitions: Object.freeze(
      (query?.measureIds ?? []).map((measureId) =>
        Object.freeze({
          metric: measureId,
          label: measureId.replaceAll("_", " "),
          definition: `Governed semantic measure ${measureId}.`,
        }),
      ),
    ),
    semanticBundleHash: semanticContext?.publicationHash ?? "0".repeat(64),
    identityGraph: Object.freeze({
      version: typeof identity.version === "number" ? identity.version : 0,
      hash: typeof identity.hash === "string" ? identity.hash : "0".repeat(64),
    }),
  });
}

function toolLabel(name: SemanticV2ToolName): string {
  const labels: Record<SemanticV2ToolName, string> = {
    get_semantic_context_v2: "Finding the governed Topics and definitions",
    create_workspace_v2: "Creating a governed query workspace",
    continue_workspace_v2: "Continuing the prior governed workspace",
    apply_workspace_patch_v2: "Repairing the governed query workspace",
    validate_workspace_v2: "Validating grain, joins, and semantics",
    preview_workspace_v2: "Previewing the deterministic query plan",
    execute_workspace_v2: "Running the governed analysis",
    inspect_result_v2: "Inspecting governed result evidence",
    fork_query_block_v2: "Extending the prior governed query",
    create_investigation_v2: "Structuring the analytical investigation",
    get_investigation_v2: "Checking the investigation state",
    update_investigation_v2: "Recording the investigation outcome",
    run_analytical_operator_v2: "Applying a deterministic analytical operator",
    update_insight_v2: "Recording the business decision",
  };
  return labels[name];
}

function sanitizeToolResult(
  name: SemanticV2ToolName,
  result: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (name !== "execute_workspace_v2") return result;
  const execution = isRecord(result.execution) ? result.execution : {};
  return Object.freeze({
    ...result,
    execution: Object.freeze({
      executionId: execution.executionId,
      terminalState: execution.terminalState,
      normalizedPlanHash: execution.normalizedPlanHash,
      resultDigest: execution.resultDigest,
      sourceWatermarks: execution.sourceWatermarks,
      validation: execution.validation,
      queries: recordArray(execution.queries).map((query) =>
        Object.freeze({
          queryId: query.queryId,
          period: query.period,
          topicIds: query.topicIds,
          dimensionIds: query.dimensionIds,
          measureIds: query.measureIds,
          resultColumns: query.resultColumns,
          timeRange: query.timeRange,
          rows: recordArray(query.rows).slice(0, 120),
          rowCount: recordArray(query.rows).length,
          evidence: query.evidence,
        }),
      ),
      blocks: recordArray(execution.blocks).map((block) =>
        Object.freeze({
          ...block,
          currentRows: recordArray(block.currentRows).slice(0, 120),
          comparisonRows: recordArray(block.comparisonRows).slice(0, 120),
        }),
      ),
    }),
  });
}

async function recordToolResult(
  name: SemanticV2ToolName,
  result: Readonly<Record<string, unknown>>,
  context: V2AgentContext,
): Promise<void> {
  if (name === "get_semantic_context_v2") {
    context.semanticContext.value = result as SemanticContextRecord;
    return;
  }
  if (
    name === "create_investigation_v2" ||
    name === "get_investigation_v2" ||
    name === "update_investigation_v2"
  ) {
    const investigation = isRecord(result.investigation)
      ? result.investigation
      : null;
    if (investigation) {
      context.investigation.id = requireString(
        investigation.id,
        "Investigation id",
      );
      context.investigation.revision =
        typeof result.revision === "number"
          ? result.revision
          : context.investigation.revision || 1;
      const questionClass = investigation.questionClass;
      if (
        [
          "lookup",
          "comparison",
          "diagnosis",
          "recommendation",
          "open_exploration",
        ].includes(String(questionClass))
      )
        context.investigation.questionClass =
          questionClass as LiveAlbertV2TurnResult["analysisLane"];
      for (const hypothesis of recordArray(investigation.hypotheses)) {
        if (
          typeof hypothesis.id === "string" &&
          typeof hypothesis.status === "string"
        )
          context.investigation.hypothesisStates.set(
            hypothesis.id,
            hypothesis.status,
          );
      }
    }
    return;
  }
  if (name === "execute_workspace_v2") {
    const execution = isRecord(result.execution) ? result.execution : {};
    const executionId = requireString(execution.executionId, "Execution id");
    for (const raw of recordArray(execution.queries)) {
      const evidence = raw.evidence as ResultEvidenceV2;
      const query: ExecutionQueryRecord = Object.freeze({
        executionId,
        queryId: requireString(raw.queryId, "Result id"),
        period: raw.period === "comparison" ? "comparison" : "current",
        topicIds: stringArray(raw.topicIds),
        dimensionIds: stringArray(raw.dimensionIds),
        measureIds: stringArray(raw.measureIds),
        resultColumns: stringArray(raw.resultColumns),
        timeRange: isRecord(raw.timeRange)
          ? (raw.timeRange as ExecutionQueryRecord["timeRange"])
          : {
              label: "Governed period",
              start: "1970-01-01T00:00:00.000Z",
              end: new Date().toISOString(),
              timezone: "Australia/Melbourne",
            },
        rows: recordArray(raw.rows),
        evidence,
      });
      context.executions.set(`${executionId}:${query.queryId}`, query);
      await context.emit({
        type: "query",
        status: "complete",
        topic: query.topicIds.join(" + ") || "semantic_v2",
        metrics: query.measureIds,
        dimensions: query.dimensionIds,
        timeRange: query.timeRange,
        lens: query.period,
      });
      if (query.rows.length > 0) {
        const visibleRows = query.rows
          .slice(0, 200)
          .map((row) =>
            Object.freeze(
              Object.fromEntries(
                Object.entries(row).map(([key, value]) => [
                  key,
                  toTraceCell(value),
                ]),
              ),
            ),
          );
        await context.emit({
          type: "table",
          status: "complete",
          caption: `${query.topicIds.join(" + ") || "Governed result"} · ${query.period}`,
          columns: query.resultColumns.map((key) =>
            inferColumn(key, query.rows),
          ),
          rows: visibleRows,
          resultId: `${executionId}:${query.queryId}`,
          provenance: semanticProvenance(context, query),
        });
      }
    }
    if (
      isRecord(result.investigation) &&
      typeof result.investigation.revision === "number"
    )
      context.investigation.revision = result.investigation.revision;
    return;
  }
  if (name === "run_analytical_operator_v2") {
    const artifact = isRecord(result.artifact) ? result.artifact : {};
    const operatorArtifactId = requireString(
      artifact.operatorArtifactId,
      "Operator artifact id",
    );
    context.operators.set(
      operatorArtifactId,
      Object.freeze({
        operatorArtifactId,
        operatorId: requireString(artifact.operatorId, "Operator id"),
        artifactHash: requireString(
          artifact.artifactHash,
          "Operator artifact hash",
        ),
        publicationHash: requireString(
          artifact.publicationHash,
          "Operator publication hash",
        ),
        sourceResultIds: stringArray(artifact.sourceResultIds),
        output: isRecord(artifact.output) ? artifact.output : {},
        limitations: stringArray(artifact.limitations),
      }),
    );
  }
}

function createV2Tools(): readonly Tool<V2AgentContext>[] {
  const descriptions: Record<SemanticV2ToolName, string> = {
    get_semantic_context_v2:
      "Compile the smallest publication-pinned set of exact Topic, measure, dimension, business-context, capability, and freshness definitions relevant to a question. Always call first and never invent semantic ids.",
    create_workspace_v2:
      "Create one durable governed query workspace from complete semantic blocks. Use exact ids returned by get_semantic_context_v2.",
    continue_workspace_v2:
      "Create a new draft workspace from the last executed workspace in this conversation when the question is a genuine contextual follow-up.",
    apply_workspace_patch_v2:
      "Atomically repair one or more fields in a draft workspace using optimistic concurrency.",
    validate_workspace_v2:
      "Validate and deterministically compile a workspace without running it.",
    preview_workspace_v2:
      "Inspect a physical-identifier-free normalized plan preview before execution.",
    execute_workspace_v2:
      "Execute only a validated compiler-produced workspace inside the signed read-only boundary.",
    inspect_result_v2:
      "Read a bounded window from one persisted governed result.",
    fork_query_block_v2:
      "Derive a new query block or follow-up workspace from prior governed state.",
    create_investigation_v2:
      "Persist the inspectable objective, question class, definitions, hypotheses, evidence DAG, and stop conditions. Call once before executing any workspace.",
    get_investigation_v2:
      "Read the current server-owned investigation revision and budget usage.",
    update_investigation_v2:
      "Record definition resolutions, evidence outcomes, hypothesis outcomes, and the final investigation state. Cannot change budgets.",
    run_analytical_operator_v2:
      "Choose a deterministic analytical operator and bind it to exact persisted result columns. Never supply arithmetic values; trusted code extracts and calculates them.",
    update_insight_v2:
      "Record an explicit user decision, action, resolution, or outcome against an insight returned by semantic context. Use optimistic expectedState and never infer acceptance from silence.",
  };
  return Object.freeze(
    SEMANTIC_V2_TOOL_NAMES.map(
      (name) =>
        tool({
          name,
          description: descriptions[name],
          parameters: modelJsonSchemaV2(
            semanticV2ToolInputSchemas[name],
          ) as never,
          strict: true,
          timeoutMs: name === "execute_workspace_v2" ? 150_000 : 120_000,
          execute: async (input: unknown, runContext: { context: unknown }) => {
            const context = contextOf(runContext);
            const operationDetail =
              name === "run_analytical_operator_v2" &&
              isRecord(input) &&
              typeof input.operatorId === "string"
                ? `${name.replaceAll("_", " ")}: ${input.operatorId}`
                : name.replaceAll("_", " ");
            await context.emit({
              type: "progress",
              status: "running",
              stage: name.includes("investigation")
                ? "planning"
                : name.includes("execute") ||
                    name.includes("result") ||
                    name.includes("operator")
                  ? "query"
                  : "definition",
              label: toolLabel(name),
              detail: operationDetail,
            });
            const parsedInput = parseSemanticV2ToolInput(name, input);
            const result = await context.semantic.executeV2(
              name,
              parsedInput,
              context,
            );
            await recordToolResult(name, result, context);
            await context.emit({
              type: "progress",
              status: "complete",
              stage: name.includes("investigation")
                ? "planning"
                : name.includes("execute") ||
                    name.includes("result") ||
                    name.includes("operator")
                  ? "query"
                  : "definition",
              label: toolLabel(name),
              detail: "Completed through the governed V2 runtime",
            });
            return sanitizeToolResult(name, result);
          },
        } as never) as Tool<V2AgentContext>,
    ),
  );
}

/**
 * Fail before any provider request or evaluation-budget reservation when a V2
 * tool or final-output contract cannot be represented as an OpenAI strict
 * schema. Constructing the tools and output format performs the same schema
 * conversion used by the production runner without making a network call.
 */
export function assertSemanticV2OpenAISchemaCompatibility(): void {
  createV2Tools();
  finalOutputTypeV2();
}

function buildModelInput(
  messages: readonly ContextualConversationMessage[],
  currentMessage: string,
): AgentInputItem[] {
  const latest = messages.at(-1);
  if (!latest || latest.role !== "user" || latest.text !== currentMessage)
    throw new Error(
      "Bounded V2 context must end with the current user message.",
    );
  return messages.map((message) =>
    message.role === "user" ? user(message.text) : assistant(message.text),
  );
}

function v2Instructions(): string {
  return `You are Albert Analytical Architecture V2, a rigorous business analyst for Lightspeed and Xero data.

TRUST BOUNDARY
- You interpret intent, choose semantic objects and deterministic operators, form testable hypotheses, and explain evidence.
- Trusted software owns tenants, physical identifiers, joins, grain, fan-out safety, SQL, time, currency, query cost, arithmetic, validation, and confidence eligibility.
- Never write SQL, physical tables, columns, join keys, expressions, or arithmetic inputs. Never invent a semantic id.

MANDATORY WORKFLOW
1. Call get_semantic_context_v2 with the user's resolved question. Use only exact ids returned. Call it again with narrower wording if needed.
2. Classify the question as lookup, comparison, diagnosis, recommendation, or open_exploration. Call create_investigation_v2 exactly once before any execution. Keep hypotheses factual and testable; the plan is inspectable state, not hidden reasoning. If semantic context returns previousWorkspace and this is genuinely a follow-up, use continue_workspace_v2 then patch only what changed; otherwise create a fresh workspace.
3. Resolve every material definition. If one ambiguity changes the result materially and business context cannot resolve it, return Clarification without querying. Otherwise default transparently and record it.
4. Propose complete QueryBlockV2 blocks in one create_workspace_v2 call, validate or preview, then execute. Use batch blocks for independent evidence that can run together. Repair only typed validation failures.
5. For diagnosis, recommendation, or exploration, test competing hypotheses within the server-owned budget. Use deterministic operators for comparisons, decomposition, opportunity sizing, reconciliation, anomalies, cohorts, or controllability. The operator receives result-column bindings, never copied values.
6. Update the investigation with evidence and hypothesis outcomes. Mark sufficient only when material definitions are resolved and every evidence node is terminal; otherwise mark inconclusive.
7. Ground every answer claim to an exact executionId, resultId, rowIndex, columnKey and publicationHash, or to a returned operatorArtifactId plus its exact operatorOutputPath. Do not calculate or restate any number that is absent from those exact governed values.
8. If the user explicitly accepts, rejects, resolves, reopens, or reports an outcome for a prior insight, call update_insight_v2. Never infer a disposition from silence or from merely asking a follow-up.

QUESTION-CLASS STANDARD
- Lookup: one semantic block and direct answer.
- Comparison: up to three logical blocks, explicit comparable periods.
- Diagnosis: competing hypotheses, contribution analysis, and evidence that supports or refutes each material cause.
- Recommendation: diagnosis plus deterministic opportunity sizing, operational constraints, controllability, limitations, and ranked action.
- Open exploration: bounded breadth-first coverage, then deepen only the material signal.

TERMINAL STATES
- verified: certified semantic claims with all validation passed.
- derived: deterministic operator or governed derived-metric claims.
- exploratory: documented but uncertified semantics, disclosed precisely.
- clarification: exactly one material ambiguity prevents safe interpretation.
- no_data: the semantic question compiled and executed validly, but every relevant result is empty.
- unavailable: the question cannot be represented or execution/evidence is unsafe; state the exact missing capability and unlock.
Never relabel no data as unavailable, never claim absence from a failed query, and never force a numerical answer.

SYNTHESIS
Lead with the conclusion. Distinguish measured facts, interpretation, causal inference, and recommendations. A causal claim requires competing-hypothesis evidence. A recommendation requires deterministic opportunity sizing, limitations, and controllability. Mixed answers retain claim-level states; the overall state is the weakest material claim. The semantic context may include priorInsights: do not present an unchanged prior finding as new, and mention it again only when its evidence changed materially, the user asks for it, or it remains necessary context for a new conclusion. Do not mention tools, prompts, SQL, model settings, budgets, or internal ids in owner-facing text. Return concise follow-ups only when they are genuinely useful.`;
}

function providerUsageSnapshot(usage: Usage): ProviderRunUsage {
  return Object.freeze({
    requests: usage.requests,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    inputTokensDetails: Object.freeze(
      usage.inputTokensDetails.map((detail) => Object.freeze({ ...detail })),
    ),
    outputTokensDetails: Object.freeze(
      usage.outputTokensDetails.map((detail) => Object.freeze({ ...detail })),
    ),
    requestUsageEntries: usage.requestUsageEntries?.map((entry) =>
      Object.freeze({
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        inputTokensDetails: Object.freeze({ ...entry.inputTokensDetails }),
        outputTokensDetails: Object.freeze({ ...entry.outputTokensDetails }),
        ...(entry.endpoint ? { endpoint: entry.endpoint } : {}),
      }),
    ),
  });
}

function publicState(state: SemanticTerminalStateV2): SemanticV2AnswerState {
  return state === "verified"
    ? "Verified"
    : state === "derived"
      ? "Derived"
      : state === "exploratory"
        ? "Exploratory"
        : state === "clarification"
          ? "Clarification"
          : state === "no_data"
            ? "No data"
            : "Unavailable";
}

function flattenNumbers(
  value: unknown,
  output: Readonly<Record<string, unknown>>[] = [],
): Readonly<Record<string, unknown>>[] {
  if (Array.isArray(value)) {
    value.forEach((item) => flattenNumbers(item, output));
  } else if (isRecord(value)) {
    output.push(value);
    Object.values(value).forEach((item) => flattenNumbers(item, output));
  }
  return output;
}

function validateClaims(
  context: V2AgentContext,
  claims: readonly GroundedClaimV2[],
): readonly string[] {
  const results = [...context.executions.values()].map(
    ({ evidence }) => evidence,
  );
  const issues: string[] = [];
  for (const claim of claims) {
    const citedEvidence: unknown[] = [];
    const operatorValues: Array<
      Readonly<{
        operatorId: string;
        path: readonly (string | number)[];
        value: unknown;
      }>
    > = [];
    issues.push(...validateClaimEvidenceV2(claim, results));
    for (const reference of claim.evidenceRefs) {
      const query = context.executions.get(
        `${reference.executionId}:${reference.resultId}`,
      );
      if (reference.operatorArtifactId) {
        const operator = context.operators.get(reference.operatorArtifactId);
        if (!operator)
          issues.push(
            `Claim ${claim.id} references unknown operator artifact ${reference.operatorArtifactId}.`,
          );
        else if (operator.publicationHash !== reference.publicationHash)
          issues.push(`Claim ${claim.id} crosses operator publications.`);
        else {
          if (
            !operator.sourceResultIds.includes(
              `${reference.executionId}:${reference.resultId}`,
            )
          )
            issues.push(
              `Claim ${claim.id} cites an operator that was not derived from ${reference.executionId}:${reference.resultId}.`,
            );
          const resolved = resolveOperatorOutputPathV2(
            operator.output,
            reference.operatorOutputPath ?? [],
          );
          if (!resolved.found)
            issues.push(
              `Claim ${claim.id} references a missing operator output path.`,
            );
          else {
            citedEvidence.push(resolved.value);
            operatorValues.push({
              operatorId: operator.operatorId,
              path: reference.operatorOutputPath ?? [],
              value: resolved.value,
            });
          }
        }
      }
      if (
        reference.rowIndex !== undefined &&
        reference.columnKey !== undefined
      ) {
        if (!query) continue;
        const row = query.rows[reference.rowIndex];
        if (!row)
          issues.push(
            `Claim ${claim.id} references missing row ${reference.rowIndex}.`,
          );
        else if (
          !Object.prototype.hasOwnProperty.call(row, reference.columnKey)
        )
          issues.push(
            `Claim ${claim.id} references missing column ${reference.columnKey}.`,
          );
        else citedEvidence.push(row[reference.columnKey]);
      }
    }
    for (const token of findUngroundedClaimNumbersV2(claim.text, citedEvidence))
      issues.push(
        `Claim ${claim.id} contains figure ${token} that is not present in its cited evidence.`,
      );
    if (
      (claim.type === "causal" || claim.type === "recommendation") &&
      claim.evidenceRefs.every(({ operatorArtifactId }) => !operatorArtifactId)
    ) {
      issues.push(
        `Claim ${claim.id} requires deterministic operator evidence.`,
      );
    }
    issues.push(
      ...validateRecommendationOperatorEvidenceV2(claim, operatorValues).map(
        (issue) => `Claim ${claim.id}: ${issue}`,
      ),
    );
    if (claim.type === "causal") {
      const states = claim.competingHypothesisRefs.map((id) =>
        context.investigation.hypothesisStates.get(id),
      );
      if (
        states.length < 2 ||
        states.some((state) => !state) ||
        !states.includes("supported") ||
        !states.some((state) => state === "refuted" || state === "inconclusive")
      ) {
        issues.push(
          `Claim ${claim.id} lacks resolved competing-hypothesis evidence.`,
        );
      }
    }
  }
  return Object.freeze(issues);
}

function governedEvidenceForClaim(
  context: V2AgentContext,
  claim: GroundedClaimV2,
): readonly unknown[] | null {
  const governedEvidence: unknown[] = [];
  for (const reference of claim.evidenceRefs) {
    if (reference.rowIndex !== undefined && reference.columnKey !== undefined) {
      const query = context.executions.get(
        `${reference.executionId}:${reference.resultId}`,
      );
      const row = query?.rows[reference.rowIndex];
      if (
        !row ||
        !Object.prototype.hasOwnProperty.call(row, reference.columnKey)
      )
        return null;
      governedEvidence.push({
        kind: "cell",
        resultId: reference.resultId,
        columnKey: reference.columnKey,
        value: row[reference.columnKey],
      });
      continue;
    }
    if (!reference.operatorArtifactId) return null;
    const operator = context.operators.get(reference.operatorArtifactId);
    if (!operator) return null;
    const resolved = resolveOperatorOutputPathV2(
      operator.output,
      reference.operatorOutputPath ?? [],
    );
    if (!resolved.found) return null;
    governedEvidence.push({
      kind: "operator",
      resultId: reference.resultId,
      artifactHash: operator.artifactHash,
      operatorOutputPath: reference.operatorOutputPath ?? null,
      value: resolved.value,
    });
  }
  return Object.freeze(governedEvidence);
}

function unchangedInsightClaimIds(
  context: V2AgentContext,
  claims: readonly GroundedClaimV2[],
): ReadonlySet<string> {
  const prior = (context.semanticContext.value?.priorInsights ?? []).flatMap(
    (insight) =>
      typeof insight.insightKey === "string" &&
      typeof insight.evidenceDigest === "string"
        ? [
            {
              insightKey: insight.insightKey,
              evidenceDigest: insight.evidenceDigest,
            },
          ]
        : [],
  );
  const current = claims.flatMap((claim) => {
    const governedEvidence = governedEvidenceForClaim(context, claim);
    return governedEvidence ? [{ claim, governedEvidence }] : [];
  });
  return unchangedInsightClaimIdsV2(
    context.investigation.questionClass,
    current,
    prior,
  );
}

function normalizeFinalOutput(
  context: V2AgentContext,
  output: FinalOutputV2,
): Readonly<{
  state: SemanticTerminalStateV2;
  text: string;
  claims: readonly GroundedClaimV2[];
  followUps: readonly string[];
  resolvedSubject: ResolvedConversationSubject | undefined;
  validationIssues: readonly string[];
}> {
  const evidence = [...context.executions.values()].map(
    ({ evidence }) => evidence,
  );
  const claimValidation = output.claims.map((claim) => ({
    claim,
    issues: validateClaims(context, [claim]),
  }));
  const claimIssues = claimValidation.flatMap(({ issues }) => issues);
  const validClaims = claimValidation
    .filter(({ issues }) => issues.length === 0)
    .map(({ claim }) => claim);
  const unchangedClaimIds = unchangedInsightClaimIds(context, validClaims);
  const freshClaims = validClaims.filter(
    ({ id }) => !unchangedClaimIds.has(id),
  );
  // Preserve the internal evidence contract when every finding is unchanged,
  // while suppressing those claims from owner-facing prose below.
  const retainedClaims =
    freshClaims.length > 0 || unchangedClaimIds.size === 0
      ? freshClaims
      : validClaims;
  let state: SemanticTerminalStateV2;
  if (output.state === "clarification" && context.executions.size === 0)
    state = "clarification";
  else if (output.state === "unavailable" && validClaims.length === 0)
    state = "unavailable";
  else
    state = deriveAnswerStateV2({ results: evidence, claims: retainedClaims });
  const evidenceRows = [
    ...[...context.executions.values()].flatMap(({ rows }) => rows),
    ...[...context.operators.values()].flatMap(({ output: operatorOutput }) =>
      flattenNumbers(operatorOutput),
    ),
  ].map((row) =>
    Object.freeze(
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [key, toTraceCell(value)]),
      ),
    ),
  );
  const ungrounded = findUngroundedNumbers(output.text, evidenceRows);
  const groundedText =
    ungrounded.length > 0
      ? redactUngroundedProse(output.text, ungrounded) ||
        (state === "no_data"
          ? "The governed query was valid, but no matching records were returned for the requested scope and period."
          : state === "clarification"
            ? output.text
            : "Albert gathered evidence, but could not safely ground the requested conclusion.")
      : output.text;
  const text =
    unchangedClaimIds.size === 0
      ? groundedText
      : freshClaims.length > 0
        ? `${freshClaims.map(({ text: claimText }) => claimText).join("\n\n")}\n\nPreviously surfaced findings were unchanged and are not repeated.`
        : "The governed evidence did not produce a materially new insight. Previously surfaced findings remain unchanged.";
  return Object.freeze({
    state,
    text: sanitizeAnswerText(text, 16_000),
    claims: Object.freeze([...retainedClaims]),
    followUps: Object.freeze(
      output.followUps.map((item) => sanitizeTraceText(item, 180)),
    ),
    resolvedSubject: output.resolvedSubject ?? undefined,
    validationIssues: Object.freeze([
      ...claimIssues,
      ...ungrounded.map((value) => `Ungrounded number ${value}.`),
    ]),
  });
}

async function sha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function runLiveAlbertV2Turn(
  options: RunLiveAlbertV2TurnOptions,
): Promise<LiveAlbertV2TurnResult> {
  const ownedProvider = options.modelProvider
    ? undefined
    : new OpenAIProvider({
        apiKey: options.openaiApiKey,
        baseURL: options.openaiBaseUrl,
        useResponses: true,
        strictFeatureValidation: true,
      });
  const provider = options.modelProvider ?? ownedProvider!;
  const semantic =
    options.semanticClient ??
    new (await import("./semantic-client.js")).SemanticServiceClient(
      options.semanticServiceUrl,
      options.semanticSigningSecret,
    );
  try {
    const runConfig = buildOpenAIAgentRunConfig(options.preferences);
    const outputType = finalOutputTypeV2();
    const agent = new Agent<V2AgentContext, typeof outputType>({
      name: "Albert analytical architecture V2",
      instructions: v2Instructions(),
      model: runConfig.model,
      modelSettings: {
        reasoning: { ...runConfig.modelSettings.reasoning },
        text: { verbosity: "medium" },
        parallelToolCalls: true,
        store: false,
        providerData: {
          ...runConfig.modelSettings.providerData,
          ...(options.safetyIdentifier
            ? { safety_identifier: options.safetyIdentifier }
            : {}),
        },
      },
      tools: [...createV2Tools()],
      outputType,
    });
    const runner = new Runner({
      modelProvider: provider,
      tracingDisabled: !options.openaiTracingEnabled,
      traceIncludeSensitiveData: false,
      workflowName: "albert-analytical-v2",
      groupId: options.conversationId,
    });
    const executions = new Map<string, ExecutionQueryRecord>();
    const operators = new Map<string, OperatorRecord>();
    const context: V2AgentContext = Object.freeze({
      tenantId: options.tenantId,
      role: options.role,
      conversationId: options.conversationId,
      turnId: options.turnId,
      abortSignal: options.abortSignal,
      semantic,
      emit: options.emit,
      question: options.message,
      executions,
      operators,
      investigation: {
        id: null,
        revision: 0,
        questionClass: null,
        hypothesisStates: new Map(),
      },
      semanticContext: { value: null },
    });
    await options.emit({
      type: "progress",
      status: "running",
      stage: "planning",
      label: "Interpreting the question through governed Topics",
      detail: "Semantic Execution V2",
      progress: 0.03,
    });
    const run = await runner.run(
      agent,
      buildModelInput(options.modelContext, options.message),
      {
        context,
        maxTurns: 32,
        signal: options.abortSignal,
        toolNotFoundBehavior: "raise_error",
        toolExecution: { maxFunctionToolConcurrency: 8 },
      },
    );
    const providerRuntime = ownedProvider
      ? verifyOpenAIProviderRuntime(run.rawResponses, {
          model: runConfig.model,
          reasoningEffort: runConfig.modelSettings.reasoning.effort,
          reasoningMode: runConfig.modelSettings.reasoning.mode,
          serviceTier: runConfig.modelSettings.providerData.service_tier,
        })
      : null;
    const usage = new Usage();
    usage.add(run.runContext.usage);
    const providerUsage = providerUsageSnapshot(usage);
    const responseId = run.lastResponseId ?? "v2-no-provider-response-id";
    await options.onProviderUsage?.(providerUsage, run.lastResponseId ?? null);
    const parsed = finalOutputV2Schema.parse(run.finalOutput);
    const finalized = normalizeFinalOutput(context, parsed);
    if (finalized.validationIssues.length > 0) {
      await options.emit({
        type: "validation",
        status: "warning",
        name: "claim_grounding_v2",
        outcome: "qualified",
        detail: `Trusted V2 validation removed unsupported content: ${finalized.validationIssues.slice(0, 3).join(" ")}`,
      });
    } else {
      await options.emit({
        type: "validation",
        status: "complete",
        name: "claim_grounding_v2",
        outcome: "passed",
        detail:
          "Every retained claim is bound to immutable result or operator evidence.",
      });
    }
    const provenance = semanticProvenance(context, [...executions.values()][0]);
    await options.emit({
      type: "answer",
      status: "complete",
      state: publicState(finalized.state),
      text: finalized.text,
      provenance,
      followUps: finalized.followUps,
      ...(finalized.resolvedSubject
        ? { resolvedSubject: finalized.resolvedSubject }
        : {}),
      presentedResultIds: [...executions.keys()].slice(0, 2),
    });
    const resultDigest = await sha256({
      state: finalized.state,
      publicationHash: context.semanticContext.value?.publicationHash ?? null,
      investigationId: context.investigation.id,
      executions: [...executions.values()].map(
        ({ executionId, queryId, evidence }) => ({
          executionId,
          queryId,
          evidence,
        }),
      ),
      operators: [...operators.values()].map(
        ({ operatorArtifactId, artifactHash }) => ({
          operatorArtifactId,
          artifactHash,
        }),
      ),
      claims: finalized.claims,
    });
    return Object.freeze({
      lastResponseId: responseId,
      analysisLane: context.investigation.questionClass ?? "lookup",
      answerState: publicState(finalized.state),
      resultDigest: `sha256:${resultDigest}`,
      usage: providerUsage as unknown as Readonly<Record<string, unknown>>,
      providerRuntime,
      queryAuditIds: Object.freeze([]),
      semanticV2: Object.freeze({
        executionIds: Object.freeze([
          ...new Set(
            [...executions.values()].map(({ executionId }) => executionId),
          ),
        ]),
        publicationHash: context.semanticContext.value?.publicationHash ?? null,
        claims: finalized.claims,
        investigationId: context.investigation.id,
      }),
    });
  } finally {
    await options.emit.drain?.();
    await ownedProvider?.close();
  }
}
