import assert from "node:assert/strict";
import { request as httpsRequest } from "node:https";
import type { WorkerCredentialVault } from "../../../packages/connector-sdk/src/index.js";
import type { TransactionalPostgres } from "./database.js";
import { z } from "zod";

const MAX_RESPONSE_BYTES = 8 * 1024;

const vendorRelayClaimSchema = z.object({
  schemaVersion: z.literal(1),
  challengeId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
  challengeNonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  challengeNonceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  provider: z.enum(["lightspeed-r", "xero", "deputy", "square", "shopify", "stripe", "momence", "meta-ads", "google-ads"]),
  tenantId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
  connectionId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/u),
  connectionGeneration: z.coerce.number().int().positive().safe(),
  selectedExternalAccount: z.string().min(1).max(500),
  selectedExternalAccountDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  credentialRef: z.string().min(1).max(500),
  credentialReferenceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
  tokenExpiresAt: z.string().datetime({ offset: true }),
  expiresAt: z.string().datetime({ offset: true }),
}).strict();
type VendorRelayClaim = z.infer<typeof vendorRelayClaimSchema>;

export type VendorAttestationRelayConfig = Readonly<{
  origin: URL;
  serverName: string;
  expectedToolRef: string;
  expectedBuildDigest: string;
  clientCertificate: Buffer;
  clientKey: Buffer;
  serverCa: Buffer;
  pollMs: number;
}>;

export function loadVendorAttestationRelayConfig(
  source: NodeJS.ProcessEnv = process.env,
): VendorAttestationRelayConfig | null {
  const rawEnabled = source.ALBERT_VENDOR_ATTESTOR_RELAY_ENABLED ??
    (source.NODE_ENV === "production" ? "true" : "false");
  if (rawEnabled !== "true" && rawEnabled !== "false") {
    throw new Error("ALBERT_VENDOR_ATTESTOR_RELAY_ENABLED must be true or false.");
  }
  if (rawEnabled === "false") {
    if (source.NODE_ENV === "production") {
      throw new Error("The independent vendor attestation relay is mandatory in production.");
    }
    return null;
  }
  const origin = new URL(required(source, "ALBERT_VENDOR_ATTESTOR_PRIVATE_ORIGIN"));
  if (
    origin.protocol !== "https:" || origin.username || origin.password ||
    origin.pathname !== "/" || origin.search || origin.hash ||
    !origin.hostname.endsWith(".internal")
  ) throw new Error("ALBERT_VENDOR_ATTESTOR_PRIVATE_ORIGIN must be a clean private HTTPS .internal origin.");
  const serverName = required(source, "ALBERT_VENDOR_ATTESTOR_TLS_SERVER_NAME").toLowerCase();
  if (serverName !== origin.hostname || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.internal$/u.test(serverName)) {
    throw new Error("ALBERT_VENDOR_ATTESTOR_TLS_SERVER_NAME must exactly match the private attestor hostname.");
  }
  const pollMs = Number(source.ALBERT_VENDOR_ATTESTOR_RELAY_POLL_MS ?? "1000");
  if (!Number.isInteger(pollMs) || pollMs < 250 || pollMs > 5_000) {
    throw new Error("ALBERT_VENDOR_ATTESTOR_RELAY_POLL_MS must be between 250 and 5000.");
  }
  return Object.freeze({
    origin,
    serverName,
    expectedToolRef: validated(
      source, "ALBERT_VENDOR_ATTESTOR_EXPECTED_TOOL_REF",
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/u,
    ),
    expectedBuildDigest: validated(
      source, "ALBERT_VENDOR_ATTESTOR_EXPECTED_BUILD_DIGEST",
      /^sha256:[a-f0-9]{64}$/u,
    ),
    clientCertificate: decodePem(source, "ALBERT_VENDOR_ATTESTOR_TLS_CLIENT_CERT_BASE64"),
    clientKey: decodePem(source, "ALBERT_VENDOR_ATTESTOR_TLS_CLIENT_KEY_BASE64"),
    serverCa: decodePem(source, "ALBERT_VENDOR_ATTESTOR_TLS_SERVER_CA_BASE64"),
    pollMs,
  });
}

