import { z } from "zod";
import {
  ANALYTICAL_QUERY_OUTCOMES,
  ANALYTICAL_QUERY_RUNTIMES,
  ANALYTICAL_QUERY_SOURCES,
  normalizeQueryFailureCode,
  sanitizeQueryFailureMessage,
  type AnalyticalQueryAttemptOutcome,
  type AnalyticalQueryAttemptStart,
  type AnalyticalQueryRecorder,
} from "../../../packages/shared/src/query-audit.js";
import { ControlPlaneError, requireUser } from "./web-repository.js";

type QueryLogSupabase = Awaited<ReturnType<typeof requireUser>>["supabase"];

const retryablePostgresCodes = new Set([
  "08000", "08003", "08006", "08001", "08004", "08007", "08P01",
  "40001", "40P01", "53300", "53400", "55006", "57014", "57P01", "57P02", "57P03",
]);

function postgresCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || Array.isArray(error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function auditedRpc(
  supabase: QueryLogSupabase,
  functionName: string,
  parameters: Readonly<Record<string, unknown>>,
): Promise<unknown> {
  let lastError: unknown;
  for (const [index, delay] of [0, 50, 150].entries()) {
    if (delay > 0) await wait(delay);
    const { data, error } = await supabase.rpc(functionName, parameters);
    if (!error) return data;
    lastError = error;
    const code = postgresCode(error);
    if (index === 2 || (code && !retryablePostgresCodes.has(code))) break;
  }
  const code = postgresCode(lastError);
  if (code === "42501") throw new ControlPlaneError("The query audit record was not authorised.", 403);
  if (code === "PGRST202" || code === "42883") {
    throw new ControlPlaneError("The analytical query log migration is not deployed.", 503);
  }
  throw new ControlPlaneError("The analytical query could not be durably logged, so it was not allowed to continue.", 503);
}

export function createSupabaseAnalyticalQueryRecorder(input: Readonly<{
  supabase: QueryLogSupabase;
  conversationId: string;
  turnId: string;
  correlationId: string;
}>): AnalyticalQueryRecorder {
  return Object.freeze({
    start: async (attempt: AnalyticalQueryAttemptStart) => {
      await auditedRpc(input.supabase, "albert_record_analytical_query_attempt", {
        p_query_attempt_id: attempt.queryAttemptId,
        p_conversation_id: input.conversationId,
        p_turn_id: input.turnId,
        p_runtime: attempt.runtime,
        p_source: attempt.source,
        p_operation: attempt.operation,
        p_query_document: attempt.queryDocument,
        p_topic: attempt.topic ?? null,
        p_branch_label: attempt.branchLabel ?? null,
        p_correlation_id: input.correlationId,
      });
    },
    finish: async (outcome: AnalyticalQueryAttemptOutcome) => {
      const succeeded = outcome.status === "succeeded";
      await auditedRpc(input.supabase, "albert_record_analytical_query_outcome", {
        p_query_attempt_id: outcome.queryAttemptId,
        p_status: outcome.status,
        p_execution_ms: outcome.executionMs ?? null,
        p_row_count: outcome.rowCount ?? null,
        p_failure_code: succeeded
          ? null
          : normalizeQueryFailureCode(outcome.failureCode ?? `${outcome.status}_query`, "query_failed"),
        p_failure_message: succeeded
          ? null
          : sanitizeQueryFailureMessage(outcome.failureMessage, "The governed query did not complete."),
        p_result_metadata: outcome.resultMetadata ?? {},
      });
    },
  });
}

const recentTurnSchema = z.object({
  turnId: z.string(),
  turnNumber: z.number().int().positive(),
  userMessage: z.string(),
  status: z.string(),
  answerState: z.string().nullable(),
  assistantAnswer: z.string().nullable(),
}).strict();

const queryContextSnapshotSchema = z.object({
  question: z.string(),
  conversationTitle: z.string().nullable(),
  turnNumber: z.number().int().positive(),
  tenantName: z.string(),
  runtimeProfile: z.record(z.string(), z.unknown()),
  recentTurns: z.array(recentTurnSchema).max(6),
}).strict();

export const analyticalQueryLogStatusSchema = z.enum([
  "succeeded", "failed", "rejected", "cancelled", "interrupted", "in_progress",
]);

export const analyticalQueryLogFilterSchema = z.enum([
  "all", "failures", "succeeded", "in_progress",
]);

const analyticalQueryLogItemSchema = z.object({
  queryAttemptId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
  tenantId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
  tenantName: z.string().min(1),
  actorEmail: z.string().email().nullable(),
  conversationId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
  turnId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
  runtime: z.enum(ANALYTICAL_QUERY_RUNTIMES),
  source: z.enum(ANALYTICAL_QUERY_SOURCES),
  operation: z.string().min(1),
  topic: z.string().nullable(),
  branchLabel: z.string().nullable(),
  status: analyticalQueryLogStatusSchema,
  queryDocument: z.record(z.string(), z.unknown()),
  contextSnapshot: queryContextSnapshotSchema,
  correlationId: z.string().nullable(),
  executionMs: z.number().int().nonnegative().nullable(),
  rowCount: z.number().int().nonnegative().nullable(),
  failureCode: z.string().nullable(),
  failureMessage: z.string().nullable(),
  resultMetadata: z.record(z.string(), z.unknown()),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
}).strict();

const analyticalQueryLogsSchema = z.object({
  generatedAt: z.string(),
  summary: z.object({
    windowDays: z.number().int().positive(),
    total: z.number().int().nonnegative(),
    succeeded: z.number().int().nonnegative(),
    failures: z.number().int().nonnegative(),
    inProgress: z.number().int().nonnegative(),
    failureRate: z.coerce.number().min(0).max(1),
  }).strict(),
  items: z.array(analyticalQueryLogItemSchema).max(200),
}).strict();

export type AnalyticalQueryLogFilter = z.infer<typeof analyticalQueryLogFilterSchema>;
export type AnalyticalQueryLogItem = z.infer<typeof analyticalQueryLogItemSchema>;
export type AnalyticalQueryLogs = z.infer<typeof analyticalQueryLogsSchema>;

export async function isAnalyticalQueryLogViewer(
  supabaseClient?: QueryLogSupabase,
): Promise<boolean> {
  const supabase = supabaseClient ?? (await requireUser()).supabase;
  const { data, error } = await supabase.rpc("albert_analytical_query_log_viewer_status");
  if (error) {
    if (error.code === "PGRST202" || error.code === "42883" || error.code === "42501") return false;
    throw new ControlPlaneError("Query log access could not be verified.", 503);
  }
  return data === true;
}

export async function loadAnalyticalQueryLogs(input: Readonly<{
  status: AnalyticalQueryLogFilter;
  search?: string;
  limit?: number;
  supabase?: QueryLogSupabase;
}>): Promise<AnalyticalQueryLogs> {
  const supabase = input.supabase ?? (await requireUser()).supabase;
  const { data, error } = await supabase.rpc("albert_analytical_query_logs", {
    p_status: input.status,
    p_search: input.search?.trim() || null,
    p_limit: input.limit ?? 100,
  });
  if (error) {
    if (error.code === "42501") throw new ControlPlaneError("Query log access is restricted to Tom's account.", 403);
    if (error.code === "22023") throw new ControlPlaneError("The query log filters are invalid.", 400);
    if (error.code === "PGRST202" || error.code === "42883") {
      throw new ControlPlaneError("The analytical query log migration is not deployed.", 503);
    }
    throw new ControlPlaneError("Query logs are unavailable.", 503);
  }
  const parsed = analyticalQueryLogsSchema.safeParse(data);
  if (!parsed.success) throw new ControlPlaneError("Query logs returned invalid diagnostic data.", 503);
  return parsed.data;
}

export const analyticalQueryOutcomeValues = ANALYTICAL_QUERY_OUTCOMES;
