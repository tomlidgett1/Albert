import {
  ConnectorError,
  parseRetryAfter,
  type ConnectorManifest,
  type RateLimitResponseCooldownPolicy,
  type VendorRateBudget,
} from "../../../packages/connector-sdk/src/index.js";
import type { TransactionalPostgres } from "./database.js";

type RatePolicy = Readonly<{
  key: string;
  emissionIntervalMs: number;
  burstCapacity: number;
}>;

export type VendorRateBudgetOptions = Readonly<Record<string, number | undefined>>;

function safeObservedHeaders(
  headers: Headers,
  declaredHeaders: readonly string[],
): Readonly<Record<string, string>> {
  const observedHeaders = new Set(declaredHeaders.map((name) => name.toLowerCase()));
  observedHeaders.add("retry-after");
  const result: Record<string, string> = {};
  for (const [name, value] of headers) {
    const normalized = name.toLowerCase();
    if (observedHeaders.has(normalized)) result[normalized] = value.slice(0, 200);
  }
  return Object.freeze(result);
}

function tokenBucketCooldown(
  headers: Headers,
  policy: RateLimitResponseCooldownPolicy,
): number | null {
  const bucket = headers.get(policy.levelHeader);
  const drip = Number(headers.get(policy.dripRateHeader));
  if (!bucket || !Number.isFinite(drip) || drip <= 0) return null;
  const [levelText, capacityText] = bucket.split("/");
  const level = Number(levelText);
  const capacity = Number(capacityText);
  if (!Number.isFinite(level) || !Number.isFinite(capacity)) return null;
  const overage = level + policy.headroom - capacity;
  return overage > 0 ? Math.ceil((overage / drip) * 1_000) : null;
}

function responseCooldown(
  headers: Headers,
  policies: readonly RateLimitResponseCooldownPolicy[],
): number {
  return policies.reduce((cooldown, policy) =>
    Math.max(cooldown, tokenBucketCooldown(headers, policy) ?? 0), 0);
}

function reservationPolicies(
  manifest: ConnectorManifest,
  options: VendorRateBudgetOptions,
): readonly RatePolicy[] {
  return manifest.rateLimit.reservations.map((reservation) => {
    const interval = reservation.interval;
    if (interval.kind === "fixed") {
      return Object.freeze({
        key: reservation.key,
        emissionIntervalMs: interval.milliseconds,
        burstCapacity: reservation.burstCapacity,
      });
    }
    const configuredLimit = options[interval.option] ?? interval.defaultLimit;
    if (!Number.isSafeInteger(configuredLimit) ||
        !interval.allowedLimits.includes(configuredLimit)) {
      throw new Error(`vendor_rate_budget_option_invalid:${manifest.id}:${interval.option}`);
    }
    return Object.freeze({
      key: reservation.key,
      emissionIntervalMs: Math.ceil(interval.windowMilliseconds / configuredLimit),
      burstCapacity: reservation.burstCapacity,
    });
  });
}

function asRetryAfter(value: string | number | null | undefined): number {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return 1_000;
  return Math.min(7 * 24 * 60 * 60_000, Math.ceil(milliseconds));
}

/** Wait inline for short budget delays so multipage claims do not thrash. */
const INLINE_BUDGET_WAIT_MS = 30_000;

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** PostgreSQL-backed GCRA budget shared by every sync-worker replica. */
export class PostgresVendorRateBudget implements VendorRateBudget {
  private readonly policies: readonly RatePolicy[];

  constructor(
    private readonly db: TransactionalPostgres,
    private readonly tenantId: string,
    private readonly connectionId: string,
    private readonly manifest: ConnectorManifest,
    options: VendorRateBudgetOptions = {},
  ) {
    this.policies = reservationPolicies(manifest, options);
  }

  async beforeRequest(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    for (const policy of this.policies) {
      const deadline = Date.now() + INLINE_BUDGET_WAIT_MS;
      while (true) {
        const result = await this.db.query<{
          allowed: boolean;
          retry_after_ms: string | number;
        }>(
          `select allowed, retry_after_ms
             from control_plane.reserve_vendor_api_request($1, $2, $3, $4, $5)`,
          [
            this.tenantId,
            this.connectionId,
            policy.key,
            policy.emissionIntervalMs,
            policy.burstCapacity,
          ],
        );
        signal?.throwIfAborted();
        const reservation = result.rows[0];
        if (reservation?.allowed) break;
        const retryAfterMs = asRetryAfter(reservation?.retry_after_ms);
        if (Date.now() + retryAfterMs > deadline) {
          throw new ConnectorError(
            "RATE_LIMITED",
            "The shared vendor request budget is temporarily exhausted.",
            {
              retryable: true,
              retryAfterMs,
              details: { budgetKey: policy.key },
            },
          );
        }
        await sleep(retryAfterMs, signal);
      }
    }
  }

  async observeResponse(response: Response): Promise<void> {
    const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
    const providerCooldown = responseCooldown(
      response.headers,
      this.manifest.rateLimit.cooldowns ?? [],
    );
    const cooldownMs = Math.max(
      retryAfter ?? 0,
      providerCooldown,
      response.status === 429 && retryAfter === null ? 60_000 : 0,
    );
    const observedHeaders = safeObservedHeaders(
      response.headers,
      this.manifest.rateLimit.responseHeaders,
    );
    if (cooldownMs === 0 && Object.keys(observedHeaders).length === 0) return;

    for (const policy of this.policies) {
      await this.db.query(
        `select control_plane.observe_vendor_api_response($1, $2, $3, $4, $5::jsonb)`,
        [
          this.tenantId,
          this.connectionId,
          policy.key,
          cooldownMs,
          JSON.stringify(observedHeaders),
        ],
      );
    }
  }
}
