import { ulid } from "ulid";
import {
  SCHEDULED_RUN_GRACE_MS,
  scheduledFailureText,
  scheduledRunConversationTitle,
  scheduledRunMessage,
  type ScheduledRun,
  type ScheduledTask,
} from "../../scheduled/src/contracts.js";
import { formatInZone, nextScheduledRunAt } from "../../scheduled/src/next-run.js";
import type { ImessageWorkspace } from "./contracts.js";
import { formatAnswerForImessage } from "./format.js";
import type { LinqTextDecoration } from "./linq.js";
import type { OwnerAnalysisRequest, OwnerAnalysisResult } from "./analysis.js";

/**
 * The scheduled-reports loop (ADR 0131). Every poll it asks the control
 * plane for due schedules and queued manual runs, claims each one
 * atomically (the RPC advances the schedule's next slot at claim time, so
 * a long run is never claimed twice), runs the Omni analysis as the owner
 * and texts the answer to the schedule's enrolled number through Linq.
 *
 * It lives in the bridge because the bridge is the one process holding the
 * owner session, the Cube signing secret and the Linq token; nothing else
 * may run turns as the owner or send on the line.
 */

/** A scheduled task as the work RPC returns it (no run history). */
export type SchedulerTask = Omit<ScheduledTask, "lastRun" | "recentRuns">;

export type ScheduledWork = Readonly<{
  due: readonly SchedulerTask[];
  queued: ReadonlyArray<ScheduledRun & Readonly<{ task: SchedulerTask }>>;
}>;

export type ScheduledRunClaim = Readonly<{
  taskId: string;
  runId: string;
  trigger: "schedule" | "manual";
  expectedNextRunAt: string | null;
  nextRunAt: string | null;
}>;

export type ScheduledRunOutcome = Readonly<{
  runId: string;
  status: "sent" | "failed" | "missed";
  conversationId?: string;
  turnId?: string;
  answerState?: string;
  summary?: string;
  error?: string;
  bubbles?: number;
}>;

export interface SchedulerStore {
  scheduledWork(): Promise<ScheduledWork>;
  claimScheduledRun(claim: ScheduledRunClaim): Promise<ScheduledRun | null>;
  finishScheduledRun(outcome: ScheduledRunOutcome): Promise<void>;
  imessageWorkspace(): Promise<ImessageWorkspace>;
}

export interface SchedulerSender {
  createChat(from: string, to: string, text: string, decorations?: readonly LinqTextDecoration[]): Promise<string | null>;
  sendMessage(chatId: string, text: string, decorations?: readonly LinqTextDecoration[]): Promise<void>;
}

export type SchedulerDeps = Readonly<{
  store: SchedulerStore;
  sender: SchedulerSender;
  botNumber: string;
  runAnalysis: (request: OwnerAnalysisRequest) => Promise<OwnerAnalysisResult>;
  pollMs: number;
  log: (event: string, fields?: Record<string, unknown>) => void;
  now?: () => Date;
}>;

