import { createHash } from "node:crypto";
import {
  DAILY_BRIEF_CONVERSATION_TITLE,
  dailyBriefDue,
  dailyBriefMessage,
  dailyBriefModelLabel,
  dailyBriefTitle,
  dailyBriefWindow,
  DAILY_BRIEF_VERSION_PREFIX,
  DAILY_BRIEF_REFRESH_MS,
  parseDailyBriefAnswer,
  type DailyBriefFreshness,
} from "../../recommended-analysis/src/daily-brief.js";
import type { RecommendedQuestion } from "../../recommended-analysis/src/playbook.js";
import { normaliseRecommendedTools } from "../../recommended-analysis/src/tools.js";
import type { OwnerAnalysisRequest, OwnerAnalysisResult } from "./analysis.js";
import type { OwnerTenantContext } from "./owner-session.js";

/**
 * The daily look (ADR 0138). Every 24 hours a governed Luna Max turn
 * reviews the last seven days and stores up to three material investigations
 * with separate follow-up questions and evidence. Reuses a standing audit
 * conversation without old answers; failed attempts back off for retryMs.
 * The bridge holds the owner session and Cube signing capability.
 */

export type StoredDailyBrief = Readonly<{
  model: string;
  generatedAt: string;
  itemCount: number;
  windowStart?: string | null;
  windowEnd?: string | null;
}>;

export type DailyBriefSave = Readonly<{
  sourceFingerprint: string;
  sourceCount: number;
  verdict: string;
  recommendations: readonly RecommendedQuestion[];
  model: string;
  windowStart: string;
  windowEnd: string;
}>;

export interface DailyBriefStore {
  tenantContext(): Promise<OwnerTenantContext>;
  connectorRouting(): Promise<Readonly<{ activeConnectors: readonly string[]; freshness?: readonly DailyBriefFreshness[] }>>;
  findConversationByTitle(title: string): Promise<string | null>;
  recommendedAnalysis(): Promise<StoredDailyBrief | null>;
  saveRecommendedAnalysis(input: DailyBriefSave): Promise<void>;
}

export type DailyBriefDeps = Readonly<{
  store: DailyBriefStore;
  runAnalysis: (request: OwnerAnalysisRequest) => Promise<OwnerAnalysisResult>;
  model: string;
  effort: NonNullable<OwnerAnalysisRequest["effort"]>;
  refreshMs?: number;
  pollMs: number;
  /** After a failed attempt, how long to wait before trying again. */
  retryMs?: number;
  log: (event: string, fields?: Record<string, unknown>) => void;
  now?: () => Date;
}>;

export type DailyBriefStatus = Readonly<{
  enabled: boolean;
  pollMs: number;
  model: string;
  refreshMs: number;
  lastTickAt: string | null;
  lastRunAt: string | null;
  lastError: string | null;
  running: boolean;
  ticks: number;
}>;

const DEFAULT_RETRY_MS = 30 * 60_000;

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** The stored row's fingerprint: this run, not the chat corpus. */
export function dailyBriefFingerprint(input: Readonly<{ tenantId: string; conversationId: string; turnId: string }>): string {
  return createHash("sha256")
    .update(`daily-brief:${input.tenantId}:${input.conversationId}:${input.turnId}`)
    .digest("hex");
}

export class DailyBriefLoop {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private running = false;
  private lastTickAt: string | null = null;
  private lastRunAt: string | null = null;
  private lastError: string | null = null;
  private lastAttemptAt: number | null = null;
  private ticks = 0;

  constructor(private readonly deps: DailyBriefDeps) {}

  status(): DailyBriefStatus {
    return Object.freeze({
      enabled: true,
      pollMs: this.deps.pollMs,
      model: this.deps.model,
      refreshMs: this.deps.refreshMs ?? DAILY_BRIEF_REFRESH_MS,
      lastTickAt: this.lastTickAt,
      lastRunAt: this.lastRunAt,
      lastError: this.lastError,
      running: this.running,
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

  /** One poll: refresh the observed window if due. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.ticks += 1;
      const now = this.now();
      this.lastTickAt = now.toISOString();
      const retryMs = this.deps.retryMs ?? DEFAULT_RETRY_MS;
      if (this.lastAttemptAt !== null && now.getTime() - this.lastAttemptAt < retryMs) return;
      const [tenant, stored] = await Promise.all([
        this.deps.store.tenantContext(),
        this.deps.store.recommendedAnalysis(),
      ]);
      // A chat-history brief (the playbook's row) does not count as today's look.
      const lastGeneratedAt = stored?.model.startsWith(DAILY_BRIEF_VERSION_PREFIX) ? stored.generatedAt : null;
      if (!dailyBriefDue({ now, lastGeneratedAt, refreshMs: this.deps.refreshMs })) return;
      await this.run(tenant, now);
      this.lastError = null;
    } catch (error) {
      this.lastError = errorText(error);
      this.lastAttemptAt = this.now().getTime();
      this.deps.log("daily_brief_failed", { error: this.lastError });
    } finally {
      this.ticking = false;
    }
  }

  private async run(tenant: OwnerTenantContext, now: Date): Promise<void> {
    const { store } = this.deps;
    const startedAt = Date.now();
    this.lastAttemptAt = now.getTime();
    const routing = await store.connectorRouting();
    const tools = normaliseRecommendedTools(routing.activeConnectors);
    if (tools.length === 0) {
      this.deps.log("daily_brief_skipped", { reason: "no_connected_tools" });
      return;
    }
    this.running = true;
    try {
      const existing = await store.findConversationByTitle(DAILY_BRIEF_CONVERSATION_TITLE);
      const analysis = await this.deps.runAnalysis({
        question: dailyBriefMessage({
          now,
          timezone: tenant.timezone,
          connectorKeys: routing.activeConnectors,
          freshness: routing.freshness ?? [],
        }),
        ...(existing ? { conversationId: existing } : { newConversationTitle: DAILY_BRIEF_CONVERSATION_TITLE }),
        model: this.deps.model,
        effort: this.deps.effort,
        kind: "daily_brief",
        freshContext: true,
        // The answer is read by this loop and, if opened, rendered in the app: no bubble contract.
        channel: null,
      });
      const parsed = parseDailyBriefAnswer({
        text: analysis.answerText,
        followUps: analysis.followUps,
        connectorKeys: routing.activeConnectors,
        source: { conversationId: analysis.conversationId, title: dailyBriefTitle(now, tenant.timezone) },
      });
      if (analysis.clarification || !["Verified", "Qualified", "Exploratory"].includes(analysis.answerState) || !parsed.valid) {
        throw new Error(analysis.clarification
          ? "The daily look asked a clarifying question instead of answering."
          : "The daily look did not return a valid, evidence-backed brief.");
      }
      await store.saveRecommendedAnalysis({
        sourceFingerprint: dailyBriefFingerprint({
          tenantId: tenant.tenant_id,
          conversationId: analysis.conversationId,
          turnId: analysis.turnId,
        }),
        sourceCount: Math.min(40, tools.length),
        verdict: parsed.verdict.slice(0, 400),
        recommendations: parsed.items,
        model: dailyBriefModelLabel(this.deps.model),
        ...dailyBriefWindow(now),
      });
      this.lastRunAt = this.now().toISOString();
      this.deps.log("daily_brief_generated", {
        conversationId: analysis.conversationId,
        turnId: analysis.turnId,
        answerState: analysis.answerState,
        items: parsed.items.length,
        tools: parsed.items.map((item) => item.tool ?? null),
        durationMs: Date.now() - startedAt,
      });
    } finally {
      this.running = false;
    }
  }
}
