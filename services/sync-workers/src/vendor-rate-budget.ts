import {
  ConnectorError,
  parseRetryAfter,
  type ConnectorId,
  type VendorRateBudget,
} from "../../../packages/connector-sdk/src/index.js";
import type { TransactionalPostgres } from "./database.js";

type RatePolicy = Readonly<{
  key: string;
  emissionIntervalMs: number;
  burstCapacity: number;
}>;

// Deliberately conservative sustained rates. Vendor response headers and
// Retry-After can tighten these gates at runtime without a deploy.
const BASE_RATE_POLICIES: Readonly<Record<ConnectorId, readonly RatePolicy[]>> = {
  "lightspeed-r": [{ key: "lightspeed-r.api", emissionIntervalMs: 1_000, burstCapacity: 2 }],
  xero: [{ key: "xero.api-minute", emissionIntervalMs: 1_000, burstCapacity: 5 }],
  deputy: [{ key: "deputy.api", emissionIntervalMs: 1_000, burstCapacity: 2 }],
};

const OBSERVED_HEADERS = new Set([
  "retry-after",
  "x-appminlimit-remaining",
  "x-daylimit-remaining",
  "x-ls-api-bucket-level",
  "x-ls-api-drip-rate",
  "x-minlimit-remaining",
  "x-rate-limit-problem",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
]);

function safeObservedHeaders(headers: Headers): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [name, value] of headers) {
    const normalized = name.toLowerCase();
    if (OBSERVED_HEADERS.has(normalized)) result[normalized] = value.slice(0, 200);
  }
  return Object.freeze(result);
}

function lightspeedCooldown(headers: Headers): number | null {
  const bucket = headers.get("x-ls-api-bucket-level");
  const drip = Number(headers.get("x-ls-api-drip-rate"));
  if (!bucket || !Number.isFinite(drip) || drip <= 0) return null;
  const [levelText, capacityText] = bucket.split("/");
  const level = Number(levelText);
  const capacity = Number(capacityText);
  if (!Number.isFinite(level) || !Number.isFinite(capacity)) return null;
  const overage = level + 2 - capacity;
  return overage > 0 ? Math.ceil((overage / drip) * 1_000) : null;
}

function asRetryAfter(value: string | number | null | undefined): number {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return 1_000;
  return Math.min(7 * 24 * 60 * 60_000, Math.ceil(milliseconds));
}

/** PostgreSQL-backed GCRA budget shared by every sync-worker replica. */
export class PostgresVendorRateBudget implements VendorRateBudget {
  private readonly policies: readonly RatePolicy[];

  constructor(
    private readonly db: TransactionalPostgres,
    private readonly tenantId: string,
    private readonly connectionId: string,
    connectorId: ConnectorId,
    options: Readonly<{ xeroDailyRequestLimit?: 1000 | 5000 }> = {},
  ) {
    const base = BASE_RATE_POLICIES[connectorId];
    if (connectorId !== "xero") {
      this.policies = base;
      return;
    }
    const dailyLimit = options.xeroDailyRequestLimit ?? 1000;
    this.policies = [
      ...base,
      {
        key: "xero.api-day",
        emissionIntervalMs: Math.ceil(86_400_000 / dailyLimit),
        burstCapacity: 60,
      },
    ];
  }

  async beforeRequest(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    for (const policy of this.policies) {
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
      if (!reservation?.allowed) {
        throw new ConnectorError(
          "RATE_LIMITED",
          "The shared vendor request budget is temporarily exhausted.",
          {
            retryable: true,
            retryAfterMs: asRetryAfter(reservation?.retry_after_ms),
            details: { budgetKey: policy.key },
          },
        );
      }
    }
  }

  async observeResponse(response: Response): Promise<void> {
    const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
    const providerCooldown = lightspeedCooldown(response.headers);
    const cooldownMs = Math.max(
      retryAfter ?? 0,
      providerCooldown ?? 0,
      response.status === 429 && retryAfter === null ? 60_000 : 0,
    );
    const observedHeaders = safeObservedHeaders(response.headers);
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
