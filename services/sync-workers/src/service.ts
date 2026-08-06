import type { DurableSyncQueue } from "../../../packages/queue/src/index.js";
import { SyncJobProcessor } from "./worker.js";

export type WorkerHealth = Readonly<{
  ready: boolean;
  startedAt: string;
  workerId: string;
  concurrency: number;
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
      concurrency?: number;
    }> = {},
  ) {
    if (!workerId.trim()) throw new Error("A stable worker id is required.");
    const concurrency = options.concurrency ?? 1;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) {
      throw new Error("Sync worker concurrency must be an integer between 1 and 64.");
    }
  }

  health(): WorkerHealth {
    return Object.freeze({
      ready: this.ready,
      startedAt: this.startedAt,
      workerId: this.workerId,
      concurrency: this.options.concurrency ?? 1,
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
      await Promise.all(Array.from(
        { length: this.options.concurrency ?? 1 },
        () => this.runLane(signal),
      ));
    } finally {
      this.ready = false;
    }
  }

  private async runLane(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      let claim;
      try {
        claim = await this.queue.claim({
          workerId: this.workerId,
          visibilityTimeoutSeconds: this.options.visibilityTimeoutSeconds ?? 900,
        });
      } catch (error) {
        // A malformed queue payload lands here: pgmq has already read the
        // message (burning a visibility window), so without this line the
        // poison pill retries forever while the worker looks healthily idle.
        this.lastErrorCode = "queue_claim_failed";
        console.error("Albert sync worker queue claim failed", {
          workerId: this.workerId,
          error: error instanceof Error ? error.message : String(error),
        });
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
          const outcome = await this.processor.process(claim, signal);
          if (outcome.status === "completed") {
            this.lastCompletionAt = new Date().toISOString();
            this.lastErrorCode = null;
          } else {
            this.lastErrorCode = outcome.failure.code;
          }
        } catch (error) {
          // A failed error-transition or a superseded lease must not stop the
          // always-on worker. PGMQ will make an unacknowledged message visible
          // again; readiness exposes the degraded worker state meanwhile.
          // The cause is logged: a silent retry loop is indistinguishable
          // from a healthy idle worker, which is how a broken coordinator
          // once burned four visibility windows without one diagnostic line.
          this.lastErrorCode = "job_processing_failed";
          console.error("Albert sync worker job processing failed", {
            workerId: this.workerId,
            error: error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error),
          });
        }
      } finally {
        clearInterval(extensionInterval);
        this.activeJobs -= 1;
      }
    }
  }
}
