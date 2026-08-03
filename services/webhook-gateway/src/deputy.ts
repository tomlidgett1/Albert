import {
  parseDeputyWebhook,
  parseDeputyWebhookVerificationMaterial,
} from "../../../connectors/deputy/webhooks.js";
import type {
  WebhookDisposition,
  WebhookEnvelope,
} from "../../../packages/connector-sdk/src/index.js";
import {
  openSecret,
  type SealedSecret,
} from "../../../packages/security/src/index.js";
import type { TransactionalPostgres } from "../../sync-workers/src/database.js";
import {
  attestWebhookDocument,
  type WebhookAttestor,
} from "./attestation.js";
import type { WebhookConnection } from "./store.js";

export type ResolvedDeputyWebhook = WebhookConnection & Readonly<{
  materialId: string;
  materialVersion: number;
  verificationMode: "custom_header" | "custom_header_and_enterprise_hmac";
  envelope: SealedSecret;
  callbackUrl: string;
}>;

type ResolvedRow = Readonly<{
  tenant_id: string;
  connection_id: string;
  connector_key: "deputy";
  external_account_reference: string;
  material_id: string;
  material_version: number | string;
  verification_mode: ResolvedDeputyWebhook["verificationMode"];
  envelope_version: 1 | string;
  algorithm: "A256GCM";
  key_id: string;
  iv: string;
  ciphertext: string;
  callback_url: string;
}>;

function associatedData(value: Pick<ResolvedDeputyWebhook, "tenantId" | "connectionId" | "materialId">): string {
  return `albert:deputy-webhook:v1:${value.tenantId}:${value.connectionId}:${value.materialId}`;
}

function isCanonicalBase64Url256(value: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.byteLength === 32 && decoded.toString("base64url") === value;
}

export class DeputyWebhookResolver {
  constructor(
    private readonly db: TransactionalPostgres,
    private readonly attestor: WebhookAttestor,
  ) {}

  async resolve(connectionId: string, materialId: string): Promise<ResolvedDeputyWebhook | null> {
    const { document, proof } = attestWebhookDocument(
      this.attestor,
      "deputy.resolve",
      connectionId,
      { version: 1, operation: "deputy.resolve", connectionId, materialId },
    );
    const result = await this.db.query<ResolvedRow>(
      `select tenant_id, connection_id, connector_key,
              external_account_reference, material_id, material_version,
              verification_mode, envelope_version, algorithm, key_id, iv,
              ciphertext, callback_url
         from control_plane.resolve_attested_deputy_webhook_material(
           $1, $2, $3, $4, $5
         )`,
      [document, proof.issuedAt, proof.nonce, proof.keyId, proof.signature],
    );
    if (result.rows.length > 1) throw new Error("deputy_webhook_resolution_ambiguous");
    const row = result.rows[0];
    if (!row) return null;
    return Object.freeze({
      tenantId: row.tenant_id,
      connectionId: row.connection_id,
      connectorKey: row.connector_key,
      externalAccountReference: row.external_account_reference,
      materialId: row.material_id,
      materialVersion: Number(row.material_version),
      verificationMode: row.verification_mode,
      envelope: Object.freeze({
        version: Number(row.envelope_version) as 1,
        algorithm: row.algorithm,
        keyId: row.key_id,
        iv: row.iv,
        ciphertext: row.ciphertext,
      }),
      callbackUrl: row.callback_url,
    });
  }
}

export class DeputyWebhookVerifier {
  private readonly encryptionKeys: ReadonlyMap<string, string>;

  constructor(private readonly config: Readonly<{
    encryptionKey: string;
    keyId: string;
    encryptionKeys?: ReadonlyMap<string, string>;
    maxClockSkewMs: number;
    now?: () => number;
  }>) {
    if (!isCanonicalBase64Url256(config.encryptionKey)) {
      throw new Error("DEPUTY_WEBHOOK_ENCRYPTION_KEY must be a base64url-encoded 256-bit key.");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(config.keyId)) {
      throw new Error("DEPUTY_WEBHOOK_ENCRYPTION_KEY_ID is invalid.");
    }
    const keys = new Map(config.encryptionKeys ?? []);
    for (const [keyId, key] of keys) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(keyId) ||
          !isCanonicalBase64Url256(key)) {
        throw new Error("A Deputy webhook decryption key is invalid.");
      }
    }
    if (keys.has(config.keyId) && keys.get(config.keyId) !== config.encryptionKey) {
      throw new Error("The current Deputy webhook key ID is ambiguous.");
    }
    keys.set(config.keyId, config.encryptionKey);
    this.encryptionKeys = keys;
  }

  async verify(
    resolved: ResolvedDeputyWebhook,
    event: WebhookEnvelope,
  ): Promise<WebhookDisposition> {
    const encryptionKey = this.encryptionKeys.get(resolved.envelope.keyId);
    if (!encryptionKey || resolved.materialVersion !== 1) {
      throw new Error("deputy_webhook_key_version_unavailable");
    }
    const plaintext = await openSecret({
      envelope: resolved.envelope,
      encodedKey: encryptionKey,
      associatedData: associatedData(resolved),
    });
    const material = parseDeputyWebhookVerificationMaterial(JSON.parse(plaintext));
    const expectedMode = material.enterpriseHmacKey
      ? "custom_header_and_enterprise_hmac"
      : "custom_header";
    if (expectedMode !== resolved.verificationMode) {
      throw new Error("deputy_webhook_verification_mode_mismatch");
    }
    return parseDeputyWebhook({
      event,
      material,
      expectedCallbackUrl: resolved.callbackUrl,
      nowMs: this.config.now?.(),
      maxClockSkewMs: this.config.maxClockSkewMs,
    });
  }
}
