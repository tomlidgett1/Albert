import { createHash, randomBytes } from "node:crypto";
import { ulid } from "ulid";
import type {
  CredentialRefreshLeaseContext,
  CredentialRefreshLeaseProof,
  OAuthCredentialSecret,
  VersionedCredential,
  WorkerCredentialVault,
} from "../../../packages/connector-sdk/src/index.js";
import type { PostgresQueryClient } from "../../../packages/queue/src/index.js";
import {
  DurableCredentialRefreshLeaseCoordinator,
  PostgresCredentialRefreshLeaseStore,
} from "./credential-refresh-lease.js";
import type { TransactionalPostgres } from "./database.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function webBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  return webBytes(Buffer.from(value, "base64url"));
}

function concat(...values: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(values.reduce((total, value) => total + value.byteLength, 0));
  let offset = 0;
  for (const value of values) {
    result.set(value, offset);
    offset += value.byteLength;
  }
  return result;
}

export type WrappedDataKey = Readonly<{
  wrappedDataKey: Uint8Array;
  keyReference: string;
  keyVersion: string;
}>;

/** Production KMS/HSM adapters implement only random-DEK wrap and unwrap. */
export interface DataKeyWrapper {
  wrap(rawDataKey: Uint8Array): Promise<WrappedDataKey>;
  unwrap(input: WrappedDataKey): Promise<Uint8Array>;
}

/**
 * AES-KW adapter for a 256-bit key-encryption-key held in the worker secret
 * manager. The KEK never encrypts credential data directly; every secret gets
 * an independent cryptographically random DEK.
 */
export class AesKeyWrapper implements DataKeyWrapper {
  private readonly keyBytes: Uint8Array<ArrayBuffer>;

  constructor(
    encodedKey: string,
    private readonly keyReference: string,
    private readonly keyVersion: string,
  ) {
    this.keyBytes = base64UrlToBytes(encodedKey);
    if (this.keyBytes.byteLength !== 32) {
      throw new Error("TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes.");
    }
    if (!keyReference.trim() || !keyVersion.trim()) {
      throw new Error("Envelope key reference and version are required.");
    }
  }

  private importKek(usages: KeyUsage[]) {
    return crypto.subtle.importKey("raw", this.keyBytes, "AES-KW", false, usages);
  }

  async wrap(rawDataKey: Uint8Array): Promise<WrappedDataKey> {
    if (rawDataKey.byteLength !== 32) throw new Error("A credential DEK must contain 32 bytes.");
    const [kek, dek] = await Promise.all([
      this.importKek(["wrapKey"]),
      crypto.subtle.importKey("raw", webBytes(rawDataKey), "AES-GCM", true, ["encrypt", "decrypt"]),
    ]);
    const wrapped = await crypto.subtle.wrapKey("raw", dek, kek, "AES-KW");
    return {
      wrappedDataKey: new Uint8Array(wrapped),
      keyReference: this.keyReference,
      keyVersion: this.keyVersion,
    };
  }

  async unwrap(input: WrappedDataKey): Promise<Uint8Array> {
    if (input.keyReference !== this.keyReference || input.keyVersion !== this.keyVersion) {
      throw new Error("The configured key wrapper cannot unwrap this key version.");
    }
    const kek = await this.importKek(["unwrapKey"]);
    const dek = await crypto.subtle.unwrapKey(
      "raw",
      webBytes(input.wrappedDataKey),
      kek,
      "AES-KW",
      "AES-GCM",
      true,
      ["encrypt", "decrypt"],
    );
    return new Uint8Array(await crypto.subtle.exportKey("raw", dek));
  }
}

export type SealedEnvelope = Readonly<{
  algorithm: "AES-256-GCM";
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  authenticationTag: Uint8Array;
  wrappedDataKey: Uint8Array;
  keyReference: string;
  keyVersion: string;
  aadDigest: string;
}>;

function aad(tenantId: string, secretReference: string, version: number): Uint8Array<ArrayBuffer> {
  return webBytes(textEncoder.encode(
    JSON.stringify({ tenantId, secretReference, credentialVersion: version }),
  ));
}

export class EnvelopeCryptography {
  constructor(private readonly keyWrapper: DataKeyWrapper) {}

