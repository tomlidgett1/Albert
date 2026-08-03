import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { DeputyConnector } from "../../connectors/deputy/index.js";
import {
  DEPUTY_WEBHOOK_TOPICS,
  parseDeputyWebhook,
} from "../../connectors/deputy/webhooks.js";
import type {
  CredentialRefreshLeaseContext,
  OAuthCredentialSecret,
  VersionedCredential,
  WorkerCredentialVault,
} from "../../packages/connector-sdk/src/index.js";
import type { PostgresQueryClient } from "../../packages/queue/src/index.js";
import { sealSecret } from "../../packages/security/src/index.js";
import { toConnectionsWorkspace } from "../../services/control-plane/src/connections-workspace.js";
import {
  DeputyWebhookMaterialStore,
  DeputyWebhookSetupCoordinator,
} from "../../services/sync-workers/src/deputy-webhooks.js";
import type { TransactionalPostgres } from "../../services/sync-workers/src/database.js";
import { DeputyWebhookVerifier } from "../../services/webhook-gateway/src/deputy.js";

const root = new URL("../../", import.meta.url);
const callbackUrl = "https://hooks.albert.example/v1/webhooks/deputy/01J00000000000000000000001/01J00000000000000000000002";
const customHeaderSecret = "connection-bound-secret-".repeat(2);
const receivedAt = "2026-08-03T10:00:01.000Z";
const generatedAt = String(Math.floor(Date.parse(receivedAt) / 1_000));

function event(
  body: Uint8Array,
  overrides: Readonly<Record<string, string>> = {},
) {
  return {
    id: "delivery-is-not-trusted-for-dedupe",
    receivedAt,
    headers: {
      "x-albert-webhook-secret": customHeaderSecret,
      "x-deputy-generation-time": generatedAt,
      "x-deputy-webhook-callback": callbackUrl,
      ...overrides,
    },
    body,
  } as const;
}

test("Deputy verification authenticates the connection, enforces freshness, and derives replay identity from the body", () => {
  const body = new TextEncoder().encode(JSON.stringify({
    topic: "Timesheet.Update",
    data: { Id: 501, Modified: "2026-08-03T20:00:00+10:00" },
  }));
  const material = { version: 1 as const, customHeaderSecret };
  const first = parseDeputyWebhook({
    event: event(body, { "x-request-id": "mutable-one" }),
    material,
    expectedCallbackUrl: callbackUrl,
    nowMs: Date.parse(receivedAt),
  });
  const retry = parseDeputyWebhook({
    event: event(body, { "x-request-id": "mutable-two", "user-agent": "changed" }),
    material,
    expectedCallbackUrl: callbackUrl,
    nowMs: Date.parse(receivedAt) + 1_000,
  });
  assert.deepEqual(first.streams, ["timesheets"]);
  assert.equal(first.dedupeKey, retry.dedupeKey);
  assert.match(first.dedupeKey ?? "", /^deputy:Timesheet\.Update:[0-9a-f]{64}$/u);

  assert.throws(() => parseDeputyWebhook({
    event: event(body, { "x-albert-webhook-secret": "wrong".repeat(12) }),
    material,
    expectedCallbackUrl: callbackUrl,
    nowMs: Date.parse(receivedAt),
  }), /authentication failed/iu);
  assert.throws(() => parseDeputyWebhook({
    event: event(body, { "x-deputy-generation-time": String(Number(generatedAt) - 601) }),
    material,
    expectedCallbackUrl: callbackUrl,
    nowMs: Date.parse(receivedAt),
  }), /outside the accepted window/iu);
  assert.throws(() => parseDeputyWebhook({
    event: event(body, { "x-deputy-webhook-callback": callbackUrl.replace("00001/", "00009/") }),
    material,
    expectedCallbackUrl: callbackUrl,
    nowMs: Date.parse(receivedAt),
  }), /callback identity does not match/iu);
});

test("Deputy Enterprise verification additionally requires the official raw-body HMAC", () => {
  const body = new TextEncoder().encode(JSON.stringify({ topic: "Employee.Update", data: { Id: 42 } }));
  const enterpriseHmacKey = "enterprise-private-api-signing-key";
  const material = { version: 1 as const, customHeaderSecret, enterpriseHmacKey };
  const signature = createHmac("sha256", enterpriseHmacKey).update(body).digest("hex");
  assert.deepEqual(parseDeputyWebhook({
    event: event(body, { "x-deputy-secret": signature }),
    material,
    expectedCallbackUrl: callbackUrl,
    nowMs: Date.parse(receivedAt),
  }).streams, ["employees"]);
  assert.throws(() => parseDeputyWebhook({
    event: event(body, { "x-deputy-secret": "0".repeat(64) }),
    material,
    expectedCallbackUrl: callbackUrl,
    nowMs: Date.parse(receivedAt),
  }), /Enterprise webhook signature is invalid/iu);
});

