import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { EnvelopeCryptography } from "../../services/sync-workers/src/credential-vault.js";
import type { TransactionalPostgres } from "../../services/sync-workers/src/database.js";
import { OAuthSessionStore } from "../../services/sync-workers/src/oauth-session-store.js";

test("OAuth callback and account selection re-authorize the initiating connection administrator", async () => {
  const statements: string[] = [];
  const database = {
    async query(sql: string) {
      statements.push(sql);
      return { rows: [] };
    },
  } as unknown as TransactionalPostgres;
  const cryptography = {} as EnvelopeCryptography;
  const store = new OAuthSessionStore(database, cryptography);

  await assert.rejects(
    store.loadForCallback({
      tenantId: "01K1ZZZZZZ0000000000000001",
      oauthSessionId: "01K1ZZZZZZ0000000000000002",
      initiatedBy: "10000000-0000-4000-8000-000000000001",
      stateNonceHash: "a".repeat(64),
    }),
    /oauth_session_not_found/,
  );

  const authorizationQuery = statements[0] ?? "";
  assert.match(authorizationQuery, /join control_plane\.memberships as membership/i);
  assert.match(authorizationQuery, /membership\.user_id = session\.initiated_by/i);
  assert.match(authorizationQuery, /membership\.status = 'active'/i);
  assert.match(authorizationQuery, /membership\.role in \('owner', 'manager'\)/i);
});

test("multi-account selection receives a fresh bounded window for the authenticated initiator", async () => {
  const statements: string[] = [];
  const database = {
    async query(sql: string) {
      statements.push(sql);
      return { rows: [{ oauth_session_id: "01K1ZZZZZZ0000000000000002" }] };
    },
  } as unknown as TransactionalPostgres;
  const store = new OAuthSessionStore(database, {} as EnvelopeCryptography);
  const context = {
    tenantId: "01K1ZZZZZZ0000000000000001",
    oauthSessionId: "01K1ZZZZZZ0000000000000002",
    initiatedBy: "10000000-0000-4000-8000-000000000001",
    provider: "xero" as const,
    redirectUri: "https://albert.example/api/oauth/xero/callback",
    requestedScopes: ["offline_access"],
    status: "pending" as const,
    expiresAt: new Date(Date.now() + 5_000).toISOString(),
    codeVerifier: "v".repeat(64),
    choices: [],
    selectedAccountReference: null,
  };

  await store.setAccountChoices(context, [
    { externalAccountId: "tenant-a", displayName: "A", metadata: {} },
    { externalAccountId: "tenant-b", displayName: "B", metadata: {} },
  ]);

  const transition = statements[0] ?? "";
  assert.match(transition, /status = 'selecting_account'/iu);
  assert.match(transition, /expires_at = greatest\(expires_at, now\(\) \+ interval '10 minutes'\)/iu);
  assert.match(transition, /initiated_by = \$3/iu);
  assert.match(transition, /status = 'pending' and expires_at > now\(\)/iu);
});

test("committed OAuth callback outcomes replay without credential envelopes", async () => {
  const completion = {
    provider: "xero" as const,
    redirect_uri: "https://albert.example/api/oauth/xero/callback",
    state_nonce_hash: "a".repeat(64),
    status: "consumed",
    expires_at: new Date(Date.now() - 60_000),
    discovered_account_choices: null,
    selected_account_reference: "tenant-a",
    completion_result: {
      connectionId: "01K1ZZZZZZ0000000000000003",
      jobRequestId: "01K1ZZZZZZ0000000000000004",
    },
  };
  const database = {
    async query() { return { rows: [completion] }; },
  } as unknown as TransactionalPostgres;
  const store = new OAuthSessionStore(database, {} as EnvelopeCryptography);

  const replay = await store.loadCallbackReplay({
    tenantId: "01K1ZZZZZZ0000000000000001",
    oauthSessionId: "01K1ZZZZZZ0000000000000002",
    initiatedBy: "10000000-0000-4000-8000-000000000001",
    stateNonceHash: "a".repeat(64),
  });

  assert.deepEqual(replay, {
    provider: "xero",
    redirectUri: completion.redirect_uri,
    status: "connected",
    connectionId: completion.completion_result.connectionId,
    jobRequestId: completion.completion_result.jobRequestId,
  });
  assert.deepEqual(await store.loadSelectionReplay({
    tenantId: "01K1ZZZZZZ0000000000000001",
    oauthSessionId: "01K1ZZZZZZ0000000000000002",
    initiatedBy: "10000000-0000-4000-8000-000000000001",
    selectedAccountReference: "tenant-a",
  }), {
    connectionId: completion.completion_result.connectionId,
    jobRequestId: completion.completion_result.jobRequestId,
  });
});

