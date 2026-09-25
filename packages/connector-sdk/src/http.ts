import { ConnectorError, ConnectorHttpError } from "./errors.js";
import type { VendorRateBudget } from "./index.js";

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type Sleep = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

export type HttpRetryOptions = Readonly<{
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Hard deadline for one outbound HTTP attempt, including a stalled TLS exchange. */
  attemptTimeoutMs?: number;
  /** Retry-After values above this threshold must be handed back to durable orchestration. */
  maxInlineRetryAfterMs?: number;
  random?: () => number;
  sleep?: Sleep;
  beforeRequest?: (signal?: AbortSignal) => Promise<void>;
  observeResponse?: (response: Response) => void | Promise<void>;
}>;

const defaultSleep: Sleep = (milliseconds, signal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

export type ManagedDeadline = Readonly<{
  signal: AbortSignal;
  clear(): void;
}>;

/** A ref-counted deadline that callers must clear once their operation settles. */
export function createDeadlineSignal(milliseconds: number): ManagedDeadline {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    throw new Error("Deadline must be a positive duration.");
  }
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("The operation timed out.", "TimeoutError")),
    Math.ceil(milliseconds),
  );
  return Object.freeze({
    signal: controller.signal,
    clear: () => clearTimeout(timer),
  });
}

/**
 * Race an operation against an AbortSignal even when a test double or third-party
 * client fails to honour that signal. Native fetch is still given the signal so
 * its socket is actually torn down; this extra race protects the worker lease.
 */
export function raceWithSignal<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return Promise.resolve().then(operation);
  if (signal.aborted) return Promise.reject(abortReason(signal));

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(abortReason(signal)));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(operation)
      .then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
  });
}

function positiveDuration(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ConnectorError("CONFIGURATION_INVALID", `${name} must be a positive duration.`);
  }
  return Math.ceil(value);
}

function positiveAttempts(value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new ConnectorError("CONFIGURATION_INVALID", "HTTP maxAttempts must be a positive integer.");
  }
  return value;
}

export function parseRetryAfter(value: string | null, nowMs = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export function withVendorRateBudget(
  options: HttpRetryOptions | undefined,
  budget: VendorRateBudget | undefined,
): HttpRetryOptions {
  if (!budget) return options ?? {};
  return {
    ...options,
    beforeRequest: async (signal) => {
      await budget.beforeRequest(signal);
      await options?.beforeRequest?.(signal);
    },
    observeResponse: async (response) => {
      await budget.observeResponse(response);
      await options?.observeResponse?.(response);
    },
  };
}

export async function fetchWithRetry(
  fetcher: FetchLike,
  input: string | URL | Request,
  init: RequestInit,
  options: HttpRetryOptions = {},
): Promise<Response> {
  const maxAttempts = positiveAttempts(options.maxAttempts ?? 5);
  const baseDelayMs = positiveDuration(options.baseDelayMs ?? 250, "HTTP baseDelayMs");
  const maxDelayMs = positiveDuration(options.maxDelayMs ?? 30_000, "HTTP maxDelayMs");
  const attemptTimeoutMs = positiveDuration(
    options.attemptTimeoutMs ?? 30_000,
    "HTTP attemptTimeoutMs",
  );
  const maxInlineRetryAfterMs = positiveDuration(
    options.maxInlineRetryAfterMs ?? 30_000,
    "HTTP maxInlineRetryAfterMs",
  );
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;
  const callerSignal = init.signal ?? (input instanceof Request ? input.signal : undefined);
  let lastCause: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await raceWithSignal(
      () => options.beforeRequest?.(callerSignal) ?? Promise.resolve(),
      callerSignal,
    );
    const attemptDeadline = createDeadlineSignal(attemptTimeoutMs);
    const timeoutSignal = attemptDeadline.signal;
    const attemptSignal = callerSignal
      ? AbortSignal.any([callerSignal, timeoutSignal])
      : timeoutSignal;
    let response: Response;
    try {
      response = await raceWithSignal(
        () => fetcher(input, { ...init, signal: attemptSignal }),
        attemptSignal,
      );
    } catch (cause) {
      attemptDeadline.clear();
      lastCause = cause;
      if (attempt === maxAttempts || callerSignal?.aborted) break;
      const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      await sleep(Math.ceil(random() * ceiling), callerSignal);
      continue;
    }
    attemptDeadline.clear();

    await options.observeResponse?.(response);
    if (response.ok) return response;
    const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
    if (
      !retryableStatus(response.status) ||
      attempt === maxAttempts ||
      (retryAfter !== null && retryAfter > maxInlineRetryAfterMs)
    ) {
      // Vendors put the machine-readable reason (invalid_grant, invalid_client,
      // unauthorized_client) in the body; keep a bounded excerpt so a rejected
      // OAuth exchange is diagnosable from logs. Client-error bodies never carry
      // credentials, and the cap keeps a stray HTML page from flooding logs.
      const vendorReason = response.status >= 400 && response.status < 500
        ? await response.text().then((text) => text.slice(0, 512)).catch(() => null)
        : null;
      if (vendorReason === null) await response.body?.cancel().catch(() => undefined);
      throw new ConnectorHttpError(response.status, "The vendor API rejected the request.", {
        retryable: retryableStatus(response.status),
        retryAfterMs: retryAfter ?? undefined,
        requestId:
          response.headers.get("x-request-id") ??
          response.headers.get("cf-ray") ??
          undefined,
        details: vendorReason === null ? undefined : { vendorReason },
      });
    }

    await response.body?.cancel().catch(() => undefined);
    const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
    await sleep(retryAfter ?? Math.ceil(random() * ceiling), callerSignal);
  }

  throw new ConnectorError("REMOTE_UNAVAILABLE", "The vendor API could not be reached.", {
    retryable: true,
    cause: lastCause,
  });
}

export async function requestJson<T>(
  fetcher: FetchLike,
  input: string | URL,
  init: RequestInit,
  options: HttpRetryOptions = {},
): Promise<Readonly<{ value: T; response: Response }>> {
  const response = await fetchWithRetry(fetcher, input, init, options);
  try {
    return { value: (await response.json()) as T, response };
  } catch (cause) {
    throw new ConnectorError(
      "REMOTE_RESPONSE_INVALID",
      "The vendor API returned malformed JSON.",
      { cause, retryable: false },
    );
  }
}

export class AdaptiveLeakyBucket {
  private notBefore = 0;

  observe(headers: Headers): void {
    const bucket = headers.get("x-ls-api-bucket-level");
    const drip = Number(headers.get("x-ls-api-drip-rate"));
    if (!bucket || !Number.isFinite(drip) || drip <= 0) return;
    const [levelText, capacityText] = bucket.split("/");
    const level = Number(levelText);
    const capacity = Number(capacityText);
    if (!Number.isFinite(level) || !Number.isFinite(capacity)) return;
    // Keep one drip of headroom for another process sharing this connection.
    const overage = level + 2 - capacity;
    if (overage > 0) this.notBefore = Date.now() + Math.ceil((overage / drip) * 1_000);
  }

  async wait(sleep: Sleep = defaultSleep, signal?: AbortSignal): Promise<void> {
    const delay = this.notBefore - Date.now();
    if (delay > 0) await sleep(delay, signal);
  }
}

export class ConcurrencyLimiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("Concurrency limit must be a positive integer.");
    }
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active += 1;
    try {
      return await operation();
    } finally {
      this.active -= 1;
      this.waiters.shift()?.();
    }
  }
}
