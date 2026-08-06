/**
 * Lightspeed R-Series rate governor.
 *
 * R-Series enforces two independent limiters, and a fetcher that models only
 * the first will stall on the second:
 *
 *   1. A leaky bucket. Default capacity 60, default drip 1 unit/second. A GET
 *      costs 1 unit; `count=1` and every write cost 10. Capacity and drip rate
 *      both increase during the vendor's off-peak hours, and both are reported
 *      live on every response via `X-LS-API-Bucket-Level: level/capacity` and
 *      `X-LS-API-Drip-Rate`.
 *   2. A secondary burst limiter over 1-second fixed windows, documented only
 *      as "a fraction of the allowed bucket size". The fraction is not
 *      published, so it is *learned* here rather than guessed: the window cap
 *      halves on a burst rejection and recovers slowly on sustained success.
 *
 * Design rules:
 *   - The header is truth. Local accounting exists only to pace *between*
 *     responses; every observation snaps the model back to what the server says.
 *   - Never sleep a fixed interval. A fixed `sleep(1000)` wastes a third of the
 *     available rate whenever the drip is 1.5/s, which it is off-peak.
 *   - Leave headroom. Another worker may share this account's bucket, so the
 *     governor refuses to drive the level to capacity.
 *
 * The class is a pure state machine over an injectable clock: every behaviour
 * below is unit-testable with no network and no real time.
 */

/** Unit cost of a request, per the R-Series rate-limit documentation. */
export type RequestCost = 1 | 10;

export type RateGovernorOptions = Readonly<{
  /** Capacity assumed before the first response is observed. */
  initialCapacity?: number;
  /** Drip rate (units/second) assumed before the first response is observed. */
  initialDripRate?: number;
  /**
   * Units of the bucket deliberately left unused, so a concurrent worker on the
   * same account cannot be starved into a 429 by this one.
   */
  headroomUnits?: number;
  /** Starting guess for the 1-second burst window cap, before any rejection. */
  initialBurstWindowCap?: number;
  /** Lower bound the learned burst cap may never fall below. */
  minBurstWindowCap?: number;
  now?: () => number;
}>;

export type RateGovernorState = Readonly<{
  capacity: number;
  dripRate: number;
  /** Modelled bucket level, snapped to the header on every observation. */
  level: number;
  burstWindowCap: number;
  /** True once a real response has been observed; before that, values are assumed. */
  calibrated: boolean;
}>;

export type ThrottleClassification =
  | Readonly<{ kind: "burst"; waitMs: number }>
  | Readonly<{ kind: "bucket"; waitMs: number }>
  | Readonly<{ kind: "unknown"; waitMs: number }>;

const DEFAULTS = {
  initialCapacity: 60,
  initialDripRate: 1,
  headroomUnits: 2,
  initialBurstWindowCap: 6,
  minBurstWindowCap: 1,
} as const;

/** Recovery cadence for the learned burst cap: +1 slot per this many clean windows. */
const BURST_RECOVERY_WINDOWS = 12;
/** Hard ceiling on a single computed wait, so a malformed header cannot hang a worker. */
const MAX_WAIT_MS = 60_000;

export class LightspeedRateGovernor {
  private capacity: number;
  private dripRate: number;
  private level = 0;
  private lastDripAt: number;
  private calibrated = false;

  private burstWindowCap: number;
  private readonly minBurstWindowCap: number;
  private burstWindowStart = 0;
  private burstWindowCount = 0;
  private cleanWindows = 0;

  private readonly headroomUnits: number;
  private readonly now: () => number;

  constructor(options: RateGovernorOptions = {}) {
    this.capacity = options.initialCapacity ?? DEFAULTS.initialCapacity;
    this.dripRate = options.initialDripRate ?? DEFAULTS.initialDripRate;
    this.headroomUnits = options.headroomUnits ?? DEFAULTS.headroomUnits;
    this.burstWindowCap = options.initialBurstWindowCap ?? DEFAULTS.initialBurstWindowCap;
    this.minBurstWindowCap = options.minBurstWindowCap ?? DEFAULTS.minBurstWindowCap;
    this.now = options.now ?? Date.now;
    this.lastDripAt = this.now();
  }

  get state(): RateGovernorState {
    return {
      capacity: this.capacity,
      dripRate: this.dripRate,
      level: this.level,
      burstWindowCap: this.burstWindowCap,
      calibrated: this.calibrated,
    };
  }

