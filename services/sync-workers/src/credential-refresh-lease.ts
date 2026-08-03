import { ulid } from "ulid";
import type {
  CredentialRefreshLeaseContext,
  CredentialRefreshLeaseProof,
} from "../../../packages/connector-sdk/src/index.js";
import {
  createDeadlineSignal,
  raceWithSignal,
} from "../../../packages/connector-sdk/src/index.js";
import type { PostgresQueryClient } from "../../../packages/queue/src/index.js";

export type CredentialRefreshLeaseGrant = Readonly<{
  acquired: boolean;
  fencingToken?: string;
  retryAfterMs: number;
}>;

export interface CredentialRefreshLeaseStore {
  acquire(
    credentialRef: string,
    leaseId: string,
    leaseDurationMs: number,
  ): Promise<CredentialRefreshLeaseGrant>;
  extend(
    credentialRef: string,
    proof: CredentialRefreshLeaseProof,
    leaseDurationMs: number,
  ): Promise<boolean>;
  release(
    credentialRef: string,
    proof: CredentialRefreshLeaseProof,
  ): Promise<boolean>;
}

export type CredentialRefreshLeaseOptions = Readonly<{
  leaseDurationMs?: number;
  renewalIntervalMs?: number;
  operationTimeoutMs?: number;
  storeTimeoutMs?: number;
  maximumPollMs?: number;
  random?: () => number;
}>;

const DEFAULT_LEASE_DURATION_MS = 45_000;
const DEFAULT_RENEWAL_INTERVAL_MS = 15_000;
const DEFAULT_OPERATION_TIMEOUT_MS = 300_000;
const DEFAULT_STORE_TIMEOUT_MS = 5_000;
const DEFAULT_MAXIMUM_POLL_MS = 1_000;

function duration(value: number, name: string, minimum = 1): number {
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(`${name} must be at least ${minimum}ms.`);
  }
  return Math.ceil(value);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function stoppedWait(milliseconds: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(false);
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(true);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function validGrant(grant: CredentialRefreshLeaseGrant): CredentialRefreshLeaseGrant {
  if (
    typeof grant.acquired !== "boolean" ||
    !Number.isFinite(grant.retryAfterMs) ||
    grant.retryAfterMs < 0 ||
    (grant.acquired && !/^[1-9]\d*$/.test(grant.fencingToken ?? ""))
  ) {
    throw new Error("credential_refresh_lease_store_result_invalid");
  }
  return grant;
}

/**
 * Coordinates refresh-token rotation across worker replicas. Database leases
 * expire after crashes, are renewed while an operation is live, and have an
 * independent hard deadline so a vendor call can never retain one forever.
 */
export class DurableCredentialRefreshLeaseCoordinator {
  private readonly leaseDurationMs: number;
  private readonly renewalIntervalMs: number;
  private readonly operationTimeoutMs: number;
  private readonly storeTimeoutMs: number;
  private readonly maximumPollMs: number;
  private readonly random: () => number;

  constructor(
    private readonly store: CredentialRefreshLeaseStore,
    options: CredentialRefreshLeaseOptions = {},
  ) {
    this.leaseDurationMs = duration(
      options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
      "Credential refresh lease duration",
      20,
    );
    this.renewalIntervalMs = duration(
      options.renewalIntervalMs ?? DEFAULT_RENEWAL_INTERVAL_MS,
      "Credential refresh lease renewal interval",
      5,
    );
    if (this.renewalIntervalMs >= this.leaseDurationMs / 2) {
      throw new Error("Credential refresh leases must renew before half of their duration.");
    }
    this.operationTimeoutMs = duration(
      options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
      "Credential refresh operation timeout",
      this.leaseDurationMs,
    );
    this.storeTimeoutMs = duration(
      options.storeTimeoutMs ?? DEFAULT_STORE_TIMEOUT_MS,
      "Credential refresh lease store timeout",
      5,
    );
    this.maximumPollMs = duration(
      options.maximumPollMs ?? DEFAULT_MAXIMUM_POLL_MS,
      "Credential refresh lease maximum poll",
      5,
    );
    this.random = options.random ?? Math.random;
  }

  private async storeCall<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    const deadline = createDeadlineSignal(this.storeTimeoutMs);
    const boundedSignal = AbortSignal.any([signal, deadline.signal]);
    try {
      return await raceWithSignal(operation, boundedSignal);
    } finally {
      deadline.clear();
    }
  }

  private async acquire(
    credentialRef: string,
    leaseId: string,
    signal: AbortSignal,
  ): Promise<CredentialRefreshLeaseProof> {
    while (true) {
      signal.throwIfAborted();
      const grant = validGrant(await this.storeCall(
        () => this.store.acquire(credentialRef, leaseId, this.leaseDurationMs),
        signal,
      ));
      if (grant.acquired) {
        return Object.freeze({ leaseId, fencingToken: grant.fencingToken! });
      }
      const baseDelay = Math.max(10, Math.min(this.maximumPollMs, Math.ceil(grant.retryAfterMs)));
      const randomValue = this.random();
      const boundedRandom = Number.isFinite(randomValue)
        ? Math.min(1, Math.max(0, randomValue))
        : 0.5;
      const jitter = 0.75 + boundedRandom * 0.25;
      await wait(Math.max(5, Math.ceil(baseDelay * jitter)), signal);
    }
  }

  private async bestEffortRelease(
    credentialRef: string,
    proof: CredentialRefreshLeaseProof,
  ): Promise<void> {
    const deadline = createDeadlineSignal(this.storeTimeoutMs);
    try {
      await raceWithSignal(
        () => this.store.release(credentialRef, proof),
        deadline.signal,
      );
    } catch {
      // A failed explicit release is safe: the durable lease has a short crash
      // expiry and an exact lease-id/fencing-token match prevents stale release.
    } finally {
      deadline.clear();
    }
  }

  async withLease<T>(
    credentialRef: string,
    operation: (lease: CredentialRefreshLeaseContext) => Promise<T>,
    callerSignal?: AbortSignal,
  ): Promise<T> {
    if (!credentialRef.trim()) throw new Error("credential_refresh_reference_required");
    const operationDeadline = createDeadlineSignal(this.operationTimeoutMs);
    const operationSignal = callerSignal
      ? AbortSignal.any([callerSignal, operationDeadline.signal])
      : operationDeadline.signal;
    const leaseId = ulid();
    let proof: CredentialRefreshLeaseProof | undefined;
    const stopHeartbeat = new AbortController();
    const leaseLost = new AbortController();
    let heartbeat: Promise<void> | undefined;

    try {
      proof = await this.acquire(credentialRef, leaseId, operationSignal);
      const heartbeatSignal = AbortSignal.any([operationSignal, stopHeartbeat.signal]);
      heartbeat = (async () => {
        while (!heartbeatSignal.aborted) {
          const stopped = await stoppedWait(this.renewalIntervalMs, heartbeatSignal);
          if (stopped) return;
          try {
            const extended = await this.storeCall(
              () => this.store.extend(credentialRef, proof!, this.leaseDurationMs),
              operationSignal,
            );
            if (!extended) throw new Error("credential_refresh_lease_lost");
          } catch (cause) {
            if (!operationSignal.aborted && !stopHeartbeat.signal.aborted) {
              leaseLost.abort(cause);
            }
            return;
          }
        }
      })();

      const leaseSignal = AbortSignal.any([operationSignal, leaseLost.signal]);
      return await raceWithSignal(
        () => operation(Object.freeze({ abortSignal: leaseSignal, proof: proof! })),
        leaseSignal,
      );
    } finally {
      stopHeartbeat.abort();
      await heartbeat?.catch(() => undefined);
      if (proof) await this.bestEffortRelease(credentialRef, proof);
      operationDeadline.clear();
    }
  }
}

