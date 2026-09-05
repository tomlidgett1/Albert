import type { ConnectorId } from "./index.js";
import type { ConnectorManifest } from "./contract.js";
import { ConnectorError } from "./errors.js";
import { credentialExpiresSoon } from "./oauth.js";
import type {
  CredentialRefreshLeaseProof,
  OAuthCredentialSecret,
  VersionedCredential,
  WorkerCredentialVault,
} from "./oauth.js";
import type {
  ConnectorCapability,
  ConnectorContext,
  ConnectorStream,
  ReconciliationRequest,
  SyncCursor,
  SyncPage,
  SyncRange,
  WebhookDisposition,
  WebhookEnvelope,
} from "./index.js";

/**
 * Shared behaviour for packs that authorise a vendor but declare no stream.
 *
 * Every extraction entry point fails closed rather than returning an empty
 * page: downstream, an empty page reads as "synced, found nothing", which is a
 * false coverage claim. Centralising it means a new authorization-only pack
 * cannot accidentally implement a permissive `initial_sync`, and the invariant
 * is asserted once instead of per connector.
 */
export abstract class AuthorizationOnlyConnectorPack {
  abstract readonly id: ConnectorId;
  abstract readonly manifest: ConnectorManifest;

  protected abstract readonly vault: WorkerCredentialVault;
  protected abstract readonly clock: () => number;

  private readonly refreshes = new Map<string, Promise<VersionedCredential>>();

  get version(): string {
    return this.manifest.packVersion;
  }

  get apiVersion(): string {
    return this.manifest.apiVersion;
  }

  async list_streams(context: ConnectorContext): Promise<readonly ConnectorStream[]> {
    void context;
    return [];
  }

  async describe_capabilities(context: ConnectorContext): Promise<readonly ConnectorCapability[]> {
    void context;
    // No stream means no capability may be published. An empty list keeps the
    // readiness surface honest rather than implying unknown-but-coming cover.
    return [];
  }

  async initial_sync(
    context: ConnectorContext,
    stream: ConnectorStream,
    range: SyncRange,
    cursor?: SyncCursor,
  ): Promise<SyncPage> {
    void context; void range; void cursor;
    return this.refuseStream(stream);
  }

  async incremental_sync(
    context: ConnectorContext,
    stream: ConnectorStream,
    cursor: SyncCursor,
  ): Promise<SyncPage> {
    void context; void cursor;
    return this.refuseStream(stream);
  }

  async reconciliation_sync(
    context: ConnectorContext,
    stream: ConnectorStream,
    request: ReconciliationRequest,
  ): Promise<SyncPage> {
    void context; void request;
    return this.refuseStream(stream);
  }

  async handle_webhook(
    context: ConnectorContext,
    event: WebhookEnvelope,
  ): Promise<WebhookDisposition> {
    void context; void event;
    return { accepted: false, streams: [], reason: `${this.id}_authorization_only_pack` };
  }

  async refresh_credentials(context: ConnectorContext): Promise<{ credentialRef: string }> {
    const current = await this.readCredential(context);
    return { credentialRef: (await this.refreshCredential(current, context.abortSignal)).credentialRef };
  }

  protected refuseStream(stream: ConnectorStream): never {
    throw new ConnectorError(
      "CAPABILITY_UNAVAILABLE",
      `${this.id} is an authorization-only pack and declares no stream (requested: ${stream.id}).`,
    );
  }

  protected async readCredential(context: ConnectorContext): Promise<VersionedCredential> {
    const credential = await this.vault.read(context.credentialRef);
    if (credential.secret.provider !== this.id) {
      throw new ConnectorError("CONFIGURATION_INVALID", `Credential provider does not match ${this.id}.`);
    }
    return credential;
  }

  protected async validCredential(context: ConnectorContext): Promise<VersionedCredential> {
    const credential = await this.readCredential(context);
    return credentialExpiresSoon(credential.secret, this.clock())
      ? this.refreshCredential(credential, context.abortSignal)
      : credential;
  }

  /**
   * Vendor-specific token renewal. Implementations return the next secret; the
   * lease, single-flight and compare-and-swap handling stays here so no pack
   * can rotate a credential without the durable guard.
   */
  protected abstract renewCredential(
    current: VersionedCredential,
    signal?: AbortSignal,
  ): Promise<OAuthCredentialSecret>;

