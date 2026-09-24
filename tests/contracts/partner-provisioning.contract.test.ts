import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  actingMemberEmail,
  actingMemberId,
  bearerKey,
  clientIdFor,
  matchPlatform,
  parsePlatformRequest,
  parsePlatforms,
  PLATFORM_KEY_PATTERN,
  sha256Hex,
  uuidV5,
} from "../../supabase/functions/partner-provision/core.ts";

const migration = readFileSync("infra/migrations/control-plane/0195_m1_partner_provisioning.sql", "utf8");
const provisionFunction = readFileSync("supabase/functions/partner-provision/index.ts", "utf8");
const sessionFunction = readFileSync("supabase/functions/partner-session/index.ts", "utf8");
const sourcesRoute = readFileSync("app/api/partner/sources/route.ts", "utf8");

const digest = "a".repeat(64);

test("platform keys are matched by digest and only enabled platforms provision", async () => {
  const key = `albert_pp_${"K".repeat(43)}`;
  assert.equal(bearerKey(`Bearer ${key}`, PLATFORM_KEY_PATTERN), key);
  assert.equal(bearerKey(`Bearer albert_pk_${"K".repeat(43)}`, PLATFORM_KEY_PATTERN), null, "a partner session key is not a platform key");
  assert.equal(bearerKey(`Basic ${key}`, PLATFORM_KEY_PATTERN), null);
  const platforms = parsePlatforms(JSON.stringify([
    { partner: "yellow-jersey", keySha256: await sha256Hex(key), enabled: true },
    { partner: "other-partner", keySha256: digest, enabled: false },
  ]));
  assert.equal(matchPlatform(platforms, await sha256Hex(key))?.partner, "yellow-jersey");
  assert.equal(matchPlatform(platforms, digest)?.enabled, false);
  assert.equal(matchPlatform(platforms, "b".repeat(64)), undefined);
  assert.deepEqual(parsePlatforms(undefined), []);
  assert.throws(() => parsePlatforms("{}"), /must be an array/u);
  assert.throws(() => parsePlatforms(JSON.stringify([{ partner: "YJ", keySha256: digest, enabled: true }])), /partner is invalid/u);
  assert.throws(() => parsePlatforms(JSON.stringify([
    { partner: "one-partner", keySha256: digest, enabled: true },
    { partner: "two-partner", keySha256: digest, enabled: true },
  ])), /reuses a key digest/u);
});

test("provision requests carry a digest, never a key, and are strictly shaped", () => {
  const good = {
    action: "provision",
    accountRef: "3acef09d-8b28-46e8-a0c3-45ce59c61972",
    displayName: "  Wattle   Test Cycles ",
    timezone: "Australia/Melbourne",
    keySha256: digest,
    tokenBroker: true,
  };
  assert.deepEqual(parsePlatformRequest(good), { ...good, displayName: "Wattle Test Cycles" });
  assert.deepEqual(parsePlatformRequest({ action: "disable", accountRef: good.accountRef }), {
    action: "disable",
    accountRef: good.accountRef,
  });
  for (const bad of [
    null,
    [],
    { ...good, action: "delete" },
    { ...good, accountRef: "../../etc" },
    { ...good, accountRef: "" },
    { ...good, displayName: "" },
    { ...good, displayName: "x".repeat(121) },
    { ...good, timezone: "Mars/Olympus Mons" },
    { ...good, keySha256: `albert_pk_${"K".repeat(43)}` },
    { ...good, tokenBroker: "yes" },
  ]) {
    assert.equal(parsePlatformRequest(bad), null, JSON.stringify(bad));
  }
});