export class VendorAttestationRelay {
  private lastErrorCode: string | null = null;
  private lastRelayedAt: string | null = null;

  constructor(private readonly dependencies: Readonly<{
    database: TransactionalPostgres;
    vault: WorkerCredentialVault;
    workerId: string;
    config: VendorAttestationRelayConfig;
    submit?: (claim: VendorRelayClaim, token: Buffer) => Promise<void>;
    readinessProbe?: () => Promise<unknown>;
  }>) {}

  health() {
    return Object.freeze({ lastErrorCode: this.lastErrorCode, lastRelayedAt: this.lastRelayedAt });
  }

  async ready(): Promise<void> {
    const value = await (this.dependencies.readinessProbe ?? (() => this.probeReadiness()))();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("attestor_readiness_invalid");
    }
    const result = value as Readonly<Record<string, unknown>>;
    if (
      Object.keys(result).sort().join(",") !== "buildDigest,status,toolRef" ||
      result.status !== "ready" ||
      result.toolRef !== this.dependencies.config.expectedToolRef ||
      result.buildDigest !== this.dependencies.config.expectedBuildDigest
    ) throw new Error("attestor_readiness_identity_mismatch");
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        if (!await this.runOnce()) {
          await delay(this.dependencies.config.pollMs, signal);
          continue;
        }
      } catch (error) {
        if (signal.aborted) return;
        this.lastErrorCode = safeCode(error);
        await delay(this.dependencies.config.pollMs, signal);
      }
    }
  }

  async runOnce(): Promise<boolean> {
    const claimed = await this.claim();
    if (!claimed) return false;
    await this.relay(claimed);
    this.lastRelayedAt = new Date().toISOString();
    this.lastErrorCode = null;
    return true;
  }

  destroy(): void {
    this.dependencies.config.clientKey.fill(0);
  }

  private async claim(): Promise<VendorRelayClaim | null> {
    const result = await this.dependencies.database.query<{ value: unknown }>(
      "select control_plane.claim_live_vendor_attestation_relay($1) as value",
      [this.dependencies.workerId],
    );
    const value = result.rows[0]?.value;
    return value === null || value === undefined ? null : vendorRelayClaimSchema.parse(value);
  }

  private async relay(claim: VendorRelayClaim): Promise<void> {
    const credential = await this.dependencies.vault.read(claim.credentialRef);
    if (
      credential.credentialRef !== claim.credentialRef ||
      credential.secret.provider !== claim.provider ||
      credential.secret.tokenType !== "Bearer" ||
      Math.abs(Date.parse(credential.secret.expiresAt) - Date.parse(claim.tokenExpiresAt)) > 1_000 ||
      Date.parse(credential.secret.expiresAt) <= Date.now() + 5_000 ||
      selectedAccount(credential.secret.metadata, claim.provider) !== claim.selectedExternalAccount
    ) throw new Error("attestation_credential_binding_mismatch");
    const token = Buffer.from(credential.secret.accessToken, "utf8");
    try {
      if (token.byteLength < 1 || token.byteLength > 65_536 || token.includes(0x00) || token.includes(0x0a) || token.includes(0x0d)) {
        throw new Error("attestation_access_token_invalid");
      }
      await (this.dependencies.submit ?? ((input, bytes) => this.submit(input, bytes)))(claim, token);
    } finally {
      token.fill(0);
    }
  }

  private async submit(claim: VendorRelayClaim, token: Buffer): Promise<void> {
    const config = this.dependencies.config;
    const path = "/v1/vendor-connection-attestations";
    await new Promise<void>((resolve, reject) => {
      const request = httpsRequest({
        protocol: "https:", hostname: config.origin.hostname,
        port: config.origin.port ? Number(config.origin.port) : 443,
        path, method: "POST", servername: config.serverName,
        cert: config.clientCertificate, key: config.clientKey, ca: config.serverCa,
        rejectUnauthorized: true, minVersion: "TLSv1.3", maxVersion: "TLSv1.3",
        maxHeaderSize: 8 * 1024,
        signal: AbortSignal.timeout(25_000),
        headers: {
          "content-type": "application/octet-stream",
          "content-length": token.byteLength,
          "x-albert-challenge-id": claim.challengeId,
          "x-albert-challenge-nonce": claim.challengeNonce,
        },
      }, (response) => {
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += bytes.byteLength;
          if (total > MAX_RESPONSE_BYTES) {
            bytes.fill(0); chunks.forEach((item) => item.fill(0));
            response.destroy(new Error("attestor_response_too_large"));
            return;
          }
          chunks.push(bytes);
        });
        response.once("error", reject);
        response.once("end", () => {
          const body = Buffer.concat(chunks, total);
          chunks.forEach((item) => item.fill(0));
          try {
            if (response.statusCode !== 200 && response.statusCode !== 422) {
              throw new Error("attestor_submission_rejected");
            }
            const parsed = JSON.parse(body.toString("utf8")) as unknown;
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
              throw new Error("attestor_response_invalid");
            }
            resolve();
          } catch (error) {
            reject(error);
          } finally {
            body.fill(0);
          }
        });
      });
      request.once("error", reject);
      request.end(token);
    });
  }

  private async probeReadiness(): Promise<unknown> {
    const config = this.dependencies.config;
    return await new Promise<unknown>((resolve, reject) => {
      const request = httpsRequest({
        protocol: "https:", hostname: config.origin.hostname,
        port: config.origin.port ? Number(config.origin.port) : 443,
        path: "/readyz", method: "GET", servername: config.serverName,
        cert: config.clientCertificate, key: config.clientKey, ca: config.serverCa,
        rejectUnauthorized: true, minVersion: "TLSv1.3", maxVersion: "TLSv1.3",
        maxHeaderSize: 8 * 1024,
        signal: AbortSignal.timeout(5_000),
        headers: { accept: "application/json" },
      }, (response) => {
        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (chunk: Buffer | string) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += bytes.byteLength;
          if (total > MAX_RESPONSE_BYTES) {
            bytes.fill(0); chunks.forEach((item) => item.fill(0));
            response.destroy(new Error("attestor_readiness_too_large"));
            return;
          }
          chunks.push(bytes);
        });
        response.once("error", reject);
        response.once("end", () => {
          const body = Buffer.concat(chunks, total);
          chunks.forEach((item) => item.fill(0));
          try {
            if (response.statusCode !== 200) throw new Error("attestor_not_ready");
            resolve(JSON.parse(body.toString("utf8")) as unknown);
          } catch (error) {
            reject(error);
          } finally {
            body.fill(0);
          }
        });
      });
      request.once("error", reject);
      request.end();
    });
  }
}

