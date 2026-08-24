/**
 * One-shot: copy the live Bike dashboard Stripe secret into Albert's vault
 * and hand it to Fivetran's native Stripe connector. Bike has no Connect
 * client id; this path does not use Stripe Connect OAuth and does not call
 * the Stripe Admin API for ingest.
 *
 * Reads the live key from bike-dashboard env files. Does not print secrets.
 *
 * Run: node --env-file=.env.local --import tsx scripts/bootstrap-stripe-from-bike.mts
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ulid } from "ulid";

import { isStripeLiveFivetranSecret } from "../connectors/stripe/index.js";
import { loadEncodedAes256Keyring, signInternalRequest } from "../packages/security/src/index.js";
import type { OAuthCredentialSecret } from "../packages/connector-sdk/src/index.js";
import {
  AesKeyringWrapper,
  EnvelopeCryptography,
  PostgresCredentialVault,
} from "../services/sync-workers/src/credential-vault.js";
import { PgTransactionalDatabase } from "../services/sync-workers/src/postgres.js";

const TENANT_ID = "01KZN20VTX2EWW1TQ2AA3MCPW6";
const BIKE_ENV_CANDIDATES = [
  resolve("/Users/user/Bike/bike-dashboard/.env.vercel.tmp"),
  resolve("/Users/user/Bike/bike-dashboard/.env.local"),
];

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
  for (const file of [".env.local", ".env.production.local"]) {
    try {
      Object.assign(env, loadEnvFile(resolve(file)));
    } catch {
      /* optional */
    }
  }
  return env;
}

