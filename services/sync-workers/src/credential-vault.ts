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

export interface RotatingDataKeyWrapper extends DataKeyWrapper {
  readonly currentKeyReference: string;
  readonly currentKeyVersion: string;
  readonly loadedKeyVersions: ReadonlySet<string>;
  canUnwrap(input: Pick<WrappedDataKey, "keyReference" | "keyVersion">): boolean;
  rewrap(input: WrappedDataKey): Promise<WrappedDataKey>;
  assertCanUnwrap(input: WrappedDataKey): Promise<void>;
}

const CANONICAL_BASE64URL_256 = /^[A-Za-z0-9_-]{43}$/u;

function decodeCanonicalKek(encodedKey: string): Uint8Array<ArrayBuffer> {
  if (!CANONICAL_BASE64URL_256.test(encodedKey)) {
    throw new Error("A token encryption key must be an unpadded base64url-encoded 256-bit KEK.");
  }
  const decoded = Buffer.from(encodedKey, "base64url");
  if (decoded.byteLength !== 32 || decoded.toString("base64url") !== encodedKey) {
    throw new Error("A token encryption key must be an unpadded base64url-encoded 256-bit KEK.");
  }
  return webBytes(decoded);
}

/**
 * AES-KW keyring with one write key and a bounded, decrypt-only overlap set.
 * Key IDs are the persisted envelope key versions. All keys share the stable
 * logical key reference; a changed reference is treated as unavailable rather
 * than silently trying unrelated key material.
 */
export class AesKeyringWrapper implements RotatingDataKeyWrapper {
  private readonly keyBytesByVersion: ReadonlyMap<string, Uint8Array<ArrayBuffer>>;
  readonly loadedKeyVersions: ReadonlySet<string>;

  constructor(input: Readonly<{
    currentKeyReference: string;
    currentKeyVersion: string;
    encodedKeys: ReadonlyMap<string, string>;
  }>) {
    if (!input.currentKeyReference.trim() || !input.currentKeyVersion.trim()) {
      throw new Error("Envelope key reference and version are required.");
    }
    if (!input.encodedKeys.has(input.currentKeyVersion)) {
      throw new Error("The token keyring does not contain its current key ID.");
    }
    if (input.encodedKeys.size < 1 || input.encodedKeys.size > 5) {
      throw new Error("The token keyring must contain one current and at most four overlap keys.");
    }
    const decoded = new Map<string, Uint8Array<ArrayBuffer>>();
    const material = new Set<string>();
    for (const [keyVersion, encodedKey] of input.encodedKeys) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(keyVersion)) {
        throw new Error("A token encryption key ID is invalid.");
      }
      const keyBytes = decodeCanonicalKek(encodedKey);
      const canonical = Buffer.from(keyBytes).toString("base64url");
      if (material.has(canonical)) {
        throw new Error("Token encryption key material must not be reused under another key ID.");
      }
      material.add(canonical);
      decoded.set(keyVersion, keyBytes);
    }
    this.currentKeyReference = input.currentKeyReference;
    this.currentKeyVersion = input.currentKeyVersion;
    this.keyBytesByVersion = decoded;
    this.loadedKeyVersions = new Set(decoded.keys());
  }

  readonly currentKeyReference: string;
  readonly currentKeyVersion: string;

  private importKek(keyVersion: string, usages: KeyUsage[]) {
    const keyBytes = this.keyBytesByVersion.get(keyVersion);
    if (!keyBytes) throw new Error("credential_kek_unavailable");
    return crypto.subtle.importKey("raw", keyBytes, "AES-KW", false, usages);
  }

  canUnwrap(input: Pick<WrappedDataKey, "keyReference" | "keyVersion">): boolean {
    return input.keyReference === this.currentKeyReference &&
      this.keyBytesByVersion.has(input.keyVersion);
  }

  async wrap(rawDataKey: Uint8Array): Promise<WrappedDataKey> {
    if (rawDataKey.byteLength !== 32) throw new Error("A credential DEK must contain 32 bytes.");
    const [kek, dek] = await Promise.all([
      this.importKek(this.currentKeyVersion, ["wrapKey"]),
      crypto.subtle.importKey("raw", webBytes(rawDataKey), "AES-GCM", true, ["encrypt", "decrypt"]),
    ]);
    const wrapped = await crypto.subtle.wrapKey("raw", dek, kek, "AES-KW");
    return {
      wrappedDataKey: new Uint8Array(wrapped),
      keyReference: this.currentKeyReference,
      keyVersion: this.currentKeyVersion,
    };
  }

  async unwrap(input: WrappedDataKey): Promise<Uint8Array> {
    if (!this.canUnwrap(input)) throw new Error("credential_kek_unavailable");
    const kek = await this.importKek(input.keyVersion, ["unwrapKey"]);
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

  async assertCanUnwrap(input: WrappedDataKey): Promise<void> {
    const rawDataKey = await this.unwrap(input);
    rawDataKey.fill(0);
  }

  async rewrap(input: WrappedDataKey): Promise<WrappedDataKey> {
    if (
      input.keyReference === this.currentKeyReference &&
      input.keyVersion === this.currentKeyVersion
    ) {
      return input;
    }
    const rawDataKey = await this.unwrap(input);
    try {
      return await this.wrap(rawDataKey);
    } finally {
      rawDataKey.fill(0);
    }
  }
}

/**
 * AES-KW adapter for a 256-bit key-encryption-key held in the worker secret
 * manager. The KEK never encrypts credential data directly; every secret gets
 * an independent cryptographically random DEK.
 */
export class AesKeyWrapper extends AesKeyringWrapper {
  constructor(
    encodedKey: string,
    keyReference: string,
    keyVersion: string,
  ) {
    super({
      currentKeyReference: keyReference,
      currentKeyVersion: keyVersion,
      encodedKeys: new Map([[keyVersion, encodedKey]]),
    });
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

  /**
   * Rotate only the random DEK wrapping. Credential ciphertext and its binding
   * are returned byte-for-byte unchanged and OAuth plaintext is never opened.
   */
  async rewrapDataKey(envelope: SealedEnvelope): Promise<SealedEnvelope> {
    const wrapper = this.keyWrapper as Partial<RotatingDataKeyWrapper>;
    if (typeof wrapper.rewrap !== "function") {
      throw new Error("credential_kek_rotation_unsupported");
    }
    const wrapped = await wrapper.rewrap({
      wrappedDataKey: envelope.wrappedDataKey,
      keyReference: envelope.keyReference,
      keyVersion: envelope.keyVersion,
    });
    return Object.freeze({
      ...envelope,
      wrappedDataKey: wrapped.wrappedDataKey,
      keyReference: wrapped.keyReference,
      keyVersion: wrapped.keyVersion,
    });
  }
}

export function parseOAuthCredentialSecret(value: unknown): OAuthCredentialSecret {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Decrypted OAuth credential is invalid.");
  }
  const candidate = value as Partial<OAuthCredentialSecret>;
  if (
    !["lightspeed-r", "lightspeed-x", "xero", "deputy", "square", "shopify", "stripe", "momence", "meta-ads", "google-ads"].includes(String(candidate.provider)) ||
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
