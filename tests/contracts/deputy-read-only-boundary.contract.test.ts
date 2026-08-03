import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { DeputyConnector } from "../../connectors/deputy/index.js";
import {
  DEPUTY_REVIEWED_UNSUPPORTED_FIELDS,
  deputyManifest,
} from "../../connectors/deputy/manifest.js";
import type {
  CredentialRefreshLeaseContext,
  OAuthCredentialSecret,
  VersionedCredential,
  WorkerCredentialVault,
} from "../../packages/connector-sdk/src/index.js";
import { signInternalRequest } from "../../packages/security/src/index.js";
import { OAuthWorkerHttpHandler } from "../../services/sync-workers/src/oauth-http.js";
import type { OAuthConnectorFactory } from "../../services/sync-workers/src/oauth-http.js";
import type { OAuthSessionStore } from "../../services/sync-workers/src/oauth-session-store.js";

type DeputyFixture = Readonly<{
  responses: Readonly<Record<string, unknown>>;
}>;

class MemoryVault implements WorkerCredentialVault {
  private revision = 1;

  constructor(private secret: OAuthCredentialSecret) {}

  async create(secret: OAuthCredentialSecret): Promise<VersionedCredential> {
    this.secret = secret;
    return this.read("oauth-deputy-fixture");
  }

  async read(credentialRef: string): Promise<VersionedCredential> {
    return { credentialRef, revision: String(this.revision), secret: this.secret };
  }

  async compareAndSwap(
    credentialRef: string,
    expectedRevision: string,
    secret: OAuthCredentialSecret,
  ): Promise<VersionedCredential> {
    assert.equal(expectedRevision, String(this.revision));
    this.secret = secret;
    this.revision += 1;
    return this.read(credentialRef);
  }

  withRefreshLease<T>(
    _credentialRef: string,
    operation: (lease: CredentialRefreshLeaseContext) => Promise<T>,
    abortSignal = new AbortController().signal,
  ): Promise<T> {
    return operation({
      abortSignal,
      proof: { leaseId: "01H00000000000000000000000", fencingToken: "1" },
    });
  }

  async destroy(): Promise<void> {
    throw new Error("not_used");
  }
}

const context = Object.freeze({
  tenantId: "01J00000000000000000000001",
  connectionId: "01J00000000000000000000002",
  credentialRef: "oauth-deputy-fixture",
});

function requestUrl(input: string | URL | Request): URL {
  return new URL(input instanceof Request ? input.url : input.toString());
}

function assertReadOnlyDeputyCall(method: string | undefined, url: URL): void {
  const normalizedMethod = method ?? "GET";
  assert.ok(
    normalizedMethod === "GET" ||
      (normalizedMethod === "POST" && url.pathname.endsWith("/QUERY")),
    `Deputy call crossed the read-only boundary: ${normalizedMethod} ${url.pathname}`,
  );
  if (normalizedMethod === "POST") assert.match(url.pathname, /\/QUERY$/u);
  assert.doesNotMatch(url.pathname, /\/resource\/Webhook(?:\/|$)/u);
}

test("every Deputy non-OAuth vendor call is GET or a Resource QUERY POST", async () => {
  const fixture = JSON.parse(readFileSync(
    new URL("../../connectors/deputy/fixtures/sanitized-recording.json", import.meta.url),
    "utf8",
  )) as DeputyFixture;
  const calls: Array<Readonly<{ method: string; url: URL }>> = [];
  const vault = new MemoryVault({
    provider: "deputy",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    tokenType: "Bearer",
    expiresAt: "2099-01-01T00:00:00.000Z",
    scopes: ["longlife_refresh_token"],
    metadata: { endpoint: "demo.au.deputy.com" },
  });
  const connector = new DeputyConnector({
    clientId: "deputy-client",
    clientSecret: "deputy-secret",
    redirectUri: "https://albert.example/api/oauth/deputy/callback",
    vault,
    fetcher: async (input, init) => {
      const url = requestUrl(input);
      const method = init?.method ?? "GET";
      calls.push({ method, url });
      assertReadOnlyDeputyCall(method, url);
      if (url.pathname === "/api/v1/me") {
        return Response.json({ Id: 7, DisplayName: "Albert Deputy" });
      }
      const contract = deputyManifest.streams.find((stream) =>
        url.pathname.endsWith(`/resource/${stream.endpoint}`)
      );
      assert.ok(contract, `Unexpected Deputy Resource query: ${url.pathname}`);
      return Response.json(fixture.responses[contract.id]);
    },
  });

  assert.equal(await connector.check_connection(context), "healthy");
  assert.equal((await connector.discover_accounts(context)).length, 1);
  await connector.select_account(context, "demo.au.deputy.com");
  const streams = await connector.list_streams(context);
  assert.equal(streams.length, connector.manifest.streams.length);
  for (const stream of streams) {
    const page = await connector.initial_sync(context, stream, {
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-08-04T00:00:00.000Z",
    });
    assert.ok(page.records.length > 0, `${stream.id} did not execute its fixture query`);
  }

  assert.ok(calls.some(({ method, url }) => method === "GET" && url.pathname === "/api/v1/me"));
  assert.equal(calls.filter(({ method }) => method === "POST").length, streams.length);
  calls.forEach(({ method, url }) => assertReadOnlyDeputyCall(method, url));
});

