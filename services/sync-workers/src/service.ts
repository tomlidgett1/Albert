import type { DurableSyncQueue } from "../../../packages/queue/src/index.js";
import { SyncJobProcessor } from "./worker.js";

export type WorkerHealth = Readonly<{
  ready: boolean;
  startedAt: string;
  workerId: string;
  activeJobs: number;
  lastClaimAt: string | null;
  lastCompletionAt: string | null;
  lastErrorCode: string | null;
}>;

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export class SyncWorkerService {
  private readonly startedAt = new Date().toISOString();
  private activeJobs = 0;
  private lastClaimAt: string | null = null;
  private lastCompletionAt: string | null = null;
  private lastErrorCode: string | null = null;
  private ready = false;

  constructor(
    private readonly workerId: string,
    private readonly queue: DurableSyncQueue,
    private readonly processor: SyncJobProcessor,
    private readonly options: Readonly<{
      visibilityTimeoutSeconds?: number;
      emptyPollDelayMs?: number;
    }> = {},
  ) {
    if (!workerId.trim()) throw new Error("A stable worker id is required.");
  }

  health(): WorkerHealth {
    return Object.freeze({
      ready: this.ready,
      startedAt: this.startedAt,
      workerId: this.workerId,
      activeJobs: this.activeJobs,
      lastClaimAt: this.lastClaimAt,
      lastCompletionAt: this.lastCompletionAt,
      lastErrorCode: this.lastErrorCode,
    });
  }

  async run(signal: AbortSignal): Promise<void> {
    await this.queue.preflight();
    this.ready = true;
    try {
      while (!signal.aborted) {
        let claim;
        try {
          claim = await this.queue.claim({
            workerId: this.workerId,
            visibilityTimeoutSeconds: this.options.visibilityTimeoutSeconds ?? 900,
          });
          this.lastErrorCode = null;
        } catch {
          this.lastErrorCode = "queue_claim_failed";
          await wait(1_000, signal);
          continue;
        }
        if (!claim) {
          await wait(this.options.emptyPollDelayMs ?? 500, signal);
          continue;
        }
        this.lastClaimAt = new Date().toISOString();
        this.activeJobs += 1;
        const visibilityTimeoutSeconds = this.options.visibilityTimeoutSeconds ?? 900;
        const extensionInterval = setInterval(() => {
          void this.queue.extendVisibility(claim, visibilityTimeoutSeconds).catch(() => {
            this.lastErrorCode = "queue_visibility_extension_failed";
          });
        }, Math.max(30_000, Math.floor(visibilityTimeoutSeconds * 1_000 / 3)));
        extensionInterval.unref();
        try {
          try {
            await this.processor.process(claim, signal);
            this.lastCompletionAt = new Date().toISOString();
          } catch {
            // A failed error-transition or a superseded lease must not stop the
            // always-on worker. PGMQ will make an unacknowledged message visible
            // again; readiness exposes the degraded worker state meanwhile.
            this.lastErrorCode = "job_processing_failed";
          }
        } finally {
          clearInterval(extensionInterval);
          this.activeJobs -= 1;
        }
      }
    } finally {
      this.ready = false;
    }
  }
}