test("a store gets a stable client id, acting member id and an undeliverable address", async () => {
  const clientId = clientIdFor("yellow-jersey", "3acef09d-8b28-46e8-a0c3-45ce59c61972");
  assert.equal(clientId, "yellow-jersey-3acef09d8b2846e8a0c345ce59c61972");
  assert.match(clientId, /^[a-z0-9][a-z0-9-]{2,63}$/u);
  assert.equal(actingMemberEmail(clientId), `${clientId}@partner-members.albert.invalid`);
  // RFC 4122 v5 test vector (DNS namespace, "python.org").
  assert.equal(await uuidV5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", "python.org"), "886313e1-3b8a-5372-9b90-0c9aee199e5d");
  const first = await actingMemberId("yellow-jersey", "3acef09d-8b28-46e8-a0c3-45ce59c61972");
  assert.equal(first, await actingMemberId("yellow-jersey", "3acef09d-8b28-46e8-a0c3-45ce59c61972"));
  assert.notEqual(first, await actingMemberId("other-partner", "3acef09d-8b28-46e8-a0c3-45ce59c61972"));
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
});

test("0195 keeps partner clients private: service_role RPCs only, worker reads the broker binding", () => {
  assert.match(migration, /ALTER TABLE control_plane\.partner_clients ENABLE ROW LEVEL SECURITY/u);
  assert.match(migration, /REVOKE ALL ON TABLE control_plane\.partner_clients\s+FROM PUBLIC, anon, authenticated, service_role/u);
  // The worker never sees a key digest.
  assert.match(migration, /GRANT SELECT \(client_id, partner, partner_account_ref, tenant_id, status, token_broker\)\s+ON TABLE control_plane\.partner_clients TO albert_sync_control/u);
  assert.doesNotMatch(migration, /GRANT SELECT ON TABLE control_plane\.partner_clients/u);
  assert.match(migration, /USING \(status = 'active' AND token_broker\)/u);
  const functions = [...migration.matchAll(/CREATE OR REPLACE FUNCTION (public\.albert_partner_[a-z_]+)\(/gu)].map((match) => match[1]);
  assert.deepEqual(functions.sort(), [
    "public.albert_partner_activate_client",
    "public.albert_partner_client_by_digest",
    "public.albert_partner_client_for_account",
    "public.albert_partner_disable_client",
    "public.albert_partner_reserve_client",
  ]);
  for (const name of functions) {
    assert.match(migration, new RegExp(`REVOKE ALL ON FUNCTION ${name.replace(".", "\\.")}\\([^)]*\\)\\s+FROM PUBLIC, anon, authenticated;`, "u"), name);
    assert.match(migration, new RegExp(`GRANT EXECUTE ON FUNCTION ${name.replace(".", "\\.")}\\([^)]*\\) TO service_role;`, "u"), name);
    assert.doesNotMatch(migration, new RegExp(`GRANT EXECUTE ON FUNCTION ${name.replace(".", "\\.")}\\([^)]*\\) TO (?:anon|authenticated)`, "u"), name);
  }
  assert.equal((migration.match(/SECURITY DEFINER\s+SET search_path = pg_catalog/gu) ?? []).length, functions.length);
  // Activation proves ownership: the acting member must own the tenant.
  assert.match(migration, /membership\.role = 'owner'/u);
  assert.match(migration, /fivetran_connections_partner_live_unique/u);
  assert.match(migration, /^BEGIN;$/mu);
  assert.match(migration, /^COMMIT;\s*$/mu);
  // The runner refuses unreviewed direct Auth dependencies (control-plane-auth-compat).
  assert.doesNotMatch(migration, /\bauth\.(?:users\b|uid\s*\(|jwt\s*\()/iu);
});

test("partner-provision creates tenants through the member's own session, never with elevated SQL", () => {
  assert.match(provisionFunction, /scoped\.rpc\("albert_create_organisation"/u);
  assert.doesNotMatch(provisionFunction, /from\("tenants"\)|insert into control_plane/iu);
  assert.match(provisionFunction, /email_confirm: true/u);
  assert.match(provisionFunction, /signOut\(accessToken, "local"\)/u);
  // The partner's key never reaches Albert: only keySha256 is accepted.
  assert.doesNotMatch(provisionFunction, /albert_pk_/u);
});

test("partner-session keeps env clients first and reaches provisioned ones only by digest", () => {
  const envMatch = sessionFunction.indexOf("for (const candidate of clients)");
  const dbLookup = sessionFunction.indexOf("client = await provisionedClient(admin, digest)");
  assert.ok(envMatch > 0 && dbLookup > envMatch, "ALBERT_PARTNER_CLIENTS is matched before the database");
  assert.match(sessionFunction, /admin\.rpc\("albert_partner_client_by_digest", \{ p_key_sha256: digest \}\)/u);
  assert.doesNotMatch(sessionFunction, /\.from\("partner_clients"\)/u);
  // The tenant check still guards every mint.
  assert.match(sessionFunction, /resolvedTenant !== client\.tenantId/u);
});

test("the partner sources route is bearer-only and goes through the worker's start path", () => {
  assert.match(sourcesRoute, /if \(!\(await requestBearerAccessToken\(\)\)\)/u);
  assert.match(sourcesRoute, /`\/v1\/fivetran\/\$\{service\}\/start`/u);
  assert.match(sourcesRoute, /grantSource: "partner"/u);
  assert.match(sourcesRoute, /\["owner", "manager"\]\.includes\(tenant\.role\)/u);
  assert.doesNotMatch(sourcesRoute, /accountRef|partner_account_ref/u, "the partner's account comes from Albert's binding, never the request");
});