test("Deputy gateway accepts a bounded decrypt-only key during verifier rotation", async () => {
  const oldKey = Buffer.alloc(32, 31).toString("base64url");
  const currentKey = Buffer.alloc(32, 32).toString("base64url");
  const envelope = await sealSecret({
    plaintext: JSON.stringify({ version: 1, customHeaderSecret }),
    encodedKey: oldKey,
    keyId: "deputy-webhook-v1",
    associatedData: "albert:deputy-webhook:v1:01J00000000000000000000003:01J00000000000000000000001:01J00000000000000000000002",
  });
  const verifier = new DeputyWebhookVerifier({
    encryptionKey: currentKey,
    keyId: "deputy-webhook-v2",
    encryptionKeys: new Map([
      ["deputy-webhook-v1", oldKey],
      ["deputy-webhook-v2", currentKey],
    ]),
    maxClockSkewMs: 300_000,
    now: () => Date.parse(receivedAt),
  });
  const body = new TextEncoder().encode(JSON.stringify({
    topic: "Roster.Update",
    data: { Id: 991 },
  }));
  const disposition = await verifier.verify({
    tenantId: "01J00000000000000000000003",
    connectionId: "01J00000000000000000000001",
    connectorKey: "deputy",
    externalAccountReference: "demo.au.deputy.com",
    materialId: "01J00000000000000000000002",
    materialVersion: 1,
    verificationMode: "custom_header",
    envelope,
    callbackUrl,
  }, event(body));
  assert.deepEqual(disposition.streams, ["rosters"]);
});

class StaticVault implements WorkerCredentialVault {
  private readonly value: VersionedCredential;

  constructor(secret: OAuthCredentialSecret) {
    this.value = { credentialRef: "oauth-fixture", revision: "1", secret };
  }

  async create(): Promise<VersionedCredential> { throw new Error("not_used"); }
  async read(): Promise<VersionedCredential> { return this.value; }
  async compareAndSwap(): Promise<VersionedCredential> { throw new Error("not_used"); }
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
  async destroy(): Promise<void> { throw new Error("not_used"); }
}

type StoredMaterial = Record<string, unknown> & {
  tenant_id: string;
  connection_id: string;
  material_id: string;
  material_version: number;
  verification_mode: "custom_header";
  envelope_version: 1;
  algorithm: "A256GCM";
  key_id: string;
  iv: string;
  ciphertext: string;
  callback_url: string;
  setup_status: string;
  attempt_count: number;
  provisioning_lease_active: boolean;
  retired_at: null;
};

class MaterialDatabase implements TransactionalPostgres {
  readonly rows = new Map<string, StoredMaterial>();
  readonly connectionStates: unknown[][] = [];

