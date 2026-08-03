import { ulid } from "ulid";

import type { PostgresQueryClient } from "../../../packages/queue/src/index.js";
import type { TransactionalPostgres } from "./database.js";
import type {
  RotatingDataKeyWrapper,
  WrappedDataKey,
} from "./credential-vault.js";

export type OAuthKekEnvelopeScope = "credential" | "oauth_session";

export type ActiveOAuthKekUsage = Readonly<{
  scope: OAuthKekEnvelopeScope;
  keyReference: string;
  keyVersion: string;
  wrappedDataKey: Uint8Array;
  activeCount: number;
}>;

export type OAuthKekRewrapCandidate = Readonly<{
  scope: OAuthKekEnvelopeScope;
  tenantId: string;
  envelopeId: string;
  resourceId: string;
  credentialVersion: number;
  wrappedDataKey: Uint8Array;
  keyReference: string;
  keyVersion: string;
}>;

export type OAuthKekRewrapCounts = Readonly<{
  credentials: number;
  oauthSessions: number;
}>;

export interface OAuthTokenKekRotationStore {
  inspectActiveKeyUsage(): Promise<readonly ActiveOAuthKekUsage[]>;
  rewrapBatch(input: Readonly<{
    currentKeyReference: string;
    currentKeyVersion: string;
    limit: number;
    rewrap: (candidate: OAuthKekRewrapCandidate) => Promise<WrappedDataKey>;
  }>): Promise<OAuthKekRewrapCounts>;
}

type ActiveUsageRow = Readonly<{
  envelope_scope: OAuthKekEnvelopeScope;
  key_reference: string;
  key_version: string;
  wrapped_data_key: Uint8Array;
  active_count: number | string;
}>;

type CandidateRow = Readonly<{
  tenant_id: string;
  envelope_id: string;
  resource_id: string;
  credential_version: number | string;
  wrapped_data_key: Uint8Array;
  key_reference: string;
  key_version: string;
}>;