  async seal(
    plaintext: string,
    binding: Readonly<{ tenantId: string; secretReference: string; version: number }>,
  ): Promise<SealedEnvelope> {
    if (!plaintext) throw new Error("Cannot envelope-encrypt an empty secret.");
    const rawDek = webBytes(randomBytes(32));
    const nonce = webBytes(randomBytes(12));
    const associatedData = aad(binding.tenantId, binding.secretReference, binding.version);
    const [wrapped, dek] = await Promise.all([
      this.keyWrapper.wrap(rawDek),
      crypto.subtle.importKey("raw", rawDek, "AES-GCM", false, ["encrypt"]),
    ]);
    rawDek.fill(0);
    const encrypted = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: associatedData, tagLength: 128 },
      dek,
      webBytes(textEncoder.encode(plaintext)),
    ));
    if (encrypted.byteLength <= 16) throw new Error("Credential encryption produced no ciphertext.");
    return Object.freeze({
      algorithm: "AES-256-GCM",
      ciphertext: encrypted.slice(0, -16),
      authenticationTag: encrypted.slice(-16),
      nonce,
      wrappedDataKey: wrapped.wrappedDataKey,
      keyReference: wrapped.keyReference,
      keyVersion: wrapped.keyVersion,
      aadDigest: createHash("sha256").update(associatedData).digest("hex"),
    });
  }

  async open(
    envelope: SealedEnvelope,
    binding: Readonly<{ tenantId: string; secretReference: string; version: number }>,
  ): Promise<string> {
    if (envelope.algorithm !== "AES-256-GCM") throw new Error("Unsupported envelope algorithm.");
    const associatedData = aad(binding.tenantId, binding.secretReference, binding.version);
    const digest = createHash("sha256").update(associatedData).digest("hex");
    if (digest !== envelope.aadDigest) throw new Error("Credential envelope binding does not match.");
    const rawDek = await this.keyWrapper.unwrap({
      wrappedDataKey: envelope.wrappedDataKey,
      keyReference: envelope.keyReference,
      keyVersion: envelope.keyVersion,
    });
    try {
      const dek = await crypto.subtle.importKey("raw", webBytes(rawDek), "AES-GCM", false, ["decrypt"]);
      const decrypted = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: webBytes(envelope.nonce),
          additionalData: webBytes(associatedData),
          tagLength: 128,
        },
        dek,
        concat(envelope.ciphertext, envelope.authenticationTag),
      );
      return textDecoder.decode(decrypted);
    } finally {
      rawDek.fill(0);
    }
  }
}

export function parseOAuthCredentialSecret(value: unknown): OAuthCredentialSecret {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Decrypted OAuth credential is invalid.");
  }
  const candidate = value as Partial<OAuthCredentialSecret>;
  if (
    !["lightspeed-r", "xero", "deputy"].includes(String(candidate.provider)) ||
    typeof candidate.accessToken !== "string" || !candidate.accessToken ||
    Buffer.byteLength(candidate.accessToken, "utf8") > 65_536 ||
    (candidate.refreshToken !== undefined &&
      (typeof candidate.refreshToken !== "string" || !candidate.refreshToken ||
        Buffer.byteLength(candidate.refreshToken, "utf8") > 65_536)) ||
    candidate.tokenType !== "Bearer" ||
    typeof candidate.expiresAt !== "string" || Number.isNaN(Date.parse(candidate.expiresAt)) ||
    !Array.isArray(candidate.scopes) || candidate.scopes.length > 100 ||
    !candidate.scopes.every((scope) => typeof scope === "string" && scope.length <= 500) ||
    !candidate.metadata || typeof candidate.metadata !== "object" || Array.isArray(candidate.metadata)
  ) {
    throw new Error("Decrypted OAuth credential does not match the vault contract.");
  }
  return candidate as OAuthCredentialSecret;
}

function tokenMaterialChanged(
  current: OAuthCredentialSecret,
  next: OAuthCredentialSecret,
): boolean {
  return current.provider !== next.provider ||
    current.accessToken !== next.accessToken ||
    current.refreshToken !== next.refreshToken ||
    current.tokenType !== next.tokenType ||
    current.expiresAt !== next.expiresAt ||
    current.scopes.length !== next.scopes.length ||
    current.scopes.some((scope, index) => scope !== next.scopes[index]);
}

type EnvelopeRow = Readonly<{
  tenant_id: string;
  token_ref_id: string;
  connection_id: string;
  secret_reference: string;
  credential_version: number | string;
  algorithm: "AES-256-GCM";
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  authentication_tag: Uint8Array;
  wrapped_data_key: Uint8Array;
  key_reference: string;
  key_version: string;
  aad_digest: string;
}>;

function sealedFromRow(row: EnvelopeRow): SealedEnvelope {
  return {
    algorithm: row.algorithm,
    ciphertext: new Uint8Array(row.ciphertext),
    nonce: new Uint8Array(row.nonce),
    authenticationTag: new Uint8Array(row.authentication_tag),
    wrappedDataKey: new Uint8Array(row.wrapped_data_key),
    keyReference: row.key_reference,
    keyVersion: row.key_version,
    aadDigest: row.aad_digest,
  };
}