  protected async refreshCredential(
    current: VersionedCredential,
    signal?: AbortSignal,
  ): Promise<VersionedCredential> {
    const existing = this.refreshes.get(current.credentialRef);
    if (existing) return existing;
    const promise = this.vault.withRefreshLease(
      current.credentialRef,
      async (lease) => {
        const latest = await this.vault.read(current.credentialRef);
        if (latest.secret.provider !== this.id) {
          throw new ConnectorError("CONFIGURATION_INVALID", `Credential provider does not match ${this.id}.`);
        }
        // Another worker already rotated it; adopt theirs rather than racing.
        if (latest.revision !== current.revision) return latest;
        return this.commitRefresh(latest, lease.abortSignal, lease.proof);
      },
      signal,
    ).finally(() => this.refreshes.delete(current.credentialRef));
    this.refreshes.set(current.credentialRef, promise);
    return promise;
  }

  private async commitRefresh(
    current: VersionedCredential,
    signal?: AbortSignal,
    refreshLease?: CredentialRefreshLeaseProof,
  ): Promise<VersionedCredential> {
    const next = await this.renewCredential(current, signal);
    try {
      signal?.throwIfAborted();
      return await this.vault.compareAndSwap(current.credentialRef, current.revision, next, refreshLease);
    } catch (cause) {
      const latest = await this.vault.read(current.credentialRef);
      if (!credentialExpiresSoon(latest.secret, this.clock())) return latest;
      throw new ConnectorError("CREDENTIAL_CONFLICT", `Concurrent ${this.id} token rotation failed.`, {
        cause,
        retryable: true,
      });
    }
  }
}

/**
 * Builds a manifest for a pack that authorises but never extracts. Streams,
 * capabilities, field coverage and source authority are empty *by
 * construction* rather than by convention, so an authorization-only pack
 * cannot drift into claiming coverage it has no stream to support.
 */
export function authorizationOnlyManifest(input: Readonly<{
  id: ConnectorId;
  displayName: string;
  packVersion: string;
  apiVersion: string;
  releasedAt: string;
  documentation: readonly string[];
  scopes: readonly string[];
  leastPrivilegeNotes: readonly string[];
  refreshTokenRotation: boolean;
  remoteRevocation: "supported" | "not_documented";
  concurrency?: number;
  responseHeaders?: readonly string[];
  identityRules: readonly string[];
  topology: readonly string[];
  qualityAssertions: readonly string[];
  limitations: readonly string[];
}>): ConnectorManifest {
  return {
    id: input.id,
    displayName: input.displayName,
    packVersion: input.packVersion,
    apiVersion: input.apiVersion,
    releasedAt: input.releasedAt,
    documentation: input.documentation,
    ingestion: { initialStart: "automatic" },
    oauth: {
      scopes: input.scopes,
      leastPrivilegeNotes: input.leastPrivilegeNotes,
      refreshTokenRotation: input.refreshTokenRotation,
      remoteRevocation: input.remoteRevocation,
    },
    streams: [],
    sourceAuthority: { defaults: [] },
    rateLimit: {
      algorithm: "vendor_response_directed_backoff",
      concurrency: input.concurrency ?? 2,
      responseHeaders: input.responseHeaders ?? ["Retry-After"],
      reservations: [],
    },
    capabilities: {},
    identityRules: input.identityRules,
    topology: [
      "Authorization only. The pack exchanges, refreshes and revokes credentials and reads account identity; it enqueues no sync job and writes no source record.",
      ...input.topology,
    ],
    fieldCoverage: [],
    qualityAssertions: [
      "The pack declares no stream, so no coverage, freshness or completeness claim can be made from this connection.",
      ...input.qualityAssertions,
    ],
    limitations: [
      "No data is extracted, staged or projected. A connected account contributes nothing to an answer and must not be treated as coverage for any question.",
      ...input.limitations,
    ],
    unknownFieldPolicy: "quarantine_schema_drift",
  };
}

/** Shared guard: vendors return absolute expiries in several shapes. */
export function absoluteExpiry(value: string, connectorId: string, label: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ConnectorError("REMOTE_RESPONSE_INVALID", `${connectorId} returned an unparseable ${label}.`);
  }
  return new Date(parsed).toISOString();
}
