/**
 * One-shot: copy a live Ashburton Lightspeed token from bike-dashboard into
 * Albert's credential vault so ingest can proceed while Albert's own OAuth
 * client registration is broken on Lightspeed's IdP.
 *
 * Requires bike-dashboard .env.local (TOKEN_ENCRYPTION_KEY + Supabase service
 * role) and Albert control-plane vault env.
 */
import { createDecipheriv } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { loadEncodedAes256Keyring } from "../packages/security/src/index.js";
import type { OAuthCredentialSecret } from "../packages/connector-sdk/src/index.js";
import {
  AesKeyringWrapper,
  EnvelopeCryptography,
  PostgresCredentialVault,
} from "../services/sync-workers/src/credential-vault.js";
import { PgTransactionalDatabase } from "../services/sync-workers/src/postgres.js";

const TENANT_ID = "01KZ4ZMVF5QNQ4TX35VF3WDJBM";
const CONNECTION_ID = "01KZ54B1PCKM1MHSNHY4XT6DEX";
const ACCOUNT_ID = "168990";
const BIKE_ENV = resolve("/Users/user/Bike/bike-dashboard/.env.local");
const BIKE_USER_ID = "3acef09d-8b28-46e8-a0c3-45ce59c61972"; // freshest Ashburton row

function loadEnvFile(path: string): Record<string, string> {
  const vals: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const raw = line.trim();
    if (!raw || raw.startsWith("#") || !raw.includes("=")) continue;
    const i = raw.indexOf("=");
    const key = raw.slice(0, i).trim();
    let value = raw.slice(i + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    vals[key] = value;
  }
  return vals;
}

function loadAlbertEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const file of [".env.local", ".env.production.local", "/tmp/albert-ls-bike-client.env"]) {
    try {
      Object.assign(env, loadEnvFile(resolve(file)));
    } catch {
      /* optional */
    }
  }
  // Overlay bike client last so refresh uses the client that minted the token.
  Object.assign(env, loadEnvFile("/tmp/albert-ls-bike-client.env"));
  return env;
}