async function readActiveCredential(
  client: PostgresQueryClient,
  cryptography: EnvelopeCryptography,
  credentialRef: string,
): Promise<VersionedCredential> {
  const result = await client.query<EnvelopeRow>(
    `select token.tenant_id, token.token_ref_id, token.connection_id,
            token.secret_reference, envelope.credential_version,
            envelope.algorithm, envelope.ciphertext, envelope.nonce,
            envelope.authentication_tag, envelope.wrapped_data_key,
            envelope.key_reference, envelope.key_version, envelope.aad_digest
       from control_plane.oauth_token_refs as token
       join control_plane.oauth_secret_envelopes as envelope
         on envelope.tenant_id = token.tenant_id
        and envelope.token_ref_id = token.token_ref_id
        and envelope.retired_at is null
      where token.secret_reference = $1`,
    [credentialRef],
  );
  const row = result.rows[0];
  if (!row) throw new Error("credential_not_found");
  const version = Number(row.credential_version);
  const plaintext = await cryptography.open(sealedFromRow(row), {
    tenantId: row.tenant_id,
    secretReference: row.secret_reference,
    version,
  });
  return {
    credentialRef: row.secret_reference,
    revision: String(version),
    secret: parseOAuthCredentialSecret(JSON.parse(plaintext)),
  };
}

export class PostgresCredentialVault implements WorkerCredentialVault {
  private readonly refreshLeases: DurableCredentialRefreshLeaseCoordinator;

  constructor(
    private readonly db: TransactionalPostgres,
    private readonly cryptography: EnvelopeCryptography,
    private readonly binding?: Readonly<{ tenantId: string; connectionId: string }>,
  ) {
    this.refreshLeases = new DurableCredentialRefreshLeaseCoordinator(
      new PostgresCredentialRefreshLeaseStore(db),
    );
  }

  async create(secret: OAuthCredentialSecret): Promise<VersionedCredential> {
    if (!this.binding) throw new Error("credential_create_requires_connection_binding");
    const tokenRefId = ulid();
    const credentialRef = `oauth_${ulid()}`;
    const version = 1;
    const envelope = await this.cryptography.seal(JSON.stringify(secret), {
      tenantId: this.binding.tenantId,
      secretReference: credentialRef,
      version,
    });
    await this.db.transaction(async (client) => {
      await client.query(
        `insert into control_plane.oauth_token_refs (
           tenant_id, token_ref_id, connection_id, secret_reference,
           encryption_key_version, granted_scopes, token_expires_at, last_rotated_at
         ) values ($1, $2, $3, $4, $5, $6::text[], $7, now())`,
        [
          this.binding!.tenantId,
          tokenRefId,
          this.binding!.connectionId,
          credentialRef,
          envelope.keyVersion,
          [...secret.scopes],
          secret.expiresAt,
        ],
      );
      await insertOAuthEnvelope(client, {
        tenantId: this.binding!.tenantId,
        tokenRefId,
        version,
        envelope,
      });
    });
    return { credentialRef, revision: "1", secret };
  }

  read(credentialRef: string): Promise<VersionedCredential> {
    return readActiveCredential(this.db, this.cryptography, credentialRef);
  }

