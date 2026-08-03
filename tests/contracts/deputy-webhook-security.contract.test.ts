import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  DEPUTY_WEBHOOK_TOPICS,
  parseDeputyWebhook,
} from "../../connectors/deputy/webhooks.js";
import type { PostgresQueryClient } from "../../packages/queue/src/index.js";
import { sealSecret } from "../../packages/security/src/index.js";
import { toConnectionsWorkspace } from "../../services/control-plane/src/connections-workspace.js";
import { DeputyWebhookMaterialStore } from "../../services/sync-workers/src/deputy-webhooks.js";
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
  retired_at: null;
};

class MaterialDatabase implements TransactionalPostgres {
  readonly rows = new Map<string, StoredMaterial>();
  readonly statements: string[] = [];

  async transaction<T>(work: (client: PostgresQueryClient) => Promise<T>): Promise<T> {
    return work(this);
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<Readonly<{ rows: readonly Row[] }>> {
    const statement = sql.replace(/\s+/gu, " ").trim();
    this.statements.push(statement);
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
          setup_status: "installation_required",
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
      return { rows: (row ? [row] : []) as Row[] };
    }
    if (statement.startsWith("update control_plane.deputy_webhook_material") && statement.includes("set callback_url")) {
      const row = this.rows.get(key);
      if (row) {
        row.callback_url = String(values[2]);
        if (row.setup_status !== "active") row.setup_status = "installation_required";
      }
      return { rows: [] };
    }
    if (statement.startsWith("update control_plane.deputy_webhook_material") && statement.includes("set envelope_version = $4")) {
      const row = this.rows.get(key);
      if (!row || row.material_id !== values[2] || row.key_id !== values[8]) return { rows: [] };
      row.envelope_version = Number(values[3]) as 1;
      row.algorithm = String(values[4]) as "A256GCM";
      row.key_id = String(values[5]);
      row.iv = String(values[6]);
      row.ciphertext = String(values[7]);
      return { rows: [{ material_id: row.material_id } as unknown as Row] };
    }
    if (statement.startsWith("update control_plane.deputy_webhook_material") && statement.includes("set envelope_version = $5")) {
      const row = this.rows.get(key);
      if (!row || row.material_id !== values[2] || row.key_id !== values[3]) return { rows: [] };
      row.envelope_version = Number(values[4]) as 1;
      row.algorithm = String(values[5]) as "A256GCM";
      row.key_id = String(values[6]);
      row.iv = String(values[7]);
      row.ciphertext = String(values[8]);
      return { rows: [{ material_id: row.material_id } as unknown as Row] };
    }
    if (statement.startsWith("insert into control_plane.audit_log")) return { rows: [] };
    throw new Error(`Unhandled material-store query: ${statement}`);
  }
}

test("explicit operator preparation creates encrypted, stable, connection-bound material without a vendor client", async () => {
  const database = new MaterialDatabase();
  const firstKey = Buffer.alloc(32, 21).toString("base64url");
  const store = new DeputyWebhookMaterialStore(
    database,
    firstKey,
    "deputy-webhook-v1",
    "https://hooks.albert.example",
  );
  const first = await store.prepareForOperatorInstallation(
    "01J00000000000000000000003",
    "01J00000000000000000000001",
  );
  const repeated = await store.prepareForOperatorInstallation(
    "01J00000000000000000000003",
    "01J00000000000000000000001",
  );
  const other = await store.prepareForOperatorInstallation(
    "01J00000000000000000000006",
    "01J00000000000000000000007",
  );
  assert.equal(repeated.materialId, first.materialId);
  assert.equal(repeated.material.customHeaderSecret, first.material.customHeaderSecret);
  assert.notEqual(other.material.customHeaderSecret, first.material.customHeaderSecret);
  assert.equal(first.callbackUrl, `https://hooks.albert.example/v1/webhooks/deputy/01J00000000000000000000001/${first.materialId}`);
  const stored = database.rows.get("01J00000000000000000000003:01J00000000000000000000001");
  assert.equal(stored?.setup_status, "installation_required");
  assert.equal(stored?.ciphertext.includes(first.material.customHeaderSecret), false);
  assert.ok(database.statements.some((statement) =>
    statement.includes("deputy.webhook_material_prepared_for_operator") &&
    statement.includes("vendor_write_performed")
  ));

  const secondKey = Buffer.alloc(32, 23).toString("base64url");
  const rotatedStore = new DeputyWebhookMaterialStore(
    database,
    secondKey,
    "deputy-webhook-v2",
    "https://hooks.albert.example",
    new Map([["deputy-webhook-v1", firstKey]]),
  );
  const rotated = await rotatedStore.prepareForOperatorInstallation(
    "01J00000000000000000000003",
    "01J00000000000000000000001",
  );
  assert.equal(rotated.material.customHeaderSecret, first.material.customHeaderSecret);
  assert.equal(stored?.key_id, "deputy-webhook-v2");
  assert.equal(stored?.ciphertext.includes(rotated.material.customHeaderSecret), false);

  const thirdKey = Buffer.alloc(32, 24).toString("base64url");
  const backgroundStore = new DeputyWebhookMaterialStore(
    database,
    thirdKey,
    "deputy-webhook-v3",
    "https://hooks.albert.example",
    new Map([
      ["deputy-webhook-v1", firstKey],
      ["deputy-webhook-v2", secondKey],
    ]),
  );
  assert.equal(await backgroundStore.rewrapPreviousMaterials(), 2);
  assert.equal(stored?.key_id, "deputy-webhook-v3");
  assert.equal(await backgroundStore.rewrapPreviousMaterials(), 0);
});

