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
    const headroom = interval.headroomRequests ?? 0;
    if (!Number.isSafeInteger(headroom) || headroom < 0 || headroom >= configuredLimit) {
      throw new Error(`vendor_rate_budget_headroom_invalid:${manifest.id}:${interval.option}`);
    }
    const executableLimit = configuredLimit - headroom;
    return Object.freeze({
      key: reservation.key,
      emissionIntervalMs: Math.ceil(interval.windowMilliseconds / executableLimit),
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
/**
 * A slow pacer (Xero's 1,000/day = one call per 86s) emits tokens further
 * apart than the flat inline ceiling. Kicking a claim out at 30s made every
 * winner spend its token and lose the slot before the next call, so no page
 * ever completed and the freed slot just fed the herd. Let a claim ride out
 * one emission interval of the policy that denied it (bounded) instead.
 */
const MAX_INLINE_BUDGET_WAIT_MS = 180_000;

/**
 * How long a claim bounced by the budget should stay off the queue. Under a
 * slow pacer the herd of waiting jobs otherwise wakes at the pacer's cadence
 * and snipes the token from the claim that is mid-walk. Backing off by
 * several emission intervals thins the herd; the slot holder keeps walking.
 */
const MIN_SLOW_PACER_DEFERRAL_MS = 5 * 60_000;

function deferralMs(policies: readonly RatePolicy[], denied: VendorRateReservationDenied): number {
  const policy = policies.find((candidate) => candidate.key === denied.budgetKey);
  const emission = policy?.emissionIntervalMs ?? 0;
  if (emission <= INLINE_BUDGET_WAIT_MS) return denied.retryAfterMs;
  return Math.max(denied.retryAfterMs, MIN_SLOW_PACER_DEFERRAL_MS);
}

function inlineWaitCeilingMs(policies: readonly RatePolicy[], budgetKey: string): number {
  const policy = policies.find((candidate) => candidate.key === budgetKey);
  const emission = policy?.emissionIntervalMs ?? 0;
  return Math.min(MAX_INLINE_BUDGET_WAIT_MS, Math.max(INLINE_BUDGET_WAIT_MS, emission + 5_000));
}

class VendorRateReservationDenied extends Error {
  constructor(
    readonly budgetKey: string,
    readonly retryAfterMs: number,
  ) {
    super("vendor_rate_reservation_denied");
    this.name = "VendorRateReservationDenied";
  }
}

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
    // Total inline budget for one request: the slowest policy's ceiling, so a
    // request may ride out one emission interval but never accumulate more.
    const deadline = Date.now() + this.policies.reduce(
      (maximum, policy) => Math.max(maximum, inlineWaitCeilingMs(this.policies, policy.key)),
      INLINE_BUDGET_WAIT_MS,
    );
    while (true) {
      let denied: VendorRateReservationDenied | null = null;
      try {
        await this.db.transaction(async (client) => {
          for (const policy of this.policies) {
            const result = await client.query<{
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
            if (!reservation?.allowed) {
              // Throwing rolls the transaction back, including reservations
              // made for earlier policies. One outbound request must consume
              // either every declared budget or none of them.
              throw new VendorRateReservationDenied(
                policy.key,
                asRetryAfter(reservation?.retry_after_ms),
              );
            }
          }
        });
      } catch (error) {
        if (!(error instanceof VendorRateReservationDenied)) throw error;
        denied = error;
      }
      if (!denied) return;
      const ceiling = inlineWaitCeilingMs(this.policies, denied.budgetKey);
      if (denied.retryAfterMs > ceiling || Date.now() + denied.retryAfterMs > deadline) {
        throw new ConnectorError(
          "RATE_LIMITED",
          "The shared vendor request budget is temporarily exhausted.",
          {
            retryable: true,
            retryAfterMs: deferralMs(this.policies, denied),
            details: { budgetKey: denied.budgetKey },
          },
        );
      }
      await sleep(denied.retryAfterMs, signal);
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

    await this.db.transaction(async (client) => {
      for (const policy of this.policies) {
        await client.query(
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
    });
  }
}
