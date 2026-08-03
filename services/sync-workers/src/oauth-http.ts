import { verifyInternalRequest } from "../../../packages/security/src/index.js";
import {
  ConnectorError,
  createDeadlineSignal,
  raceWithSignal,
  type OAuthConnectorPack,
  type WorkerCredentialVault,
} from "../../../packages/connector-sdk/src/index.js";
import { ulid } from "ulid";
import { CredentialVaultFactory } from "./credential-vault.js";
import type { TransactionalPostgres } from "./database.js";
import { OAuthSessionStore } from "./oauth-session-store.js";
import {
  DeputyWebhookSetupCoordinator,
  type DeputyWebhookSetupResult,
} from "./deputy-webhooks.js";

type Provider = "lightspeed-r" | "xero" | "deputy";

export interface OAuthConnectorFactory {
  create(provider: Provider, vault: WorkerCredentialVault): OAuthConnectorPack;
  scopes(provider: Provider): readonly string[];
}

type DisconnectRecord = Readonly<{
  tenantId: string;
  connectionId: string;
  connectorId: Provider;
  credentialRef: string;
  initiatedBy: string;
}>;

export class DisconnectStore {
  constructor(private readonly db: TransactionalPostgres) {}

  async load(input: Readonly<{ tenantId: string; connectionId: string; userId: string }>): Promise<DisconnectRecord> {
    const result = await this.db.query<{
      tenant_id: string;
      connection_id: string;
      connector_key: Provider;
      secret_reference: string;
    }>(
      `select connection.tenant_id, connection.connection_id,
              connection.connector_key, token.secret_reference
         from control_plane.connections as connection
         join control_plane.memberships as membership
           on membership.tenant_id = connection.tenant_id
          and membership.user_id = $3
          and membership.status = 'active'
          and membership.role in ('owner', 'manager')
         join control_plane.oauth_token_refs as token
           on token.tenant_id = connection.tenant_id
          and token.connection_id = connection.connection_id
        where connection.tenant_id = $1 and connection.connection_id = $2
          and connection.status <> 'disconnected'`,
      [input.tenantId, input.connectionId, input.userId],
    );
    const row = result.rows[0];
    if (!row) throw new Error("disconnect_connection_not_found");
    return {
      tenantId: row.tenant_id,
      connectionId: row.connection_id,
      connectorId: row.connector_key,
      credentialRef: row.secret_reference,
      initiatedBy: input.userId,
    };
  }

  async finalize(record: DisconnectRecord, remoteStatus: "succeeded" | "unsupported" | "failed") {
    return this.db.transaction(async (client) => {
      await client.query(
        `delete from control_plane.deputy_webhook_material
          where tenant_id = $1 and connection_id = $2`,
        [record.tenantId, record.connectionId],
      );
      await client.query(
        `delete from control_plane.oauth_token_refs
          where tenant_id = $1 and connection_id = $2 and secret_reference = $3`,
        [record.tenantId, record.connectionId, record.credentialRef],
      );
      await client.query(
        `update control_plane.connections
            set status = 'disconnected', auth_health = 'revoked', disconnected_at = now()
          where tenant_id = $1 and connection_id = $2`,
        [record.tenantId, record.connectionId],
      );
      await client.query(
        `update control_plane.readiness
            set state = 'blocked', reason_code = 'connection_disconnected',
                reason_detail = 'Connection data is scheduled for deletion.', evaluated_at = now()
          where tenant_id = $1 and connection_id = $2`,
        [record.tenantId, record.connectionId],
      );
      const existing = await client.query<{ deletion_request_id: string }>(
        `select deletion_request_id
           from control_plane.deletion_requests
          where tenant_id = $1 and connection_id = $2
            and status in ('queued', 'running', 'retry_wait', 'verifying', 'failed')
          for update`,
        [record.tenantId, record.connectionId],
      );
      const deletionRequestId = existing.rows[0]?.deletion_request_id ?? ulid();
      if (!existing.rows[0]) {
        await client.query(
          `insert into control_plane.deletion_requests (
             tenant_id, deletion_request_id, connection_id, scope, status,
             requested_by, remote_revocation_status, credential_destroyed_at,
             purge_due_at, progress
           ) values ($1, $2, $3, 'connection', 'queued', $4, $5, now(),
             now(), jsonb_build_object(
               'credential_vault', jsonb_build_object('verified', true, 'completedAt', now()),
               'remote_revocation', jsonb_build_object('summary', $5::text)
             ))`,
          [record.tenantId, deletionRequestId, record.connectionId, record.initiatedBy, remoteStatus],
        );
      }
      await client.query(
        `insert into control_plane.audit_log (
           tenant_id, audit_id, actor_user_id, actor_type, action,
           resource_type, resource_id, audit_metadata
         ) values ($1, $2, $3, 'service', 'connection.disconnected',
           'connection', $4, jsonb_build_object(
             'deletion_request_id', $5::text,
             'remote_revocation_status', $6::text,
             'credential_destroyed', true
           ))`,
        [
          record.tenantId,
          ulid(),
          record.initiatedBy,
          record.connectionId,
          deletionRequestId,
          remoteStatus,
        ],
      );
      await client.query("select control_plane.enqueue_deletion_request($1)", [deletionRequestId]);
      return deletionRequestId;
    });
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_request");
  return value as Record<string, unknown>;
}

function requiredString(input: Record<string, unknown>, key: string, max = 500): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error("invalid_request");
  return value;
}

