import assert from "node:assert/strict";
import test from "node:test";
import type { TransactionalPostgres } from "./src/database.js";
import { VendorAttestationRelay, type VendorAttestationRelayConfig } from "./src/vendor-attestation-relay.js";

test("relay claims from DB, sends only the selected generation access token, and zeroes its buffer", async () => {
  const claim = {
    schemaVersion: 1,
    challengeId: "01K1Z0F0W6A1B2C3D4E5F6G7H8",
    challengeNonce: "n".repeat(43),
    challengeNonceDigest: "a".repeat(64),
    provider: "xero",
    tenantId: "01K1Z0F0W6A1B2C3D4E5F6G7H9",
    connectionId: "01K1Z0F0W6A1B2C3D4E5F6G7HA",
    connectionGeneration: 4,
    selectedExternalAccount: "6e91a9e7-f5b2-45db-afe9-60bca7dc3075",
    selectedExternalAccountDigest: "b".repeat(64),
    credentialRef: "oauth_exact_ref",
    credentialReferenceDigest: "c".repeat(64),
    tokenExpiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 2 * 60_000).toISOString(),
  } as const;
  let submittedReference: Buffer | undefined;
  let submittedCopy = "";
  const database: TransactionalPostgres = {
    query: async <Row extends Record<string, unknown>>() => ({
      rows: [{ value: claim } as unknown as Row],
    }),
    transaction: async () => { throw new Error("unused"); },
  };
  const relay = new VendorAttestationRelay({
    database,
    vault: {
      read: async () => ({
        credentialRef: claim.credentialRef,
        revision: "9",
        secret: {
          provider: "xero",
          accessToken: "live-access-token",
          refreshToken: "must-never-cross-mtls",
          tokenType: "Bearer" as const,
          expiresAt: claim.tokenExpiresAt,
          scopes: ["accounting.transactions.read"],
          metadata: { xeroTenantId: claim.selectedExternalAccount },
        },
      }),
      create: async () => { throw new Error("unused"); },
      compareAndSwap: async () => { throw new Error("unused"); },
      withRefreshLease: async () => { throw new Error("unused"); },
      destroy: async () => { throw new Error("unused"); },
    },
    workerId: "sync-worker-1",
    config: {
      origin: new URL("https://vendor-attestor.internal:8791"),
      serverName: "vendor-attestor.internal",
      expectedToolRef: `trust/albert-vendor-attestor@${"d".repeat(40)}`,
      expectedBuildDigest: `sha256:${"e".repeat(64)}`,
      clientCertificate: Buffer.from("certificate"),
      clientKey: Buffer.from("private-key"),
      serverCa: Buffer.from("ca"),
      pollMs: 1_000,
    } satisfies VendorAttestationRelayConfig,
    submit: async (_claim, token) => {
      submittedReference = token;
      submittedCopy = token.toString("utf8");
    },
  });
  assert.equal(await relay.runOnce(), true);
  assert.equal(submittedCopy, "live-access-token");
  assert.equal(submittedCopy.includes("refresh"), false);
  assert.ok(submittedReference?.every((byte) => byte === 0));
});

test("relay readiness proves the mTLS peer's pinned tool and build identity", async () => {
  const config = {
    origin: new URL("https://vendor-attestor.internal:8791"),
    serverName: "vendor-attestor.internal",
    expectedToolRef: `trust/albert-vendor-attestor@${"d".repeat(40)}`,
    expectedBuildDigest: `sha256:${"e".repeat(64)}`,
    clientCertificate: Buffer.from("certificate"),
    clientKey: Buffer.from("private-key"),
    serverCa: Buffer.from("ca"),
    pollMs: 1_000,
  } satisfies VendorAttestationRelayConfig;
  const database: TransactionalPostgres = {
    query: async <Row extends Record<string, unknown>>() => ({ rows: [] as Row[] }),
    transaction: async () => { throw new Error("unused"); },
  };
  const base = {
    database,
    vault: {} as never,
    workerId: "sync-worker-1",
    config,
  };
  await new VendorAttestationRelay({
    ...base,
    readinessProbe: async () => ({
      status: "ready",
      toolRef: config.expectedToolRef,
      buildDigest: config.expectedBuildDigest,
    }),
  }).ready();
  await assert.rejects(new VendorAttestationRelay({
    ...base,
    readinessProbe: async () => ({
      status: "ready",
      toolRef: config.expectedToolRef,
      buildDigest: `sha256:${"f".repeat(64)}`,
    }),
  }).ready(), /attestor_readiness_identity_mismatch/u);
});
