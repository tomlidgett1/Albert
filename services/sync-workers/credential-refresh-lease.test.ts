import assert from "node:assert/strict";
import test from "node:test";

import { XeroConnector } from "../../connectors/xero/index.js";
import type {
  CredentialRefreshLeaseContext,
  CredentialRefreshLeaseProof,
  OAuthCredentialSecret,
  VersionedCredential,
  WorkerCredentialVault,
} from "../../packages/connector-sdk/src/index.js";
import {
  DurableCredentialRefreshLeaseCoordinator,
  type CredentialRefreshLeaseGrant,
  type CredentialRefreshLeaseStore,
} from "./src/credential-refresh-lease.js";

function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

type LeaseState = {
  leaseId: string | null;
  fencingToken: number;
  expiresAt: number;
};

class SharedMemoryLeaseStore implements CredentialRefreshLeaseStore {
  private readonly leases = new Map<string, LeaseState>();
  readonly events: string[] = [];

  async acquire(
    credentialRef: string,
    leaseId: string,
    leaseDurationMs: number,
  ): Promise<CredentialRefreshLeaseGrant> {
    const now = Date.now();
    const current = this.leases.get(credentialRef);
    if (
      current && current.leaseId !== null && current.leaseId !== leaseId &&
      current.expiresAt > now
    ) {
      return {
        acquired: false,
        retryAfterMs: Math.max(1, current.expiresAt - now),
      };
    }
    const sameLease = current?.leaseId === leaseId;
    const fencingToken = sameLease
      ? current.fencingToken
      : (current?.fencingToken ?? 0) + 1;
    this.leases.set(credentialRef, {
      leaseId,
      fencingToken,
      expiresAt: now + leaseDurationMs,
    });
    this.events.push(`acquire:${fencingToken}`);
    return { acquired: true, fencingToken: String(fencingToken), retryAfterMs: 0 };
  }

  async extend(
    credentialRef: string,
    proof: CredentialRefreshLeaseProof,
    leaseDurationMs: number,
  ): Promise<boolean> {
    const current = this.leases.get(credentialRef);
    const now = Date.now();
    if (
      !current || current.leaseId !== proof.leaseId ||
      current.fencingToken !== Number(proof.fencingToken) || current.expiresAt <= now
    ) return false;
    current.expiresAt = now + leaseDurationMs;
    this.events.push(`extend:${current.fencingToken}`);
    return true;
  }

  async release(
    credentialRef: string,
    proof: CredentialRefreshLeaseProof,
  ): Promise<boolean> {
    const current = this.leases.get(credentialRef);
    if (
      !current || current.leaseId !== proof.leaseId ||
      current.fencingToken !== Number(proof.fencingToken)
    ) return false;
    current.leaseId = null;
    current.expiresAt = Date.now();
    this.events.push(`release:${current.fencingToken}`);
    return true;
  }

  active(credentialRef: string, proof: CredentialRefreshLeaseProof): boolean {
    const current = this.leases.get(credentialRef);
    return Boolean(
      current && current.leaseId === proof.leaseId &&
      current.fencingToken === Number(proof.fencingToken) &&
      current.expiresAt > Date.now(),
    );
  }
}

const shortLeaseOptions = {
  leaseDurationMs: 90,
  renewalIntervalMs: 25,
  operationTimeoutMs: 1_000,
  storeTimeoutMs: 50,
  maximumPollMs: 10,
  random: () => 0,
} as const;

type SharedCredential = { revision: number; secret: OAuthCredentialSecret };

class ReplicaVault implements WorkerCredentialVault {
  readonly reads: string[] = [];
  private readonly leases: DurableCredentialRefreshLeaseCoordinator;

  constructor(
    private readonly credential: SharedCredential,
    private readonly leaseStore: SharedMemoryLeaseStore,
  ) {
    this.leases = new DurableCredentialRefreshLeaseCoordinator(leaseStore, shortLeaseOptions);
  }

  async create(): Promise<VersionedCredential> {
    throw new Error("not_used");
  }

  async read(credentialRef: string): Promise<VersionedCredential> {
    const revision = String(this.credential.revision);
    this.reads.push(revision);
    return { credentialRef, revision, secret: this.credential.secret };
  }

  async compareAndSwap(
    credentialRef: string,
    expectedRevision: string,
    secret: OAuthCredentialSecret,
    refreshLease?: CredentialRefreshLeaseProof,
  ): Promise<VersionedCredential> {
    if (!refreshLease || !this.leaseStore.active(credentialRef, refreshLease)) {
      throw new Error("credential_refresh_lease_lost");
    }
    if (String(this.credential.revision) !== expectedRevision) {
      throw new Error("credential_revision_conflict");
    }
    this.credential.revision += 1;
    this.credential.secret = secret;
    return this.read(credentialRef);
  }

