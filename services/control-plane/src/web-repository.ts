import { z } from "zod";
import { createClient } from "../../../utils/supabase/server.js";
import { toConnectionsWorkspace } from "./connections-workspace.js";

const tenantContextSchema = z.object({
  tenant_id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  tenant_name: z.string().min(1),
  tenant_slug: z.string().min(1),
  role: z.enum(["owner", "manager", "bookkeeper", "internal_operator"]),
  timezone: z.string().min(1).default("Australia/Melbourne"),
});

// The list/history RPCs project this with jsonb_build_object, which materialises
// an absent key as JSON null rather than omitting it. Turns written before a
// preference existed therefore arrive as null, so accept both null and absent —
// one such turn would otherwise fail the whole array parse and blank the sidebar.
const runtimeProfileSchema = z.object({
  model: z.string().nullish(),
  reasoningEffort: z.string().nullish(),
  fastMode: z.boolean().nullish(),
  runtime: z.string().nullish(),
  analyticalRuntime: z.string().nullish(),
  provider: z.string().nullish(),
});

const conversationSummarySchema = z.object({
  conversation_id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  title: z.string().nullable(),
  status: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  last_turn: z.object({
    turn_id: z.string(),
    turn_number: z.number().int().positive(),
    user_message: z.string(),
    status: z.string(),
    answer_state: z.string().nullable(),
    runtime_profile: runtimeProfileSchema,
    created_at: z.string(),
    completed_at: z.string().nullable(),
  }).nullable(),
});

const conversationHistorySchema = z.object({
  conversation_id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  turns: z.array(z.object({
    turn_id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
    turn_number: z.number().int().positive(),
    user_message: z.string(),
    status: z.string(),
    answer_state: z.string().nullable(),
    runtime_profile: runtimeProfileSchema,
    created_at: z.string(),
    completed_at: z.string().nullable(),
    events: z.array(z.unknown()),
  })),
  next_sequence: z.number().int().nonnegative(),
});

const answerLineageSchema = z.object({
  answerArtifactId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  conversationId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  turnId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  turnNumber: z.number().int().positive(),
  answerState: z.enum(["verified", "derived", "qualified", "exploratory", "clarification", "no_data", "unavailable"]),
  question: z.string().min(1).max(40_000),
  finalNarrative: z.string().min(1).max(16_000),
  interpretedPlan: z.record(z.string(), z.unknown()),
  validationOutcomes: z.array(z.unknown()),
  provenance: z.record(z.string(), z.unknown()),
  semanticBundleHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  traceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  artifactDigest: z.string().regex(/^[a-f0-9]{64}$/),
  queries: z.array(z.object({
    queryAuditId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
    route: z.enum(["semantic", "semantic_v2", "source_exploration", "sql_first"]),
    topic: z.string().nullable(),
    bundleHash: z.string().regex(/^[a-f0-9]{64}$/),
    registryVersion: z.string().min(1),
    compilerOutputHash: z.string().regex(/^[a-f0-9]{64}$/),
    resultDigest: z.string().regex(/^[a-f0-9]{64}$/),
    answerState: z.enum(["verified", "derived", "qualified", "exploratory", "clarification", "no_data", "unavailable"]),
    validation: z.record(z.string(), z.unknown()),
  }).strict()).max(20),
  finalizedAt: z.string(),
}).strict();

const connectionDisconnectSchema = z.object({
  deletionRequestId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  status: z.enum(["queued", "running", "retry_wait", "verifying", "failed"]),
}).strict();

const connectorRoutingWorkspaceSchema = z.object({
  connections: z.array(z.object({
    connector_key: z.string().trim().min(1).max(80),
    status: z.enum(["pending", "connected", "degraded", "blocked", "disconnected"]),
    readiness: z.array(z.object({
      domain: z.string().trim().min(1).max(80),
      data_ready_through: z.string().nullable().optional(),
    }).passthrough()).default([]),
  }).passthrough()).default([]),
}).passthrough();

export type ConnectorRouting = Readonly<{
  activeConnectors: readonly string[];
  /** Per connector+domain sync watermarks; data past a watermark is unsynced, not zero. */
  freshness: readonly Readonly<{
    connector: string;
    domain: string;
    dataThrough: string | null;
  }>[];
}>;

