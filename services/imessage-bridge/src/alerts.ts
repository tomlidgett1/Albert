import { ulid } from "ulid";
import {
  ALERT_TRIGGER_BY_KEY,
  ALERT_TRIGGER_CATALOGUE,
  ALERT_STALE_DATA_RERUN_MS,
  ALERTS_CONVERSATION_TITLE,
  packAlertBubbles,
  type AlertEvaluation,
  type AlertEvent,
  type AlertEventDraft,
  type AlertResultSummary,
  type AlertSettings,
  type AlertTriggerKey,
  type AlertTriggerRow,
} from "../../alerts/src/contracts.js";
import { evaluateAlerts, freshnessDigest } from "../../alerts/src/evaluate.js";
import {
  ALERT_TRIGGERS,
  alertContext,
  type AlertFreshness,
  type AlertQueryLoader,
  type AlertTrigger,
} from "../../alerts/src/triggers.js";
import type { ImessageWorkspace } from "./contracts.js";
import type { LinqTextDecoration } from "./linq.js";
import type { OwnerTenantContext } from "./owner-session.js";

/**
 * The heads-up alerts loop (ADR 0132). Every poll it asks the control plane
 * whether a check was requested or a scheduled evaluation is due, claims it,
 * opens a short owner turn lease in the standing "Alerts · checks"
 * conversation (Cube refuses queries without one), evaluates the enabled
 * triggers over the governed views, records each reading and every new
 * event, and texts the fired events to each trigger's recipients.
 *
 * It lives in the bridge for the same reason the scheduler does: this is
 * the one process holding the owner session, the Cube signing secret and
 * the Linq token.
 */

export type AlertsWork = Readonly<{
  queued: AlertEvaluation | null;
  due: boolean;
  settings: AlertSettings;
  triggers: readonly AlertTriggerRow[];
}>;

export type AlertEvaluationClaim = Readonly<{
  evaluationId: string;
  trigger: "schedule" | "manual";
  conversationId: string;
  turnId: string;
}>;

export type AlertRecordInput = Readonly<{
  evaluationId: string;
  triggerKey: AlertTriggerKey;
  result: AlertResultSummary;
  events: ReadonlyArray<AlertEventDraft & Readonly<{ recipients: readonly string[] }>>;
}>;

export type AlertEvaluationOutcome = Readonly<{
  evaluationId: string;
  status: "finished" | "failed";
  summary: Readonly<Record<string, unknown>>;
  error?: string;
  freshnessDigest?: string;
}>;

export interface AlertsStore {
  alertsWork(): Promise<AlertsWork>;
  claimAlertEvaluation(claim: AlertEvaluationClaim): Promise<AlertEvaluation | null>;
  recordAlertResult(input: AlertRecordInput): Promise<readonly AlertEvent[]>;
  finishAlertEvent(input: Readonly<{ eventId: string; status: "sent" | "failed"; error?: string }>): Promise<void>;
  finishAlertEvaluation(outcome: AlertEvaluationOutcome): Promise<void>;
  imessageWorkspace(): Promise<ImessageWorkspace>;
  tenantContext(): Promise<OwnerTenantContext>;
  connectorRouting(): Promise<Readonly<{ activeConnectors: readonly string[]; freshness: readonly AlertFreshness[] }>>;
  findConversationByTitle(title: string): Promise<string | null>;
  beginTurn(input: Readonly<{
    conversationId?: string;
    turnId: string;
    message: string;
    runtimeProfile: Readonly<Record<string, unknown>>;
  }>): Promise<string>;
  releaseRunningTurns(conversationId: string): Promise<void>;
  assignConversationTitle(conversationId: string, title: string): Promise<void>;
  renewTurnLease(turnId: string): Promise<void>;
  failTurn(conversationId: string, turnId: string, failureCode: string): Promise<void>;
}

export interface AlertsSender {
  createChat(from: string, to: string, text: string, decorations?: readonly LinqTextDecoration[]): Promise<string | null>;
  sendMessage(chatId: string, text: string, decorations?: readonly LinqTextDecoration[]): Promise<void>;
}

/** Builds the query loader for one evaluation's lease (a Cube client in production). */
export type AlertQueryLoaderFactory = (lease: Readonly<{
  tenantId: string;
  role: OwnerTenantContext["role"];
  conversationId: string;
  turnId: string;
}>) => AlertQueryLoader;