test("optional Deputy webhook installation is visible without degrading the core connection", () => {
  const workspace = toConnectionsWorkspace({
    tenant_id: "01J00000000000000000000003",
    tenant_name: "Albert Cycle Co.",
    connections: [{
      connection_id: "01J00000000000000000000001",
      connector_key: "deputy",
      display_name: "Albert Deputy",
      status: "connected",
      auth_health: "healthy",
      account_metadata: {
        webhook_setup: {
          status: "operator_installation_required",
          reason_code: "deputy_webhook_operator_installation_required",
          optional: true,
          completeness_mode: "scheduled_polling_and_reconciliation",
        },
      },
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
  const deputyConnection = deputy?.connections[0];
  assert.equal(deputyConnection?.auth.state, "healthy");
  assert.equal(deputyConnection?.auth.label, "Connected");
  assert.match(deputyConnection?.auth.detail ?? "", /polling and reconciliation provide complete ingestion/iu);
  assert.match(deputyConnection?.auth.detail ?? "", /optional webhooks require explicit owner or operator installation/iu);
});

test("Deputy ingress remains connection-bound while OAuth and sync composition have no provisioning authority", async () => {
  const [migration, boundaryMigration, proofBoundary, gateway, connector, oauth, sessionStore, main, config, environment] = await Promise.all([
    readFile(new URL("infra/migrations/control-plane/0009_deputy_webhook_security.sql", root), "utf8"),
    readFile(new URL("infra/migrations/control-plane/0028_m7_deputy_read_only_webhook_boundary.sql", root), "utf8"),
    readFile(new URL("infra/migrations/control-plane/0039_m7_proof_gated_webhook_lifecycle.sql", root), "utf8"),
    readFile(new URL("services/webhook-gateway/src/deputy.ts", root), "utf8"),
    readFile(new URL("connectors/deputy/index.ts", root), "utf8"),
    readFile(new URL("services/sync-workers/src/oauth-http.ts", root), "utf8"),
    readFile(new URL("services/sync-workers/src/oauth-session-store.ts", root), "utf8"),
    readFile(new URL("services/sync-workers/src/main.ts", root), "utf8"),
    readFile(new URL("services/sync-workers/src/config.ts", root), "utf8"),
    readFile(new URL(".env.example", root), "utf8"),
  ]);
  assert.match(migration, /REVOKE ALL ON TABLE control_plane\.oauth_token_refs FROM albert_webhook_control/i);
  assert.match(migration, /resolve_deputy_webhook_material[\s\S]*SECURITY DEFINER/i);
  assert.match(migration, /enqueue_deputy_webhook_sync[\s\S]*SECURITY DEFINER/i);
  assert.match(migration, /webhook\.received_at\s*=\s*p_received_at/i);
  assert.doesNotMatch(migration, /GRANT[^;]*oauth_(?:token_refs|secret_envelopes)[^;]*albert_webhook_control/i);
  assert.match(gateway, /resolve_attested_deputy_webhook_material\([\s\S]*\$1, \$2, \$3, \$4, \$5/u);
  assert.match(
    proofBoundary,
    /REVOKE EXECUTE ON FUNCTION[\s\S]*resolve_deputy_webhook_material\(text,text\)[\s\S]*FROM PUBLIC,[\s\S]*albert_webhook_control/iu,
  );
  assert.match(
    proofBoundary,
    /GRANT EXECUTE ON FUNCTION[\s\S]*resolve_attested_deputy_webhook_material\(text,bigint,text,text,text\)[\s\S]*TO albert_webhook_control/iu,
  );
  assert.match(gateway, /associatedData\(resolved\)/u);
  assert.doesNotMatch(connector, /provision_webhooks|resource\/Webhook/u);
  assert.doesNotMatch(oauth, /provisionDeputyWebhooks|webhookSetup|DeputyWebhookSetupCoordinator/u);
  assert.doesNotMatch(main, /DeputyWebhookMaterialStore|DeputyWebhookSetupCoordinator/u);
  assert.doesNotMatch(config, /DEPUTY_WEBHOOK_ENCRYPTION_KEY|WEBHOOK_GATEWAY_PUBLIC_URL/u);
  assert.match(sessionStore, /finalize_oauth_connection_identity/u);
  assert.match(sessionStore, /status: "operator_installation_required"/u);
  assert.match(boundaryMigration, /scheduled_polling_and_reconciliation/u);
  assert.match(boundaryMigration, /account_metadata/u);
  assert.doesNotMatch(environment, /DEPUTY_WEBHOOK_(?:SHARED_SECRET|SIGNING_KEY)=/u);
  assert.match(environment, /DEPUTY_WEBHOOK_ENCRYPTION_KEY=/u);
  assert.deepEqual([...DEPUTY_WEBHOOK_TOPICS].sort(), [...new Set(DEPUTY_WEBHOOK_TOPICS)].sort());
});