  withRefreshLease<T>(
    credentialRef: string,
    operation: (lease: CredentialRefreshLeaseContext) => Promise<T>,
    abortSignal?: AbortSignal,
  ): Promise<T> {
    return this.leases.withLease(credentialRef, operation, abortSignal);
  }

  async destroy(): Promise<void> {
    throw new Error("not_used");
  }
}

test("two Xero connector replicas perform one rotating-token refresh and the loser re-reads", async () => {
  const leaseStore = new SharedMemoryLeaseStore();
  const credential: SharedCredential = {
    revision: 1,
    secret: {
      provider: "xero",
      accessToken: "expired-access",
      refreshToken: "rotating-refresh-v1",
      tokenType: "Bearer",
      expiresAt: "2020-01-01T00:00:00.000Z",
      scopes: ["offline_access", "accounting.transactions.read"],
      metadata: {},
    },
  };
  const firstVault = new ReplicaVault(credential, leaseStore);
  const secondVault = new ReplicaVault(credential, leaseStore);
  let vendorRefreshes = 0;
  const fetcher = async () => {
    vendorRefreshes += 1;
    await delay(35);
    return Response.json({
      access_token: "fresh-access",
      refresh_token: "rotating-refresh-v2",
      expires_in: 1800,
      token_type: "Bearer",
      scope: "offline_access accounting.transactions.read",
    });
  };
  const first = new XeroConnector({ clientId: "client-id", vault: firstVault, fetcher });
  const second = new XeroConnector({ clientId: "client-id", vault: secondVault, fetcher });
  const context = {
    tenantId: "tenant-a",
    connectionId: "connection-a",
    credentialRef: "oauth-shared",
  } as const;

  await Promise.all([
    first.refresh_credentials(context),
    second.refresh_credentials(context),
  ]);

  assert.equal(vendorRefreshes, 1);
  assert.equal(credential.revision, 2);
  assert.equal(credential.secret.refreshToken, "rotating-refresh-v2");
  assert.ok(
    [firstVault.reads, secondVault.reads].some((reads) =>
      reads[0] === "1" && reads.includes("2")
    ),
    "the losing replica must re-read revision 2 after it acquires the released lease",
  );
});

test("a crashed holder expires and a new replica receives a higher fencing token", async () => {
  const store = new SharedMemoryLeaseStore();
  const crashed = await store.acquire(
    "oauth-crash",
    "01H00000000000000000000001",
    45,
  );
  assert.equal(crashed.acquired, true);
  const coordinator = new DurableCredentialRefreshLeaseCoordinator(store, {
    leaseDurationMs: 45,
    renewalIntervalMs: 15,
    operationTimeoutMs: 300,
    storeTimeoutMs: 40,
    maximumPollMs: 8,
    random: () => 0,
  });
  let replacementFence = "";
  await coordinator.withLease("oauth-crash", async ({ proof }) => {
    replacementFence = proof.fencingToken;
  });
  assert.equal(replacementFence, "2");
});

test("lease renewal prevents a second replica entering during a long bounded refresh", async () => {
  const store = new SharedMemoryLeaseStore();
  const options = {
    leaseDurationMs: 60,
    renewalIntervalMs: 20,
    operationTimeoutMs: 500,
    storeTimeoutMs: 40,
    maximumPollMs: 8,
    random: () => 0,
  } as const;
  const first = new DurableCredentialRefreshLeaseCoordinator(store, options);
  const second = new DurableCredentialRefreshLeaseCoordinator(store, options);
  const sequence: string[] = [];
  const firstRun = first.withLease("oauth-long", async ({ abortSignal }) => {
    sequence.push("first:start");
    await delay(140, abortSignal);
    sequence.push("first:end");
  });
  await delay(5);
  const secondRun = second.withLease("oauth-long", async () => {
    sequence.push("second:start");
  });
  await Promise.all([firstRun, secondRun]);

  assert.deepEqual(sequence, ["first:start", "first:end", "second:start"]);
  assert.ok(store.events.some((event) => event.startsWith("extend:")));
});

test("losing a lease aborts the in-flight refresh before it can publish", async () => {
  class ExtensionLosingStore extends SharedMemoryLeaseStore {
    override async extend(): Promise<boolean> { return false; }
  }
  const coordinator = new DurableCredentialRefreshLeaseCoordinator(
    new ExtensionLosingStore(),
    {
      leaseDurationMs: 60,
      renewalIntervalMs: 20,
      operationTimeoutMs: 400,
      storeTimeoutMs: 40,
      maximumPollMs: 8,
      random: () => 0,
    },
  );

  await assert.rejects(
    coordinator.withLease("oauth-lost", async ({ abortSignal }) => {
      await delay(200, abortSignal);
    }),
    /credential_refresh_lease_lost/u,
  );
});