export type AlertsLoopDeps = Readonly<{
  store: AlertsStore;
  sender: AlertsSender;
  botNumber: string;
  queryLoader: AlertQueryLoaderFactory;
  pollMs: number;
  /** Local hours during which scheduled evaluations do not run (a manual check always runs). */
  quietHours: Readonly<{ from: number; to: number }>;
  log: (event: string, fields?: Record<string, unknown>) => void;
  triggers?: readonly AlertTrigger[];
  now?: () => Date;
  /** The turn's stored runtime profile; the same shape the analysis path records. */
  runtimeProfile: Readonly<Record<string, unknown>>;
}>;

export type AlertsLoopStatus = Readonly<{
  enabled: boolean;
  pollMs: number;
  lastTickAt: string | null;
  lastError: string | null;
  lastEvaluationAt: string | null;
  evaluating: boolean;
  ticks: number;
}>;

const LEASE_RENEWAL_INTERVAL_MS = 120_000;
const EVALUATION_TIMEOUT_MS = 9 * 60_000;

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function localHour(date: Date, timezone: string): number {
  try {
    const hour = Number(new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "numeric", hourCycle: "h23" }).format(date));
    return Number.isFinite(hour) ? hour : date.getUTCHours();
  } catch {
    return date.getUTCHours();
  }
}

/** True inside the quiet window (which may wrap midnight, e.g. 21 → 7). */
export function inQuietHours(hour: number, quiet: Readonly<{ from: number; to: number }>): boolean {
  if (quiet.from === quiet.to) return false;
  return quiet.from < quiet.to
    ? hour >= quiet.from && hour < quiet.to
    : hour >= quiet.from || hour < quiet.to;
}

/**
 * Resolves each catalogue trigger's switch and recipients: a stored row
 * wins; without one the trigger is on and goes to the owner's enrolled
 * number. Recipients are always filtered to enabled enrolments, so a number
 * removed on the iMessage page stops receiving alerts at once.
 */
export function resolveAlertRecipients(input: Readonly<{
  rows: readonly AlertTriggerRow[];
  workspace: ImessageWorkspace;
}>): ReadonlyMap<AlertTriggerKey, Readonly<{ enabled: boolean; recipients: readonly string[] }>> {
  const enabledPhones = new Set(input.workspace.enrollments.filter((entry) => entry.enabled).map((entry) => entry.phone));
  const owner = input.workspace.enrollments.find((entry) => entry.isOwner && entry.enabled)?.phone
    ?? input.workspace.enrollments.find((entry) => entry.enabled)?.phone
    ?? null;
  const byKey = new Map(input.rows.map((row) => [row.triggerKey, row]));
  const resolved = new Map<AlertTriggerKey, Readonly<{ enabled: boolean; recipients: readonly string[] }>>();
  for (const definition of ALERT_TRIGGER_CATALOGUE) {
    const row = byKey.get(definition.key);
    const recipients = row ? row.recipients.filter((phone) => enabledPhones.has(phone)) : owner ? [owner] : [];
    resolved.set(definition.key, Object.freeze({ enabled: row?.enabled ?? true, recipients: Object.freeze([...new Set(recipients)]) }));
  }
  return resolved;
}

export class AlertsEvaluatorLoop {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private lastTickAt: string | null = null;
  private lastError: string | null = null;
  private lastEvaluationAt: string | null = null;
  private evaluating = false;
  private ticks = 0;

  constructor(private readonly deps: AlertsLoopDeps) {}