test("Deputy OAuth completion performs discovery only and never provisions a webhook", async () => {
  const signingSecret = "s".repeat(48);
  const tenantId = "01J00000000000000000000003";
  const oauthSessionId = "01J00000000000000000000004";
  const connectionId = "01J00000000000000000000005";
  const userId = "00000000-0000-4000-8000-000000000001";
  const calls: Array<Readonly<{ method: string; url: URL }>> = [];
  const vault = new MemoryVault({
    provider: "deputy",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    tokenType: "Bearer",
    expiresAt: "2099-01-01T00:00:00.000Z",
    scopes: ["longlife_refresh_token"],
    metadata: { endpoint: "demo.au.deputy.com" },
  });
  const connector = new DeputyConnector({
    clientId: "deputy-client",
    clientSecret: "deputy-secret",
    redirectUri: "https://albert.example/api/oauth/deputy/callback",
    vault,
    fetcher: async (input, init) => {
      const url = requestUrl(input);
      const method = init?.method ?? "GET";
      calls.push({ method, url });
      assertReadOnlyDeputyCall(method, url);
      assert.equal(url.pathname, "/api/v1/me");
      return Response.json({ Id: 7, DisplayName: "Albert Deputy" });
    },
  });
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
    credentialVault() { return vault; },
    async provisionalCredentialReference() { return context.credentialRef; },
    async finalizeConnection(input: Readonly<{
      context: Readonly<{ selectedAccountReference: string | null }>;
    }>) {
      assert.equal(input.context.selectedAccountReference, "demo.au.deputy.com");
      return {
        connectionId,
        jobRequestId: "01J00000000000000000000006",
        credentialRef: "live-credential",
      };
    },
  } as unknown as OAuthSessionStore;
  const connectors = {
    create() { return connector; },
    scopes() { return ["longlife_refresh_token"]; },
  } as OAuthConnectorFactory;
  const handler = new OAuthWorkerHttpHandler({
    oauthWorkerSigningSecret: signingSecret,
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
    secret: signingSecret,
  });
  const response = await handler.handle(new Request("https://worker.internal/v1/oauth/callback", {
    method: "POST",
    headers: { "content-type": "application/json", ...signed },
    body,
  }));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    result: {
      oauthSessionId,
      status: "connected",
      connectionId,
      jobRequestId: "01J00000000000000000000006",
    },
  });
  assert.equal(calls.length, 2, "OAuth should perform only account discovery and selection checks");
  assert.ok(calls.every(({ method, url }) => method === "GET" && url.pathname === "/api/v1/me"));
  assert.ok(calls.every(({ url }) => !url.pathname.includes("Webhook")));
});

test("reviewed Deputy top-level fields are explicitly dispositioned and do not create false schema drift", async () => {
  const fixture = JSON.parse(readFileSync(
    new URL("../../connectors/deputy/fixtures/sanitized-recording.json", import.meta.url),
    "utf8",
  )) as DeputyFixture;
  const vault = new MemoryVault({
    provider: "deputy",
    accessToken: "access-token",
    refreshToken: "refresh-token",
    tokenType: "Bearer",
    expiresAt: "2099-01-01T00:00:00.000Z",
    scopes: ["longlife_refresh_token"],
    metadata: { endpoint: "demo.au.deputy.com" },
  });
  const connector = new DeputyConnector({
    clientId: "deputy-client",
    clientSecret: "deputy-secret",
    redirectUri: "https://albert.example/api/oauth/deputy/callback",
    vault,
    fetcher: async (input, init) => {
      const url = requestUrl(input);
      assertReadOnlyDeputyCall(init?.method, url);
      const contract = deputyManifest.streams.find((stream) =>
        url.pathname.endsWith(`/resource/${stream.endpoint}`)
      );
      assert.ok(contract);
      const base = (fixture.responses[contract.id] as readonly Record<string, unknown>[])[0];
      assert.ok(base);
      const reviewed = DEPUTY_REVIEWED_UNSUPPORTED_FIELDS[
        contract.id as keyof typeof DEPUTY_REVIEWED_UNSUPPORTED_FIELDS
      ] ?? [];
      return Response.json([{ ...base, ...Object.fromEntries(reviewed.map((field) => [field, "reviewed-source-value"])) }]);
    },
  });

  for (const [stream, fields] of Object.entries(DEPUTY_REVIEWED_UNSUPPORTED_FIELDS)) {
    const dispositions = deputyManifest.fieldCoverage.filter((entry) => entry.stream === stream);
    for (const field of fields) {
      const matches = dispositions.filter((entry) => entry.field === field);
      assert.equal(matches.length, 1, `${stream}.${field} must have exactly one reviewed disposition`);
      assert.equal(matches[0]?.disposition, "unsupported");
      assert.ok(matches[0]?.reason?.trim(), `${stream}.${field} must explain its exclusion`);
      assert.ok(matches[0]?.pii, `${stream}.${field} must have a PII classification`);
    }
    const connectorStream = (await connector.list_streams(context)).find((candidate) => candidate.id === stream);
    assert.ok(connectorStream);
    const page = await connector.initial_sync(context, connectorStream, {
      from: "2026-07-01T00:00:00.000Z",
      to: "2026-08-04T00:00:00.000Z",
    });
    assert.equal(page.records.length, 1);
    assert.equal(page.records[0]?.validationIssues?.some((issue) => issue.code === "schema_drift") ?? false, false);
    for (const field of fields) {
      assert.equal(field in (page.records[0]?.normalized?.fields ?? {}), false);
    }
  }
});
