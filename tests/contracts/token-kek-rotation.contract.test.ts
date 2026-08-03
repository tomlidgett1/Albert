import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { inspectRuntimeEnvironment } from "../../packages/config/src/env.js";
import {
  AesKeyringWrapper,
  AesKeyWrapper,
  EnvelopeCryptography,
  type SealedEnvelope,
  type WrappedDataKey,
} from "../../services/sync-workers/src/credential-vault.js";
import {
  OAuthTokenKekRotationService,
  type ActiveOAuthKekUsage,
  type OAuthKekRewrapCandidate,
  type OAuthTokenKekRotationStore,
} from "../../services/sync-workers/src/token-kek-rotation.js";

const oldKey = Buffer.alloc(32, 41).toString("base64url");
const currentKey = Buffer.alloc(32, 42).toString("base64url");
const keyReference = "env:TOKEN_ENCRYPTION_KEY";
const binding = Object.freeze({
  tenantId: "01J00000000000000000000001",
  secretReference: "oauth_01J00000000000000000000002",
  version: 7,
});

type MemoryRow = {
  scope: "credential" | "oauth_session";
  tenantId: string;
  envelopeId: string;
  resourceId: string;
  credentialVersion: number;
  wrappedDataKey: Uint8Array;
  keyReference: string;
  keyVersion: string;
};

class MemoryRotationStore implements OAuthTokenKekRotationStore {
  private gate: Promise<void> = Promise.resolve();

  constructor(readonly rows: MemoryRow[]) {}

  async inspectActiveKeyUsage(): Promise<readonly ActiveOAuthKekUsage[]> {
    const grouped = new Map<string, MemoryRow[]>();
    for (const row of this.rows) {
      const key = `${row.scope}\u0000${row.keyReference}\u0000${row.keyVersion}`;
      grouped.set(key, [...(grouped.get(key) ?? []), row]);
    }
    return [...grouped.values()].map((rows) => ({
      scope: rows[0]!.scope,
      keyReference: rows[0]!.keyReference,
      keyVersion: rows[0]!.keyVersion,
      wrappedDataKey: new Uint8Array(rows[0]!.wrappedDataKey),
      activeCount: rows.length,
    }));
  }

  async rewrapBatch(input: Readonly<{
    currentKeyReference: string;
    currentKeyVersion: string;
    limit: number;
    rewrap: (candidate: OAuthKekRewrapCandidate) => Promise<WrappedDataKey>;
  }>) {
    let release!: () => void;
    const predecessor = this.gate;
    this.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await predecessor;
    try {
      let credentials = 0;
      let oauthSessions = 0;
      const selected = this.rows.filter((row) =>
        row.keyReference !== input.currentKeyReference ||
        row.keyVersion !== input.currentKeyVersion
      ).slice(0, input.limit);
      for (const row of selected) {
        const originalKeyReference = row.keyReference;
        const originalKeyVersion = row.keyVersion;
        const originalWrappedDataKey = new Uint8Array(row.wrappedDataKey);
        const rotated = await input.rewrap({ ...row });
        if (
          row.keyReference !== originalKeyReference ||
          row.keyVersion !== originalKeyVersion ||
          !Buffer.from(row.wrappedDataKey).equals(Buffer.from(originalWrappedDataKey))
        ) {
          continue;
        }
        row.wrappedDataKey = new Uint8Array(rotated.wrappedDataKey);
        row.keyReference = rotated.keyReference;
        row.keyVersion = rotated.keyVersion;
        if (row.scope === "credential") credentials += 1;
        else oauthSessions += 1;
      }
      return { credentials, oauthSessions };
    } finally {
      release();
    }
  }
}

function currentWrapper(includeOld = true): AesKeyringWrapper {
  return new AesKeyringWrapper({
    currentKeyReference: keyReference,
    currentKeyVersion: "token-v2",
    encodedKeys: new Map([
      ["token-v2", currentKey],
      ...(includeOld ? [["token-v1", oldKey] as const] : []),
    ]),
  });
}

test("wrapped-DEK rotation preserves OAuth ciphertext and binding byte-for-byte", async () => {
  const oldCryptography = new EnvelopeCryptography(
    new AesKeyWrapper(oldKey, keyReference, "token-v1"),
  );
  const envelope = await oldCryptography.seal("refresh-token-never-exposed", binding);
  const rotatingCryptography = new EnvelopeCryptography(currentWrapper());

  assert.equal(await rotatingCryptography.open(envelope, binding), "refresh-token-never-exposed");
  const rotated = await rotatingCryptography.rewrapDataKey(envelope);
  assert.equal(rotated.keyVersion, "token-v2");
  assert.notDeepEqual(rotated.wrappedDataKey, envelope.wrappedDataKey);
  assert.deepEqual(rotated.ciphertext, envelope.ciphertext);
  assert.deepEqual(rotated.nonce, envelope.nonce);
  assert.deepEqual(rotated.authenticationTag, envelope.authenticationTag);
  assert.equal(rotated.aadDigest, envelope.aadDigest);
  assert.equal(await rotatingCryptography.open(rotated, binding), "refresh-token-never-exposed");
});

