import type { FivetranWorkerHttpHandler } from "./fivetran-http.js";

/**
 * Background loop that keeps Fivetran's Deputy connections authenticated.
 *
 * Fivetran stores a static Deputy access token and never refreshes it; Deputy
 * expires those after ~24 h. Albert holds the rotating refresh token in its
 * vault, so every `intervalMs` (default 6 h) the worker refreshes each live
 * Deputy-via-Fivetran grant through the connector's lease-guarded path and
 * pushes the new access token to Fivetran. The credential bridge only
 * refreshes tokens with less than 8 h left, so a 6 h cadence keeps Fivetran's
 * copy always inside its lifetime with margin for a missed cycle.
 *
 * Runs only on the main sync worker (the OAuth-only entrypoint has no
 * background loops); a second replica would simply no-op on the lease.
 */
export class FivetranDeputyTokenRelay {
  private lastRunAt: string | null = null;
  private lastPushed = 0;
  private lastError: string | null = null;

  constructor(
    private readonly handler: FivetranWorkerHttpHandler,
    private readonly options: Readonly<{ intervalMs?: number; initialDelayMs?: number }> = {},
  ) {}

  health(): Readonly<{ lastRunAt: string | null; lastPushed: number; lastError: string | null }> {
    return { lastRunAt: this.lastRunAt, lastPushed: this.lastPushed, lastError: this.lastError };
  }

  async run(signal: AbortSignal): Promise<void> {
    await sleep(this.options.initialDelayMs ?? 60_000, signal);
    while (!signal.aborted) {
      try {
        this.lastPushed = await this.handler.refreshDeputyTokens(signal);
        this.lastError = null;
      } catch (error) {
        if (signal.aborted) return;
        this.lastError = error instanceof Error ? error.message.slice(0, 120) : "unknown";
        console.error("Albert Fivetran Deputy token relay cycle failed", { message: this.lastError });
      }
      this.lastRunAt = new Date().toISOString();
      await sleep(this.options.intervalMs ?? 6 * 60 * 60_000, signal);
    }
  }
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