  async transaction<T>(work: (client: PostgresQueryClient) => Promise<T>): Promise<T> {
    return work(this);
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<Readonly<{ rows: readonly Row[] }>> {
    const statement = sql.replace(/\s+/gu, " ").trim();
    const key = `${String(values[0])}:${String(values[1])}`;
    if (statement.startsWith("insert into control_plane.deputy_webhook_material")) {
      if (!this.rows.has(key)) {
        this.rows.set(key, {
          tenant_id: String(values[0]),
          connection_id: String(values[1]),
          material_id: String(values[2]),
          material_version: 1,
          verification_mode: "custom_header",
          envelope_version: 1,
          algorithm: "A256GCM",
          key_id: String(values[5]),
          iv: String(values[6]),
          ciphertext: String(values[7]),
          callback_url: String(values[8]),
          setup_status: "provisioning",
          attempt_count: 1,
          provisioning_lease_active: true,
          retired_at: null,
        });
      }
      return { rows: [] };
    }
    if (statement.includes("from control_plane.deputy_webhook_material") && statement.endsWith("for update skip locked")) {
      const previousKeyIds = new Set(values[0] as readonly string[]);
      const limit = Number(values[1]);
      return {
        rows: [...this.rows.values()]
          .filter((row) => row.retired_at === null && previousKeyIds.has(row.key_id))
          .slice(0, limit) as Row[],
      };
    }
    if (statement.includes("from control_plane.deputy_webhook_material") && statement.endsWith("for update")) {
      const row = this.rows.get(key);
      if (row) row.provisioning_lease_active = row.setup_status === "provisioning";
      return { rows: (row ? [row] : []) as Row[] };
    }
    if (statement.startsWith("update control_plane.deputy_webhook_material") && statement.includes("set callback_url")) {
      const row = this.rows.get(key);
      if (row) {
        row.callback_url = String(values[2]);
        row.setup_status = "provisioning";
        row.attempt_count = Number(values[3]);
        row.provisioning_lease_active = true;
      }
      return { rows: [] };
    }
    if (statement.startsWith("update control_plane.deputy_webhook_material") && statement.includes("set setup_status = 'active'")) {
      const row = this.rows.get(key);
      if (!row || row.material_id !== values[2] || row.attempt_count !== values[3]) return { rows: [] };
      row.setup_status = "active";
      return { rows: [{ material_id: row.material_id } as unknown as Row] };
    }
    if (statement.startsWith("update control_plane.deputy_webhook_material") && statement.includes("set setup_status = $5")) {
      const row = this.rows.get(key);
      if (!row || row.material_id !== values[2] || row.attempt_count !== values[3]) return { rows: [] };
      row.setup_status = String(values[4]);
      return { rows: [{ material_id: row.material_id } as unknown as Row] };
    }
    if (statement.startsWith("update control_plane.deputy_webhook_material") && statement.includes("set envelope_version = $5")) {
      const row = this.rows.get(key);
      const reconnectRewrap = statement.includes("and attempt_count = $4");
      const expectedKeyId = reconnectRewrap ? values[9] : values[3];
      if (!row || row.material_id !== values[2] || row.key_id !== expectedKeyId) return { rows: [] };
      if (reconnectRewrap && row.attempt_count !== values[3]) return { rows: [] };
      row.envelope_version = Number(values[4]) as 1;
      row.algorithm = String(values[5]) as "A256GCM";
      row.key_id = String(values[6]);
      row.iv = String(values[7]);
      row.ciphertext = String(values[8]);
      return { rows: [{ material_id: row.material_id } as unknown as Row] };
    }
    if (statement.startsWith("update control_plane.connections")) {
      this.connectionStates.push([...values]);
      return { rows: [] };
    }
    if (statement.startsWith("insert into control_plane.audit_log")) return { rows: [] };
    throw new Error(`Unhandled material-store query: ${statement}`);
  }
}

test("Deputy webhook material is encrypted, unique per connection, and stable across setup retries", async () => {
  const database = new MaterialDatabase();
  const store = new DeputyWebhookMaterialStore(
    database,
    Buffer.alloc(32, 21).toString("base64url"),
    "deputy-webhook-v1",
    "https://hooks.albert.example",
  );
  const first = await store.prepare(
    "01J00000000000000000000003",
    "01J00000000000000000000001",
  );
  await assert.rejects(store.prepare(
    "01J00000000000000000000003",
    "01J00000000000000000000001",
  ), /setup_in_progress/u);
  const firstStored = database.rows.get("01J00000000000000000000003:01J00000000000000000000001");
  assert.ok(firstStored);
  firstStored.setup_status = "retry_wait";
  const retry = await store.prepare(
    "01J00000000000000000000003",
    "01J00000000000000000000001",
  );
  const other = await store.prepare(
    "01J00000000000000000000006",
    "01J00000000000000000000007",
  );
  assert.equal(retry.materialId, first.materialId);
  assert.equal(retry.material.customHeaderSecret, first.material.customHeaderSecret);
  assert.notEqual(other.material.customHeaderSecret, first.material.customHeaderSecret);
  assert.equal(first.callbackUrl, `https://hooks.albert.example/v1/webhooks/deputy/01J00000000000000000000001/${first.materialId}`);
  const stored = database.rows.get("01J00000000000000000000003:01J00000000000000000000001");
  assert.ok(stored);
  assert.equal(stored.ciphertext.includes(first.material.customHeaderSecret), false);

  const vendorWebhookIds = Object.fromEntries(
    DEPUTY_WEBHOOK_TOPICS.map((topic, index) => [topic, String(index + 1)]),
  );
  await assert.rejects(store.markActive(first, vendorWebhookIds), /material_changed/u);
  await store.markActive(retry, vendorWebhookIds);
  assert.equal(stored.setup_status, "active");
  assert.equal(database.connectionStates.at(-1)?.[2], "connected");
  assert.equal(database.connectionStates.at(-1)?.[3], "active");

  const rotatedKey = Buffer.alloc(32, 23).toString("base64url");
  const rotatedStore = new DeputyWebhookMaterialStore(
    database,
    rotatedKey,
    "deputy-webhook-v2",
    "https://hooks.albert.example",
    new Map([["deputy-webhook-v1", Buffer.alloc(32, 21).toString("base64url")]]),
  );
  const rotated = await rotatedStore.prepare(
    "01J00000000000000000000003",
    "01J00000000000000000000001",
  );
  assert.equal(rotated.material.customHeaderSecret, first.material.customHeaderSecret);
  assert.equal(stored.key_id, "deputy-webhook-v2");
  assert.equal(stored.ciphertext.includes(rotated.material.customHeaderSecret), false);

  const backgroundRotatedStore = new DeputyWebhookMaterialStore(
    database,
    Buffer.alloc(32, 24).toString("base64url"),
    "deputy-webhook-v3",
    "https://hooks.albert.example",
    new Map([
      ["deputy-webhook-v1", Buffer.alloc(32, 21).toString("base64url")],
      ["deputy-webhook-v2", rotatedKey],
    ]),
  );
  assert.equal(await backgroundRotatedStore.rewrapPreviousMaterials(), 2);
  assert.equal(stored.key_id, "deputy-webhook-v3");
  assert.equal(database.rows.get("01J00000000000000000000006:01J00000000000000000000007")?.key_id, "deputy-webhook-v3");
  assert.equal(await backgroundRotatedStore.rewrapPreviousMaterials(), 0);
  stored.setup_status = "retry_wait";
  const afterBackgroundRotation = await backgroundRotatedStore.prepare(
    "01J00000000000000000000003",
    "01J00000000000000000000001",
  );
  assert.equal(afterBackgroundRotation.material.customHeaderSecret, first.material.customHeaderSecret);
});

test("normal Deputy OAuth provisioning reconciles every required vendor topic with a unique connection header", async () => {
  const writes: Record<string, unknown>[] = [];
  const connector = new DeputyConnector({
    clientId: "client",
    clientSecret: "secret",
    redirectUri: "https://albert.example/api/oauth/deputy/callback",
    vault: new StaticVault({
      provider: "deputy",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      tokenType: "Bearer",
      expiresAt: "2099-01-01T00:00:00.000Z",
      scopes: ["longlife_refresh_token"],
      metadata: { endpoint: "demo.au.deputy.com" },
    }),
    fetcher: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer access-token");
      if (url.pathname.endsWith("/Webhook/QUERY")) return Response.json([]);
      assert.equal(url.pathname, "/api/v1/resource/Webhook");
      const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
      writes.push(payload);
      return Response.json({ Id: writes.length });
    },
  });
  const result = await connector.provision_webhooks({
    tenantId: "01J00000000000000000000003",
    connectionId: "01J00000000000000000000001",
    credentialRef: "oauth-fixture",
  }, { callbackUrl, customHeaderSecret });

  assert.equal(writes.length, DEPUTY_WEBHOOK_TOPICS.length);
  assert.deepEqual(writes.map((value) => value.Topic), [...DEPUTY_WEBHOOK_TOPICS]);
  assert.ok(writes.every((value) =>
    value.Address === callbackUrl &&
    value.Headers === `X-Albert-Webhook-Secret: ${customHeaderSecret}` &&
    value.Enabled === 1 && value.Type === "URL"
  ));
  assert.deepEqual(Object.keys(result.vendorWebhookIds), [...DEPUTY_WEBHOOK_TOPICS]);
});

