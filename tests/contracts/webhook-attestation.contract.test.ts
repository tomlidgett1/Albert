import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createWebhookAttestor } from "../../services/webhook-gateway/src/attestation.js";

const root = new URL("../../", import.meta.url);

test("webhook proofs bind the exact document, operation, receipt, time, and one-use nonce", () => {
  const secret = Buffer.alloc(32, 11);
  const document = JSON.stringify({
    version: 1,
    operation: "receipt.finalize",
    receiptId: "01J00000000000000000000003",
    streams: ["employees"],
  });
  const attestor = createWebhookAttestor({
    keyId: "webhook-v1",
    encodedSecret: secret.toString("base64url"),
    now: () => 1_786_272_000_000,
    nonce: () => Buffer.alloc(16, 12).toString("base64url"),
  });
  const proof = attestor.attest(
    "receipt.finalize",
    "01J00000000000000000000003",
    document,
  );
  const digest = createHash("sha256").update(document, "utf8").digest("hex");
  const canonical = [
    "albert:webhook-attestation:v1",
    "receipt.finalize",
    "01J00000000000000000000003",
    digest,
    proof.issuedAt,
    proof.nonce,
  ].join("\n");
  assert.equal(
    proof.signature,
    createHmac("sha256", secret).update(canonical, "utf8").digest("hex"),
  );
  const tampered = document.replace("employees", "timesheets");
  const tamperedDigest = createHash("sha256").update(tampered, "utf8").digest("hex");
  assert.notEqual(tamperedDigest, digest);
  assert.throws(
    () => createWebhookAttestor({ keyId: "webhook-v1", encodedSecret: "short" }),
    /exactly 32 bytes/u,
  );
});

test("control plane consumes proofs once and leaves the edge no receipt-table or enqueue authority", async () => {
  const [migration, lifecycle, store, provisioner, contract] = await Promise.all([
    readFile(new URL("infra/migrations/control-plane/0037_m7_verified_webhook_attestation_boundary.sql", root), "utf8"),
    readFile(new URL("infra/migrations/control-plane/0039_m7_proof_gated_webhook_lifecycle.sql", root), "utf8"),
    readFile(new URL("services/webhook-gateway/src/store.ts", root), "utf8"),
    readFile(new URL("scripts/provision-webhook-attestation-key.ts", root), "utf8"),
    readFile(new URL("deploy/runtime-contract.json", root), "utf8"),
  ]);
  assert.match(migration, /PRIMARY KEY \(key_id, nonce\)/u);
  assert.match(migration, /p_issued_at < current_epoch - 300/u);
  assert.match(migration, /extensions\.hmac\(/u);
  assert.match(migration, /EXCEPTION WHEN unique_violation[\s\S]*already consumed/u);
  assert.match(lifecycle, /pg_advisory_xact_lock\([\s\S]*webhook-attestation:key-ring/u);
  assert.match(lifecycle, /gen_random_bytes\(16\)[\s\S]*lease_version\s*=\s*item\.lease_version\s*\+\s*1/u);
  assert.match(
    lifecycle,
    /assert_xero_webhook_lease_fence[\s\S]*lease_token\s*=\s*p_lease_token[\s\S]*lease_version\s*=\s*p_lease_version[\s\S]*lease_expires_at\s*>\s*clock_timestamp/u,
  );
  assert.match(lifecycle, /assert_attested_webhook_gateway_ready[\s\S]*consume_webhook_attestation/u);
  assert.match(
    lifecycle,
    /REVOKE EXECUTE ON FUNCTION[\s\S]*claim_xero_webhook_inbox\(text,integer,integer\)[\s\S]*resolve_deputy_webhook_material\(text,text\)[\s\S]*attach_attested_webhook_raw\(text,text,text,text\)[\s\S]*FROM PUBLIC/iu,
  );
  assert.match(
    migration,
    /REVOKE ALL ON TABLE control_plane\.connections, control_plane\.webhook_receipts\s+FROM albert_webhook_control/u,
  );
  assert.match(
    migration,
    /REVOKE EXECUTE ON FUNCTION control_plane\.enqueue_deputy_webhook_sync\([\s\S]*FROM albert_webhook_control/u,
  );
  assert.doesNotMatch(store, /insert into control_plane\.webhook_receipts/iu);
  assert.doesNotMatch(store, /update control_plane\.webhook_receipts/iu);
  assert.match(store, /reserve_attested_webhook_receipt/u);
  assert.match(store, /finalize_attested_deputy_webhook/u);
  assert.match(provisioner, /install_webhook_attestation_key\(\$1, \$2::bytea\)/u);
  assert.doesNotMatch(provisioner, /console\.log\([^)]*secret|process\.stdout[^;]*secret/iu);
  const deployment = JSON.parse(contract) as {
    runtimes: { "webhook-gateway": { requiredSecretNames: string[] } };
  };
  assert.ok(deployment.runtimes["webhook-gateway"].requiredSecretNames.includes(
    "WEBHOOK_ATTESTATION_SECRET",
  ));
});

test("manual-only Xero webhooks remain proof-bound connection deliveries", async () => {
  const migration = await readFile(
    new URL("infra/migrations/control-plane/0173_m2_xero_manual_webhook_delivery.sql", root),
    "utf8",
  );
  assert.match(migration, /receipt\.status IN \('queued','ignored'\)/u);
  assert.match(migration, /receipt\.signature_verified/u);
  assert.match(migration, /receipt\.raw_object_key IS NOT NULL/u);
  assert.match(
    migration,
    /REVOKE ALL ON FUNCTION[\s\S]*record_attested_xero_webhook_connection_delivery[\s\S]*FROM PUBLIC,anon,authenticated,service_role/u,
  );
  assert.match(
    migration,
    /GRANT EXECUTE ON FUNCTION[\s\S]*record_attested_xero_webhook_connection_delivery[\s\S]*TO albert_webhook_control/u,
  );
});