function positiveInteger(value: number | string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${label}_invalid`);
  return parsed;
}

function candidate(scope: OAuthKekEnvelopeScope, row: CandidateRow): OAuthKekRewrapCandidate {
  return Object.freeze({
    scope,
    tenantId: row.tenant_id,
    envelopeId: row.envelope_id,
    resourceId: row.resource_id,
    credentialVersion: positiveInteger(row.credential_version, "credential_version"),
    wrappedDataKey: new Uint8Array(row.wrapped_data_key),
    keyReference: row.key_reference,
    keyVersion: row.key_version,
  });
}

/**
 * The database implementation performs online, row-fenced rewraps. It updates
 * only the wrapped DEK and KEK locator fields; OAuth ciphertext and its
 * nonce/tag/AAD/version never enter this code path.
 */
export class PostgresOAuthTokenKekRotationStore implements OAuthTokenKekRotationStore {
  constructor(private readonly db: TransactionalPostgres) {}

  async inspectActiveKeyUsage(): Promise<readonly ActiveOAuthKekUsage[]> {
    const result = await this.db.query<ActiveUsageRow>(
      `with active_envelopes as (
         select 'credential'::text as envelope_scope,
                oauth_secret_envelope_id as envelope_id,
                key_reference, key_version, wrapped_data_key
           from control_plane.oauth_secret_envelopes
          where retired_at is null
         union all
         select 'oauth_session'::text as envelope_scope,
                oauth_session_secret_id as envelope_id,
                key_reference, key_version, wrapped_data_key
           from control_plane.oauth_session_secret_envelopes
          where consumed_at is null and destroyed_at is null
       ), usage as (
         select envelope_scope, envelope_id, key_reference, key_version,
                wrapped_data_key,
                count(*) over (partition by envelope_scope, key_reference, key_version)
                  as active_count
           from active_envelopes
       )
       select distinct on (envelope_scope, key_reference, key_version)
              envelope_scope, key_reference, key_version, wrapped_data_key,
              active_count
         from usage
        order by envelope_scope, key_reference, key_version, envelope_id`,
    );
    return Object.freeze(result.rows.map((row) => Object.freeze({
      scope: row.envelope_scope,
      keyReference: row.key_reference,
      keyVersion: row.key_version,
      wrappedDataKey: new Uint8Array(row.wrapped_data_key),
      activeCount: positiveInteger(row.active_count, "active_kek_usage_count"),
    })));
  }

  async rewrapBatch(input: Readonly<{
    currentKeyReference: string;
    currentKeyVersion: string;
    limit: number;
    rewrap: (candidate: OAuthKekRewrapCandidate) => Promise<WrappedDataKey>;
  }>): Promise<OAuthKekRewrapCounts> {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500) {
      throw new Error("credential_kek_rewrap_limit_invalid");
    }
    return this.db.transaction(async (client) => {
      const credentials = await client.query<CandidateRow>(
        `select envelope.tenant_id,
                envelope.oauth_secret_envelope_id as envelope_id,
                envelope.token_ref_id as resource_id,
                envelope.credential_version,
                envelope.wrapped_data_key,
                envelope.key_reference,
                envelope.key_version
           from control_plane.oauth_secret_envelopes as envelope
           join control_plane.oauth_token_refs as token
             on token.tenant_id = envelope.tenant_id
            and token.token_ref_id = envelope.token_ref_id
          where envelope.retired_at is null
            and not (
              envelope.key_reference = $1 and envelope.key_version = $2
            )
          order by envelope.tenant_id, envelope.token_ref_id
          limit $3
          for update of token, envelope skip locked`,
        [input.currentKeyReference, input.currentKeyVersion, input.limit],
      );
      let credentialCount = 0;
      for (const row of credentials.rows) {
        await this.rewrapCredential(client, candidate("credential", row), input);
        credentialCount += 1;
      }

      const remaining = input.limit - credentialCount;
      let sessionCount = 0;
      if (remaining > 0) {
        const sessions = await client.query<CandidateRow>(
          `select envelope.tenant_id,
                  envelope.oauth_session_secret_id as envelope_id,
                  envelope.oauth_session_id as resource_id,
                  envelope.credential_version,
                  envelope.wrapped_data_key,
                  envelope.key_reference,
                  envelope.key_version
             from control_plane.oauth_session_secret_envelopes as envelope
            where envelope.consumed_at is null
              and envelope.destroyed_at is null
              and not (
                envelope.key_reference = $1 and envelope.key_version = $2
              )
            order by envelope.tenant_id, envelope.oauth_session_id,
                     envelope.secret_kind
            limit $3
            for update of envelope skip locked`,
          [input.currentKeyReference, input.currentKeyVersion, remaining],
        );
        for (const row of sessions.rows) {
          await this.rewrapSession(client, candidate("oauth_session", row), input);
          sessionCount += 1;
        }
      }
      return Object.freeze({ credentials: credentialCount, oauthSessions: sessionCount });
    });
  }

  private async rewrapCredential(
    client: PostgresQueryClient,
    row: OAuthKekRewrapCandidate,
    input: Readonly<{
      currentKeyReference: string;
      currentKeyVersion: string;
      rewrap: (candidate: OAuthKekRewrapCandidate) => Promise<WrappedDataKey>;
    }>,
  ): Promise<void> {
    const rotated = await input.rewrap(row);
    const updated = await client.query<{ oauth_secret_envelope_id: string }>(
      `update control_plane.oauth_secret_envelopes
          set wrapped_data_key = $4::bytea,
              key_reference = $5,
              key_version = $6
        where tenant_id = $1 and oauth_secret_envelope_id = $2
          and token_ref_id = $3 and retired_at is null
          and key_reference = $7 and key_version = $8
          and wrapped_data_key = $9::bytea
      returning oauth_secret_envelope_id`,
      [
        row.tenantId,
        row.envelopeId,
        row.resourceId,
        Buffer.from(rotated.wrappedDataKey),
        rotated.keyReference,
        rotated.keyVersion,
        row.keyReference,
        row.keyVersion,
        Buffer.from(row.wrappedDataKey),
      ],
    );
    if (!updated.rows[0]) throw new Error("credential_kek_rewrap_conflict");
    await client.query(
      `update control_plane.oauth_token_refs
          set encryption_key_version = $3
        where tenant_id = $1 and token_ref_id = $2`,
      [row.tenantId, row.resourceId, rotated.keyVersion],
    );
    await this.audit(client, row, rotated.keyVersion);
  }

  private async rewrapSession(
    client: PostgresQueryClient,
    row: OAuthKekRewrapCandidate,
    input: Readonly<{
      currentKeyReference: string;
      currentKeyVersion: string;
      rewrap: (candidate: OAuthKekRewrapCandidate) => Promise<WrappedDataKey>;
    }>,
  ): Promise<void> {
    const rotated = await input.rewrap(row);
    const updated = await client.query<{ oauth_session_secret_id: string }>(
      `update control_plane.oauth_session_secret_envelopes
          set wrapped_data_key = $4::bytea,
              key_reference = $5,
              key_version = $6
        where tenant_id = $1 and oauth_session_secret_id = $2
          and oauth_session_id = $3
          and consumed_at is null and destroyed_at is null
          and key_reference = $7 and key_version = $8
          and wrapped_data_key = $9::bytea
      returning oauth_session_secret_id`,
      [
        row.tenantId,
        row.envelopeId,
        row.resourceId,
        Buffer.from(rotated.wrappedDataKey),
        rotated.keyReference,
        rotated.keyVersion,
        row.keyReference,
        row.keyVersion,
        Buffer.from(row.wrappedDataKey),
      ],
    );
    if (!updated.rows[0]) throw new Error("credential_kek_rewrap_conflict");
    await this.audit(client, row, rotated.keyVersion);
  }

  private async audit(
    client: PostgresQueryClient,
    row: OAuthKekRewrapCandidate,
    targetKeyVersion: string,
  ): Promise<void> {
    await client.query(
      `insert into control_plane.audit_log (
         tenant_id, audit_id, actor_type, action, resource_type, resource_id,
         audit_metadata
       ) values (
         $1, $2, 'service', $3, $4, $5,
         jsonb_build_object(
           'from_key_id', $6::text,
           'to_key_id', $7::text,
           'credential_version', $8::integer,
           'wrapped_dek_only', true,
           'credential_ciphertext_changed', false,
           'aad_changed', false
         )
       )`,
      [
        row.tenantId,
        ulid(),
        row.scope === "credential"
          ? "oauth.credential_kek_rewrapped"
          : "oauth.session_kek_rewrapped",
        row.scope === "credential" ? "oauth_token_ref" : "oauth_session",
        row.resourceId,
        row.keyVersion,
        targetKeyVersion,
        row.credentialVersion,
      ],
    );
  }
}

export type OAuthTokenKekRotationHealth = Readonly<{
  ready: boolean;
  currentKeyVersion: string;
  loadedOverlapKeyCount: number;
  activeEnvelopeCount: number;
  pendingRewrapCount: number;
  missingKeyVersions: readonly string[];
  unreadableKeyVersions: readonly string[];
  lastRewrapAt: string | null;
  lastErrorCode: string | null;
}>;

function errorCode(error: unknown): string {
  if (!(error instanceof Error)) return "credential_kek_rotation_failed";
  return /^[a-z][a-z0-9_]{1,119}$/u.test(error.message)
    ? error.message
    : "credential_kek_rotation_failed";
}

function wait(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, delayMs);
    timer.unref();
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/** Coordinates readiness proof and the convergent online rewrap lifecycle. */
export class OAuthTokenKekRotationService {
  private running = false;
  private state: OAuthTokenKekRotationHealth;

  constructor(
    private readonly store: OAuthTokenKekRotationStore,
    private readonly wrapper: RotatingDataKeyWrapper,
  ) {
    this.state = Object.freeze({
      ready: false,
      currentKeyVersion: wrapper.currentKeyVersion,
      loadedOverlapKeyCount: Math.max(0, wrapper.loadedKeyVersions.size - 1),
      activeEnvelopeCount: 0,
      pendingRewrapCount: 0,
      missingKeyVersions: Object.freeze([]),
      unreadableKeyVersions: Object.freeze([]),
      lastRewrapAt: null,
      lastErrorCode: null,
    });
  }

  health(): OAuthTokenKekRotationHealth {
    return this.state;
  }

  async inspect(): Promise<OAuthTokenKekRotationHealth> {
    const usage = await this.store.inspectActiveKeyUsage();
    const missing = new Set<string>();
    const unreadable = new Set<string>();
    let activeEnvelopeCount = 0;
    let pendingRewrapCount = 0;
    for (const item of usage) {
      activeEnvelopeCount += item.activeCount;
      if (
        item.keyReference !== this.wrapper.currentKeyReference ||
        !this.wrapper.loadedKeyVersions.has(item.keyVersion)
      ) {
        missing.add(item.keyVersion);
        continue;
      }
      try {
        await this.wrapper.assertCanUnwrap({
          wrappedDataKey: item.wrappedDataKey,
          keyReference: item.keyReference,
          keyVersion: item.keyVersion,
        });
      } catch {
        unreadable.add(item.keyVersion);
      }
      if (
        item.keyReference !== this.wrapper.currentKeyReference ||
        item.keyVersion !== this.wrapper.currentKeyVersion
      ) {
        pendingRewrapCount += item.activeCount;
      }
    }
    const ready = missing.size === 0 && unreadable.size === 0;
    this.state = Object.freeze({
      ...this.state,
      ready,
      activeEnvelopeCount,
      pendingRewrapCount,
      missingKeyVersions: Object.freeze([...missing].sort()),
      unreadableKeyVersions: Object.freeze([...unreadable].sort()),
      ...(ready ? { lastErrorCode: null } : {}),
    });
    return this.state;
  }

  async assertReady(): Promise<void> {
    const health = await this.inspect();
    if (!health.ready) throw new Error("credential_kek_active_envelope_unavailable");
  }

  async rewrapBatch(limit = 100): Promise<Readonly<{
    credentials: number;
    oauthSessions: number;
    total: number;
    pendingRewrapCount: number;
  }>> {
    await this.assertReady();
    const counts = await this.store.rewrapBatch({
      currentKeyReference: this.wrapper.currentKeyReference,
      currentKeyVersion: this.wrapper.currentKeyVersion,
      limit,
      rewrap: (row) => this.wrapper.rewrap(row),
    });
    const total = counts.credentials + counts.oauthSessions;
    const inspected = await this.inspect();
    this.state = Object.freeze({
      ...inspected,
      lastRewrapAt: total > 0 ? new Date().toISOString() : inspected.lastRewrapAt,
      lastErrorCode: null,
    });
    return Object.freeze({ ...counts, total, pendingRewrapCount: inspected.pendingRewrapCount });
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.running) throw new Error("credential_kek_rotation_already_running");
    this.running = true;
    try {
      while (!signal.aborted) {
        try {
          const outcome = await this.rewrapBatch();
          await wait(outcome.pendingRewrapCount > 0 ? 250 : 30_000, signal);
        } catch (error) {
          this.state = Object.freeze({
            ...this.state,
            ready: false,
            lastErrorCode: errorCode(error),
          });
          await wait(5_000, signal);
        }
      }
    } finally {
      this.running = false;
    }
  }
}