  async compareAndSwap(
    credentialRef: string,
    expectedRevision: string,
    secret: OAuthCredentialSecret,
    refreshLease?: CredentialRefreshLeaseProof,
  ): Promise<VersionedCredential> {
    if (!/^[1-9][0-9]*$/.test(expectedRevision)) throw new Error("credential_revision_invalid");
    const current = await this.db.query<EnvelopeRow>(
      `select token.tenant_id, token.token_ref_id, token.connection_id,
              token.secret_reference, envelope.credential_version,
              envelope.algorithm, envelope.ciphertext, envelope.nonce,
              envelope.authentication_tag, envelope.wrapped_data_key,
              envelope.key_reference, envelope.key_version, envelope.aad_digest
         from control_plane.oauth_token_refs as token
         join control_plane.oauth_secret_envelopes as envelope
           on envelope.tenant_id = token.tenant_id
          and envelope.token_ref_id = token.token_ref_id
          and envelope.retired_at is null
        where token.secret_reference = $1`,
      [credentialRef],
    );
    const snapshot = current.rows[0];
    if (!snapshot) throw new Error("credential_not_found");
    const currentVersion = Number(snapshot.credential_version);
    const currentPlaintext = await this.cryptography.open(sealedFromRow(snapshot), {
      tenantId: snapshot.tenant_id,
      secretReference: credentialRef,
      version: currentVersion,
    });
    const currentSecret = parseOAuthCredentialSecret(JSON.parse(currentPlaintext));
    if (tokenMaterialChanged(currentSecret, secret) && !refreshLease) {
      throw new Error("credential_refresh_lease_required");
    }
    const nextVersion = Number(expectedRevision) + 1;
    const envelope = await this.cryptography.seal(JSON.stringify(secret), {
      tenantId: snapshot.tenant_id,
      secretReference: credentialRef,
      version: nextVersion,
    });

    await this.db.transaction(async (client) => {
      if (refreshLease) {
        await client.query(
          "select control_plane.assert_credential_refresh_lease($1,$2,$3::bigint)",
          [credentialRef, refreshLease.leaseId, refreshLease.fencingToken],
        );
      }
      const locked = await client.query<{ credential_version: string | number }>(
        `select envelope.credential_version
           from control_plane.oauth_token_refs as token
           join control_plane.oauth_secret_envelopes as envelope
             on envelope.tenant_id = token.tenant_id
            and envelope.token_ref_id = token.token_ref_id
            and envelope.retired_at is null
          where token.secret_reference = $1
          for update of token, envelope`,
        [credentialRef],
      );
      if (String(locked.rows[0]?.credential_version) !== expectedRevision) {
        throw new Error("credential_revision_conflict");
      }
      await client.query(
        `update control_plane.oauth_secret_envelopes
            set retired_at = now()
          where tenant_id = $1 and token_ref_id = $2 and retired_at is null`,
        [snapshot.tenant_id, snapshot.token_ref_id],
      );
      await insertOAuthEnvelope(client, {
        tenantId: snapshot.tenant_id,
        tokenRefId: snapshot.token_ref_id,
        version: nextVersion,
        envelope,
      });
      await client.query(
        `update control_plane.oauth_token_refs
            set encryption_key_version = $3,
                granted_scopes = $4::text[],
                token_expires_at = $5,
                last_rotated_at = now()
          where tenant_id = $1 and token_ref_id = $2`,
        [
          snapshot.tenant_id,
          snapshot.token_ref_id,
          envelope.keyVersion,
          [...secret.scopes],
          secret.expiresAt,
        ],
      );
    });
    return { credentialRef, revision: String(nextVersion), secret };
  }

  withRefreshLease<T>(
    credentialRef: string,
    operation: (lease: CredentialRefreshLeaseContext) => Promise<T>,
    abortSignal?: AbortSignal,
  ): Promise<T> {
    return this.refreshLeases.withLease(credentialRef, operation, abortSignal);
  }

  async destroy(credentialRef: string): Promise<void> {
    await this.db.transaction(async (client) => {
      const result = await client.query<{
        tenant_id: string;
        token_ref_id: string;
        connection_id: string;
      }>(
        `select tenant_id, token_ref_id, connection_id
           from control_plane.oauth_token_refs
          where secret_reference = $1
          for update`,
        [credentialRef],
      );
      const row = result.rows[0];
      if (!row) return;
      await client.query(
        "delete from control_plane.oauth_token_refs where tenant_id = $1 and token_ref_id = $2",
        [row.tenant_id, row.token_ref_id],
      );
      await client.query(
        `insert into control_plane.audit_log (
           tenant_id, audit_id, actor_type, action, resource_type, resource_id,
           audit_metadata
         ) values ($1, $2, 'service', 'oauth.credential_destroyed', 'connection', $3, '{}'::jsonb)`,
        [row.tenant_id, ulid(), row.connection_id],
      );
    });
  }
}

async function insertOAuthEnvelope(
  client: PostgresQueryClient,
  input: Readonly<{
    tenantId: string;
    tokenRefId: string;
    version: number;
    envelope: SealedEnvelope;
  }>,
) {
  await client.query(
    `insert into control_plane.oauth_secret_envelopes (
       tenant_id, oauth_secret_envelope_id, token_ref_id, credential_version,
       algorithm, ciphertext, nonce, authentication_tag, wrapped_data_key,
       key_reference, key_version, aad_digest
     ) values ($1, $2, $3, $4, $5, $6::bytea, $7::bytea, $8::bytea, $9::bytea,
       $10, $11, $12)`,
    [
      input.tenantId,
      ulid(),
      input.tokenRefId,
      input.version,
      input.envelope.algorithm,
      Buffer.from(input.envelope.ciphertext),
      Buffer.from(input.envelope.nonce),
      Buffer.from(input.envelope.authenticationTag),
      Buffer.from(input.envelope.wrappedDataKey),
      input.envelope.keyReference,
      input.envelope.keyVersion,
      input.envelope.aadDigest,
    ],
  );
}

export class CredentialVaultFactory {
  constructor(
    private readonly db: TransactionalPostgres,
    private readonly cryptography: EnvelopeCryptography,
  ) {}

  forConnection(tenantId: string, connectionId: string): WorkerCredentialVault {
    return new PostgresCredentialVault(this.db, this.cryptography, { tenantId, connectionId });
  }

  reader(): WorkerCredentialVault {
    return new PostgresCredentialVault(this.db, this.cryptography);
  }
}