  /**
   * Milliseconds to wait before a request of `cost` may be issued. Pure: it
   * advances the drip model but reserves nothing. Call `commit` once the
   * request is actually dispatched.
   */
  delayFor(cost: RequestCost = 1): number {
    const now = this.now();
    this.drip(now);

    const usable = Math.max(1, this.capacity - this.headroomUnits);
    const bucketWaitMs =
      this.level + cost <= usable
        ? 0
        : Math.ceil(((this.level + cost - usable) / this.dripRate) * 1_000);

    const windowElapsed = now - this.burstWindowStart;
    const inWindow = windowElapsed < 1_000;
    const burstWaitMs =
      inWindow && this.burstWindowCount >= this.burstWindowCap
        ? 1_000 - windowElapsed
        : 0;

    return Math.min(MAX_WAIT_MS, Math.max(bucketWaitMs, burstWaitMs));
  }

  /** Record that a request of `cost` was dispatched. */
  commit(cost: RequestCost = 1): void {
    const now = this.now();
    this.drip(now);
    this.level += cost;

    if (now - this.burstWindowStart >= 1_000) {
      // A window closed without a burst rejection; earn back capacity slowly.
      if (this.burstWindowCount > 0) {
        this.cleanWindows += 1;
        if (this.cleanWindows >= BURST_RECOVERY_WINDOWS) {
          this.burstWindowCap += 1;
          this.cleanWindows = 0;
        }
      }
      this.burstWindowStart = now;
      this.burstWindowCount = 0;
    }
    this.burstWindowCount += 1;
  }

  /**
   * Snap the model to the server's own accounting. The header is authoritative;
   * a locally-modelled bucket drifts and will eventually either waste capacity
   * or trip a 429.
   */
  observe(headers: Headers | Readonly<Record<string, string>>): void {
    const read = (name: string): string | null =>
      headers instanceof Headers
        ? headers.get(name)
        : (headers[name] ?? headers[name.toLowerCase()] ?? null);

    const drip = Number(read("X-LS-API-Drip-Rate"));
    if (Number.isFinite(drip) && drip > 0) this.dripRate = drip;

    const bucket = read("X-LS-API-Bucket-Level");
    if (!bucket) return;
    const [levelText, capacityText] = bucket.split("/");
    const level = Number(levelText);
    const capacity = Number(capacityText);
    if (!Number.isFinite(level) || !Number.isFinite(capacity) || capacity <= 0) return;

    this.capacity = capacity;
    this.level = Math.max(0, level);
    this.lastDripAt = this.now();
    this.calibrated = true;
  }

  /**
   * Classify a 429 and return how long to wait. The two limiters need different
   * responses: a burst rejection clears in one second regardless of bucket
   * level, whereas bucket exhaustion needs the deficit to drain.
   */
  classifyThrottle(
    body: string,
    headers?: Headers | Readonly<Record<string, string>>,
  ): ThrottleClassification {
    if (headers) this.observe(headers);

    if (/burst\s+rate\s+limit/i.test(body)) {
      // Learn the real window ceiling instead of assuming the undocumented fraction.
      this.burstWindowCap = Math.max(
        this.minBurstWindowCap,
        Math.floor(this.burstWindowCap / 2),
      );
      this.cleanWindows = 0;
      return { kind: "burst", waitMs: 1_000 };
    }

    const usable = Math.max(1, this.capacity - this.headroomUnits);
    if (this.level >= usable) {
      const deficit = this.level - usable + 1;
      return {
        kind: "bucket",
        waitMs: Math.min(MAX_WAIT_MS, Math.ceil((deficit / this.dripRate) * 1_000)),
      };
    }

    // Unclassifiable: assume a full bucket's worth of drain rather than hammering.
    return {
      kind: "unknown",
      waitMs: Math.min(MAX_WAIT_MS, Math.ceil((1 / this.dripRate) * 1_000)),
    };
  }

  /** Advance the modelled level for elapsed time. */
  private drip(now: number): void {
    const elapsedMs = now - this.lastDripAt;
    if (elapsedMs <= 0) return;
    this.level = Math.max(0, this.level - (elapsedMs / 1_000) * this.dripRate);
    this.lastDripAt = now;
  }
}

/**
 * Governors are per (OAuth client x account): the bucket is scoped to the
 * credential pair, so two workers on the same connection must share one
 * instance or they will starve each other into 429s.
 */
export class RateGovernorRegistry {
  private readonly governors = new Map<string, LightspeedRateGovernor>();

  constructor(private readonly options: RateGovernorOptions = {}) {}

  for(connectionId: string): LightspeedRateGovernor {
    let governor = this.governors.get(connectionId);
    if (!governor) {
      governor = new LightspeedRateGovernor(this.options);
      this.governors.set(connectionId, governor);
    }
    return governor;
  }

  snapshot(): Readonly<Record<string, RateGovernorState>> {
    return Object.fromEntries([...this.governors].map(([id, g]) => [id, g.state]));
  }
}
