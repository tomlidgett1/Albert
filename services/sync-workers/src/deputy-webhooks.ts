import { randomBytes } from "node:crypto";
import { ulid } from "ulid";

import {
  DEPUTY_WEBHOOK_TOPICS,
  DeputyConnector,
  parseDeputyWebhookVerificationMaterial,
  type DeputyWebhookVerificationMaterial,
} from "../../../connectors/deputy/index.js";
import {
  ConnectorHttpError,
  type ConnectorContext,
} from "../../../packages/connector-sdk/src/index.js";
import {
  openSecret,
  sealSecret,
  type SealedSecret,
} from "../../../packages/security/src/index.js";
import type { PostgresQueryClient } from "../../../packages/queue/src/index.js";
import type { TransactionalPostgres } from "./database.js";

type MaterialRow = Readonly<{
  tenant_id: string;
  connection_id: string;
  material_id: string;
  material_version: number | string;
  verification_mode: "custom_header" | "custom_header_and_enterprise_hmac";
  envelope_version: 1 | string;
  algorithm: "A256GCM";
  key_id: string;
  iv: string;
  ciphertext: string;
  callback_url: string;
  setup_status: string;
  attempt_count: number | string;
  provisioning_lease_active: boolean;
  retired_at: string | Date | null;
}>;

type RewrapMaterialRow = Readonly<{
  tenant_id: string;
  connection_id: string;
  material_id: string;
  envelope_version: 1 | string;
  algorithm: "A256GCM";
  key_id: string;
  iv: string;
  ciphertext: string;
}>;

export type DeputyWebhookSetupResult = Readonly<{
  state: "active" | "action_required" | "retryable";
  reasonCode?: string;
  provisionedTopics: readonly string[];
}>;

export type PreparedDeputyWebhook = Readonly<{
  tenantId: string;
  connectionId: string;
  materialId: string;
  attemptCount: number;
  callbackUrl: string;
  material: DeputyWebhookVerificationMaterial;
}>;

function associatedData(tenantId: string, connectionId: string, materialId: string): string {
  return `albert:deputy-webhook:v1:${tenantId}:${connectionId}:${materialId}`;
}

function envelope(row: MaterialRow): SealedSecret {
  return {
    version: Number(row.envelope_version) as 1,
    algorithm: row.algorithm,
    keyId: row.key_id,
    iv: row.iv,
    ciphertext: row.ciphertext,
  };
}

function cleanGatewayOrigin(value: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" || url.username || url.password ||
    url.search || url.hash || url.pathname !== "/"
  ) {
    throw new Error("WEBHOOK_GATEWAY_PUBLIC_URL must be a clean HTTPS origin.");
  }
  return url;
}

function callbackUrl(origin: URL, connectionId: string, materialId: string): string {
  return new URL(`/v1/webhooks/deputy/${connectionId}/${materialId}`, origin).toString();
}

function isCanonicalBase64Url256(value: string): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) return false;
  const decoded = Buffer.from(value, "base64url");
  return decoded.byteLength === 32 && decoded.toString("base64url") === value;
}

function safeFailure(error: unknown): Readonly<{
  status: "blocked_permission" | "blocked_vendor_approval" | "retry_wait";
  reasonCode: string;
  state: "action_required" | "retryable";
}> {
  if (error instanceof ConnectorHttpError) {
    if (error.status === 401 || error.status === 403) {
      return { status: "blocked_permission", reasonCode: "deputy_webhook_permission_required", state: "action_required" };
    }
    if (error.status === 404 || error.status === 405 || error.status === 422) {
      return { status: "blocked_vendor_approval", reasonCode: "deputy_webhook_vendor_approval_required", state: "action_required" };
    }
  }
  return { status: "retry_wait", reasonCode: "deputy_webhook_setup_retry_required", state: "retryable" };
}

export class DeputyWebhookMaterialStore {
  private readonly gatewayOrigin: URL;
  private readonly encryptionKeys: ReadonlyMap<string, string>;

