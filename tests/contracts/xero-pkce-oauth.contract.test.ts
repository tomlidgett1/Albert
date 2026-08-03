import assert from "node:assert/strict";
import test from "node:test";

import { XeroConnector } from "../../connectors/xero/index.js";
import type {
  CredentialRefreshLeaseContext,
  CredentialRefreshLeaseProof,
  OAuthCredentialSecret,
  VersionedCredential,
  WorkerCredentialVault,
} from "../../packages/connector-sdk/src/index.js";

const CLIENT_ID = "xero-public-client";
const PUBLIC_CLIENT_AUTHORIZATION = `Basic ${Buffer.from(`${CLIENT_ID}:`, "utf8").toString("base64")}`;
const CONTEXT = {
  tenantId: "tenant-test",
  connectionId: "connection-test",
  credentialRef: "credential:xero-test",
} as const;

class MemoryVault implements WorkerCredentialVault {
  private revision = 1;
  destroyed = false;

  constructor(private secret?: OAuthCredentialSecret) {}

  async create(secret: OAuthCredentialSecret): Promise<VersionedCredential> {
    this.secret = secret;
    return this.read(CONTEXT.credentialRef);
  }

  async read(credentialRef: string): Promise<VersionedCredential> {
    assert.ok(this.secret, "credential must exist");
    return { credentialRef, revision: String(this.revision), secret: this.secret };
  }

  async compareAndSwap(
    credentialRef: string,
    expectedRevision: string,
    secret: OAuthCredentialSecret,
    refreshLease?: CredentialRefreshLeaseProof,
  ): Promise<VersionedCredential> {
    assert.equal(expectedRevision, String(this.revision));
    assert.deepEqual(refreshLease, {
      leaseId: "01H00000000000000000000000",
      fencingToken: "1",
    });
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
    this.destroyed = true;
    this.secret = undefined;
  }
}

function requestBody(init: RequestInit | undefined): URLSearchParams {
  assert.ok(init?.body instanceof URLSearchParams);
  return init.body;
}

function assertPublicClientAuthentication(init: RequestInit | undefined): void {
  const headers = new Headers(init?.headers);
  assert.equal(headers.get("authorization"), PUBLIC_CLIENT_AUTHORIZATION);
  assert.doesNotMatch(headers.get("authorization") ?? "", /secret/iu);
  assert.equal(headers.get("content-type"), "application/x-www-form-urlencoded");
}

test("Xero PKCE exchanges an authorization code as a secretless public client", async () => {
  const vault = new MemoryVault();
  const connector = new XeroConnector({
    clientId: CLIENT_ID,
    vault,
    fetcher: async (input, init) => {
      assert.equal(String(input), "https://identity.xero.com/connect/token");
      assert.equal(init?.method, "POST");
      assertPublicClientAuthentication(init);
      const body = requestBody(init);
      assert.equal(body.get("grant_type"), "authorization_code");
      assert.equal(body.get("client_id"), CLIENT_ID);
      assert.equal(body.get("code"), "one-use-code");
      assert.equal(body.get("redirect_uri"), "https://albert.example/api/oauth/xero/callback");
      assert.equal(body.get("code_verifier"), "v".repeat(64));
      assert.equal(body.get("client_secret"), null);
      return Response.json({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 1_800,
        token_type: "Bearer",
        scope: "offline_access accounting.settings.read",
      });
    },
  });

  const result = await connector.exchange_authorization_code({
    code: "one-use-code",
    redirectUri: "https://albert.example/api/oauth/xero/callback",
    codeVerifier: "v".repeat(64),
  });

  assert.equal(result.credentialRef, CONTEXT.credentialRef);
  assert.equal((await vault.read(result.credentialRef)).secret.refreshToken, "refresh-token");
});

test("Xero rotates refresh tokens as a secretless public client", async () => {
  const vault = new MemoryVault({
    provider: "xero",
    accessToken: "old-access-token",
    refreshToken: "old-refresh-token",
    tokenType: "Bearer",
    expiresAt: "2099-01-01T00:00:00.000Z",
    scopes: ["offline_access", "accounting.settings.read"],
    metadata: { xeroTenantId: "xero-tenant" },
  });
  const connector = new XeroConnector({
    clientId: CLIENT_ID,
    vault,
    fetcher: async (input, init) => {
      assert.equal(String(input), "https://identity.xero.com/connect/token");
      assert.equal(init?.method, "POST");
      assertPublicClientAuthentication(init);
      const body = requestBody(init);
      assert.equal(body.get("grant_type"), "refresh_token");
      assert.equal(body.get("client_id"), CLIENT_ID);
      assert.equal(body.get("refresh_token"), "old-refresh-token");
      assert.equal(body.get("client_secret"), null);
      return Response.json({
        access_token: "new-access-token",
        refresh_token: "new-refresh-token",
        expires_in: 1_800,
        token_type: "Bearer",
        scope: "offline_access accounting.settings.read",
      });
    },
  });

  await connector.refresh_credentials(CONTEXT);

  const rotated = await vault.read(CONTEXT.credentialRef);
  assert.equal(rotated.secret.accessToken, "new-access-token");
  assert.equal(rotated.secret.refreshToken, "new-refresh-token");
  assert.equal(rotated.revision, "2");
});

test("Xero revokes a refresh token as a secretless public client", async () => {
  const vault = new MemoryVault({
    provider: "xero",
    accessToken: "access-token",
    refreshToken: "refresh-token-to-revoke",
    tokenType: "Bearer",
    expiresAt: "2099-01-01T00:00:00.000Z",
    scopes: ["offline_access"],
    metadata: { xeroTenantId: "xero-tenant" },
  });
  const connector = new XeroConnector({
    clientId: CLIENT_ID,
    vault,
    fetcher: async (input, init) => {
      assert.equal(String(input), "https://identity.xero.com/connect/revocation");
      assert.equal(init?.method, "POST");
      assertPublicClientAuthentication(init);
      const body = requestBody(init);
      assert.equal(body.get("token"), "refresh-token-to-revoke");
      assert.equal(body.get("client_secret"), null);
      return new Response(null, { status: 200 });
    },
  });

  await connector.revoke_credentials(CONTEXT);

  assert.equal(vault.destroyed, true);
});