const tenantDeletionReceiptSchema = z.object({
  deletionRequestId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  status: z.enum([
    "awaiting_approval", "queued", "running", "retry_wait", "verifying",
    "failed", "completed", "cancelled",
  ]),
  requestedAt: z.string(),
  approvedAt: z.string().nullable(),
  purgeDueAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  lastErrorCode: z.string().nullable(),
  proof: z.object({
    proofId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
    proofDigest: z.string().regex(/^[a-f0-9]{64}$/),
    completedAt: z.string(),
    remoteRevocation: z.record(z.string(), z.unknown()),
    storeVerification: z.record(z.string(), z.unknown()),
    serviceVersion: z.string().min(1).max(120),
  }).strict().nullable(),
}).strict();

export type TenantContext = z.infer<typeof tenantContextSchema>;
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;
export type ConversationHistory = z.infer<typeof conversationHistorySchema>;
export type AnswerLineage = z.infer<typeof answerLineageSchema>;
export type TenantDeletionReceipt = z.infer<typeof tenantDeletionReceiptSchema>;

const tenantSessionStateSchema = z.object({
  context: tenantContextSchema.nullable(),
  deletionReceipt: tenantDeletionReceiptSchema.nullable(),
  needsBootstrap: z.boolean(),
}).strict();

export type TenantSessionState = z.infer<typeof tenantSessionStateSchema>;

export const ALBERT_RATE_LIMIT_POLICIES = Object.freeze({
  "conversation.turn": Object.freeze({ limit: 20, windowSeconds: 60 }),
  // Cheap nano titles; keep separate so sidebar backfill cannot starve turns.
  "conversation.title": Object.freeze({ limit: 40, windowSeconds: 60 }),
  "conversation.transcribe": Object.freeze({ limit: 30, windowSeconds: 60 }),
  "oauth.start": Object.freeze({ limit: 5, windowSeconds: 600 }),
  "oauth.callback": Object.freeze({ limit: 10, windowSeconds: 600 }),
  "oauth.select": Object.freeze({ limit: 10, windowSeconds: 600 }),
  "oauth.disconnect": Object.freeze({ limit: 5, windowSeconds: 3_600 }),
  "review.mutation": Object.freeze({ limit: 30, windowSeconds: 60 }),
  "dashboard.mutation": Object.freeze({ limit: 60, windowSeconds: 60 }),
  "dashboard.refresh": Object.freeze({ limit: 12, windowSeconds: 60 }),
  // A backfill is expensive and vendor-rate-limited; cap it far below click speed.
  "connection.manual_sync": Object.freeze({ limit: 6, windowSeconds: 3_600 }),
  "connection.start_ingestion": Object.freeze({ limit: 6, windowSeconds: 3_600 }),
} as const);

export type AlbertRateLimitAction = keyof typeof ALBERT_RATE_LIMIT_POLICIES;
export type AlbertRateLimitDecision = Readonly<{
  allowed: boolean;
  retryAfterSeconds: number;
  remaining: number;
  limit: number;
}>;

function singleton(value: unknown): unknown {
  if (Array.isArray(value)) return value[0] ?? null;
  return value;
}

export async function requireUser() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) throw new ControlPlaneError("Authentication is required.", 401);
  return { supabase, user: data.user };
}

export async function currentTenantContext(): Promise<TenantContext | null> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("current_albert_context");
  if (error) {
    if (error.code === "PGRST202" || error.code === "42883") {
      throw new ControlPlaneError("The Albert control-plane migration is not deployed.", 503);
    }
    throw new ControlPlaneError("The organisation context could not be loaded.", 503);
  }
  const candidate = singleton(data);
  if (!candidate) return null;
  const parsed = tenantContextSchema.safeParse(candidate);
  if (!parsed.success) throw new ControlPlaneError("The organisation context is invalid.", 503);
  return parsed.data;
}

export async function currentTenantDeletionReceipt(): Promise<TenantDeletionReceipt | null> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("current_albert_tenant_deletion_receipt");
  if (error) {
    if (error.code === "PGRST202" || error.code === "42883") {
      throw new ControlPlaneError("The Albert deletion-receipt migration is not deployed.", 503);
    }
    throw new ControlPlaneError("Deletion status could not be loaded.", 503);
  }
  if (!data) return null;
  const parsed = tenantDeletionReceiptSchema.safeParse(data);
  if (!parsed.success) throw new ControlPlaneError("Deletion status returned invalid state.", 503);
  return parsed.data;
}

