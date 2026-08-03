import type {
  CredentialRefreshLeaseContext,
  CredentialRefreshLeaseProof,
  OAuthCredentialSecret,
  VersionedCredential,
  WorkerCredentialVault,
} from "../../../packages/connector-sdk/src/index.js";
import type { TransactionalPostgres } from "../../sync-workers/src/database.js";
import {
  type EnvelopeCryptography,
  parseOAuthCredentialSecret,
} from "../../sync-workers/src/credential-vault.js";
import {
  DurableCredentialRefreshLeaseCoordinator,
  type CredentialRefreshLeaseGrant,
  type CredentialRefreshLeaseStore,
} from "../../sync-workers/src/credential-refresh-lease.js";
import { asDeletionControl } from "./database-role.js";
import type { DeletionClaim } from "./store.js";

type CredentialRow = Readonly<{
  secret_reference: string;
  credential_version: string | number;
  algorithm: "AES-256-GCM";
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  authentication_tag: Uint8Array;
  wrapped_data_key: Uint8Array;
  key_reference: string;
  key_version: string;
  aad_digest: string;
}>;

function bytes(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}

function nonNegativeInteger(value: string | number | bigint, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name}_invalid`);
  return parsed;
}

class DeletionCredentialRefreshLeaseStore implements CredentialRefreshLeaseStore {
  constructor(
    private readonly database: TransactionalPostgres,
    private readonly claim: DeletionClaim,
    private readonly workerId: string,
  ) {}

  private claimParameters(): readonly [number, string, string, number] {
    return [this.claim.messageId, this.claim.requestId, this.workerId, this.claim.readCount];
  }

  async acquire(
    credentialRef: string,
    leaseId: string,
    leaseDurationMs: number,
  ): Promise<CredentialRefreshLeaseGrant> {
    const result = await asDeletionControl(this.database, (client) => client.query<{
      acquired: boolean;
      fencing_token: string | number | bigint | null;
      retry_after_ms: string | number | bigint;
    }>(
      "select * from control_plane.acquire_deletion_credential_refresh_lease($1,$2,$3,$4,$5,$6,$7)",
      [...this.claimParameters(), credentialRef, leaseId, leaseDurationMs],
    ));
    const row = result.rows[0];
    if (!row) throw new Error("credential_refresh_lease_result_missing");
    return Object.freeze({
      acquired: row.acquired,
      ...(row.fencing_token === null ? {} : { fencingToken: String(row.fencing_token) }),
      retryAfterMs: nonNegativeInteger(row.retry_after_ms, "credential_refresh_retry_after"),
    });
  }

  async extend(
    credentialRef: string,
    proof: CredentialRefreshLeaseProof,
    leaseDurationMs: number,
  ): Promise<boolean> {
    const result = await asDeletionControl(this.database, (client) => client.query<{
      extended: boolean;
    }>(
      `select control_plane.extend_deletion_credential_refresh_lease(
         $1,$2,$3,$4,$5,$6,$7::bigint,$8
       ) as extended`,
      [
        ...this.claimParameters(), credentialRef, proof.leaseId,
        proof.fencingToken, leaseDurationMs,
      ],
    ));
    return result.rows[0]?.extended === true;
  }

  async release(
    credentialRef: string,
    proof: CredentialRefreshLeaseProof,
  ): Promise<boolean> {
    const result = await asDeletionControl(this.database, (client) => client.query<{
      released: boolean;
    }>(
      `select control_plane.release_deletion_credential_refresh_lease(
         $1,$2,$3,$4,$5,$6,$7::bigint
       ) as released`,
      [...this.claimParameters(), credentialRef, proof.leaseId, proof.fencingToken],
    ));
    return result.rows[0]?.released === true;
  }
}

/**
 * A claim-bound vault used only while a fenced deletion lease is active.
 * Every SQL function independently proves the credential belongs to that
 * deletion scope, so the worker login cannot enumerate or mutate other rows.
 */
export class DeletionCredentialVault implements WorkerCredentialVault {
  private readonly refreshLeases: DurableCredentialRefreshLeaseCoordinator;

  constructor(
    private readonly database: TransactionalPostgres,
    private readonly cryptography: EnvelopeCryptography,
    private readonly claim: DeletionClaim,
    private readonly workerId: string,
  ) {
    this.refreshLeases = new DurableCredentialRefreshLeaseCoordinator(
      new DeletionCredentialRefreshLeaseStore(database, claim, workerId),
    );
  }

  create(): Promise<VersionedCredential> {
    return Promise.reject(new Error("deletion_credential_create_forbidden"));
  }

  async read(credentialRef: string): Promise<VersionedCredential> {
    const result = await asDeletionControl(this.database, (client) => client.query<CredentialRow>(
      `select * from control_plane.read_deletion_credential($1,$2,$3,$4,$5)`,
      [
        this.claim.messageId,
        this.claim.requestId,
        this.workerId,
        this.claim.readCount,
        credentialRef,
      ],
    ));
    const row = result.rows[0];
    if (!row) throw new Error("credential_not_found");
    const version = Number(row.credential_version);
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new Error("credential_revision_invalid");
    }
    const plaintext = await this.cryptography.open({
      algorithm: row.algorithm,
      ciphertext: bytes(row.ciphertext),
      nonce: bytes(row.nonce),
      authenticationTag: bytes(row.authentication_tag),
      wrappedDataKey: bytes(row.wrapped_data_key),
      keyReference: row.key_reference,
      keyVersion: row.key_version,
      aadDigest: row.aad_digest,
    }, {
      tenantId: this.claim.tenantId,
      secretReference: row.secret_reference,
      version,
    });
    return Object.freeze({
      credentialRef: row.secret_reference,
      revision: String(version),
      secret: parseOAuthCredentialSecret(JSON.parse(plaintext)),
    });
  }

  async compareAndSwap(
    credentialRef: string,
    expectedRevision: string,
    secret: OAuthCredentialSecret,
    refreshLease?: CredentialRefreshLeaseProof,
  ): Promise<VersionedCredential> {
    if (!/^[1-9][0-9]*$/.test(expectedRevision)) {
      throw new Error("credential_revision_invalid");
    }
    if (!refreshLease) throw new Error("credential_refresh_lease_required");
    const expectedVersion = Number(expectedRevision);
    if (!Number.isSafeInteger(expectedVersion)) throw new Error("credential_revision_invalid");
    const nextVersion = expectedVersion + 1;
    const envelope = await this.cryptography.seal(JSON.stringify(secret), {
      tenantId: this.claim.tenantId,
      secretReference: credentialRef,
      version: nextVersion,
    });
    const parameters = [
      this.claim.messageId,
      this.claim.requestId,
      this.workerId,
      this.claim.readCount,
      credentialRef,
      expectedVersion,
      envelope.algorithm,
      Buffer.from(envelope.ciphertext),
      Buffer.from(envelope.nonce),
      Buffer.from(envelope.authenticationTag),
      Buffer.from(envelope.wrappedDataKey),
      envelope.keyReference,
      envelope.keyVersion,
      envelope.aadDigest,
      [...secret.scopes],
      secret.expiresAt,
    ] as const;
    const result = await asDeletionControl(this.database, (client) =>
      client.query<{ credential_version: string | number }>(
        `select control_plane.rotate_deletion_credential_under_refresh_lease(
          $1,$2,$3,$4,$5,$6,$7,$8::bytea,$9::bytea,$10::bytea,$11::bytea,
          $12,$13,$14,$15::text[],$16::timestamptz,$17,$18::bigint
        ) credential_version`,
        [...parameters, refreshLease.leaseId, refreshLease.fencingToken],
      ));
    const storedVersion = Number(result.rows[0]?.credential_version);
    if (storedVersion !== nextVersion) throw new Error("credential_rotation_result_invalid");
    return Object.freeze({ credentialRef, revision: String(storedVersion), secret });
  }

  withRefreshLease<T>(
    credentialRef: string,
    operation: (lease: CredentialRefreshLeaseContext) => Promise<T>,
    abortSignal?: AbortSignal,
  ): Promise<T> {
    return this.refreshLeases.withLease(credentialRef, operation, abortSignal);
  }

  async destroy(credentialRef: string): Promise<void> {
    await asDeletionControl(this.database, (client) => client.query(
      "select control_plane.destroy_one_deletion_credential($1,$2,$3,$4,$5)",
      [
        this.claim.messageId,
        this.claim.requestId,
        this.workerId,
        this.claim.readCount,
        credentialRef,
      ],
    ));
  }
}
