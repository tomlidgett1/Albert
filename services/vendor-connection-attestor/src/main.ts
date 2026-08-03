import assert from "node:assert/strict";
import { createHash, createPrivateKey, createPublicKey } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { Pool as PgPool } from "pg";
import { startVendorAttestorServers } from "./node-server.js";
import { VendorConnectionAttestorService } from "./service.js";
import { PostgresVendorAttestationStore } from "./store.js";

type PgModule = Readonly<{ Pool: new (options: Readonly<Record<string, unknown>>) => PgPool }>;

export async function startVendorConnectionAttestorFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
) {
  const config = loadConfig(environment);
  const pg = await loadPg();
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    application_name: "albert-independent-vendor-attestor",
    max: 4,
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 30_000,
    maxLifetimeSeconds: 1_800,
  });
  const store = new PostgresVendorAttestationStore(pool);
  const service = new VendorConnectionAttestorService({
    store,
    signingKey: config.signingKey,
    keyId: config.keyId,
    toolRef: config.toolRef,
    buildDigest: config.buildDigest,
    admissionHmacKey: config.admissionHmacKey,
  });
  try {
    assert.equal(await store.ready(), true, "Independent vendor attestation database boundary is not ready.");
    return await startVendorAttestorServers({
      service,
      ready: () => store.ready(),
      closeDependencies: async () => {
        try {
          await pool.end();
        } finally {
          zeroRuntimeSecrets(config);
        }
      },
      tls: config.tls,
      host: config.host,
      port: config.port,
      healthPort: config.healthPort,
      toolRef: config.toolRef,
      buildDigest: config.buildDigest,
    });
  } catch (error) {
    try {
      await pool.end();
    } finally {
      zeroRuntimeSecrets(config);
    }
    throw error;
  }
}

function zeroRuntimeSecrets(config: ReturnType<typeof loadConfig>): void {
  config.admissionHmacKey.fill(0);
  config.tls.key.fill(0);
}

function loadConfig(environment: NodeJS.ProcessEnv) {
  const databaseUrl = required(environment, "ALBERT_VENDOR_ATTESTOR_DATABASE_URL");
  const parsed = new URL(databaseUrl);
  assert.ok(["postgres:", "postgresql:"].includes(parsed.protocol), "Vendor attestor database URL must be PostgreSQL.");
  assert.ok(["require", "verify-ca", "verify-full"].includes(parsed.searchParams.get("sslmode") ?? ""), "Vendor attestor database URL must require TLS.");
  assert.equal(decodeURIComponent(parsed.username).split(".")[0], "albert_vendor_attestor_runtime", "Vendor attestor database URL must use its dedicated LOGIN.");
  assert.equal(["localhost", "127.0.0.1", "::1"].includes(parsed.hostname), false, "Vendor attestor database cannot be local.");
  const privateKeyBytes = decoded(environment, "ALBERT_VENDOR_ATTESTOR_ED25519_PRIVATE_KEY_BASE64");
  const privateKey = (() => {
    try {
      return createPrivateKey(privateKeyBytes);
    } finally {
      privateKeyBytes.fill(0);
    }
  })();
  assert.equal(privateKey.asymmetricKeyType, "ed25519", "Vendor attestor signing key must be Ed25519.");
  const keyId = required(environment, "ALBERT_VENDOR_ATTESTOR_KEY_ID");
  const publicKeyDer = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  assert.equal(
    keyId,
    `ed25519:${createHash("sha256").update(publicKeyDer).digest("hex")}`,
    "Vendor attestor key id must be derived from the Ed25519 SPKI public key.",
  );
  const toolRef = required(environment, "ALBERT_VENDOR_ATTESTOR_TOOL_REF");
  assert.match(toolRef, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/u);
  const buildDigest = required(environment, "ALBERT_VENDOR_ATTESTOR_BUILD_DIGEST");
  assert.match(buildDigest, /^sha256:[a-f0-9]{64}$/u);
  const fingerprints = new Set(required(environment, "ALBERT_VENDOR_ATTESTOR_SYNC_CLIENT_SHA256")
    .split(",").map((value) => value.replaceAll(":", "").trim().toLowerCase()));
  assert.ok(fingerprints.size >= 1 && fingerprints.size <= 2);
  for (const fingerprint of fingerprints) assert.match(fingerprint, /^[a-f0-9]{64}$/u);
  const port = boundedPort(environment.ALBERT_VENDOR_ATTESTOR_PORT, 8791);
  const healthPort = boundedPort(environment.ALBERT_VENDOR_ATTESTOR_HEALTH_PORT, 8792);
  assert.notEqual(port, healthPort, "Vendor attestor service and health ports must differ.");
  return Object.freeze({
    databaseUrl, signingKey: privateKey, keyId, toolRef, buildDigest,
    admissionHmacKey: decodedExact(environment, "ALBERT_VENDOR_ATTESTOR_ADMISSION_HMAC_KEY_BASE64", 32),
    host: environment.ALBERT_VENDOR_ATTESTOR_HOST?.trim() || "0.0.0.0",
    port, healthPort,
    tls: Object.freeze({
      key: decoded(environment, "ALBERT_VENDOR_ATTESTOR_TLS_KEY_BASE64"),
      cert: decoded(environment, "ALBERT_VENDOR_ATTESTOR_TLS_CERT_BASE64"),
      ca: decoded(environment, "ALBERT_VENDOR_ATTESTOR_TLS_CLIENT_CA_BASE64"),
      clientFingerprints: fingerprints,
    }),
  });
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  assert.ok(value, `${name} is required by the independent vendor attestor.`);
  return value;
}

function decoded(environment: NodeJS.ProcessEnv, name: string): Buffer {
  const encoded = required(environment, name);
  assert.match(encoded, /^[A-Za-z0-9+/]+={0,2}$/u, `${name} must be standard base64.`);
  const value = Buffer.from(encoded, "base64");
  assert.ok(value.byteLength >= 32 && value.byteLength <= 32 * 1024, `${name} has an invalid size.`);
  return value;
}

function decodedExact(environment: NodeJS.ProcessEnv, name: string, bytes: number): Buffer {
  const value = decoded(environment, name);
  assert.equal(value.byteLength, bytes, `${name} must decode to ${bytes} bytes.`);
  return value;
}

function boundedPort(value: string | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  assert.ok(Number.isInteger(parsed) && parsed >= 1 && parsed <= 65_535, "Vendor attestor port is invalid.");
  return parsed;
}

async function loadPg(): Promise<PgModule> {
  const imported = await import("pg");
  const pg = (imported.default ?? imported) as unknown as PgModule;
  if (!pg.Pool) throw new Error("Vendor attestor image must provide pg.");
  return pg;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const running = await startVendorConnectionAttestorFromEnvironment();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void running.close().catch(() => { process.exitCode = 1; });
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