export async function currentTenantSessionState(): Promise<TenantSessionState> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("current_albert_session_state");
  if (error) {
    if (error.code === "PGRST202" || error.code === "42883") {
      throw new ControlPlaneError("The Albert session-state migration is not deployed.", 503);
    }
    throw new ControlPlaneError("The organisation session could not be loaded.", 503);
  }
  const parsed = tenantSessionStateSchema.safeParse(data);
  if (!parsed.success) throw new ControlPlaneError("The organisation session returned invalid state.", 503);
  if (parsed.data.needsBootstrap !== (
    parsed.data.context === null && parsed.data.deletionReceipt === null
  )) {
    throw new ControlPlaneError("The organisation session returned inconsistent state.", 503);
  }
  return parsed.data;
}

export async function bootstrapTenant(input: Readonly<{
  displayName: string;
  timezone: string;
}>): Promise<TenantContext> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("bootstrap_albert_tenant", {
    p_display_name: input.displayName,
    p_timezone: input.timezone,
  });
  if (error) {
    throw new ControlPlaneError(
      error.code === "55000"
        ? "Your prior organisation is still being securely deleted."
        : "Your organisation could not be created.",
      error.code === "55000" ? 409 : 503,
    );
  }
  const parsed = tenantContextSchema.safeParse(singleton(data));
  if (!parsed.success) throw new ControlPlaneError("The created organisation is invalid.", 503);
  return parsed.data;
}

export async function loadConnectionsWorkspace(): Promise<unknown> {
  const { supabase } = await requireUser();
  const context = await currentTenantContext();
  if (!context) throw new ControlPlaneError("Create your organisation before loading connections.", 409);
  const { data, error } = await supabase.rpc("albert_connections_workspace");
  if (error) throw new ControlPlaneError("Connection status could not be loaded.", 503);
  return toConnectionsWorkspace(singleton(data), context.timezone);
}

/**
 * Return the authenticated tenant's connector keys that may still have a
 * readable analytical surface. Pending connections have never become usable;
 * disconnected connections are in the deletion lifecycle. Degraded and
 * blocked connections remain visible because governed historical data can
 * still be queryable with an explicit freshness qualification.
 */
export async function loadConnectorRouting(
  supabaseClient?: Awaited<ReturnType<typeof requireUser>>["supabase"],
): Promise<ConnectorRouting> {
  const supabase = supabaseClient ?? (await requireUser()).supabase;
  const { data, error } = await supabase.rpc("albert_connections_workspace");
  if (error) throw new ControlPlaneError("Connection routing state could not be loaded.", 503);
  const parsed = connectorRoutingWorkspaceSchema.safeParse(singleton(data));
  if (!parsed.success) {
    throw new ControlPlaneError("Connection routing state returned invalid data.", 503);
  }
  const active = parsed.data.connections
    .filter(({ status }) => status !== "pending" && status !== "disconnected");
  // Several connections of one connector: the freshest watermark per domain
  // reflects what is actually queryable.
  const byConnectorDomain = new Map<string, { connector: string; domain: string; dataThrough: string | null }>();
  for (const connection of active) {
    for (const readiness of connection.readiness) {
      const key = `${connection.connector_key} ${readiness.domain}`;
      const existing = byConnectorDomain.get(key);
      const candidate = readiness.data_ready_through ?? null;
      if (!existing || (candidate !== null && (existing.dataThrough === null || candidate > existing.dataThrough))) {
        byConnectorDomain.set(key, {
          connector: connection.connector_key,
          domain: readiness.domain,
          dataThrough: candidate,
        });
      }
    }
  }
  let freshness = [...byConnectorDomain.values()]
    .sort((a, b) => a.connector.localeCompare(b.connector) || a.domain.localeCompare(b.domain));
  if (!freshness.some((entry) => entry.dataThrough !== null)) {
    // readiness is unpopulated for some tenants; fall back to the ingestion
    // stream cursors so the agent still knows how fresh each source is.
    const { data: fallback } = await supabase.rpc("albert_connector_freshness");
    const parsed = connectorFreshnessSchema.safeParse(singleton(fallback));
    if (parsed.success) {
      freshness = parsed.data.map((entry) => ({
        connector: entry.connector,
        domain: entry.domain,
        dataThrough: entry.dataThrough,
      }));
    }
  }
  return Object.freeze({
    activeConnectors: Object.freeze([...new Set(
      active.map(({ connector_key: connectorKey }) => connectorKey),
    )].sort()),
    freshness: Object.freeze(freshness),
  });
}