export type SchedulerStatus = Readonly<{
  enabled: boolean;
  pollMs: number;
  lastTickAt: string | null;
  lastError: string | null;
  activeRuns: number;
  ticks: number;
}>;

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export class ScheduledReportScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private lastTickAt: string | null = null;
  private lastError: string | null = null;
  private activeRuns = 0;
  private ticks = 0;

  constructor(private readonly deps: SchedulerDeps) {}

  status(): SchedulerStatus {
    return Object.freeze({
      enabled: true,
      pollMs: this.deps.pollMs,
      lastTickAt: this.lastTickAt,
      lastError: this.lastError,
      activeRuns: this.activeRuns,
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

  /** One poll: queued manual runs first (someone is waiting), then due schedules. Serial. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const work = await this.deps.store.scheduledWork();
      this.ticks += 1;
      this.lastTickAt = this.now().toISOString();
      for (const run of work.queued) await this.processQueued(run);
      for (const task of work.due) await this.processDue(task);
      this.lastError = null;
    } catch (error) {
      this.lastError = errorText(error);
      this.deps.log("scheduled_tick_failed", { error: this.lastError });
    } finally {
      this.ticking = false;
    }
  }

  private async processDue(task: SchedulerTask): Promise<void> {
    const now = this.now();
    // The slot after this one, computed from the schedule as it was read;
    // the claim is optimistic on the slot we read, so an edit in between
    // makes this claim miss and the next tick reads the new schedule.
    const nextRunAt = nextScheduledRunAt(task, now);
    const claimed = await this.deps.store.claimScheduledRun({
      taskId: task.taskId,
      runId: ulid(),
      trigger: "schedule",
      expectedNextRunAt: task.nextRunAt,
      nextRunAt: nextRunAt ? nextRunAt.toISOString() : null,
    });
    if (!claimed) return;
    const scheduledFor = claimed.scheduledFor ? Date.parse(claimed.scheduledFor) : now.getTime();
    if (Number.isFinite(scheduledFor) && now.getTime() - scheduledFor > SCHEDULED_RUN_GRACE_MS) {
      // Hours late is worse than absent: "yesterday" would no longer mean
      // yesterday. Record the miss and wait for the next slot.
      const slot = formatInZone(new Date(scheduledFor), task.timezone);
      await this.deps.store.finishScheduledRun({
        runId: claimed.runId,
        status: "missed",
        error: `Missed the ${slot} slot because the scheduler was not running.`,
      });
      this.deps.log("scheduled_run_missed", { taskId: task.taskId, runId: claimed.runId, scheduledFor: claimed.scheduledFor });
      return;
    }
    await this.execute(task, claimed);
  }

  private async processQueued(run: ScheduledRun & Readonly<{ task: SchedulerTask }>): Promise<void> {
    const claimed = await this.deps.store.claimScheduledRun({
      taskId: run.taskId,
      runId: run.runId,
      trigger: "manual",
      expectedNextRunAt: null,
      nextRunAt: null,
    });
    if (!claimed) return;
    await this.execute(run.task, claimed);
  }

  private async execute(task: SchedulerTask, run: ScheduledRun): Promise<void> {
    this.activeRuns += 1;
    const startedAt = Date.now();
    let conversationId: string | undefined;
    let turnId: string | undefined;
    try {
      // Enrolment is the boundary that decides who may receive the
      // business's data; re-check it at send time, not just at save time.
      const workspace = await this.deps.store.imessageWorkspace();
      const enrolled = workspace.enrollments.some((enrollment) => enrollment.enabled && enrollment.phone === task.phone);
      if (!enrolled) {
        await this.deps.store.finishScheduledRun({
          runId: run.runId,
          status: "failed",
          error: "That number is no longer enrolled for iMessage.",
        });
        this.deps.log("scheduled_run_rejected", { taskId: task.taskId, runId: run.runId, reason: "not_enrolled" });
        return;
      }
      const analysis = await this.deps.runAnalysis({
        question: scheduledRunMessage(task),
        newConversationTitle: scheduledRunConversationTitle(task),
      });
      conversationId = analysis.conversationId;
      turnId = analysis.turnId;
      const text = analysis.clarification || analysis.answerText;
      const bubbles = text ? formatAnswerForImessage(text) : [];
      if (bubbles.length === 0) {
        await this.deps.store.finishScheduledRun({
          runId: run.runId,
          status: "failed",
          conversationId,
          turnId,
          answerState: analysis.answerState,
          error: "The analysis finished without an answer.",
        });
        this.deps.log("scheduled_run_empty", { taskId: task.taskId, runId: run.runId, conversationId, turnId });
        return;
      }
      const [first, ...rest] = bubbles;
      const chatId = await this.deps.sender.createChat(this.deps.botNumber, task.phone, first!.text, first!.decorations);
      for (const bubble of rest) {
        if (!chatId) throw new Error("Linq did not return the chat for the remaining bubbles.");
        await this.deps.sender.sendMessage(chatId, bubble.text, bubble.decorations);
      }
      await this.deps.store.finishScheduledRun({
        runId: run.runId,
        status: "sent",
        conversationId,
        turnId,
        answerState: analysis.answerState,
        summary: first!.text.slice(0, 240),
        bubbles: bubbles.length,
      });
      this.deps.log("scheduled_run_sent", {
        taskId: task.taskId,
        runId: run.runId,
        trigger: run.trigger,
        conversationId,
        turnId,
        answerState: analysis.answerState,
        bubbles: bubbles.length,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      const message = errorText(error);
      this.deps.log("scheduled_run_failed", {
        taskId: task.taskId,
        runId: run.runId,
        trigger: run.trigger,
        conversationId,
        turnId,
        durationMs: Date.now() - startedAt,
        error: message,
      });
      await this.deps.store.finishScheduledRun({
        runId: run.runId,
        status: "failed",
        ...(conversationId ? { conversationId } : {}),
        ...(turnId ? { turnId } : {}),
        error: message.slice(0, 400),
      }).catch((finishError) => this.deps.log("scheduled_run_finish_failed", {
        runId: run.runId,
        error: errorText(finishError),
      }));
      if (run.trigger === "schedule") {
        // The owner is expecting a text at this time; say why there is none.
        await this.deps.sender.createChat(this.deps.botNumber, task.phone, scheduledFailureText(task)).catch(() => undefined);
      }
    } finally {
      this.activeRuns -= 1;
    }
  }
}