test("Deputy webhook permission denial preserves OAuth and exposes an action-required retry state", async () => {
  const database = new MaterialDatabase();
  const coordinator = new DeputyWebhookSetupCoordinator(new DeputyWebhookMaterialStore(
    database,
    Buffer.alloc(32, 22).toString("base64url"),
    "deputy-webhook-v1",
    "https://hooks.albert.example",
  ));
  const connector = new DeputyConnector({
    clientId: "client",
    clientSecret: "secret",
    redirectUri: "https://albert.example/api/oauth/deputy/callback",
    vault: new StaticVault({
      provider: "deputy",
      accessToken: "access-token",
      refreshToken: "refresh-token",
      tokenType: "Bearer",
      expiresAt: "2099-01-01T00:00:00.000Z",
      scopes: ["longlife_refresh_token"],
      metadata: { endpoint: "demo.au.deputy.com" },
    }),
    fetcher: async () => new Response("permission denied", { status: 403 }),
  });
  const result = await coordinator.provision({
    connector,
    context: {
      tenantId: "01J00000000000000000000003",
      connectionId: "01J00000000000000000000001",
      credentialRef: "oauth-fixture",
    },
  });
  assert.deepEqual(result, {
    state: "action_required",
    reasonCode: "deputy_webhook_permission_required",
    provisionedTopics: [],
  });
  const stored = database.rows.get("01J00000000000000000000003:01J00000000000000000000001");
  assert.equal(stored?.setup_status, "blocked_permission");
  assert.equal(database.connectionStates.at(-1)?.[2], "degraded");
  assert.equal(database.connectionStates.at(-1)?.[3], "blocked_permission");
  assert.equal(database.connectionStates.at(-1)?.[4], "deputy_webhook_permission_required");
});

