import assert from "node:assert/strict";
import test from "node:test";
import { signInternalRequest } from "../../packages/security/src/index.js";
import type { CredentialVaultFactory } from "./src/credential-vault.js";
import type { OAuthConnectorPack, WorkerCredentialVault } from "../../packages/connector-sdk/src/index.js";
import type { DisconnectStore, OAuthConnectorFactory } from "./src/oauth-http.js";
import { OAuthWorkerHttpHandler } from "./src/oauth-http.js";
import type { OAuthSessionStore } from "./src/oauth-session-store.js";
import type { DeputyWebhookSetupCoordinator } from "./src/deputy-webhooks.js";

const unusedDeputyWebhooks = {} as DeputyWebhookSetupCoordinator;

test("OAuth worker stores the web-bound state hash and encrypted-PKCE input contract", async () => {
  const secret = "s".repeat(48);
  const captured: Record<string, unknown>[] = [];
  const sessions = {
    async create(input: Record<string, unknown>) {
      captured.push(input);
      return "01J00000000000000000000001";
    },
  } as unknown as OAuthSessionStore;
  const connectors = {
    scopes() { return ["accounting.transactions.read"]; },
    create() { throw new Error("not_used_during_start"); },
  } as OAuthConnectorFactory;
  const handler = new OAuthWorkerHttpHandler({
    oauthWorkerSigningSecret: secret,
    allowedRedirectUris: new Set(["https://albert.example/api/oauth/xero/callback"]),
    sessions,
    credentialVaults: {} as CredentialVaultFactory,
    connectors,
    disconnects: {} as DisconnectStore,
    deputyWebhooks: unusedDeputyWebhooks,
  });
  const payload = {
    tenantId: "01J00000000000000000000002",
    userId: "00000000-0000-4000-8000-000000000001",
    provider: "xero",
    redirectUri: "https://albert.example/api/oauth/xero/callback",
    stateNonceHash: "a".repeat(64),
    codeVerifier: "v".repeat(64),
    expiresAt: new Date(Date.now() + 9 * 60_000).toISOString(),
  };
  const body = JSON.stringify(payload);
  const signed = await signInternalRequest({ method: "POST", path: "/v1/oauth/start", body, secret });
  const response = await handler.handle(new Request("https://worker.internal/v1/oauth/start", {
    method: "POST",
    headers: { "content-type": "application/json", ...signed },
    body,
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    result: { oauthSessionId: "01J00000000000000000000001" },
  });
  assert.equal(captured[0]?.stateNonceHash, payload.stateNonceHash);
  assert.equal(captured[0]?.codeVerifier, payload.codeVerifier);
});

test("OAuth worker rejects unsigned internal calls", async () => {
  const handler = new OAuthWorkerHttpHandler({
    oauthWorkerSigningSecret: "s".repeat(48),
    allowedRedirectUris: new Set(),
    sessions: {} as OAuthSessionStore,
    credentialVaults: {} as CredentialVaultFactory,
    connectors: {} as OAuthConnectorFactory,
    disconnects: {} as DisconnectStore,
    deputyWebhooks: unusedDeputyWebhooks,
  });
  const response = await handler.handle(new Request("https://worker.internal/v1/oauth/start", {
    method: "POST",
    body: "{}",
  }));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "unauthorised" });
});

test("OAuth callbacks cancel a hung vendor exchange before the web callback deadline", async () => {
  const secret = "s".repeat(48);
  const tenantId = "01J00000000000000000000002";
  const oauthSessionId = "01J00000000000000000000003";
  const userId = "00000000-0000-4000-8000-000000000001";
  let exchangeSignal: AbortSignal | undefined;
  const sessions = {
    async loadForCallback() {
      return {
        tenantId,
        oauthSessionId,
        initiatedBy: userId,
        provider: "xero",
        redirectUri: "https://albert.example/api/oauth/xero/callback",
        requestedScopes: [],
        status: "pending",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        codeVerifier: "v".repeat(64),
        choices: [],
        selectedAccountReference: null,
      } as const;
    },
    credentialVault() { return {} as WorkerCredentialVault; },
    async provisionalCredentialReference() { throw new Error("session_credential_not_found"); },
  } as unknown as OAuthSessionStore;
  const connector = {
    async exchange_authorization_code(request: { abortSignal?: AbortSignal }) {
      exchangeSignal = request.abortSignal;
      return await new Promise<never>(() => undefined);
    },
  } as unknown as OAuthConnectorPack;
  const connectors = {
    scopes() { return []; },
    create() { return connector; },
  } as OAuthConnectorFactory;
  const handler = new OAuthWorkerHttpHandler({
    oauthWorkerSigningSecret: secret,
    allowedRedirectUris: new Set(),
    sessions,
    credentialVaults: {} as CredentialVaultFactory,
    connectors,
    disconnects: {} as DisconnectStore,
    deputyWebhooks: unusedDeputyWebhooks,
    operationTimeoutMs: 20,
  });
  const body = JSON.stringify({
    tenantId,
    oauthSessionId,
    userId,
    provider: "xero",
    stateNonceHash: "a".repeat(64),
    code: "vendor-code",
  });
  const signed = await signInternalRequest({
    method: "POST",
    path: "/v1/oauth/callback",
    body,
    secret,
  });
  const startedAt = Date.now();
  const response = await handler.handle(new Request("https://worker.internal/v1/oauth/callback", {
    method: "POST",
    headers: { "content-type": "application/json", ...signed },
    body,
  }));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "oauth_worker_timeout" });
  assert.ok(Date.now() - startedAt < 1_000, "OAuth callback outlived its operation deadline");
  assert.equal(exchangeSignal?.aborted, true);
});

