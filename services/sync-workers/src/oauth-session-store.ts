import { createHash, randomBytes } from "node:crypto";
import { ulid } from "ulid";
import type {
  ConnectionDiscovery,
  CredentialRefreshLeaseContext,
  CredentialRefreshLeaseProof,
  OAuthCredentialSecret,
  VersionedCredential,
  WorkerCredentialVault,
} from "../../../packages/connector-sdk/src/index.js";
import type { PostgresQueryClient } from "../../../packages/queue/src/index.js";
import type { TransactionalPostgres } from "./database.js";
import {
  EnvelopeCryptography,
  parseOAuthCredentialSecret,
  type SealedEnvelope,
} from "./credential-vault.js";
import {
  DurableCredentialRefreshLeaseCoordinator,
  PostgresCredentialRefreshLeaseStore,
} from "./credential-refresh-lease.js";

type ActiveSessionStatus = "pending" | "selecting_account" | "exchanging";

function stateHash(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("oauth_state_hash_invalid");
  return value;
}

function safeAccountChoice(discovery: ConnectionDiscovery) {
  return Object.freeze({
    externalAccountId: discovery.externalAccountId.slice(0, 300),
    displayName: discovery.displayName.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 160),
    ...(discovery.baseUrl ? { baseUrl: new URL(discovery.baseUrl).origin } : {}),
    metadata: Object.fromEntries(
      Object.entries(discovery.metadata)
        .filter(([key, value]) =>
          /^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(key) &&
          (value === null || ["string", "number", "boolean"].includes(typeof value)),
        )
        .slice(0, 30)
        .map(([key, value]) => [key, typeof value === "string" ? value.slice(0, 300) : value]),
    ),
  });
}

export type SanitizedAccountChoice = ReturnType<typeof safeAccountChoice>;