  constructor(
    private readonly db: TransactionalPostgres,
    private readonly encryptionKey: string,
    private readonly keyId: string,
    gatewayPublicUrl: string,
    previousEncryptionKeys: ReadonlyMap<string, string> = new Map(),
  ) {
    if (!isCanonicalBase64Url256(encryptionKey)) {
      throw new Error("DEPUTY_WEBHOOK_ENCRYPTION_KEY must be a base64url-encoded 256-bit key.");
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(keyId)) {
      throw new Error("DEPUTY_WEBHOOK_ENCRYPTION_KEY_ID is invalid.");
    }
    const keys = new Map(previousEncryptionKeys);
    for (const [previousKeyId, previousKey] of keys) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(previousKeyId) ||
          !isCanonicalBase64Url256(previousKey)) {
        throw new Error("A previous Deputy webhook encryption key is invalid.");
      }
    }
    if (keys.has(keyId) && keys.get(keyId) !== encryptionKey) {
      throw new Error("The current Deputy webhook key ID is ambiguous.");
    }
    keys.set(keyId, encryptionKey);
    this.encryptionKeys = keys;
    this.gatewayOrigin = cleanGatewayOrigin(gatewayPublicUrl);
  }

  async prepare(tenantId: string, connectionId: string): Promise<PreparedDeputyWebhook> {
    const candidateMaterialId = ulid();
    const candidateMaterial: DeputyWebhookVerificationMaterial = Object.freeze({
      version: 1,
      customHeaderSecret: randomBytes(32).toString("base64url"),
    });
    const candidateCallback = callbackUrl(this.gatewayOrigin, connectionId, candidateMaterialId);
    const candidateEnvelope = await sealSecret({
      plaintext: JSON.stringify(candidateMaterial),
      encodedKey: this.encryptionKey,
      keyId: this.keyId,
      associatedData: associatedData(tenantId, connectionId, candidateMaterialId),
    });

    const row = await this.db.transaction(async (client) => {
      await client.query(
        `insert into control_plane.deputy_webhook_material (
           tenant_id, connection_id, material_id, material_version,
           verification_mode, envelope_version, algorithm, key_id, iv,
           ciphertext, callback_url, setup_status, required_topics,
           attempt_count, last_attempted_at
         ) values (
           $1, $2, $3, 1, 'custom_header', $4, $5, $6, $7, $8, $9,
           'provisioning', $10::text[], 1, now()
         ) on conflict (tenant_id, connection_id) do nothing`,
        [
          tenantId,
          connectionId,
          candidateMaterialId,
          candidateEnvelope.version,
          candidateEnvelope.algorithm,
          candidateEnvelope.keyId,
          candidateEnvelope.iv,
          candidateEnvelope.ciphertext,
          candidateCallback,
          [...DEPUTY_WEBHOOK_TOPICS],
        ],
      );
      const selected = await client.query<MaterialRow>(
        `select tenant_id, connection_id, material_id, material_version,
                verification_mode, envelope_version, algorithm, key_id, iv,
                ciphertext, callback_url, setup_status, attempt_count,
                case when setup_status = 'provisioning'
                  then coalesce(last_attempted_at > clock_timestamp() - interval '2 minutes', true)
                  else false
                end as provisioning_lease_active,
                retired_at
           from control_plane.deputy_webhook_material
          where tenant_id = $1 and connection_id = $2
          for update`,
        [tenantId, connectionId],
      );
      const material = selected.rows[0];
      if (!material || material.retired_at) throw new Error("deputy_webhook_material_unavailable");
      const currentAttempt = Number(material.attempt_count);
      if (!Number.isSafeInteger(currentAttempt) || currentAttempt < 1) {
        throw new Error("deputy_webhook_attempt_invalid");
      }
      const candidateOwnsAttempt = material.material_id === candidateMaterialId;
      if (!candidateOwnsAttempt && material.provisioning_lease_active) {
        throw new Error("deputy_webhook_setup_in_progress");
      }
      const nextCallback = callbackUrl(this.gatewayOrigin, connectionId, material.material_id);
      const nextAttempt = candidateOwnsAttempt ? currentAttempt : currentAttempt + 1;
      await client.query(
        `update control_plane.deputy_webhook_material
            set callback_url = $3, setup_status = 'provisioning',
                last_error_code = null,
                attempt_count = $4,
                last_attempted_at = now()
          where tenant_id = $1 and connection_id = $2`,
        [tenantId, connectionId, nextCallback, nextAttempt],
      );
      return { ...material, callback_url: nextCallback, attempt_count: nextAttempt };
    });

    const decryptionKey = this.encryptionKeys.get(row.key_id);
    if (!decryptionKey) throw new Error("deputy_webhook_key_version_unavailable");
    const plaintext = await openSecret({
      envelope: envelope(row),
      encodedKey: decryptionKey,
      associatedData: associatedData(row.tenant_id, row.connection_id, row.material_id),
    });
    const parsed = parseDeputyWebhookVerificationMaterial(JSON.parse(plaintext));
    if (row.key_id !== this.keyId) {
      const rotated = await sealSecret({
        plaintext,
        encodedKey: this.encryptionKey,
        keyId: this.keyId,
        associatedData: associatedData(row.tenant_id, row.connection_id, row.material_id),
      });
      const updated = await this.db.query(
        `update control_plane.deputy_webhook_material
            set envelope_version = $5, algorithm = $6, key_id = $7,
                iv = $8, ciphertext = $9
          where tenant_id = $1 and connection_id = $2 and material_id = $3
            and attempt_count = $4 and key_id = $10 and retired_at is null
        returning material_id`,
        [
          row.tenant_id,
          row.connection_id,
          row.material_id,
          Number(row.attempt_count),
          rotated.version,
          rotated.algorithm,
          rotated.keyId,
          rotated.iv,
          rotated.ciphertext,
          row.key_id,
        ],
      );
      if (!updated.rows[0]) throw new Error("deputy_webhook_material_changed");
    }
    return Object.freeze({
      tenantId: row.tenant_id,
      connectionId: row.connection_id,
      materialId: row.material_id,
      attemptCount: Number(row.attempt_count),
      callbackUrl: row.callback_url,
      material: parsed,
    });
  }

  async markActive(
    prepared: PreparedDeputyWebhook,
    vendorWebhookIds: Readonly<Record<string, string>>,
  ): Promise<void> {
    const topics = Object.keys(vendorWebhookIds).sort();
    if (topics.length !== DEPUTY_WEBHOOK_TOPICS.length ||
        !DEPUTY_WEBHOOK_TOPICS.every((topic) => topics.includes(topic))) {
      throw new Error("deputy_webhook_topics_incomplete");
    }
    await this.db.transaction(async (client) => {
      const updated = await client.query(
        `update control_plane.deputy_webhook_material
            set setup_status = 'active', provisioned_topics = $5::text[],
                vendor_webhook_ids = $6::jsonb, last_error_code = null,
                provisioned_at = now(), retired_at = null
          where tenant_id = $1 and connection_id = $2 and material_id = $3
            and attempt_count = $4
            and retired_at is null
        returning material_id`,
        [
          prepared.tenantId,
          prepared.connectionId,
          prepared.materialId,
          prepared.attemptCount,
          topics,
          JSON.stringify(vendorWebhookIds),
        ],
      );
      if (!updated.rows[0]) throw new Error("deputy_webhook_material_changed");
      await this.updateConnectionState(client, prepared, "connected", "active", null);
      await this.audit(client, prepared, "deputy.webhooks_provisioned", {
        topic_count: topics.length,
        verification_mode: prepared.material.enterpriseHmacKey
          ? "custom_header_and_enterprise_hmac"
          : "custom_header",
      });
    });
  }

  async rewrapPreviousMaterials(limit = 100): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new Error("Deputy webhook rewrap limit is invalid.");
    }
    const previousKeyIds = [...this.encryptionKeys.keys()]
      .filter((candidate) => candidate !== this.keyId);
    if (previousKeyIds.length === 0) return 0;
    return this.db.transaction(async (client) => {
      const selected = await client.query<RewrapMaterialRow>(
        `select tenant_id, connection_id, material_id, envelope_version,
                algorithm, key_id, iv, ciphertext
           from control_plane.deputy_webhook_material
          where retired_at is null and key_id = any($1::text[])
          order by tenant_id, connection_id
          limit $2
          for update skip locked`,
        [previousKeyIds, limit],
      );
      let rewrapped = 0;
      for (const row of selected.rows) {
        const previousKey = this.encryptionKeys.get(row.key_id);
        if (!previousKey) throw new Error("deputy_webhook_key_version_unavailable");
        const aad = associatedData(row.tenant_id, row.connection_id, row.material_id);
        const plaintext = await openSecret({
          envelope: {
            version: Number(row.envelope_version) as 1,
            algorithm: row.algorithm,
            keyId: row.key_id,
            iv: row.iv,
            ciphertext: row.ciphertext,
          },
          encodedKey: previousKey,
          associatedData: aad,
        });
        parseDeputyWebhookVerificationMaterial(JSON.parse(plaintext));
        const rotated = await sealSecret({
          plaintext,
          encodedKey: this.encryptionKey,
          keyId: this.keyId,
          associatedData: aad,
        });
        const updated = await client.query(
          `update control_plane.deputy_webhook_material
              set envelope_version = $5, algorithm = $6, key_id = $7,
                  iv = $8, ciphertext = $9
            where tenant_id = $1 and connection_id = $2 and material_id = $3
              and key_id = $4 and retired_at is null
          returning material_id`,
          [
            row.tenant_id,
            row.connection_id,
            row.material_id,
            row.key_id,
            rotated.version,
            rotated.algorithm,
            rotated.keyId,
            rotated.iv,
            rotated.ciphertext,
          ],
        );
        if (!updated.rows[0]) throw new Error("deputy_webhook_material_changed");
        await client.query(
          `insert into control_plane.audit_log (
             tenant_id, audit_id, actor_type, action, resource_type, resource_id,
             audit_metadata
           ) values ($1, $2, 'service', 'deputy.webhook_material_rewrapped',
             'connection', $3, jsonb_build_object(
               'from_key_id', $4::text, 'to_key_id', $5::text
             ))`,
          [row.tenant_id, ulid(), row.connection_id, row.key_id, this.keyId],
        );
        rewrapped += 1;
      }
      return rewrapped;
    });
  }

  async markFailure(
    prepared: PreparedDeputyWebhook,
    failure: ReturnType<typeof safeFailure>,
  ): Promise<void> {
    await this.db.transaction(async (client) => {
      const updated = await client.query(
        `update control_plane.deputy_webhook_material
            set setup_status = $5, last_error_code = $6
          where tenant_id = $1 and connection_id = $2 and material_id = $3
            and attempt_count = $4
            and retired_at is null
        returning material_id`,
        [
          prepared.tenantId,
          prepared.connectionId,
          prepared.materialId,
          prepared.attemptCount,
          failure.status,
          failure.reasonCode,
        ],
      );
      if (!updated.rows[0]) throw new Error("deputy_webhook_material_changed");
      await this.updateConnectionState(client, prepared, "degraded", failure.status, failure.reasonCode);
      await this.audit(client, prepared, "deputy.webhooks_setup_blocked", {
        reason_code: failure.reasonCode,
      });
    });
  }

  private async updateConnectionState(
    client: PostgresQueryClient,
    prepared: PreparedDeputyWebhook,
    status: "connected" | "degraded",
    setupStatus: string,
    reasonCode: string | null,
  ): Promise<void> {
    await client.query(
      `update control_plane.connections
          set status = $3,
              account_metadata = coalesce(account_metadata, '{}'::jsonb)
                || jsonb_build_object('webhook_setup', jsonb_build_object(
                  'status', $4::text,
                  'reason_code', $5::text,
                  'recoverable', true,
                  'updated_at', now()
                ))
        where tenant_id = $1 and connection_id = $2 and connector_key = 'deputy'`,
      [prepared.tenantId, prepared.connectionId, status, setupStatus, reasonCode],
    );
  }

  private async audit(
    client: PostgresQueryClient,
    prepared: PreparedDeputyWebhook,
    action: string,
    metadata: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await client.query(
      `insert into control_plane.audit_log (
         tenant_id, audit_id, actor_type, action, resource_type, resource_id,
         audit_metadata
       ) values ($1, $2, 'service', $3, 'connection', $4, $5::jsonb)`,
      [prepared.tenantId, ulid(), action, prepared.connectionId, JSON.stringify(metadata)],
    );
  }
}

export class DeputyWebhookSetupCoordinator {
  constructor(private readonly store: DeputyWebhookMaterialStore) {}

  async provision(input: Readonly<{
    connector: DeputyConnector;
    context: ConnectorContext;
  }>): Promise<DeputyWebhookSetupResult> {
    const prepared = await this.store.prepare(input.context.tenantId, input.context.connectionId);
    try {
      const installed = await input.connector.provision_webhooks(input.context, {
        callbackUrl: prepared.callbackUrl,
        customHeaderSecret: prepared.material.customHeaderSecret,
      });
      await this.store.markActive(prepared, installed.vendorWebhookIds);
      return Object.freeze({
        state: "active",
        provisionedTopics: Object.freeze(Object.keys(installed.vendorWebhookIds).sort()),
      });
    } catch (error) {
      const failure = safeFailure(error);
      await this.store.markFailure(prepared, failure);
      return Object.freeze({
        state: failure.state,
        reasonCode: failure.reasonCode,
        provisionedTopics: Object.freeze([]),
      });
    }
  }
}
