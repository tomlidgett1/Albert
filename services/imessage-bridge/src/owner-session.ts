import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { ulid } from "ulid";
import type { TraceEvent } from "../../../packages/shared/src/index.js";
import {
  normalizeQueryFailureCode,
  sanitizeQueryFailureMessage,
  type AnalyticalQueryAttemptOutcome,
  type AnalyticalQueryAttemptStart,
} from "../../../packages/shared/src/query-audit.js";
import {
  scheduledRunSchema,
  scheduledTaskSchema,
  toScheduledRun,
  toScheduledTask,
  type ScheduledRun,
} from "../../scheduled/src/contracts.js";
import type { ImessageWorkspace } from "./contracts.js";
import type {
  ScheduledRunClaim,
  ScheduledRunOutcome,
  ScheduledWork,
  SchedulerTask,
} from "./scheduler.js";

/**
 * Headless owner authentication and the control-plane operations the bridge
 * needs. The bridge signs in as the Albert owner (never as service_role for
 * data access): the Auth admin API issues a magic-link token for the owner's
 * email, verifying it yields a normal user session, and every RPC then runs
 * under the exact policies the web app's cookie session would. The
 * service key is used only for that token mint.
 */

const SESSION_REFRESH_MARGIN_MS = 5 * 60_000;

const tenantContextSchema = z.object({
  tenant_id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
  tenant_name: z.string(),
  role: z.enum(["owner", "manager", "bookkeeper", "internal_operator"]),
  timezone: z.string().min(1),
}).passthrough();

export type OwnerTenantContext = z.infer<typeof tenantContextSchema>;

const beginTurnSchema = z.object({
  conversation_id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
}).passthrough();

const conversationSummarySchema = z.object({
  conversation_id: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
  title: z.string().nullable(),
  updated_at: z.string(),
}).passthrough();

const modelContextTurnSchema = z.object({
  user_message: z.string(),
  status: z.string(),
  assistant_event: z.object({
    type: z.enum(["answer", "clarification"]),
    text: z.string().nullish(),
    question: z.string().nullish(),
  }).passthrough().nullish(),
}).passthrough();

const businessContextSchema = z.object({ rendered: z.string() }).passthrough();

const imessageWorkspaceSchema = z.object({
  allowGroupChats: z.boolean(),
  enrollments: z.array(z.object({
    enrollmentId: z.string(),
    phone: z.string(),
    displayName: z.string().nullish(),
    email: z.string().nullish(),
    isOwner: z.boolean(),
    enabled: z.boolean(),
    createdAt: z.string(),
  }).passthrough()),
}).passthrough();

const connectionsWorkspaceSchema = z.object({
  connections: z.array(z.object({
    connector_key: z.string(),
    status: z.string(),
    readiness: z.array(z.object({
      domain: z.string(),
      data_ready_through: z.string().nullish(),
    }).passthrough()).default([]),
  }).passthrough()),
}).passthrough();

const freshnessSchema = z.array(z.object({
  connector: z.string(),
  domain: z.string(),
  dataFrom: z.string().nullish(),
  dataThrough: z.string().nullable(),
}).passthrough());

const scheduledWorkSchema = z.object({
  due: z.array(scheduledTaskSchema),
  queued: z.array(scheduledRunSchema.extend({ task: scheduledTaskSchema })),
}).passthrough();

function toSchedulerTask(raw: z.infer<typeof scheduledTaskSchema>): SchedulerTask {
  const task = toScheduledTask(raw);
  return Object.freeze({
    taskId: task.taskId,
    title: task.title,
    requestText: task.requestText,
    prompt: task.prompt,
    timeOfDay: task.timeOfDay,
    days: task.days,
    timezone: task.timezone,
    phone: task.phone,
    enabled: task.enabled,
    nextRunAt: task.nextRunAt,
    lastRunAt: task.lastRunAt,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  });
}

export type ConnectorFreshnessEntry = Readonly<{
  connector: string;
  domain: string;
  dataFrom?: string | null;
  dataThrough: string | null;
}>;

function singleton(data: unknown): unknown {
  return Array.isArray(data) ? data[0] : data;
}

export class OwnerSessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OwnerSessionError";
  }
}

type CachedSession = Readonly<{ client: SupabaseClient; userId: string; expiresAtMs: number }>;

export class OwnerControlPlane {
  private session: CachedSession | null = null;
  private minting: Promise<CachedSession> | null = null;

  constructor(private readonly options: Readonly<{
    supabaseUrl: string;
    anonKey: string;
    serviceKey: string;
    ownerEmail: string;
  }>) {}