const connectorFreshnessSchema = z.array(z.object({
  connector: z.string().trim().min(1).max(80),
  domain: z.string().trim().min(1).max(120),
  dataThrough: z.string().nullable(),
}).strict());

const sourceFindingsSchema = z.array(z.object({
  concept: z.string().trim().min(1).max(60),
  finding: z.string().trim().min(1).max(500),
  recordedAt: z.string(),
}).strict());

export type TenantSourceFindings = z.infer<typeof sourceFindingsSchema>;

/** Durable source-topology facts recorded by earlier agent investigations. */
export async function loadSourceFindings(
  supabaseClient?: Awaited<ReturnType<typeof requireUser>>["supabase"],
): Promise<TenantSourceFindings> {
  const supabase = supabaseClient ?? (await requireUser()).supabase;
  const { data, error } = await supabase.rpc("albert_list_source_findings");
  if (error) throw new ControlPlaneError("Source findings could not be loaded.", 503);
  const parsed = sourceFindingsSchema.safeParse(singleton(data));
  if (!parsed.success) throw new ControlPlaneError("Source findings returned invalid data.", 503);
  return parsed.data;
}

export async function recordSourceFinding(
  concept: string,
  finding: string,
  supabaseClient?: Awaited<ReturnType<typeof requireUser>>["supabase"],
): Promise<void> {
  const supabase = supabaseClient ?? (await requireUser()).supabase;
  const { error } = await supabase.rpc("albert_record_source_finding", {
    p_concept: concept,
    p_finding: finding,
  });
  if (error) throw new ControlPlaneError("The source finding could not be recorded.", 503);
}

export async function loadActiveConnectorKeys(
  supabaseClient?: Awaited<ReturnType<typeof requireUser>>["supabase"],
): Promise<readonly string[]> {
  return (await loadConnectorRouting(supabaseClient)).activeConnectors;
}

export async function disconnectConnection(
  connectionId: string,
): Promise<z.infer<typeof connectionDisconnectSchema>> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("albert_disconnect_connection", {
    p_connection_id: connectionId,
  });
  if (error) {
    const queueUnavailable = error.code === "55000" && /queue.*unavailable/iu.test(error.message);
    const status = error.code === "42501"
      ? 403
      : error.code === "P0002"
        ? 404
        : error.code === "22023"
          ? 400
          : error.code === "55000" && !queueUnavailable
            ? 409
            : 503;
    throw new ControlPlaneError(
      status === 403
        ? "Owner or manager access is required."
        : status === 404
          ? "The connection was not found."
          : status === 400
            ? "The connection is invalid."
            : status === 409
              ? "The connection cannot be disconnected in its current state."
              : "The connection could not be disconnected safely.",
      status,
    );
  }
  const parsed = connectionDisconnectSchema.safeParse(singleton(data));
  if (!parsed.success) {
    throw new ControlPlaneError("The disconnect request returned invalid state.", 503);
  }
  return parsed.data;
}

export async function answerBlockingQuestion(questionId: string, optionId: string): Promise<void> {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("albert_answer_blocking_question", {
    p_question_id: questionId,
    p_option_id: optionId,
  });
  if (error) throw new ControlPlaneError("The answer could not be saved.", 503);
}

export async function decideIdentityMatch(
  taskId: string,
  decision: "proposed" | "accepted" | "rejected",
): Promise<void> {
  const { supabase } = await requireUser();
  const { error } = await supabase.rpc("albert_decide_identity_match", {
    p_task_id: taskId,
    p_decision: decision,
  });
  if (error) throw new ControlPlaneError("The match decision could not be saved.", 503);
}

export async function listConversations(limit = 30): Promise<readonly ConversationSummary[]> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("albert_list_conversations", {
    p_limit: Math.max(1, Math.min(100, Math.trunc(limit))),
  });
  if (error) throw new ControlPlaneError("Conversation history could not be loaded.", 503);
  const parsed = z.array(conversationSummarySchema).safeParse(data);
  if (!parsed.success) throw new ControlPlaneError("Conversation history returned invalid state.", 503);
  return Object.freeze(parsed.data);
}

export async function loadConversationHistory(
  conversationId: string,
  afterSequence = 0,
): Promise<ConversationHistory> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("albert_conversation_history", {
    p_conversation_id: conversationId,
    p_after_sequence: Math.max(0, Math.trunc(afterSequence)),
  });
  if (error) {
    throw new ControlPlaneError(
      error.code === "P0002" ? "Conversation was not found." : "The conversation could not be loaded.",
      error.code === "P0002" ? 404 : 503,
    );
  }
  const parsed = conversationHistorySchema.safeParse(data);
  if (!parsed.success) throw new ControlPlaneError("The conversation returned invalid state.", 503);
  return parsed.data;
}