test("Deputy OAuth completion provisions connection-bound webhooks after durable finalisation", async () => {
  const secret = "s".repeat(48);
  const tenantId = "01J00000000000000000000002";
  const oauthSessionId = "01J00000000000000000000003";
  const connectionId = "01J00000000000000000000004";
  const userId = "00000000-0000-4000-8000-000000000001";
  const order: string[] = [];
  const provisionalVault = {} as WorkerCredentialVault;
  const liveVault = {} as WorkerCredentialVault;
  const account = {
    externalAccountId: "demo.au.deputy.com",
    displayName: "Albert Deputy",
    metadata: { endpoint: "demo.au.deputy.com" },
  } as const;
  const selectionConnector = {
    async discover_accounts() { return [account]; },
    async select_account() { return account; },
  } as unknown as OAuthConnectorPack;
  const liveConnector = { provision_webhooks() { throw new Error("coordinator_owns_call"); } };
  const sessions = {
    async loadForCallback() {
      return {
        tenantId,
        oauthSessionId,
        initiatedBy: userId,
        provider: "deputy",
        redirectUri: "https://albert.example/api/oauth/deputy/callback",
        requestedScopes: ["longlife_refresh_token"],
        status: "pending",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        codeVerifier: undefined,
        choices: [],
        selectedAccountReference: null,
      } as const;
    },
    credentialVault() { return provisionalVault; },
    async provisionalCredentialReference() { return "provisional-credential"; },
    async finalizeConnection() {
      order.push("finalized");
      return {
        connectionId,
        jobRequestId: "01J00000000000000000000005",
        credentialRef: "live-credential",
      };
    },
  } as unknown as OAuthSessionStore;
  const connectors = {
    scopes() { return ["longlife_refresh_token"]; },
    create(_provider: string, vault: WorkerCredentialVault) {
      return vault === provisionalVault
        ? selectionConnector
        : liveConnector as unknown as OAuthConnectorPack;
    },
  } as OAuthConnectorFactory;
  const deputyWebhooks = {
    async provision(input: { connector: unknown; context: Record<string, unknown> }) {
      order.push("provisioned");
      assert.equal(input.connector, liveConnector);
      assert.deepEqual(input.context, {
        tenantId,
        connectionId,
        credentialRef: "live-credential",
        abortSignal: input.context.abortSignal,
      });
      assert.ok(input.context.abortSignal instanceof AbortSignal);
      return {
        state: "active" as const,
        provisionedTopics: ["Timesheet.Update"],
      };
    },
  } as unknown as DeputyWebhookSetupCoordinator;
  const handler = new OAuthWorkerHttpHandler({
    oauthWorkerSigningSecret: secret,
    allowedRedirectUris: new Set(),
    sessions,
    credentialVaults: { reader: () => liveVault } as CredentialVaultFactory,
    connectors,
    disconnects: {} as DisconnectStore,
    deputyWebhooks,
  });
  const body = JSON.stringify({
    tenantId,
    oauthSessionId,
    userId,
    provider: "deputy",
    stateNonceHash: "a".repeat(64),
    code: "already-exchanged",
  });
  const signed = await signInternalRequest({
    method: "POST",
    path: "/v1/oauth/callback",
    body,
    secret,
  });
  const response = await handler.handle(new Request("https://worker.internal/v1/oauth/callback", {
    method: "POST",
    headers: { "content-type": "application/json", ...signed },
    body,
  }));
  assert.equal(response.status, 200);
  assert.deepEqual(order, ["finalized", "provisioned"]);
  assert.deepEqual(await response.json(), {
    result: {
      oauthSessionId,
      status: "connected",
      connectionId,
      jobRequestId: "01J00000000000000000000005",
      webhookSetup: {
        state: "active",
        provisionedTopics: ["Timesheet.Update"],
      },
    },
  });
});