type AcquireRow = Readonly<{
  acquired: boolean;
  fencing_token: string | number | bigint | null;
  retry_after_ms: string | number | bigint;
}>;

function safeNonNegativeInteger(value: string | number | bigint, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name}_invalid`);
  }
  return parsed;
}

/** SQL adapter shared by final and provisional OAuth credential vaults. */
export class PostgresCredentialRefreshLeaseStore implements CredentialRefreshLeaseStore {
  constructor(private readonly database: PostgresQueryClient) {}

  async acquire(
    credentialRef: string,
    leaseId: string,
    leaseDurationMs: number,
  ): Promise<CredentialRefreshLeaseGrant> {
    const result = await this.database.query<AcquireRow>(
      "select * from control_plane.acquire_credential_refresh_lease($1,$2,$3)",
      [credentialRef, leaseId, leaseDurationMs],
    );
    const row = result.rows[0];
    if (!row) throw new Error("credential_refresh_lease_result_missing");
    return Object.freeze({
      acquired: row.acquired,
      ...(row.fencing_token === null
        ? {}
        : { fencingToken: String(row.fencing_token) }),
      retryAfterMs: safeNonNegativeInteger(row.retry_after_ms, "credential_refresh_retry_after"),
    });
  }

  async extend(
    credentialRef: string,
    proof: CredentialRefreshLeaseProof,
    leaseDurationMs: number,
  ): Promise<boolean> {
    const result = await this.database.query<{ extended: boolean }>(
      "select control_plane.extend_credential_refresh_lease($1,$2,$3::bigint,$4) as extended",
      [credentialRef, proof.leaseId, proof.fencingToken, leaseDurationMs],
    );
    return result.rows[0]?.extended === true;
  }

  async release(
    credentialRef: string,
    proof: CredentialRefreshLeaseProof,
  ): Promise<boolean> {
    const result = await this.database.query<{ released: boolean }>(
      "select control_plane.release_credential_refresh_lease($1,$2,$3::bigint) as released",
      [credentialRef, proof.leaseId, proof.fencingToken],
    );
    return result.rows[0]?.released === true;
  }
}
