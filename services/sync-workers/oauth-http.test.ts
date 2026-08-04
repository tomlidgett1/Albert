import assert from "node:assert/strict";
import test from "node:test";
import { signInternalRequest } from "../../packages/security/src/index.js";
import type { OAuthConnectorPack, WorkerCredentialVault } from "../../packages/connector-sdk/src/index.js";
import type { OAuthConnectorFactory } from "./src/oauth-http.js";
import { OAuthWorkerHttpHandler } from "./src/oauth-http.js";
import type { OAuthSessionStore } from "./src/oauth-session-store.js";

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
    connectors,
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
    result: {
      oauthSessionId: "01J00000000000000000000001",
      scopes: ["accounting.transactions.read"],
    },
  });
  assert.equal(captured[0]?.stateNonceHash, payload.stateNonceHash);
  assert.equal(captured[0]?.codeVerifier, payload.codeVerifier);
});

test("OAuth worker rejects unsigned internal calls", async () => {
  const handler = new OAuthWorkerHttpHandler({
    oauthWorkerSigningSecret: "s".repeat(48),
    allowedRedirectUris: new Set(),
    sessions: {} as OAuthSessionStore,
    connectors: {} as OAuthConnectorFactory,
  });
  const response = await handler.handle(new Request("https://worker.internal/v1/oauth/start", {
    method: "POST",
    body: "{}",
  }));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "unauthorised" });
});

test("OAuth callback replays committed selection and terminal outcomes after response loss", async () => {
  const secret = "s".repeat(48);
  const tenantId = "01J00000000000000000000002";
  const oauthSessionId = "01J00000000000000000000003";
  const userId = "00000000-0000-4000-8000-000000000001";
  const redirectUri = "https://albert.example/api/oauth/xero/callback";
  const replays = [
    {
      replay: {
        provider: "xero" as const,
        redirectUri,
        status: "selection_required" as const,
        choices: [
          { externalAccountId: "tenant-a", displayName: "A", metadata: {} },
          { externalAccountId: "tenant-b", displayName: "B", metadata: {} },
        ],
      },
      expectedStatus: 202,
    },
    {
      replay: {
        provider: "xero" as const,
        redirectUri,
        status: "connected" as const,
        connectionId: "01J00000000000000000000004",
        jobRequestId: "01J00000000000000000000005",
      },
      expectedStatus: 200,
    },
  ] as const;

  for (const { replay, expectedStatus } of replays) {
    const sessions = {
      async loadCallbackReplay() { return replay; },
      async loadForCallback() { throw new Error("committed_replay_must_not_load_secrets"); },
    } as unknown as OAuthSessionStore;
    const handler = new OAuthWorkerHttpHandler({
      oauthWorkerSigningSecret: secret,
      allowedRedirectUris: new Set(),
      sessions,
      connectors: {
        scopes() { return []; },
        create() { throw new Error("committed_replay_must_not_call_provider"); },
      },
    });
    const body = JSON.stringify({
      tenantId,
      oauthSessionId,
      userId,
      provider: "xero",
      redirectUri,
      stateNonceHash: "a".repeat(64),
      code: "already-consumed",
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

    assert.equal(response.status, expectedStatus);
    const payload = await response.json() as { result?: { status?: string } };
    assert.equal(payload.result?.status, replay.status);
  }
});

test("OAuth callbacks cancel a hung vendor exchange before the web callback deadline", async () => {
  const secret = "s".repeat(48);
  const tenantId = "01J00000000000000000000002";
  const oauthSessionId = "01J00000000000000000000003";
  const userId = "00000000-0000-4000-8000-000000000001";
  let exchangeSignal: AbortSignal | undefined;
  const sessions = {
    async loadCallbackReplay() { return null; },
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
    connectors,
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
  // Outside production the handler appends a sanitised `detail` string for
  // operator debugging; only the stable error code is contractual.
  const payload = await response.json() as { error: string };
  assert.equal(payload.error, "oauth_worker_timeout");
  assert.ok(Date.now() - startedAt < 1_000, "OAuth callback outlived its operation deadline");
  assert.equal(exchangeSignal?.aborted, true);
});

test("Deputy OAuth completion finalises the connection without a webhook provisioning path", async () => {
  const secret = "s".repeat(48);
  const tenantId = "01J00000000000000000000002";
  const oauthSessionId = "01J00000000000000000000003";
  const connectionId = "01J00000000000000000000004";
  const userId = "00000000-0000-4000-8000-000000000001";
  const order: string[] = [];
  const provisionalVault = {} as WorkerCredentialVault;
  const account = {
    externalAccountId: "demo.au.deputy.com",
    displayName: "Albert Deputy",
    metadata: { endpoint: "demo.au.deputy.com" },
  } as const;
  const selectionConnector = {
    async discover_accounts() { return [account]; },
    async select_account() { return account; },
  } as unknown as OAuthConnectorPack;
  const sessions = {
    async loadCallbackReplay() { return null; },
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
      assert.equal(vault, provisionalVault);
      order.push("connector_created");
      return selectionConnector;
    },
  } as OAuthConnectorFactory;
  const handler = new OAuthWorkerHttpHandler({
    oauthWorkerSigningSecret: secret,
    allowedRedirectUris: new Set(),
    sessions,
    connectors,
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
  assert.deepEqual(order, ["connector_created", "finalized"]);
  assert.deepEqual(await response.json(), {
    result: {
      oauthSessionId,
      status: "connected",
      connectionId,
      jobRequestId: "01J00000000000000000000005",
    },
  });
});

test("OAuth worker exposes no disconnect endpoint or client-supplied actor path", async () => {
  const secret = "s".repeat(48);
  const handler = new OAuthWorkerHttpHandler({
    oauthWorkerSigningSecret: secret,
    allowedRedirectUris: new Set(),
    sessions: {} as OAuthSessionStore,
    connectors: {} as OAuthConnectorFactory,
  });
  const body = JSON.stringify({
    tenantId: "01J00000000000000000000002",
    connectionId: "01J00000000000000000000004",
    userId: "00000000-0000-4000-8000-000000000001",
  });
  const signed = await signInternalRequest({
    method: "POST",
    path: "/v1/oauth/disconnect",
    body,
    secret,
  });
  const response = await handler.handle(new Request("https://worker.internal/v1/oauth/disconnect", {
    method: "POST",
    headers: { "content-type": "application/json", ...signed },
    body,
  }));

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "not_found" });
});