  private async mintSession(): Promise<CachedSession> {
    const admin = createClient(this.options.supabaseUrl, this.options.serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const link = await admin.auth.admin.generateLink({
      type: "magiclink",
      email: this.options.ownerEmail,
    });
    const tokenHash = link.data.properties?.hashed_token;
    if (link.error || !tokenHash) {
      throw new OwnerSessionError(`The owner sign-in link could not be issued: ${link.error?.message ?? "no token"}`);
    }
    const verifier = createClient(this.options.supabaseUrl, this.options.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const verified = await verifier.auth.verifyOtp({ type: "magiclink", token_hash: tokenHash });
    const accessToken = verified.data.session?.access_token;
    const expiresAt = verified.data.session?.expires_at;
    const userId = verified.data.user?.id ?? verified.data.session?.user?.id;
    if (verified.error || !accessToken || !userId) {
      throw new OwnerSessionError(`The owner session could not be established: ${verified.error?.message ?? "no session"}`);
    }
    const client = createClient(this.options.supabaseUrl, this.options.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers: { Authorization: `Bearer ${accessToken}` } },
    });
    return Object.freeze({
      client,
      userId,
      expiresAtMs: expiresAt ? expiresAt * 1000 : Date.now() + 30 * 60_000,
    });
  }

  private async currentSession(): Promise<CachedSession> {
    if (this.session && this.session.expiresAtMs - Date.now() > SESSION_REFRESH_MARGIN_MS) {
      return this.session;
    }
    this.minting ??= this.mintSession().finally(() => { this.minting = null; });
    this.session = await this.minting;
    return this.session;
  }

  private async client(): Promise<SupabaseClient> {
    return (await this.currentSession()).client;
  }

  /** The owner's auth user id — the actorId every turn runs under. */
  async ownerUserId(): Promise<string> {
    return (await this.currentSession()).userId;
  }

  private async rpc<T>(
    name: string,
    params: Record<string, unknown> | undefined,
    parse: (data: unknown) => T,
  ): Promise<T> {
    const client = await this.client();
    const { data, error } = await client.rpc(name, params);
    if (error) {
      throw new OwnerSessionError(`${name} failed: ${error.message ?? "unknown error"}${error.code ? ` (${error.code})` : ""}`);
    }
    return parse(data);
  }

  async tenantContext(): Promise<OwnerTenantContext> {
    return this.rpc("current_albert_context", undefined, (data) => {
      const parsed = tenantContextSchema.parse(singleton(data));
      return parsed;
    });
  }

  /** Finds the standing conversation for a Linq chat by its assigned title. */
  async findConversationByTitle(title: string): Promise<string | null> {
    return this.rpc("albert_list_conversations", { p_limit: 100 }, (data) => {
      const parsed = z.array(conversationSummarySchema.passthrough()).parse(data ?? []);
      const match = parsed.find((conversation) => conversation.title === title);
      return match?.conversation_id ?? null;
    });
  }

  async beginTurn(input: Readonly<{
    conversationId?: string;
    turnId: string;
    message: string;
    runtimeProfile: Readonly<Record<string, unknown>>;
  }>): Promise<string> {
    return this.rpc("begin_albert_turn", {
      p_conversation_id: input.conversationId ?? null,
      p_turn_id: input.turnId,
      p_user_message: input.message,
      p_runtime_profile: input.runtimeProfile,
      p_confirmation_turn_id: null,
      p_confirmation_option_id: null,
    }, (data) => beginTurnSchema.parse(singleton(data)).conversation_id);
  }

  /** Fails any still-running turns so a fresh begin can proceed. */
  async releaseRunningTurns(conversationId: string): Promise<void> {
    const client = await this.client();
    const history = await client.rpc("albert_conversation_history", {
      p_conversation_id: conversationId,
      p_after_sequence: 0,
    });
    if (history.error) return;
    const payload = singleton(history.data);
    const turns = Array.isArray((payload as { turns?: unknown })?.turns)
      ? (payload as { turns: unknown[] }).turns
      : Array.isArray(history.data) ? history.data as unknown[] : [];
    for (const turn of turns) {
      if (!turn || typeof turn !== "object") continue;
      const record = turn as { status?: unknown; turn_id?: unknown };
      if (record.status !== "running" || typeof record.turn_id !== "string") continue;
      await client.rpc("fail_albert_turn", {
        p_conversation_id: conversationId,
        p_turn_id: record.turn_id,
        p_failure_code: "stale_lease_released",
      });
    }
  }

  async renewTurnLease(turnId: string): Promise<void> {
    const client = await this.client();
    await client.rpc("renew_albert_turn_lease", { p_turn_id: turnId, p_lease_seconds: 360 });
  }

  async failTurn(conversationId: string, turnId: string, failureCode: string): Promise<void> {
    const client = await this.client();
    await client.rpc("fail_albert_turn", {
      p_conversation_id: conversationId,
      p_turn_id: turnId,
      p_failure_code: failureCode,
    });
  }