function selectedAccount(
  metadata: Readonly<Record<string, string | number | boolean | null>>,
  provider: VendorRelayClaim["provider"],
): string | null {
  const value = provider === "xero" ? metadata.xeroTenantId
    : provider === "lightspeed-r" ? metadata.lightspeedAccountId
    : metadata.endpoint;
  return typeof value === "string" ? value : null;
}

function required(source: NodeJS.ProcessEnv, name: string): string {
  const value = source[name]?.trim();
  if (!value) throw new Error(`${name} is required by the vendor attestation relay.`);
  return value;
}

function validated(source: NodeJS.ProcessEnv, name: string, pattern: RegExp): string {
  const value = required(source, name);
  assert.match(value, pattern, `${name} is invalid.`);
  return value;
}

function decodePem(source: NodeJS.ProcessEnv, name: string): Buffer {
  const encoded = required(source, name);
  assert.match(encoded, /^[A-Za-z0-9+/]+={0,2}$/u, `${name} must be standard base64.`);
  const value = Buffer.from(encoded, "base64");
  assert.ok(value.byteLength >= 32 && value.byteLength <= 32 * 1024, `${name} has an invalid size.`);
  return value;
}

function safeCode(error: unknown): string {
  const code = error instanceof Error ? error.message.split(":", 1)[0] : "attestation_relay_failed";
  return /^[a-z][a-z0-9_]{2,79}$/u.test(code) ? code : "attestation_relay_failed";
}

async function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      signal.removeEventListener("abort", stop);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const stop = () => { clearTimeout(timer); finish(); };
    signal.addEventListener("abort", stop, { once: true });
  });
}
