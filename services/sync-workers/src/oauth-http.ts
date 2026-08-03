import { verifyInternalRequest } from "../../../packages/security/src/index.js";
import {
  ConnectorError,
  createDeadlineSignal,
  raceWithSignal,
  type OAuthConnectorPack,
  type WorkerCredentialVault,
} from "../../../packages/connector-sdk/src/index.js";
import { OAuthSessionStore } from "./oauth-session-store.js";

type Provider = "lightspeed-r" | "xero" | "deputy";

export interface OAuthConnectorFactory {
  create(provider: Provider, vault: WorkerCredentialVault): OAuthConnectorPack;
  scopes(provider: Provider): readonly string[];
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
      : /deletion_(?:in_progress|irreversible)|conflict|already/.test(code)
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
    connectors: OAuthConnectorFactory;
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
    return response({ oauthSessionId, scopes: [...scopes] });
  }

  private async callback(input: Record<string, unknown>, signal: AbortSignal) {
    const callbackIdentity = {
      tenantId: requiredString(input, "tenantId", 26),
      oauthSessionId: requiredString(input, "oauthSessionId", 26),
      initiatedBy: requiredString(input, "userId", 36),
      stateNonceHash: stateNonceHash(input),
    } as const;
    const replay = await this.dependencies.sessions.loadCallbackReplay(callbackIdentity);
    if (replay) {
      if (input.provider !== undefined && provider(input) !== replay.provider) {
        throw new Error("oauth_provider_mismatch");
      }
      if (input.redirectUri !== undefined && requiredString(input, "redirectUri", 1000) !== replay.redirectUri) {
        throw new Error("oauth_redirect_mismatch");
      }
      return replay.status === "selection_required"
        ? response({
            oauthSessionId: callbackIdentity.oauthSessionId,
            status: replay.status,
            choices: replay.choices,
          }, 202)
        : response({
            oauthSessionId: callbackIdentity.oauthSessionId,
            status: replay.status,
            connectionId: replay.connectionId,
            jobRequestId: replay.jobRequestId,
          });
    }
    const context = await this.dependencies.sessions.loadForCallback({
      ...callbackIdentity,
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
    const result = {
      connectionId: finalized.connectionId,
      jobRequestId: finalized.jobRequestId,
    };
    return response({
      oauthSessionId: context.oauthSessionId,
      status: "connected",
      ...result,
    });
  }

  private async select(input: Record<string, unknown>, signal: AbortSignal) {
    const selectionIdentity = {
      tenantId: requiredString(input, "tenantId", 26),
      oauthSessionId: requiredString(input, "oauthSessionId", 26),
      initiatedBy: requiredString(input, "userId", 36),
      selectedAccountReference: requiredString(input, "externalAccountId", 300),
    } as const;
    const replay = await this.dependencies.sessions.loadSelectionReplay(selectionIdentity);
    if (replay) {
      return response({
        oauthSessionId: selectionIdentity.oauthSessionId,
        status: "connected",
        connectionId: replay.connectionId,
        jobRequestId: replay.jobRequestId,
      });
    }
    const context = await this.dependencies.sessions.loadForSelection(selectionIdentity);
    const accountId = selectionIdentity.selectedAccountReference;
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
    const result = {
      connectionId: finalized.connectionId,
      jobRequestId: finalized.jobRequestId,
    };
    return response({
      oauthSessionId: context.oauthSessionId,
      status: "connected",
      ...result,
    });
  }

}

function internalSigningSecretBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