  /**
   * The analytical query ledger, written through the same RPCs the web route
   * uses (services/control-plane/src/query-log-repository.ts). Without it an
   * iMessage turn leaves no record of which governed queries ran or failed.
   */
  async recordQueryAttempt(input: Readonly<{
    conversationId: string;
    turnId: string;
    correlationId: string;
    attempt: AnalyticalQueryAttemptStart;
  }>): Promise<void> {
    return this.rpc("albert_record_analytical_query_attempt", {
      p_query_attempt_id: input.attempt.queryAttemptId,
      p_conversation_id: input.conversationId,
      p_turn_id: input.turnId,
      p_runtime: input.attempt.runtime,
      p_source: input.attempt.source,
      p_operation: input.attempt.operation,
      p_query_document: input.attempt.queryDocument,
      p_topic: input.attempt.topic ?? null,
      p_branch_label: input.attempt.branchLabel ?? null,
      p_correlation_id: input.correlationId,
    }, () => undefined);
  }

  async recordQueryOutcome(outcome: AnalyticalQueryAttemptOutcome): Promise<void> {
    const succeeded = outcome.status === "succeeded";
    return this.rpc("albert_record_analytical_query_outcome", {
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
    }, () => undefined);
  }

  async assignConversationTitle(conversationId: string, title: string): Promise<void> {
    const client = await this.client();
    await client.rpc("albert_assign_conversation_title", {
      p_conversation_id: conversationId,
      p_title: title,
    });
  }

  async appendEvent(conversationId: string, turnId: string, event: TraceEvent): Promise<void> {
    return this.rpc("albert_answer_event_append", {
      p_conversation_id: conversationId,
      p_turn_id: turnId,
      p_event: event,
    }, () => undefined);
  }

  /** Prior turns as model messages, matching the web caller's mapping. */
  async priorConversation(conversationId: string): Promise<ReadonlyArray<Readonly<{ role: "user" | "assistant"; text: string }>>> {
    return this.rpc("albert_model_context", {
      p_conversation_id: conversationId,
      p_turn_limit: 12,
    }, (data) => {
      const parsed = z.array(modelContextTurnSchema).parse(data ?? []);
      const messages: Array<{ role: "user" | "assistant"; text: string }> = [];
      for (const turn of parsed) {
        messages.push({ role: "user", text: turn.user_message.slice(0, 24_000) });
        const event = turn.assistant_event;
        if (event?.type === "answer" && event.text) {
          messages.push({ role: "assistant", text: event.text.slice(0, 24_000) });
        } else if (event?.type === "clarification" && event.question) {
          messages.push({ role: "assistant", text: event.question.slice(0, 24_000) });
        } else if (turn.status === "failed") {
          messages.push({ role: "assistant", text: "No answer was produced for this message." });
        }
      }
      return Object.freeze(messages.slice(-12));
    });
  }

  /** Enrolled senders and the group-chat switch, managed on /imessage. */
  async imessageWorkspace(): Promise<ImessageWorkspace> {
    return this.rpc("albert_imessage_workspace", undefined, (data) => {
      const parsed = imessageWorkspaceSchema.parse(singleton(data));
      return Object.freeze({
        allowGroupChats: parsed.allowGroupChats,
        enrollments: Object.freeze(parsed.enrollments.map((enrollment) => Object.freeze({
          enrollmentId: enrollment.enrollmentId,
          phone: enrollment.phone,
          displayName: enrollment.displayName ?? null,
          email: enrollment.email ?? null,
          isOwner: enrollment.isOwner,
          enabled: enrollment.enabled,
          createdAt: enrollment.createdAt,
        }))),
      });
    });
  }

  /** Due schedules and queued manual runs (migration 0183), for the scheduler. */
  async scheduledWork(): Promise<ScheduledWork> {
    return this.rpc("albert_scheduled_work", undefined, (data) => {
      const parsed = scheduledWorkSchema.parse(singleton(data));
      return Object.freeze({
        due: Object.freeze(parsed.due.map(toSchedulerTask)),
        queued: Object.freeze(parsed.queued.map((run) => Object.freeze({
          ...toScheduledRun(run),
          task: toSchedulerTask(run.task),
        }))),
      });
    });
  }

  /** Atomically claims one run; null when the slot was edited or taken. */
  async claimScheduledRun(claim: ScheduledRunClaim): Promise<ScheduledRun | null> {
    return this.rpc("albert_scheduled_run_claim", {
      p_task_id: claim.taskId,
      p_run_id: claim.runId,
      p_trigger: claim.trigger,
      p_expected_next_run_at: claim.expectedNextRunAt,
      p_next_run_at: claim.nextRunAt,
    }, (data) => {
      const value = singleton(data);
      if (value == null) return null;
      return toScheduledRun(scheduledRunSchema.parse(value));
    });
  }