test("a connected Deputy account with incomplete webhook setup is visibly recoverable", () => {
  const workspace = toConnectionsWorkspace({
    tenant_id: "01J00000000000000000000003",
    tenant_name: "Albert Cycle Co.",
    connections: [{
      connection_id: "01J00000000000000000000001",
      connector_key: "deputy",
      display_name: "Albert Deputy",
      status: "degraded",
      auth_health: "healthy",
      authorised_at: receivedAt,
      last_checked_at: receivedAt,
      readiness: [],
    }],
    dossier: null,
    identity_review_tasks: [],
    blocking_answers: {},
    oauth_sessions: [],
  }, "Australia/Melbourne");
  const deputy = workspace.providers.find((provider) => provider.id === "deputy");
  assert.equal(deputy?.auth.state, "error");
  assert.equal(deputy?.auth.label, "Connected · setup needs attention");
  assert.match(deputy?.auth.detail ?? "", /Reconnect to retry/u);
});

test("Deputy ingress SQL exposes one material resolver and one fixed enqueue path without OAuth-table grants", async () => {
  const [migration, gateway, oauth, sessionStore, environment] = await Promise.all([
    readFile(new URL("infra/migrations/control-plane/0009_deputy_webhook_security.sql", root), "utf8"),
    readFile(new URL("services/webhook-gateway/src/deputy.ts", root), "utf8"),
    readFile(new URL("services/sync-workers/src/oauth-http.ts", root), "utf8"),
    readFile(new URL("services/sync-workers/src/oauth-session-store.ts", root), "utf8"),
    readFile(new URL(".env.example", root), "utf8"),
  ]);
  assert.match(migration, /REVOKE ALL ON TABLE control_plane\.oauth_token_refs FROM albert_webhook_control/i);
  assert.match(migration, /resolve_deputy_webhook_material[\s\S]*SECURITY DEFINER/i);
  assert.match(migration, /assert_deputy_webhook_gateway_ready[\s\S]*SECURITY DEFINER/i);
  assert.match(migration, /enqueue_deputy_webhook_sync[\s\S]*SECURITY DEFINER/i);
  assert.match(migration, /webhook\.received_at\s*=\s*p_received_at/i);
  assert.doesNotMatch(migration, /GRANT[^;]*oauth_(?:token_refs|secret_envelopes)[^;]*albert_webhook_control/i);
  assert.match(gateway, /resolve_deputy_webhook_material\(\$1, \$2\)/u);
  assert.match(gateway, /associatedData\(resolved\)/u);
  assert.match(oauth, /finalizeConnection[\s\S]*provisionDeputyWebhooks/u);
  assert.match(sessionStore, /provider === "deputy" \? "degraded" : "connected"/u);
  assert.match(sessionStore, /webhook_setup:[\s\S]*status: "pending"[\s\S]*recoverable: true/u);
  assert.doesNotMatch(environment, /DEPUTY_WEBHOOK_(?:SHARED_SECRET|SIGNING_KEY)=/u);
  assert.match(environment, /DEPUTY_WEBHOOK_ENCRYPTION_KEY=/u);
});