type SessionEnvelopeRow = Readonly<{
  tenant_id: string;
  oauth_session_id: string;
  initiated_by: string;
  provider: "lightspeed-r" | "xero" | "deputy";
  state_nonce_hash: string;
  redirect_uri: string;
  requested_scopes: string[];
  status: ActiveSessionStatus;
  expires_at: string | Date;
  discovered_account_choices: SanitizedAccountChoice[] | null;
  selected_account_reference: string | null;
  secret_reference: string;
  secret_kind: "pkce_verifier" | "exchanged_credential";
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

function envelopeFromRow(row: SessionEnvelopeRow): SealedEnvelope {
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

async function insertSessionEnvelope(
  client: PostgresQueryClient,
  input: Readonly<{
    tenantId: string;
    sessionId: string;
    secretReference: string;
    kind: "pkce_verifier" | "exchanged_credential";
    version: number;
    envelope: SealedEnvelope;
  }>,
) {
  await client.query(
    `insert into control_plane.oauth_session_secret_envelopes (
       tenant_id, oauth_session_secret_id, oauth_session_id, secret_reference,
       secret_kind, credential_version, algorithm, ciphertext, nonce,
       authentication_tag, wrapped_data_key, key_reference, key_version, aad_digest
     ) values (
       $1, $2, $3, $4, $5, $6, $7, $8::bytea, $9::bytea, $10::bytea,
       $11::bytea, $12, $13, $14
     )`,
    [
      input.tenantId,
      ulid(),
      input.sessionId,
      input.secretReference,
      input.kind,
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

export type OAuthSessionContext = Readonly<{
  tenantId: string;
  oauthSessionId: string;
  initiatedBy: string;
  provider: "lightspeed-r" | "xero" | "deputy";
  redirectUri: string;
  requestedScopes: readonly string[];
  status: ActiveSessionStatus;
  expiresAt: string;
  codeVerifier: string;
  choices: readonly SanitizedAccountChoice[];
  selectedAccountReference: string | null;
}>;

export type OAuthCallbackReplay = Readonly<{
  provider: OAuthSessionContext["provider"];
  redirectUri: string;
}> & (
  | Readonly<{
      status: "selection_required";
      choices: readonly SanitizedAccountChoice[];
    }>
  | Readonly<{
      status: "connected";
      connectionId: string;
      jobRequestId: string;
  }>
);

export type OAuthSelectionReplay = Readonly<{
  connectionId: string;
  jobRequestId: string;
}>;

export class OAuthSessionStore {
  constructor(
    private readonly db: TransactionalPostgres,
    private readonly cryptography: EnvelopeCryptography,
  ) {}

  async create(input: Readonly<{
    tenantId: string;
    initiatedBy: string;
    provider: "lightspeed-r" | "xero" | "deputy";
    redirectUri: string;
    requestedScopes: readonly string[];
    stateNonceHash: string;
    codeVerifier: string;
    expiresAt: string;
  }>): Promise<string> {
    const oauthSessionId = ulid();
    const pkceReference = `oauth_pkce_${ulid()}`;
    const envelope = await this.cryptography.seal(input.codeVerifier, {
      tenantId: input.tenantId,
      secretReference: pkceReference,
      version: 1,
    });
    await this.db.transaction(async (client) => {
      const membership = await client.query(
        `select 1
           from control_plane.memberships
          where tenant_id = $1 and user_id = $2 and status = 'active'
            and role in ('owner', 'manager')`,
        [input.tenantId, input.initiatedBy],
      );
      if (!membership.rows[0]) throw new Error("oauth_actor_not_connection_admin");
      await client.query(
        `insert into control_plane.oauth_sessions (
           tenant_id, oauth_session_id, initiated_by, provider,
           state_nonce_hash, pkce_verifier_secret_reference, redirect_uri,
           requested_scopes, status, expires_at
         ) values ($1, $2, $3, $4, $5, $6, $7, $8::text[], 'pending', $9)`,
        [
          input.tenantId,
          oauthSessionId,
          input.initiatedBy,
          input.provider,
          stateHash(input.stateNonceHash),
          pkceReference,
          input.redirectUri,
          [...input.requestedScopes],
          input.expiresAt,
        ],
      );
      await insertSessionEnvelope(client, {
        tenantId: input.tenantId,
        sessionId: oauthSessionId,
        secretReference: pkceReference,
        kind: "pkce_verifier",
        version: 1,
        envelope,
      });
      await client.query(
        `insert into control_plane.audit_log (
           tenant_id, audit_id, actor_user_id, actor_type, action,
           resource_type, resource_id, audit_metadata
         ) values ($1, $2, $3, 'service', 'oauth.session_created',
           'oauth_session', $4, jsonb_build_object('provider', $5::text))`,
        [input.tenantId, ulid(), input.initiatedBy, oauthSessionId, input.provider],
      );
    });
    return oauthSessionId;
  }

  async loadForCallback(input: Readonly<{
    tenantId: string;
    oauthSessionId: string;
    initiatedBy: string;
    stateNonceHash: string;
  }>): Promise<OAuthSessionContext> {
    const session = await this.loadWithPkce(input.tenantId, input.oauthSessionId, input.initiatedBy);
    const stateRecord = await this.db.query<{ state_nonce_hash: string }>(
      `select state_nonce_hash from control_plane.oauth_sessions
        where tenant_id = $1 and oauth_session_id = $2 and initiated_by = $3`,
      [input.tenantId, input.oauthSessionId, input.initiatedBy],
    );
    if (stateRecord.rows[0]?.state_nonce_hash !== stateHash(input.stateNonceHash)) {
      throw new Error("oauth_state_mismatch");
    }
    if (session.status !== "pending") throw new Error("oauth_session_already_used");
    return session;
  }

  async loadCallbackReplay(input: Readonly<{
    tenantId: string;
    oauthSessionId: string;
    initiatedBy: string;
    stateNonceHash: string;
  }>): Promise<OAuthCallbackReplay | null> {
    const result = await this.db.query<{
      provider: OAuthSessionContext["provider"];
      redirect_uri: string;
      state_nonce_hash: string;
      status: string;
      expires_at: string | Date;
      discovered_account_choices: SanitizedAccountChoice[] | null;
      completion_result: Record<string, unknown> | null;
    }>(
      `select session.provider,session.redirect_uri,session.state_nonce_hash,
              session.status,session.expires_at,session.discovered_account_choices,
              session.completion_result
         from control_plane.oauth_sessions as session
         join control_plane.memberships as membership
           on membership.tenant_id = session.tenant_id
          and membership.user_id = session.initiated_by
          and membership.status = 'active'
          and membership.role in ('owner', 'manager')
        where session.tenant_id = $1 and session.oauth_session_id = $2
          and session.initiated_by = $3`,
      [input.tenantId, input.oauthSessionId, input.initiatedBy],
    );
    const row = result.rows[0];
    if (!row) throw new Error("oauth_session_not_found");
    if (row.state_nonce_hash !== stateHash(input.stateNonceHash)) {
      throw new Error("oauth_state_mismatch");
    }
    if (row.status === "selecting_account") {
      if (new Date(row.expires_at).valueOf() <= Date.now()) {
        throw new Error("oauth_session_expired");
      }
      const choices = row.discovered_account_choices ?? [];
      if (choices.length < 2) throw new Error("oauth_callback_result_unavailable");
      return Object.freeze({
        provider: row.provider,
        redirectUri: row.redirect_uri,
        status: "selection_required" as const,
        choices: Object.freeze([...choices]),
      });
    }
    if (row.status === "consumed") {
      const connectionId = row.completion_result?.connectionId;
      const jobRequestId = row.completion_result?.jobRequestId;
      if (
        typeof connectionId !== "string" || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(connectionId) ||
        typeof jobRequestId !== "string" || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(jobRequestId)
      ) {
        throw new Error("oauth_callback_result_unavailable");
      }
      return Object.freeze({
        provider: row.provider,
        redirectUri: row.redirect_uri,
        status: "connected" as const,
        connectionId,
        jobRequestId,
      });
    }
    if (row.status === "pending" || row.status === "exchanging") return null;
    throw new Error("oauth_session_already_used");
  }

  async loadForSelection(input: Readonly<{
    tenantId: string;
    oauthSessionId: string;
    initiatedBy: string;
  }>): Promise<OAuthSessionContext> {
    const session = await this.loadWithPkce(input.tenantId, input.oauthSessionId, input.initiatedBy);
    if (session.status !== "selecting_account") throw new Error("oauth_session_not_selecting");
    return session;
  }

  async loadSelectionReplay(input: Readonly<{
    tenantId: string;
    oauthSessionId: string;
    initiatedBy: string;
    selectedAccountReference: string;
  }>): Promise<OAuthSelectionReplay | null> {
    const result = await this.db.query<{
      status: string;
      selected_account_reference: string | null;
      completion_result: Record<string, unknown> | null;
    }>(
      `select session.status,session.selected_account_reference,
              session.completion_result
         from control_plane.oauth_sessions as session
         join control_plane.memberships as membership
           on membership.tenant_id = session.tenant_id
          and membership.user_id = session.initiated_by
          and membership.status = 'active'
          and membership.role in ('owner', 'manager')
        where session.tenant_id = $1 and session.oauth_session_id = $2
          and session.initiated_by = $3`,
      [input.tenantId, input.oauthSessionId, input.initiatedBy],
    );
    const row = result.rows[0];
    if (!row) throw new Error("oauth_session_not_found");
    if (row.status === "selecting_account") return null;
    if (row.status !== "consumed") throw new Error("oauth_session_not_selecting");
    if (row.selected_account_reference !== input.selectedAccountReference) {
      throw new Error("oauth_selected_account_mismatch");
    }
    const connectionId = row.completion_result?.connectionId;
    const jobRequestId = row.completion_result?.jobRequestId;
    if (
      typeof connectionId !== "string" || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(connectionId) ||
      typeof jobRequestId !== "string" || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(jobRequestId)
    ) {
      throw new Error("oauth_callback_result_unavailable");
    }
    return Object.freeze({ connectionId, jobRequestId });
  }

  private async loadWithPkce(
    tenantId: string,
    oauthSessionId: string,
    initiatedBy: string,
  ): Promise<OAuthSessionContext> {
    const result = await this.db.query<SessionEnvelopeRow>(
      `select session.tenant_id, session.oauth_session_id, session.initiated_by,
              session.provider, session.state_nonce_hash, session.redirect_uri,
              session.requested_scopes, session.status, session.expires_at,
              session.discovered_account_choices, session.selected_account_reference,
              envelope.secret_reference, envelope.secret_kind,
              envelope.credential_version, envelope.algorithm, envelope.ciphertext,
              envelope.nonce, envelope.authentication_tag, envelope.wrapped_data_key,
              envelope.key_reference, envelope.key_version, envelope.aad_digest
         from control_plane.oauth_sessions as session
         join control_plane.oauth_session_secret_envelopes as envelope
           on envelope.tenant_id = session.tenant_id
          and envelope.oauth_session_id = session.oauth_session_id
          and envelope.secret_kind = 'pkce_verifier'
          and envelope.consumed_at is null
          and envelope.destroyed_at is null
         join control_plane.memberships as membership
           on membership.tenant_id = session.tenant_id
          and membership.user_id = session.initiated_by
          and membership.status = 'active'
          and membership.role in ('owner', 'manager')
        where session.tenant_id = $1
          and session.oauth_session_id = $2
          and session.initiated_by = $3`,
      [tenantId, oauthSessionId, initiatedBy],
    );
    const row = result.rows[0];
    if (!row) throw new Error("oauth_session_not_found");
    if (new Date(row.expires_at).valueOf() <= Date.now()) throw new Error("oauth_session_expired");
    const codeVerifier = await this.cryptography.open(envelopeFromRow(row), {
      tenantId: row.tenant_id,
      secretReference: row.secret_reference,
      version: Number(row.credential_version),
    });
    return {
      tenantId: row.tenant_id,
      oauthSessionId: row.oauth_session_id,
      initiatedBy: row.initiated_by,
      provider: row.provider,
      redirectUri: row.redirect_uri,
      requestedScopes: row.requested_scopes,
      status: row.status,
      expiresAt: new Date(row.expires_at).toISOString(),
      codeVerifier,
      choices: row.discovered_account_choices ?? [],
      selectedAccountReference: row.selected_account_reference,
    };
  }

  async setAccountChoices(
    context: OAuthSessionContext,
    discoveries: readonly ConnectionDiscovery[],
  ): Promise<readonly SanitizedAccountChoice[]> {
    const choices = discoveries.map(safeAccountChoice);
    if (choices.length < 2 || choices.some((choice) => !choice.externalAccountId || !choice.displayName)) {
      throw new Error("oauth_account_choices_invalid");
    }
    const updated = await this.db.query(
      `update control_plane.oauth_sessions
          set status = 'selecting_account',
              discovered_account_choices = $4::jsonb,
              expires_at = greatest(expires_at, now() + interval '10 minutes')
        where tenant_id = $1 and oauth_session_id = $2 and initiated_by = $3
          and status = 'pending' and expires_at > now()
        returning oauth_session_id`,
      [context.tenantId, context.oauthSessionId, context.initiatedBy, JSON.stringify(choices)],
    );
    if (!updated.rows[0]) throw new Error("oauth_session_transition_conflict");
    return choices;
  }

  async markExchanging(
    context: OAuthSessionContext,
    selectedAccountReference: string,
  ): Promise<void> {
    const choices = context.choices;
    if (
      choices.length > 0 &&
      !choices.some((choice) => choice.externalAccountId === selectedAccountReference)
    ) {
      throw new Error("oauth_account_choice_not_offered");
    }
    const result = await this.db.query(
      `update control_plane.oauth_sessions
          set status = 'exchanging', selected_account_reference = $4
        where tenant_id = $1 and oauth_session_id = $2 and initiated_by = $3
          and status in ('pending', 'selecting_account') and expires_at > now()
        returning oauth_session_id`,
      [context.tenantId, context.oauthSessionId, context.initiatedBy, selectedAccountReference],
    );
    if (!result.rows[0]) throw new Error("oauth_session_transition_conflict");
  }

  credentialVault(context: Pick<OAuthSessionContext, "tenantId" | "oauthSessionId">) {
    return new SessionCredentialVault(this.db, this.cryptography, context);
  }

  async provisionalCredentialReference(
    context: Pick<OAuthSessionContext, "tenantId" | "oauthSessionId">,
  ): Promise<string> {
    const result = await this.db.query<{ secret_reference: string }>(
      `select secret_reference
         from control_plane.oauth_session_secret_envelopes
        where tenant_id = $1 and oauth_session_id = $2
          and secret_kind = 'exchanged_credential'
          and consumed_at is null and destroyed_at is null
        order by credential_version desc
        limit 1`,
      [context.tenantId, context.oauthSessionId],
    );
    const reference = result.rows[0]?.secret_reference;
    if (!reference) throw new Error("session_credential_not_found");
    return reference;
  }

  async finalizeConnection(input: Readonly<{
    context: OAuthSessionContext;
    discovery: ConnectionDiscovery;
    provisionalCredentialRef: string;
  }>): Promise<Readonly<{ connectionId: string; jobRequestId: string; credentialRef: string }>> {
    const provisional = await this.credentialVault(input.context).read(input.provisionalCredentialRef);
    const generatedConnectionId = ulid();
    const tokenRefId = ulid();
    const credentialRef = `oauth_${ulid()}`;
    const syncRunId = ulid();
    const batchId = ulid();
    const envelope = await this.cryptography.seal(JSON.stringify(provisional.secret), {
      tenantId: input.context.tenantId,
      secretReference: credentialRef,
      version: 1,
    });
    const account = safeAccountChoice(input.discovery);
    const accountMetadata = input.context.provider === "deputy"
      ? {
          ...account.metadata,
          webhook_setup: {
            status: "operator_installation_required",
            reason_code: "deputy_webhook_operator_installation_required",
            optional: true,
            completeness_mode: "scheduled_polling_and_reconciliation",
            updated_at: new Date().toISOString(),
          },
        }
      : account.metadata;
    if (account.externalAccountId !== input.context.selectedAccountReference) {
      throw new Error("oauth_selected_account_mismatch");
    }
    return this.db.transaction(async (client) => {
      const locked = await client.query<{
        status: string;
        discovered_account_choices: SanitizedAccountChoice[] | null;
      }>(
        `select status, discovered_account_choices from control_plane.oauth_sessions
          where tenant_id = $1 and oauth_session_id = $2 and initiated_by = $3
          for update`,
        [input.context.tenantId, input.context.oauthSessionId, input.context.initiatedBy],
      );
      if (!locked.rows[0] || !["pending", "selecting_account", "exchanging"].includes(locked.rows[0].status)) {
        throw new Error("oauth_session_finalize_conflict");
      }
      const offered = locked.rows[0].discovered_account_choices ?? [];
      if (offered.length > 0 && !offered.some((choice) =>
        choice.externalAccountId === account.externalAccountId
      )) {
        throw new Error("oauth_account_choice_not_offered");
      }
      const exchanging = await client.query(
        `update control_plane.oauth_sessions
            set status = 'exchanging', selected_account_reference = $4
          where tenant_id = $1 and oauth_session_id = $2 and initiated_by = $3
            and status in ('pending', 'selecting_account', 'exchanging')
            and expires_at > now()
        returning oauth_session_id`,
        [
          input.context.tenantId,
          input.context.oauthSessionId,
          input.context.initiatedBy,
          account.externalAccountId,
        ],
      );
      if (!exchanging.rows[0]) throw new Error("oauth_session_finalize_conflict");
      const finalizedIdentity = await client.query<{
        connection_id: string;
        connection_generation: string | number;
        replayed: boolean;
      }>(
        `select connection_id,connection_generation,replayed
           from control_plane.finalize_oauth_connection_identity(
             $1::text,$2::text,$3::uuid,$4::text,$5::text,$6::text,$7::text,
             $8::jsonb,$9::text
           )`,
        [
          input.context.tenantId,
          input.context.oauthSessionId,
          input.context.initiatedBy,
          input.context.provider,
          account.externalAccountId,
          generatedConnectionId,
          account.displayName,
          JSON.stringify(accountMetadata),
          input.provisionalCredentialRef,
        ],
      );
      const connectionId = finalizedIdentity.rows[0]?.connection_id;
      const connectionGeneration = Number(finalizedIdentity.rows[0]?.connection_generation);
      if (
        !connectionId || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(connectionId) ||
        !Number.isSafeInteger(connectionGeneration) || connectionGeneration < 1
      ) {
        throw new Error("oauth_connection_identity_finalization_failed");
      }
      await client.query(
        `delete from control_plane.oauth_token_refs
          where tenant_id = $1 and connection_id = $2`,
        [input.context.tenantId, connectionId],
      );
      await client.query(
        `insert into control_plane.oauth_token_refs (
           tenant_id, token_ref_id, connection_id, secret_reference,
           encryption_key_version, granted_scopes, token_expires_at, last_rotated_at
         ) values ($1, $2, $3, $4, $5, $6::text[], $7, now())`,
        [
          input.context.tenantId,
          tokenRefId,
          connectionId,
          credentialRef,
          envelope.keyVersion,
          [...provisional.secret.scopes],
          provisional.secret.expiresAt,
        ],
      );
      await client.query(
        `insert into control_plane.oauth_secret_envelopes (
           tenant_id, oauth_secret_envelope_id, token_ref_id, credential_version,
           algorithm, ciphertext, nonce, authentication_tag, wrapped_data_key,
           key_reference, key_version, aad_digest
         ) values ($1, $2, $3, 1, $4, $5::bytea, $6::bytea, $7::bytea,
           $8::bytea, $9, $10, $11)`,
        [
          input.context.tenantId,
          ulid(),
          tokenRefId,
          envelope.algorithm,
          Buffer.from(envelope.ciphertext),
          Buffer.from(envelope.nonce),
          Buffer.from(envelope.authenticationTag),
          Buffer.from(envelope.wrappedDataKey),
          envelope.keyReference,
          envelope.keyVersion,
          envelope.aadDigest,
        ],
      );
      await client.query(
        `delete from control_plane.oauth_session_secret_envelopes
          where tenant_id = $1 and oauth_session_id = $2`,
        [input.context.tenantId, input.context.oauthSessionId],
      );
      const jobPayload = {
        schemaVersion: 1,
        type: "InitialBackfill",
        tenantId: input.context.tenantId,
        connectionId,
        connectionGeneration,
        connectorId: input.context.provider,
        externalAccountReference: account.externalAccountId,
        syncRunId,
        batchId,
        requestedAt: new Date().toISOString(),
        range: {
          from: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
          to: new Date().toISOString(),
        },
        phase: "recent",
        replayVersion: 1,
        planMode: "progressive",
      };
      const enqueued = await client.query<{ job_request_id: string }>(
        `select job_request_id
           from control_plane.enqueue_sync_job($1::jsonb, 'backfill', $2, 0)`,
        [JSON.stringify(jobPayload), `oauth-initial:${input.context.oauthSessionId}`],
      );
      const jobRequestId = enqueued.rows[0]?.job_request_id;
      if (!jobRequestId) throw new Error("oauth_initial_backfill_enqueue_failed");
      const completedSession = await client.query(
        `update control_plane.oauth_sessions
            set status = 'consumed',
                consumed_at = clock_timestamp(),
                selected_account_reference = $6::text,
                pkce_verifier_secret_reference = null,
                completion_result = jsonb_build_object(
              'connectionId',$3::text,
              'jobRequestId',$4::text,
              'oauthSessionId',$2::text,
              'connectionGeneration',$5::bigint
            )
          where tenant_id = $1 and oauth_session_id = $2
            and status = 'exchanging'
        returning oauth_session_id`,
        [
          input.context.tenantId,
          input.context.oauthSessionId,
          connectionId,
          jobRequestId,
          connectionGeneration,
          account.externalAccountId,
        ],
      );
      if (!completedSession.rows[0]) throw new Error("oauth_session_finalize_conflict");
      await client.query(
        `insert into control_plane.audit_log (
         tenant_id, audit_id, actor_user_id, actor_type, action,
           resource_type, resource_id, audit_metadata, occurred_at
         ) values ($1, $2, $3, 'service', 'oauth.connection_authorised',
           'connection', $4, jsonb_build_object(
             'provider', $5::text,
             'account', $6::text,
             'oauthSessionId', $7::text,
             'connectionGeneration', $8::bigint
           ), clock_timestamp())`,
        [
          input.context.tenantId,
          ulid(),
          input.context.initiatedBy,
          connectionId,
          input.context.provider,
          account.externalAccountId,
          input.context.oauthSessionId,
          connectionGeneration,
        ],
      );
      return { connectionId, jobRequestId, credentialRef };
    });
  }
}

class SessionCredentialVault implements WorkerCredentialVault {
  private readonly refreshLeases: DurableCredentialRefreshLeaseCoordinator;

  constructor(
    private readonly db: TransactionalPostgres,
    private readonly cryptography: EnvelopeCryptography,
    private readonly context: Readonly<{ tenantId: string; oauthSessionId: string }>,
  ) {
    this.refreshLeases = new DurableCredentialRefreshLeaseCoordinator(
      new PostgresCredentialRefreshLeaseStore(db),
    );
  }

  async create(secret: OAuthCredentialSecret): Promise<VersionedCredential> {
    const credentialRef = `oauth_session_credential_${ulid()}`;
    const envelope = await this.cryptography.seal(JSON.stringify(secret), {
      tenantId: this.context.tenantId,
      secretReference: credentialRef,
      version: 1,
    });
    await this.db.transaction(async (client) => {
      await client.query(
        `update control_plane.oauth_session_secret_envelopes
            set consumed_at = now()
          where tenant_id = $1 and oauth_session_id = $2
            and secret_kind = 'exchanged_credential'
            and consumed_at is null and destroyed_at is null`,
        [this.context.tenantId, this.context.oauthSessionId],
      );
      await insertSessionEnvelope(client, {
        tenantId: this.context.tenantId,
        sessionId: this.context.oauthSessionId,
        secretReference: credentialRef,
        kind: "exchanged_credential",
        version: 1,
        envelope,
      });
    });
    return { credentialRef, revision: "1", secret };
  }

  async read(credentialRef: string): Promise<VersionedCredential> {
    const result = await this.db.query<SessionEnvelopeRow>(
      `select session.tenant_id, session.oauth_session_id, session.initiated_by,
              session.provider, session.state_nonce_hash, session.redirect_uri,
              session.requested_scopes, session.status, session.expires_at,
              session.discovered_account_choices, session.selected_account_reference,
              envelope.secret_reference, envelope.secret_kind,
              envelope.credential_version, envelope.algorithm, envelope.ciphertext,
              envelope.nonce, envelope.authentication_tag, envelope.wrapped_data_key,
              envelope.key_reference, envelope.key_version, envelope.aad_digest
         from control_plane.oauth_sessions as session
         join control_plane.oauth_session_secret_envelopes as envelope
           on envelope.tenant_id = session.tenant_id
          and envelope.oauth_session_id = session.oauth_session_id
          and envelope.secret_kind = 'exchanged_credential'
          and envelope.consumed_at is null and envelope.destroyed_at is null
        where session.tenant_id = $1 and session.oauth_session_id = $2
          and envelope.secret_reference = $3`,
      [this.context.tenantId, this.context.oauthSessionId, credentialRef],
    );
    const row = result.rows[0];
    if (!row) throw new Error("session_credential_not_found");
    const version = Number(row.credential_version);
    const plaintext = await this.cryptography.open(envelopeFromRow(row), {
      tenantId: row.tenant_id,
      secretReference: credentialRef,
      version,
    });
    return {
      credentialRef,
      revision: String(version),
      secret: parseOAuthCredentialSecret(JSON.parse(plaintext)),
    };
  }

  async compareAndSwap(
    credentialRef: string,
    expectedRevision: string,
    secret: OAuthCredentialSecret,
    refreshLease?: CredentialRefreshLeaseProof,
  ): Promise<VersionedCredential> {
    const current = await this.read(credentialRef);
    if (current.revision !== expectedRevision) throw new Error("credential_revision_conflict");
    const tokenMaterialChanged = current.secret.provider !== secret.provider ||
      current.secret.accessToken !== secret.accessToken ||
      current.secret.refreshToken !== secret.refreshToken ||
      current.secret.tokenType !== secret.tokenType ||
      current.secret.expiresAt !== secret.expiresAt ||
      current.secret.scopes.length !== secret.scopes.length ||
      current.secret.scopes.some((scope, index) => scope !== secret.scopes[index]);
    if (tokenMaterialChanged && !refreshLease) {
      throw new Error("credential_refresh_lease_required");
    }
    const nextVersion = Number(expectedRevision) + 1;
    const envelope = await this.cryptography.seal(JSON.stringify(secret), {
      tenantId: this.context.tenantId,
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
      const rotated = await client.query(
        `update control_plane.oauth_session_secret_envelopes
            set credential_version = $5, algorithm = $6, ciphertext = $7::bytea,
                nonce = $8::bytea, authentication_tag = $9::bytea,
                wrapped_data_key = $10::bytea, key_reference = $11,
                key_version = $12, aad_digest = $13
          where tenant_id = $1 and oauth_session_id = $2
            and secret_reference = $3 and credential_version = $4::integer
            and consumed_at is null and destroyed_at is null
          returning oauth_session_secret_id`,
        [
          this.context.tenantId,
          this.context.oauthSessionId,
          credentialRef,
          expectedRevision,
          nextVersion,
          envelope.algorithm,
          Buffer.from(envelope.ciphertext),
          Buffer.from(envelope.nonce),
          Buffer.from(envelope.authenticationTag),
          Buffer.from(envelope.wrappedDataKey),
          envelope.keyReference,
          envelope.keyVersion,
          envelope.aadDigest,
        ],
      );
      if (!rotated.rows[0]) throw new Error("credential_revision_conflict");
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
    await this.db.query(
      `delete from control_plane.oauth_session_secret_envelopes
        where tenant_id = $1 and oauth_session_id = $2 and secret_reference = $3`,
      [this.context.tenantId, this.context.oauthSessionId, credentialRef],
    );
  }
}

export function makeOAuthNonce(): string {
  return randomBytes(32).toString("base64url");
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}