test("reconnect cancellation is an exact fixed-function capability", () => {
  const source = readFileSync("services/sync-workers/src/oauth-session-store.ts", "utf8");
  const migration = readFileSync(
    "infra/migrations/control-plane/0040_m0_m8_narrow_connection_mutation_capabilities.sql",
    "utf8",
  );
  assert.match(
    source,
    /set status = 'exchanging', selected_account_reference = \$4[\s\S]*expires_at > now\(\)[\s\S]*returning oauth_session_id/iu,
  );
  assert.match(
    source,
    /control_plane\.finalize_oauth_connection_identity\([\s\S]*input\.context\.oauthSessionId[\s\S]*input\.provisionalCredentialRef/iu,
  );
  assert.doesNotMatch(source, /(?:insert into|update|delete from) control_plane\.connections/iu);
  assert.doesNotMatch(source, /(?:select|update|insert into|delete from) control_plane\.deletion_requests/iu);
  assert.match(
    migration,
    /CREATE OR REPLACE FUNCTION control_plane\.finalize_oauth_connection_identity\([\s\S]*SECURITY DEFINER/iu,
  );
  assert.match(migration, /session_row\.status<>'exchanging'/iu);
  assert.match(migration, /session_row\.selected_account_reference IS DISTINCT FROM p_external_account_reference/iu);
  assert.match(migration, /cancel_reconnectable_connection_deletion\([\s\S]*cancelled_request_id IS NULL/iu);
  assert.match(migration, /REVOKE EXECUTE ON FUNCTION control_plane\.cancel_reconnectable_connection_deletion/iu);
});

test("browser disconnect derives actor and tenant in the control-plane RPC", () => {
  const route = readFileSync("app/api/oauth/disconnect/route.ts", "utf8");
  const repository = readFileSync("services/control-plane/src/web-repository.ts", "utf8");
  const webFlow = readFileSync("services/oauth/src/web-flow.ts", "utf8");
  const worker = readFileSync("services/sync-workers/src/oauth-http.ts", "utf8");
  const migration = readFileSync(
    "infra/migrations/control-plane/0034_m8_connection_lifecycle_authority.sql",
    "utf8",
  );

  assert.match(route, /disconnectConnection\(parsed\.data\.connectionId\)/u);
  assert.doesNotMatch(route, /userId|tenantId|disconnectOAuthConnection/u);
  assert.match(repository, /rpc\("albert_disconnect_connection",\s*\{\s*p_connection_id: connectionId/iu);
  assert.doesNotMatch(webFlow, /disconnectOAuthConnection|\/v1\/oauth\/disconnect/u);
  assert.doesNotMatch(worker, /\/v1\/oauth\/disconnect|class DisconnectStore/u);
  assert.match(migration, /selected_tenant text:=control_plane\.require_current_tenant_id\(\)/iu);
  assert.match(migration, /actor uuid:=auth\.uid\(\)/iu);
  assert.match(migration, /control_plane\.has_tenant_role\([\s\S]*ARRAY\['owner','manager'\]/iu);
  assert.match(migration, /FOR UPDATE[\s\S]*INSERT INTO control_plane\.deletion_requests/iu);
  assert.match(migration, /PERFORM control_plane\.enqueue_deletion_request\(generated_request_id\)/iu);
});

test("OAuth callbacks never fall back to an insecure production redirect origin", () => {
  const callbackRoute = readFileSync("app/api/oauth/[provider]/callback/route.ts", "utf8");
  const webFlow = readFileSync("services/oauth/src/web-flow.ts", "utf8");
  assert.doesNotMatch(callbackRoute, /ALBERT_PUBLIC_ORIGIN\s*\|\|\s*["']http:\/\/localhost/u);
  assert.match(callbackRoute, /!configured && process\.env\.NODE_ENV === "production"\) return null/u);
  assert.match(callbackRoute, /process\.env\.NODE_ENV !== "production" && candidate\.protocol === "http:"/u);
  assert.match(callbackRoute, /candidate\.username \|\| candidate\.password/u);
  assert.match(callbackRoute, /configured && \(candidate\.pathname !== "\/" \|\| candidate\.search \|\| candidate\.hash\)/u);
  assert.match(webFlow, /process\.env\.NODE_ENV !== "production" && origin\.protocol === "http:"/u);
  assert.match(webFlow, /origin\.username \|\| origin\.password \|\| origin\.pathname !== "\/" \|\| origin\.search \|\| origin\.hash/u);
  assert.match(callbackRoute, /OAuth callback routing is not configured[\s\S]*status: 503/u);
  assert.match(callbackRoute, /candidate\.protocol !== "https:" && !localHttp/u);
  assert.match(webFlow, /scopes: result\.scopes/u);
  assert.doesNotMatch(webFlow, /XERO_ENABLE_ADVANCED_JOURNALS/u);
});

test("Lightspeed browser authorization binds the sealed verifier as S256 PKCE", () => {
  const source = readFileSync("services/oauth/src/web-flow.ts", "utf8");
  assert.match(
    source,
    /input\.provider === "lightspeed"[\s\S]*buildLightspeedRAuthorizationUrl\([\s\S]*redirectUri[\s\S]*codeChallenge:\s*await pkceChallenge\(codeVerifier\)/u,
  );
});

test("OAuth browser state survives a transient callback-worker failure but is consumed on success", () => {
  const webFlow = readFileSync("services/oauth/src/web-flow.ts", "utf8");
  const finishStart = webFlow.indexOf("export async function finishOAuthFlow");
  const finishEnd = webFlow.indexOf("export async function selectOAuthAccount", finishStart);
  const finish = webFlow.slice(finishStart, finishEnd);
  const callbackIndex = finish.indexOf("callWorker<OAuthCallbackResult>");
  const firstDeleteIndex = finish.indexOf("cookieStore.delete", callbackIndex);

  assert.ok(callbackIndex >= 0, "the callback must cross the credential-owning worker boundary");
  assert.ok(firstDeleteIndex > callbackIndex, "valid browser state must not be consumed before the worker completes");
  assert.match(finish, /const result = await callWorker<OAuthCallbackResult>[\s\S]*cookieStore\.delete[\s\S]*return result/iu);
  assert.match(finish, /error instanceof OAuthFlowError && error\.status < 500[\s\S]*cookieStore\.delete/iu);
  assert.doesNotMatch(finish, /catch \(error\)[\s\S]{0,180}error\.status >= 500[\s\S]{0,120}cookieStore\.delete/iu);

  const sessionStore = readFileSync("services/sync-workers/src/oauth-session-store.ts", "utf8");
  const worker = readFileSync("services/sync-workers/src/oauth-http.ts", "utf8");
  assert.match(sessionStore, /session\.completion_result[\s\S]*status === "consumed"/iu);
  assert.match(sessionStore, /status === "selecting_account"[\s\S]*discovered_account_choices/iu);
  assert.match(
    sessionStore,
    /set status = 'consumed',[\s\S]*completion_result = jsonb_build_object[\s\S]*and status = 'exchanging'/iu,
  );
  assert.match(worker, /loadCallbackReplay\(callbackIdentity\)[\s\S]*replay\.status === "selection_required"/iu);
  assert.match(worker, /loadSelectionReplay\(selectionIdentity\)/iu);
});