test("online rewrap is concurrent-safe, convergent, and idempotent", async () => {
  const oldCryptography = new EnvelopeCryptography(
    new AesKeyWrapper(oldKey, keyReference, "token-v1"),
  );
  const envelope = await oldCryptography.seal("rotating-secret", binding);
  const row: MemoryRow = {
    scope: "credential",
    tenantId: binding.tenantId,
    envelopeId: "01J00000000000000000000003",
    resourceId: "01J00000000000000000000004",
    credentialVersion: binding.version,
    wrappedDataKey: new Uint8Array(envelope.wrappedDataKey),
    keyReference: envelope.keyReference,
    keyVersion: envelope.keyVersion,
  };
  const store = new MemoryRotationStore([row]);
  const service = new OAuthTokenKekRotationService(store, currentWrapper());
  const outcomes = await Promise.all(Array.from({ length: 8 }, () => service.rewrapBatch(10)));

  assert.equal(outcomes.reduce((total, item) => total + item.total, 0), 1);
  assert.equal(row.keyVersion, "token-v2");
  assert.equal((await service.rewrapBatch()).total, 0);
  assert.equal(service.health().pendingRewrapCount, 0);
  const opened = await new EnvelopeCryptography(currentWrapper()).open({
    ...envelope,
    wrappedDataKey: row.wrappedDataKey,
    keyReference: row.keyReference,
    keyVersion: row.keyVersion,
  } satisfies SealedEnvelope, binding);
  assert.equal(opened, "rotating-secret");
});

test("readiness fails closed when an active envelope key is absent or wrong", async () => {
  const oldCryptography = new EnvelopeCryptography(
    new AesKeyWrapper(oldKey, keyReference, "token-v1"),
  );
  const envelope = await oldCryptography.seal("active-secret", binding);
  const row: MemoryRow = {
    scope: "oauth_session",
    tenantId: binding.tenantId,
    envelopeId: "01J00000000000000000000005",
    resourceId: "01J00000000000000000000006",
    credentialVersion: binding.version,
    wrappedDataKey: envelope.wrappedDataKey,
    keyReference: envelope.keyReference,
    keyVersion: envelope.keyVersion,
  };

  const missing = new OAuthTokenKekRotationService(
    new MemoryRotationStore([{ ...row }]),
    currentWrapper(false),
  );
  await assert.rejects(
    missing.assertReady(),
    /credential_kek_active_envelope_unavailable/,
  );
  assert.deepEqual(missing.health().missingKeyVersions, ["token-v1"]);

  const wrongMaterial = new OAuthTokenKekRotationService(
    new MemoryRotationStore([{ ...row }]),
    new AesKeyringWrapper({
      currentKeyReference: keyReference,
      currentKeyVersion: "token-v2",
      encodedKeys: new Map([
        ["token-v2", currentKey],
        ["token-v1", Buffer.alloc(32, 99).toString("base64url")],
      ]),
    }),
  );
  await assert.rejects(
    wrongMaterial.assertReady(),
    /credential_kek_active_envelope_unavailable/,
  );
  assert.deepEqual(wrongMaterial.health().unreadableKeyVersions, ["token-v1"]);
});

