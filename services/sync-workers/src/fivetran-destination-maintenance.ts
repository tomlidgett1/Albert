import type { FivetranWorkerHttpHandler } from "./fivetran-http.js";

/**
 * Background loop that folds newly landed Fivetran tables into the Cube
 * contract. Xero and Lightspeed already do this on the token-broker call at
 * the start of each sync. Stripe has no broker: Fivetran holds a static key,
 * so without this loop `source_stripe.st_*` stays a stub until a Connections
 * status poll. Interval is short because ALL_TIME Stripe historical loads
 * create tables over minutes, not hours.
 */
export class FivetranDestinationMaintenance {
  private lastStartedAt: string | null = null;
  private lastRunAt: string | null = null;
  private lastMaintained = 0;
  private lastError: string | null = null;

  constructor(
    private readonly handler: FivetranWorkerHttpHandler,
    private readonly options: Readonly<{ intervalMs?: number; initialDelayMs?: number }> = {},
  ) {}

  health(): Readonly<{
    lastStartedAt: string | null;
    lastRunAt: string | null;
    lastMaintained: number;
    lastError: string | null;
  }> {
    return {
      lastStartedAt: this.lastStartedAt,
      lastRunAt: this.lastRunAt,
      lastMaintained: this.lastMaintained,
      lastError: this.lastError,
    };
  }

  async run(signal: AbortSignal): Promise<void> {
    await sleep(this.options.initialDelayMs ?? 30_000, signal);
    while (!signal.aborted) {
      this.lastStartedAt = new Date().toISOString();
      try {
        this.lastMaintained = await this.handler.maintainConnectedDestinations(signal);
        this.lastError = null;
      } catch (error) {
        if (signal.aborted) return;
        this.lastError = error instanceof Error ? error.message.slice(0, 120) : "unknown";
        console.error("Albert Fivetran destination maintenance cycle failed", { message: this.lastError });
      }
      this.lastRunAt = new Date().toISOString();
      await sleep(this.options.intervalMs ?? 120_000, signal);
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
