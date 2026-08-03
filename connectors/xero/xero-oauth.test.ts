import assert from "node:assert/strict";
import test from "node:test";

import type {
  CredentialRefreshLeaseContext,
  OAuthCredentialSecret,
  VersionedCredential,
  WorkerCredentialVault,
} from "../../packages/connector-sdk/src/index.js";
import { XeroConnector, type XeroConnectorConfig } from "./index.js";

class CaptureVault implements WorkerCredentialVault {
  secret?: OAuthCredentialSecret;

  async create(secret: OAuthCredentialSecret): Promise<VersionedCredential> {
    this.secret = secret;
    return { credentialRef: "credential", revision: "1", secret };
  }

  async read(): Promise<VersionedCredential> {
    if (!this.secret) throw new Error("credential_not_found");
    return { credentialRef: "credential", revision: "1", secret: this.secret };
  }

  async compareAndSwap(): Promise<VersionedCredential> {
    throw new Error("not_used");
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

  async destroy(): Promise<void> {}
}

test("Xero OAuth is pinned to the documented public-client PKCE exchange", async () => {
  const vault = new CaptureVault();
  let authorization = "";
  let body = "";
  const connector = new XeroConnector({
    clientId: "xero-client",
    vault,
    fetcher: async (_input, init) => {
      authorization = new Headers(init?.headers).get("authorization") ?? "";
      body = String(init?.body);
      return Response.json({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 1800,
        token_type: "Bearer",
        scope: "offline_access accounting.settings.read",
      });
    },
  });

  await connector.exchange_authorization_code({
    code: "code",
    redirectUri: "https://albert.example/api/oauth/xero/callback",
    codeVerifier: "v".repeat(64),
  });

  assert.equal(authorization, "");
  assert.match(body, /client_id=xero-client/u);
  assert.match(body, /code_verifier=/u);
  assert.doesNotMatch(`${authorization}${body}`, /client-secret/iu);
  assert.throws(
    () => new XeroConnector({
      clientId: "xero-client",
      oauthMode: "confidential",
      vault,
    } as unknown as XeroConnectorConfig),
    /pinned to PKCE/iu,
  );
});