function stateNonceHash(input: Record<string, unknown>): string {
  const value = requiredString(input, "stateNonceHash", 64);
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("oauth_state_hash_invalid");
  return value;
}

function codeVerifier(input: Record<string, unknown>): string {
  const value = requiredString(input, "codeVerifier", 128);
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(value)) throw new Error("oauth_pkce_verifier_invalid");
  return value;
}

function provider(input: Record<string, unknown>): Provider {
  const value = requiredString(input, "provider", 40);
  if (!(["lightspeed-r", "xero", "deputy"] as const).includes(value as Provider)) {
    throw new Error("invalid_provider");
  }
  return value as Provider;
}

function response(value: unknown, status = 200) {
  return Response.json({ result: value }, {
    status,
    headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
  });
}

function errorResponse(error: string, status: number) {
  return Response.json({ error }, {
    status,
    headers: { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" },
  });
}

function publicError(error: unknown) {
  const rawCode = error instanceof ConnectorError
    ? error.code.toLowerCase()
    : error instanceof Error ? error.message.split(":", 1)[0] : "oauth_worker_error";
  const code = /^(?:oauth|connection|credential|disconnect|invalid)_[a-z0-9_.-]+$/.test(rawCode)
    ? rawCode
    : "oauth_worker_error";
  const status = /actor_not|unauthorised/.test(code)
    ? 403
    : /not_found/.test(code)
      ? 404
      : /deletion_in_progress|conflict|already/.test(code)
        ? 409
        : /invalid|mismatch|expired|no_accounts|choice/.test(code)
          ? 400
          : 503;
  return errorResponse(code.replace(/[^a-z0-9_.-]/gi, "_").slice(0, 100), status);
}

export class OAuthWorkerHttpHandler {
  constructor(private readonly dependencies: Readonly<{
    oauthWorkerSigningSecret: string;
    allowedRedirectUris: ReadonlySet<string>;
    sessions: OAuthSessionStore;
    credentialVaults: CredentialVaultFactory;
    connectors: OAuthConnectorFactory;
    disconnects: DisconnectStore;
    deputyWebhooks: Pick<DeputyWebhookSetupCoordinator, "provision">;
    operationTimeoutMs?: number;
  }>) {
    if (internalSigningSecretBytes(dependencies.oauthWorkerSigningSecret) < 32) {
      throw new Error("ALBERT_OAUTH_WORKER_SIGNING_SECRET must contain at least 32 UTF-8 bytes.");
    }
    if (
      dependencies.operationTimeoutMs !== undefined &&
      (!Number.isFinite(dependencies.operationTimeoutMs) || dependencies.operationTimeoutMs <= 0)
    ) {
      throw new Error("OAuth worker operation timeout must be a positive duration.");
    }
  }

  async handle(request: Request): Promise<Response> {
    if (request.method !== "POST") return errorResponse("method_not_allowed", 405);
    const url = new URL(request.url);
    const contentLength = Number(request.headers.get("content-length") ?? 0);
    if (contentLength > 64 * 1024) return errorResponse("request_too_large", 413);
    const body = await request.text();
    if (Buffer.byteLength(body, "utf8") > 64 * 1024) return errorResponse("request_too_large", 413);
    const verified = await verifyInternalRequest({
      method: request.method,
      path: url.pathname,
      body,
      secret: this.dependencies.oauthWorkerSigningSecret,
      timestamp: request.headers.get("x-albert-timestamp"),
      signature: request.headers.get("x-albert-signature"),
      maxSkewMs: 60_000,
    }).catch(() => false);
    if (!verified) return errorResponse("unauthorised", 401);

    const deadline = createDeadlineSignal(this.dependencies.operationTimeoutMs ?? 40_000);
    const operationSignal = request.signal
      ? AbortSignal.any([request.signal, deadline.signal])
      : deadline.signal;
    try {
      const input = record(JSON.parse(body));
      return await raceWithSignal(async () => {
        switch (url.pathname) {
          case "/v1/oauth/start":
            return await this.start(input);
          case "/v1/oauth/callback":
            return await this.callback(input, operationSignal);
          case "/v1/oauth/select":
            return await this.select(input, operationSignal);
          case "/v1/oauth/disconnect":
            return await this.disconnect(input, operationSignal);
          default:
            return errorResponse("not_found", 404);
        }
      }, operationSignal);
    } catch (error) {
      if (operationSignal.aborted) return publicError(new Error("oauth_worker_timeout"));
      return publicError(error);
    } finally {
      deadline.clear();
    }
  }

  private async start(input: Record<string, unknown>) {
    const tenantId = requiredString(input, "tenantId", 26);
    const userId = requiredString(input, "userId", 36);
    const selectedProvider = provider(input);
    const redirectUri = requiredString(input, "redirectUri", 1000);
    if (!this.dependencies.allowedRedirectUris.has(redirectUri)) throw new Error("oauth_redirect_not_allowed");
    const scopes = this.dependencies.connectors.scopes(selectedProvider);
    const verifier = codeVerifier(input);
    const expiresAt = new Date(requiredString(input, "expiresAt", 40));
    const remaining = expiresAt.valueOf() - Date.now();
    if (!Number.isFinite(expiresAt.valueOf()) || remaining < 60_000 || remaining > 10 * 60_000 + 30_000) {
      throw new Error("oauth_expiry_invalid");
    }
    const oauthSessionId = await this.dependencies.sessions.create({
      tenantId,
      initiatedBy: userId,
      provider: selectedProvider,
      redirectUri,
      requestedScopes: scopes,
      stateNonceHash: stateNonceHash(input),
      codeVerifier: verifier,
      expiresAt: expiresAt.toISOString(),
    });
    return response({ oauthSessionId });
  }

  private async callback(input: Record<string, unknown>, signal: AbortSignal) {
    const context = await this.dependencies.sessions.loadForCallback({
      tenantId: requiredString(input, "tenantId", 26),
      oauthSessionId: requiredString(input, "oauthSessionId", 26),
      initiatedBy: requiredString(input, "userId", 36),
      stateNonceHash: stateNonceHash(input),
    });
    if (input.provider !== undefined && provider(input) !== context.provider) {
      throw new Error("oauth_provider_mismatch");
    }
    if (input.redirectUri !== undefined && requiredString(input, "redirectUri", 1000) !== context.redirectUri) {
      throw new Error("oauth_redirect_mismatch");
    }
    const vault = this.dependencies.sessions.credentialVault(context);
    const connector = this.dependencies.connectors.create(context.provider, vault);
    let credentialRef: string;
    try {
      credentialRef = await this.dependencies.sessions.provisionalCredentialReference(context);
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "session_credential_not_found") throw error;
      const exchange = await connector.exchange_authorization_code({
        code: requiredString(input, "code", 4000),
        redirectUri: context.redirectUri,
        codeVerifier: context.codeVerifier,
        abortSignal: signal,
      });
      credentialRef = exchange.credentialRef;
    }
    const connectorContext = {
      tenantId: context.tenantId,
      connectionId: context.oauthSessionId,
      credentialRef,
      abortSignal: signal,
    } as const;
    const discoveries = await connector.discover_accounts(connectorContext);
    if (discoveries.length === 0) throw new Error("oauth_no_accounts_available");
    if (discoveries.length > 1) {
      const choices = await this.dependencies.sessions.setAccountChoices(context, discoveries);
      return response({ oauthSessionId: context.oauthSessionId, status: "selection_required", choices }, 202);
    }
    const selected = discoveries[0]!;
    const discovery = await connector.select_account(connectorContext, selected.externalAccountId);
    const finalized = await this.dependencies.sessions.finalizeConnection({
      context: { ...context, status: "exchanging", selectedAccountReference: selected.externalAccountId },
      discovery,
      provisionalCredentialRef: credentialRef,
    });
    const { credentialRef: liveCredentialRef, ...result } = finalized;
    const webhookSetup = await this.provisionDeputyWebhooks(context, result.connectionId, liveCredentialRef, signal);
    return response({
      oauthSessionId: context.oauthSessionId,
      status: "connected",
      ...result,
      ...(webhookSetup ? { webhookSetup } : {}),
    });
  }

  private async select(input: Record<string, unknown>, signal: AbortSignal) {
    const context = await this.dependencies.sessions.loadForSelection({
      tenantId: requiredString(input, "tenantId", 26),
      oauthSessionId: requiredString(input, "oauthSessionId", 26),
      initiatedBy: requiredString(input, "userId", 36),
    });
    const accountId = requiredString(input, "externalAccountId", 300);
    const credentialRef = await this.dependencies.sessions.provisionalCredentialReference(context);
    const connector = this.dependencies.connectors.create(
      context.provider,
      this.dependencies.sessions.credentialVault(context),
    );
    const discovery = await connector.select_account({
      tenantId: context.tenantId,
      connectionId: context.oauthSessionId,
      credentialRef,
      abortSignal: signal,
    }, accountId);
    const finalized = await this.dependencies.sessions.finalizeConnection({
      context: { ...context, status: "exchanging", selectedAccountReference: accountId },
      discovery,
      provisionalCredentialRef: credentialRef,
    });
    const { credentialRef: liveCredentialRef, ...result } = finalized;
    const webhookSetup = await this.provisionDeputyWebhooks(context, result.connectionId, liveCredentialRef, signal);
    return response({
      oauthSessionId: context.oauthSessionId,
      status: "connected",
      ...result,
      ...(webhookSetup ? { webhookSetup } : {}),
    });
  }

  private async provisionDeputyWebhooks(
    context: Readonly<{ tenantId: string; provider: Provider }>,
    connectionId: string,
    credentialRef: string,
    signal: AbortSignal,
  ): Promise<DeputyWebhookSetupResult | undefined> {
    if (context.provider !== "deputy") return undefined;
    const connector = this.dependencies.connectors.create(
      "deputy",
      this.dependencies.credentialVaults.reader(),
    );
    if (!("provision_webhooks" in connector) || typeof connector.provision_webhooks !== "function") {
      throw new Error("deputy_webhook_provisioner_unavailable");
    }
    try {
      return await this.dependencies.deputyWebhooks.provision({
        connector: connector as Parameters<DeputyWebhookSetupCoordinator["provision"]>[0]["connector"],
        context: {
          tenantId: context.tenantId,
          connectionId,
          credentialRef,
          abortSignal: signal,
        },
      });
    } catch {
      // OAuth is already durable at this point. Returning an explicit retryable
      // state prevents a successful connection from masquerading as a failed
      // callback while reconnecting remains a safe setup retry.
      return Object.freeze({
        state: "retryable",
        reasonCode: "deputy_webhook_setup_retry_required",
        provisionedTopics: Object.freeze([]),
      });
    }
  }

  private async disconnect(input: Record<string, unknown>, signal: AbortSignal) {
    const record = await this.dependencies.disconnects.load({
      tenantId: requiredString(input, "tenantId", 26),
      connectionId: requiredString(input, "connectionId", 26),
      userId: requiredString(input, "userId", 36),
    });
    const connector = this.dependencies.connectors.create(
      record.connectorId,
      this.dependencies.credentialVaults.reader(),
    );
    let remoteStatus: "succeeded" | "unsupported" | "failed" =
      record.connectorId === "deputy" ? "unsupported" : "succeeded";
    try {
      await connector.revoke_credentials({
        tenantId: record.tenantId,
        connectionId: record.connectionId,
        credentialRef: record.credentialRef,
        abortSignal: signal,
      });
    } catch (error) {
      remoteStatus = "failed";
      void error;
    }
    const deletionRequestId = await this.dependencies.disconnects.finalize(record, remoteStatus);
    return response({ status: "disconnected", deletionRequestId, remoteRevocation: remoteStatus }, 202);
  }
}

function internalSigningSecretBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