function required(env: Record<string, string>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function loadLiveBikeStripeSecret(): { secret: string; source: string } {
  for (const path of BIKE_ENV_CANDIDATES) {
    try {
      const secret = loadEnvFile(path).STRIPE_SECRET_KEY?.trim() ?? "";
      if (isStripeLiveFivetranSecret(secret)) {
        return { secret, source: path.split("/").slice(-2).join("/") };
      }
    } catch {
      /* try the next file */
    }
  }
  throw new Error(
    "bike-dashboard has no live Stripe secret. Albert's Fivetran Stripe connector is live mode only.",
  );
}

async function probeStripeAccount(secret: string): Promise<{
  accountId: string;
  displayName: string;
  livemode: boolean;
}> {
  const response = await fetch("https://api.stripe.com/v1/account", {
    headers: {
      authorization: `Bearer ${secret}`,
      accept: "application/json",
    },
  });
  if (!response.ok) {
    throw new Error(`Stripe account probe failed HTTP ${response.status}`);
  }
  const account = await response.json() as {
    id?: string;
    livemode?: boolean;
    business_profile?: { name?: string | null };
    settings?: { dashboard?: { display_name?: string | null } };
    email?: string | null;
  };
  const accountId = account.id?.trim() ?? "";
  if (!accountId.startsWith("acct_")) throw new Error("Stripe account probe did not return an account id.");
  // GET /v1/account omits livemode. The key prefix is the mode signal.
  if (account.livemode === false) throw new Error("Stripe account probe returned a test-mode account.");
  const displayName = (
    account.business_profile?.name
    || account.settings?.dashboard?.display_name
    || account.email
    || "Stripe"
  ).trim().slice(0, 120);
  return { accountId, displayName, livemode: true };
}

async function startFivetran(input: Readonly<{
  tenantId: string;
  userId: string;
  nativeConnectionId: string;
  workerUrl: string;
  signingSecret: string;
}>): Promise<{ connectionId: string; fivetranConnectionId: string }> {
  const path = "/v1/fivetran/stripe/start";
  const body = JSON.stringify({
    tenantId: input.tenantId,
    userId: input.userId,
    nativeConnectionId: input.nativeConnectionId,
  });
  const headers = await signInternalRequest({
    method: "POST",
    path,
    body,
    secret: input.signingSecret,
  });
  const response = await fetch(new URL(path, input.workerUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
    signal: AbortSignal.timeout(180_000),
  });
  const payload = await response.json().catch(() => null) as {
    result?: { connectionId?: string; fivetranConnectionId?: string };
    error?: string;
    detail?: string;
  } | null;
  if (!response.ok || !payload?.result?.connectionId || !payload.result.fivetranConnectionId) {
    throw new Error(
      `Fivetran Stripe start failed HTTP ${response.status}: ${payload?.error ?? "unknown"}`,
    );
  }
  return {
    connectionId: payload.result.connectionId,
    fivetranConnectionId: payload.result.fivetranConnectionId,
  };
}

async function main(): Promise<void> {
  const { secret, source } = loadLiveBikeStripeSecret();
  const account = await probeStripeAccount(secret);
  console.log("bike_stripe_probe_ok", {
    source,
    accountId: account.accountId,
    displayName: account.displayName,
    secretPrefix: `${secret.slice(0, 7)}…`,
  });

  const albertEnv = loadAlbertEnv();
  const db = new PgTransactionalDatabase(
    required(albertEnv, "CONTROL_PLANE_ADMIN_DATABASE_URL"),
    {
      applicationName: "albert-bootstrap-stripe-from-bike",
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

  const owner = await db.query<{ user_id: string }>(
    `select user_id::text as user_id
       from control_plane.memberships
      where tenant_id = $1
        and status = 'active'
        and role = 'owner'
      order by created_at asc
      limit 1`,
    [TENANT_ID],
  );
  const userId = owner.rows[0]?.user_id;
  if (!userId) throw new Error("Live tenant has no active owner.");

  const existing = await db.query<{ connection_id: string }>(
    `select connection_id
       from control_plane.connections
      where tenant_id = $1
        and connector_key = 'stripe'
        and external_account_reference = $2
        and status <> 'disconnected'
      order by updated_at desc
      limit 1`,
    [TENANT_ID, account.accountId],
  );
  const connectionId = existing.rows[0]?.connection_id ?? ulid();
  if (!existing.rows[0]) {
    await db.query(
      `insert into control_plane.connections (
         tenant_id, connection_id, connector_key, display_name,
         external_account_reference, status, auth_health, account_metadata,
         authorised_by, authorised_at, last_checked_at, ingestion_start_mode
       ) values (
         $1, $2, 'stripe', $3, $4, 'connected', 'healthy',
         jsonb_build_object(
           'stripeUserId', $4::text,
           'livemode', true,
           'bootstrappedFrom', 'bike-dashboard'
         ),
         $5::uuid, now(), now(), 'manual'
       )`,
      [TENANT_ID, connectionId, account.displayName, account.accountId, userId],
    );
  } else {
    await db.query(
      `update control_plane.connections
          set status = 'connected',
              auth_health = 'healthy',
              display_name = $3,
              disconnected_at = null,
              last_checked_at = now(),
              updated_at = now(),
              ingestion_start_mode = 'manual',
              ingestion_activated_at = null,
              ingestion_activated_by = null,
              ingestion_activated_generation = null,
              account_metadata = coalesce(account_metadata, '{}'::jsonb)
                || jsonb_build_object(
                  'stripeUserId', $4::text,
                  'livemode', true,
                  'bootstrappedFrom', 'bike-dashboard'
                )
        where tenant_id = $1
          and connection_id = $2`,
      [TENANT_ID, connectionId, account.displayName, account.accountId],
    );
  }

  const vault = new PostgresCredentialVault(
    db,
    new EnvelopeCryptography(
      new AesKeyringWrapper({
        currentKeyReference: "env:TOKEN_ENCRYPTION_KEY",
        currentKeyVersion: keyring.currentKeyId,
        encodedKeys: keyring.keys,
      }),
    ),
    { tenantId: TENANT_ID, connectionId },
  );

  const next: OAuthCredentialSecret = {
    provider: "stripe",
    accessToken: account.accountId,
    tokenType: "StripeAccount",
    expiresAt: new Date(Date.now() + 10 * 365 * 24 * 60 * 60_000).toISOString(),
    scopes: ["read_write"],
    metadata: {
      stripeUserId: account.accountId,
      livemode: true,
      stripeAccessToken: secret,
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
    [connectionId],
  );
  let credentialRef = refRows.rows[0]?.secret_reference;
  if (!credentialRef) {
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

  const started = await startFivetran({
    tenantId: TENANT_ID,
    userId,
    nativeConnectionId: connectionId,
    workerUrl: albertEnv.SYNC_WORKER_INTERNAL_URL?.trim()
      || "https://albert-sync-worker-dogfood.fly.dev",
    signingSecret: required(albertEnv, "ALBERT_OAUTH_WORKER_SIGNING_SECRET"),
  });

  await db.close().catch(() => undefined);
  console.log(JSON.stringify({
    ok: true,
    tenantId: TENANT_ID,
    nativeConnectionId: connectionId,
    fivetranConnectionId: started.connectionId,
    fivetranRemoteId: started.fivetranConnectionId,
    accountId: account.accountId,
    displayName: account.displayName,
    credentialRef,
    source,
  }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