test("Postgres rewrap path locks rows and cannot rewrite OAuth ciphertext or AAD", async () => {
  const [source, migration] = await Promise.all([
    readFile(new URL(
      "../../services/sync-workers/src/token-kek-rotation.ts",
      import.meta.url,
    ), "utf8"),
    readFile(new URL(
      "../../infra/migrations/control-plane/0031_m8_oauth_token_kek_rotation.sql",
      import.meta.url,
    ), "utf8"),
  ]);
  assert.match(source, /for update of token, envelope skip locked/iu);
  assert.match(source, /for update of envelope skip locked/iu);
  assert.match(source, /wrapped_data_key\s*=\s*\$4::bytea/iu);
  assert.doesNotMatch(source, /set\s+(?:envelope\.)?ciphertext\s*=/iu);
  assert.doesNotMatch(source, /set\s+(?:envelope\.)?aad_digest\s*=/iu);
  assert.match(source, /credential_ciphertext_changed', false/iu);
  assert.match(source, /aad_changed', false/iu);
  assert.match(migration, /oauth_secret_envelopes_active_kek_idx/iu);
  assert.match(migration, /oauth_session_secret_envelopes_active_kek_idx/iu);
});

test("shared runtime inspection enforces canonical, bounded token keyrings", () => {
  const environment = {
    SUPABASE_STORAGE_S3_ENDPOINT: "https://project.storage.supabase.co/storage/v1/s3",
    SUPABASE_STORAGE_S3_REGION: "ap-southeast-2",
    SUPABASE_STORAGE_S3_ACCESS_KEY_ID: "storage-access",
    SUPABASE_STORAGE_S3_LEGACY_ANON_KEY: "legacy-anon-jwt",
    ALBERT_RAW_STORAGE_SYNC_PASSWORD: "sync-machine-password-material-00000001",
    CONTROL_PLANE_DATABASE_URL: "postgresql://control.invalid/albert",
    ANALYTICAL_DATABASE_URL: "postgresql://analytics.invalid/albert",
    TOKEN_ENCRYPTION_KEY: currentKey,
    TOKEN_ENCRYPTION_KEY_ID: "token-v2",
    TOKEN_PREVIOUS_ENCRYPTION_KEYS: JSON.stringify({ "token-v1": oldKey }),
    ALBERT_OAUTH_WORKER_SIGNING_SECRET: "o".repeat(32),
    ALBERT_PUBLIC_ORIGIN: "https://albert.example",
    LIGHTSPEED_CLIENT_ID: "lightspeed",
    LIGHTSPEED_CLIENT_SECRET: "lightspeed-secret",
    XERO_CLIENT_ID: "xero",
    XERO_DAILY_REQUEST_LIMIT: "1000",
    DEPUTY_CLIENT_ID: "deputy",
    DEPUTY_CLIENT_SECRET: "deputy-secret",
    ALBERT_WORKER_ID: "sync-worker",
  };
  assert.equal(inspectRuntimeEnvironment("worker", environment).ready, true);

  const reused = inspectRuntimeEnvironment("worker", {
    ...environment,
    TOKEN_PREVIOUS_ENCRYPTION_KEYS: JSON.stringify({ "token-v1": currentKey }),
  });
  assert.equal(reused.ready, false);
  assert.ok(reused.invalid.includes("TOKEN_PREVIOUS_ENCRYPTION_KEYS"));

  const padded = inspectRuntimeEnvironment("worker", {
    ...environment,
    TOKEN_ENCRYPTION_KEY: `${currentKey}=`,
  });
  assert.equal(padded.ready, false);
  assert.ok(padded.invalid.includes("TOKEN_ENCRYPTION_KEY"));
});

test("sync and deletion deployment contracts share the optional overlap keyring", async () => {
  const [syncConfig, syncMain, deletionConfig, deletionMain, runtimeContract] = await Promise.all([
    readFile(new URL("../../services/sync-workers/src/config.ts", import.meta.url), "utf8"),
    readFile(new URL("../../services/sync-workers/src/main.ts", import.meta.url), "utf8"),
    readFile(new URL("../../services/deletion-worker/src/config.ts", import.meta.url), "utf8"),
    readFile(new URL("../../services/deletion-worker/src/main.ts", import.meta.url), "utf8"),
    readFile(new URL("../../deploy/runtime-contract.json", import.meta.url), "utf8").then(JSON.parse),
  ]);
  for (const source of [syncConfig, deletionConfig]) {
    assert.match(source, /previousKeysJson:\s*source\.TOKEN_PREVIOUS_ENCRYPTION_KEYS/u);
    assert.match(source, /maxPreviousKeys:\s*4/u);
  }
  for (const source of [syncMain, deletionMain]) {
    assert.match(source, /new AesKeyringWrapper/u);
    assert.match(source, /encodedKeys:\s*config\.tokenEncryptionKeys/u);
  }
  assert.ok(runtimeContract.runtimes["sync-worker"].optionalSecretNames.includes(
    "TOKEN_PREVIOUS_ENCRYPTION_KEYS",
  ));
  assert.ok(runtimeContract.runtimes["deletion-worker"].optionalSecretNames.includes(
    "TOKEN_PREVIOUS_ENCRYPTION_KEYS",
  ));
  assert.ok(runtimeContract.runtimes.web.forbiddenRuntimeValues.includes(
    "TOKEN_PREVIOUS_ENCRYPTION_KEYS",
  ));
});