export async function loadAnswerLineage(answerArtifactId: string): Promise<AnswerLineage> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("albert_answer_lineage", {
    p_answer_artifact_id: answerArtifactId,
  });
  if (error) {
    throw new ControlPlaneError(
      error.code === "P0002" ? "Answer lineage was not found." : "Answer lineage could not be loaded.",
      error.code === "P0002" ? 404 : 503,
    );
  }
  const parsed = answerLineageSchema.safeParse(data);
  if (!parsed.success) throw new ControlPlaneError("Answer lineage returned invalid state.", 503);
  return parsed.data;
}

export async function loadTurnAnswerLineage(
  conversationId: string,
  turnId: string,
): Promise<AnswerLineage> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("albert_turn_answer_lineage", {
    p_conversation_id: conversationId,
    p_turn_id: turnId,
  });
  if (error) {
    throw new ControlPlaneError(
      error.code === "P0002" ? "Answer lineage was not found." : "Answer lineage could not be loaded.",
      error.code === "P0002" ? 404 : 503,
    );
  }
  const parsed = answerLineageSchema.safeParse(data);
  if (!parsed.success) throw new ControlPlaneError("Answer lineage returned invalid state.", 503);
  return parsed.data;
}

export async function consumeAlbertRateLimit(
  action: AlbertRateLimitAction,
): Promise<AlbertRateLimitDecision> {
  const policy = ALBERT_RATE_LIMIT_POLICIES[action];
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("consume_albert_rate_limit", {
    p_action: action,
    p_limit: policy.limit,
    p_window_seconds: policy.windowSeconds,
  });
  if (error) throw new ControlPlaneError("Request limits could not be verified.", 503);
  const parsed = z.object({
    allowed: z.boolean(),
    retry_after_seconds: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
  }).safeParse(singleton(data));
  if (!parsed.success) throw new ControlPlaneError("Request limits returned invalid state.", 503);
  return Object.freeze({
    allowed: parsed.data.allowed,
    retryAfterSeconds: parsed.data.retry_after_seconds,
    remaining: parsed.data.remaining,
    limit: policy.limit,
  });
}

const usageEntrySchema = z.object({
  usageLedgerId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  conversationId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  turnId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/),
  recordedAt: z.string(),
  model: z.string().min(1),
  fastMode: z.boolean(),
  requests: z.coerce.number().int().nonnegative(),
  inputTokens: z.coerce.number().int().nonnegative(),
  outputTokens: z.coerce.number().int().nonnegative(),
  cachedInputTokens: z.coerce.number().int().nonnegative(),
  estimatedCostUsdMicros: z.coerce.number().int().nonnegative(),
  query: z.string().nullable().transform((value) => value ?? ""),
  conversationTitle: z.string().nullable(),
}).strict();

const usageWorkspaceSchema = z.object({
  entries: z.array(usageEntrySchema),
  totals: z.object({
    queries: z.coerce.number().int().nonnegative(),
    inputTokens: z.coerce.number().int().nonnegative(),
    outputTokens: z.coerce.number().int().nonnegative(),
    estimatedCostUsdMicros: z.coerce.number().int().nonnegative(),
  }).strict(),
}).strict();

export type ModelUsageEntry = z.infer<typeof usageEntrySchema>;
export type ModelUsageWorkspace = z.infer<typeof usageWorkspaceSchema>;

export async function listModelUsage(limit = 100): Promise<ModelUsageWorkspace> {
  const { supabase } = await requireUser();
  const { data, error } = await supabase.rpc("albert_list_model_usage", {
    p_limit: Math.max(1, Math.min(200, Math.trunc(limit))),
  });
  if (error) {
    if (error.code === "PGRST202" || error.code === "42883") {
      throw new ControlPlaneError("The Albert control-plane migration is not deployed.", 503);
    }
    throw new ControlPlaneError("Usage history could not be loaded.", 503);
  }
  const parsed = usageWorkspaceSchema.safeParse(data);
  if (!parsed.success) throw new ControlPlaneError("Usage history returned invalid state.", 503);
  return parsed.data;
}

export class ControlPlaneError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ControlPlaneError";
  }
}