  async finishScheduledRun(outcome: ScheduledRunOutcome): Promise<void> {
    return this.rpc("albert_scheduled_run_finish", {
      p_run_id: outcome.runId,
      p_status: outcome.status,
      p_conversation_id: outcome.conversationId ?? null,
      p_turn_id: outcome.turnId ?? null,
      p_answer_state: outcome.answerState ?? null,
      p_summary: outcome.summary ?? null,
      p_error: outcome.error ?? null,
      p_bubbles: outcome.bubbles ?? null,
    }, () => undefined);
  }

  async businessContext(): Promise<string | undefined> {
    try {
      return await this.rpc("albert_business_context", undefined, (data) => {
        const payload = singleton(data);
        if (!payload) return undefined;
        const parsed = businessContextSchema.safeParse(payload);
        return parsed.success ? parsed.data.rendered.slice(0, 20_000) : undefined;
      });
    } catch {
      return undefined;
    }
  }

  async connectorRouting(): Promise<Readonly<{
    activeConnectors: readonly string[];
    freshness: readonly ConnectorFreshnessEntry[];
  }>> {
    const client = await this.client();
    const { data, error } = await client.rpc("albert_connections_workspace");
    if (error) return Object.freeze({ activeConnectors: [], freshness: [] });
    const parsed = connectionsWorkspaceSchema.safeParse(singleton(data));
    if (!parsed.success) return Object.freeze({ activeConnectors: [], freshness: [] });
    const active = parsed.data.connections
      .filter(({ status }) => status !== "pending" && status !== "disconnected");
    const activeConnectors = Object.freeze([...new Set(active.map((connection) => connection.connector_key))]);
    const byConnectorDomain = new Map<string, ConnectorFreshnessEntry>();
    for (const connection of active) {
      for (const readiness of connection.readiness) {
        const key = `${connection.connector_key} ${readiness.domain}`;
        const existing = byConnectorDomain.get(key);
        const candidate = readiness.data_ready_through ?? null;
        if (!existing || (candidate !== null && (existing.dataThrough === null || candidate > existing.dataThrough))) {
          byConnectorDomain.set(key, Object.freeze({
            connector: connection.connector_key,
            domain: readiness.domain,
            dataThrough: candidate,
          }));
        }
      }
    }
    let freshness: readonly ConnectorFreshnessEntry[] = [...byConnectorDomain.values()]
      .sort((a, b) => a.connector.localeCompare(b.connector) || a.domain.localeCompare(b.domain));
    if (!freshness.some((entry) => entry.dataThrough !== null)) {
      const fallback = await client.rpc("albert_connector_freshness");
      const parsedFallback = freshnessSchema.safeParse(singleton(fallback.data));
      if (parsedFallback.success) {
        freshness = parsedFallback.data.map((entry) => Object.freeze({
          connector: entry.connector,
          domain: entry.domain,
          dataThrough: entry.dataThrough,
        }));
      }
    }
    return Object.freeze({ activeConnectors, freshness: Object.freeze([...freshness]) });
  }
}

/**
 * Stamps and persists trace events with the same identity/ordering contract
 * as the web caller's emitter: ulid ids, 1-based contiguous sequence, ISO
 * occurredAt, writes chained in order. The 0140/0179 append RPC rejects any
 * non-contiguous sequence, so a failed write fails the rest of the turn's
 * persistence rather than skipping numbers.
 */
export function createPersistingEmitter(input: Readonly<{
  store: OwnerControlPlane;
  conversationId: string;
  turnId: string;
  onEvent?: (event: TraceEvent) => void;
  onPersistError?: (error: unknown, event: TraceEvent) => void;
}>): Readonly<{
  emit: (partial: Record<string, unknown>) => Promise<TraceEvent>;
  drain: () => Promise<void>;
}> {
  let sequence = 0;
  let broken = false;
  let queue: Promise<void> = Promise.resolve();
  const emit = async (partial: Record<string, unknown>): Promise<TraceEvent> => {
    sequence += 1;
    const event = {
      ...partial,
      id: ulid(),
      sequence,
      occurredAt: new Date().toISOString(),
    } as unknown as TraceEvent;
    queue = queue.then(async () => {
      if (broken) return;
      try {
        await input.store.appendEvent(input.conversationId, input.turnId, event);
      } catch (error) {
        broken = true;
        input.onPersistError?.(error, event);
      }
    });
    input.onEvent?.(event);
    return event;
  };
  return Object.freeze({
    emit,
    drain: async () => {
      let pending = queue;
      for (;;) {
        await pending;
        if (pending === queue) break;
        pending = queue;
      }
    },
  });
}