  status(): AlertsLoopStatus {
    return Object.freeze({
      enabled: true,
      pollMs: this.deps.pollMs,
      lastTickAt: this.lastTickAt,
      lastError: this.lastError,
      lastEvaluationAt: this.lastEvaluationAt,
      evaluating: this.evaluating,
      ticks: this.ticks,
    });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.deps.pollMs);
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** One poll: a requested check first, else a due scheduled evaluation. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const work = await this.deps.store.alertsWork();
      this.ticks += 1;
      this.lastTickAt = this.now().toISOString();
      if (work.queued) {
        await this.evaluate(work, work.queued.evaluationId, "manual");
      } else if (work.due) {
        await this.evaluateIfWorthwhile(work);
      }
      this.lastError = null;
    } catch (error) {
      this.lastError = errorText(error);
      this.deps.log("alerts_tick_failed", { error: this.lastError });
    } finally {
      this.ticking = false;
    }
  }

  private async evaluateIfWorthwhile(work: AlertsWork): Promise<void> {
    const tenant = await this.deps.store.tenantContext();
    const hour = localHour(this.now(), tenant.timezone);
    if (inQuietHours(hour, this.deps.quietHours)) return;
    // Unchanged data within the rerun window is not worth a lease and thirty
    // queries; the digest is what "the data came in" means here.
    const routing = await this.deps.store.connectorRouting();
    const digest = freshnessDigest(routing.freshness);
    const lastAt = work.settings.lastEvaluatedAt ? Date.parse(work.settings.lastEvaluatedAt) : Number.NaN;
    if (
      work.settings.lastFreshnessDigest === digest
      && Number.isFinite(lastAt)
      && this.now().getTime() - lastAt < ALERT_STALE_DATA_RERUN_MS
    ) {
      return;
    }
    await this.evaluate(work, ulid(), "schedule", { tenant, routing });
  }

  private async evaluate(
    work: AlertsWork,
    evaluationId: string,
    trigger: "schedule" | "manual",
    preloaded?: Readonly<{ tenant: OwnerTenantContext; routing: Awaited<ReturnType<AlertsStore["connectorRouting"]>> }>,
  ): Promise<void> {
    const { store } = this.deps;
    const startedAt = Date.now();
    const tenant = preloaded?.tenant ?? await store.tenantContext();
    const routing = preloaded?.routing ?? await store.connectorRouting();
    const workspace = await store.imessageWorkspace();

    // The lease: a turn in the standing alerts conversation.
    const turnId = ulid();
    const existing = await store.findConversationByTitle(ALERTS_CONVERSATION_TITLE);
    let conversationId: string;
    try {
      conversationId = await store.beginTurn({
        ...(existing ? { conversationId: existing } : {}),
        turnId,
        message: `Alerts check (${trigger})`,
        runtimeProfile: this.deps.runtimeProfile,
      });
    } catch (error) {
      if (existing && /running|55000/iu.test(error instanceof Error ? error.message : "")) {
        await store.releaseRunningTurns(existing);
        conversationId = await store.beginTurn({ conversationId: existing, turnId, message: `Alerts check (${trigger})`, runtimeProfile: this.deps.runtimeProfile });
      } else {
        throw error;
      }
    }
    if (!existing) await store.assignConversationTitle(conversationId, ALERTS_CONVERSATION_TITLE).catch(() => undefined);

    const claimed = await store.claimAlertEvaluation({ evaluationId, trigger, conversationId, turnId });
    if (!claimed) {
      await store.failTurn(conversationId, turnId, "albert_alerts_not_claimed").catch(() => undefined);
      return;
    }
    this.evaluating = true;
    const renewal = setInterval(() => void store.renewTurnLease(turnId).catch(() => undefined), LEASE_RENEWAL_INTERVAL_MS);
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(new Error("The alerts evaluation timed out.")), EVALUATION_TIMEOUT_MS);
    const recipientsByKey = resolveAlertRecipients({ rows: work.triggers, workspace });
    const triggers = (this.deps.triggers ?? ALERT_TRIGGERS).filter((entry) => recipientsByKey.get(entry.key)?.enabled !== false);
    const context = alertContext({
      now: this.now(),
      timezone: tenant.timezone,
      activeConnectors: routing.activeConnectors,
      freshness: routing.freshness,
    });
    const load = this.deps.queryLoader({ tenantId: tenant.tenant_id, role: tenant.role, conversationId, turnId });
    const pending = new Map<string, AlertEvent[]>();
    const recordedEvents: AlertEvent[] = [];
    let evaluated = 0;
    try {
      const report = await evaluateAlerts({
        triggers,
        context,
        load,
        signal: abort.signal,
        onTrigger: async (key, evaluation) => {
          evaluated += 1;
          const recipients = recipientsByKey.get(key)?.recipients ?? [];
          let recorded: readonly AlertEvent[] = [];
          try {
            recorded = await store.recordAlertResult({
              evaluationId,
              triggerKey: key,
              result: evaluation.result,
              events: evaluation.events.map((event) => ({ ...event, recipients })),
            });
          } catch (error) {
            this.deps.log("alerts_record_failed", { evaluationId, triggerKey: key, error: errorText(error) });
            return;
          }
          for (const event of recorded) {
            recordedEvents.push(event);
            if (event.status !== "queued") continue;
            for (const phone of event.recipients) {
              pending.set(phone, [...(pending.get(phone) ?? []), event]);
            }
          }
        },
      });
      const delivery = await this.deliver(pending, workspace);
      const summary = {
        trigger,
        evaluated,
        queries: report.queries,
        failedQueries: report.failedQueries,
        errors: report.errors,
        fired: recordedEvents.length,
        delivered: delivery.sent,
        deliveryFailures: delivery.failed,
        durationMs: Date.now() - startedAt,
        dataThrough: routing.freshness.map((entry) => ({ connector: entry.connector, domain: entry.domain, dataThrough: entry.dataThrough })),
        activeConnectors: routing.activeConnectors,
      };
      await store.finishAlertEvaluation({
        evaluationId,
        status: "finished",
        summary,
        freshnessDigest: freshnessDigest(routing.freshness),
      });
      this.lastEvaluationAt = this.now().toISOString();
      this.deps.log("alerts_evaluated", { evaluationId, conversationId, turnId, ...summary, dataThrough: undefined });
    } catch (error) {
      const message = errorText(error);
      this.deps.log("alerts_evaluation_failed", { evaluationId, conversationId, turnId, durationMs: Date.now() - startedAt, error: message });
      await store.finishAlertEvaluation({
        evaluationId,
        status: "failed",
        summary: { trigger, evaluated, fired: recordedEvents.length, durationMs: Date.now() - startedAt },
        error: message.slice(0, 400),
      }).catch((finishError) => this.deps.log("alerts_finish_failed", { evaluationId, error: errorText(finishError) }));
    } finally {
      clearInterval(renewal);
      clearTimeout(timeout);
      this.evaluating = false;
      await store.failTurn(conversationId, turnId, "albert_alerts_evaluated").catch(() => undefined);
    }
  }

  /** Texts each number its fired events (packed into a few bubbles) and records every event's outcome. */
  private async deliver(
    pending: ReadonlyMap<string, readonly AlertEvent[]>,
    workspace: ImessageWorkspace,
  ): Promise<Readonly<{ sent: number; failed: number }>> {
    const enabledPhones = new Set(workspace.enrollments.filter((entry) => entry.enabled).map((entry) => entry.phone));
    const outcome = new Map<string, { ok: boolean; error?: string }>();
    for (const [phone, events] of pending) {
      const mark = (ok: boolean, error?: string) => {
        for (const event of events) {
          const current = outcome.get(event.eventId);
          if (!current) outcome.set(event.eventId, { ok, ...(error ? { error } : {}) });
          else if (!ok) outcome.set(event.eventId, { ok: false, error: error ?? current.error });
        }
      };
      if (!enabledPhones.has(phone)) {
        mark(false, "That number is no longer enrolled for iMessage.");
        continue;
      }
      try {
        const bubbles = packAlertBubbles(events.map((event) => ({ headline: event.headline, body: event.body })));
        const [first, ...rest] = bubbles;
        if (!first) continue;
        const decorations = (bubble: typeof first): LinqTextDecoration[] => bubble.bold.map((range) => ({ range, style: "bold" as const }));
        const chatId = await this.deps.sender.createChat(this.deps.botNumber, phone, first.text, decorations(first));
        for (const bubble of rest) {
          if (!chatId) throw new Error("Linq did not return the chat for the remaining bubbles.");
          await this.deps.sender.sendMessage(chatId, bubble.text, decorations(bubble));
        }
        mark(true);
        this.deps.log("alerts_delivered", { phone, events: events.length, bubbles: bubbles.length });
      } catch (error) {
        const message = errorText(error);
        this.deps.log("alerts_delivery_failed", { phone, events: events.length, error: message });
        mark(false, message.slice(0, 400));
      }
    }
    let sent = 0;
    let failed = 0;
    for (const [eventId, result] of outcome) {
      if (result.ok) sent += 1;
      else failed += 1;
      await this.deps.store.finishAlertEvent({
        eventId,
        status: result.ok ? "sent" : "failed",
        ...(result.error ? { error: result.error } : {}),
      }).catch((finishError) => this.deps.log("alerts_event_finish_failed", { eventId, error: errorText(finishError) }));
    }
    return Object.freeze({ sent, failed });
  }
}

export { ALERT_TRIGGER_BY_KEY };