function required(env: Record<string, string>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function decryptBikeToken(encryptedToken: string, keyHex: string): string {
  const parts = encryptedToken.split(":");
  if (parts.length !== 3) throw new Error("Invalid bike encrypted token format");
  const [ivHex, authTagHex, encrypted] = parts;
  const decipher = createDecipheriv(
    "aes-256-gcm",
    Buffer.from(keyHex, "hex"),
    Buffer.from(ivHex!, "hex"),
  );
  decipher.setAuthTag(Buffer.from(authTagHex!, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted!, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

async function main(): Promise<void> {
  const bikeEnv = loadEnvFile(BIKE_ENV);
  const albertEnv = loadAlbertEnv();
  const supabaseUrl = required(bikeEnv, "NEXT_PUBLIC_SUPABASE_URL");
  const serviceKey = required(bikeEnv, "SUPABASE_SERVICE_ROLE_KEY");
  const bikeKey = required(bikeEnv, "TOKEN_ENCRYPTION_KEY");

  const rowRes = await fetch(
    `${supabaseUrl}/rest/v1/lightspeed_connections?user_id=eq.${BIKE_USER_ID}&select=account_id,account_name,status,access_token_encrypted,refresh_token_encrypted,token_expires_at,scopes,last_token_refresh_at`,
    {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        Accept: "application/json",
      },
    },
  );
  if (!rowRes.ok) throw new Error(`bike fetch failed HTTP ${rowRes.status}`);
  const rows = (await rowRes.json()) as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) throw new Error("No bike Lightspeed connection for bootstrap user");
  if (row.status !== "connected" || String(row.account_id) !== ACCOUNT_ID) {
    throw new Error(
      `Unexpected bike connection status/account: ${row.status}/${row.account_id}`,
    );
  }
  const accessToken = decryptBikeToken(
    String(row.access_token_encrypted),
    bikeKey,
  );
  const refreshToken = decryptBikeToken(
    String(row.refresh_token_encrypted),
    bikeKey,
  );
  const expiresAt = String(row.token_expires_at);
  const scopes = Array.isArray(row.scopes)
    ? row.scopes.map(String)
    : ["employee:all"];

  // Prove the access token works before writing into Albert.
  const probe = await fetch(
    `https://api.lightspeedapp.com/API/V3/Account/${ACCOUNT_ID}.json`,
    {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
      },
    },
  );
  if (!probe.ok) {
    throw new Error(
      `Bike access token probe failed HTTP ${probe.status}: ${(await probe.text()).slice(0, 200)}`,
    );
  }
  console.log("bike_token_probe_ok", ACCOUNT_ID);

  const db = new PgTransactionalDatabase(
    required(albertEnv, "CONTROL_PLANE_ADMIN_DATABASE_URL"),
    {
      applicationName: "albert-bootstrap-lightspeed-from-bike",
      assumedRole: "albert_control_migration_owner",
    },
  );
  const keyring = loadEncodedAes256Keyring({
    currentKey: required(albertEnv, "TOKEN_ENCRYPTION_KEY"),
    currentKeyId: required(albertEnv, "TOKEN_ENCRYPTION_KEY_ID"),
    previousKeysJson: albertEnv.TOKEN_PREVIOUS_ENCRYPTION_KEYS,
    keyName: "TOKEN_ENCRYPTION_KEY",
    keyIdName: "TOKEN_ENCRYPTION_KEY_ID",
    previousKeysName: "TOKEN_PREVIOUS_ENCRYPTION_KEYS",
    maxPreviousKeys: 4,
  });
  const vault = new PostgresCredentialVault(
    db,
    new EnvelopeCryptography(
      new AesKeyringWrapper({
        currentKeyReference: "env:TOKEN_ENCRYPTION_KEY",
        currentKeyVersion: keyring.currentKeyId,
        encodedKeys: keyring.keys,
      }),
    ),
    { tenantId: TENANT_ID, connectionId: CONNECTION_ID },
  );

  const next: OAuthCredentialSecret = {
    provider: "lightspeed-r",
    accessToken,
    refreshToken,
    tokenType: "Bearer",
    expiresAt,
    scopes,
    metadata: {
      lightspeedAccountId: ACCOUNT_ID,
      bootstrappedFrom: "bike-dashboard",
      bootstrappedAt: new Date().toISOString(),
    },
  };

  const refRows = await db.query<{ secret_reference: string }>(
    `select secret_reference
       from control_plane.oauth_token_refs
      where connection_id = $1
      order by updated_at desc
      limit 1`,
    [CONNECTION_ID],
  );
  let credentialRef = refRows.rows[0]?.secret_reference;
  if (!credentialRef) {
    // Disconnect / purge can delete the token ref. Recreate a fresh vault entry.
    const created = await vault.create(next);
    credentialRef = created.credentialRef;
  } else {
    await vault.withRefreshLease(credentialRef, async (lease) => {
      const latest = await vault.read(credentialRef!);
      return vault.compareAndSwap(
        credentialRef!,
        latest.revision,
        {
          ...latest.secret,
          ...next,
          metadata: {
            ...latest.secret.metadata,
            ...next.metadata,
          },
        },
        lease.proof,
      );
    });
  }

  await db.query(
    `update control_plane.connections
        set status = 'connected',
            auth_health = 'healthy',
            disconnected_at = null,
            last_checked_at = now(),
            updated_at = now()
      where connection_id = $1
        and tenant_id = $2`,
    [CONNECTION_ID, TENANT_ID],
  );

  await db.close().catch(() => undefined);
  console.log(
    JSON.stringify({
      ok: true,
      connectionId: CONNECTION_ID,
      accountId: ACCOUNT_ID,
      credentialRef,
      expiresAt,
      scopes,
      clientIdPrefix: required(albertEnv, "LIGHTSPEED_CLIENT_ID").slice(0, 12),
    }),
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
