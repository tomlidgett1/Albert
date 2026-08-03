import { pathToFileURL } from "node:url";
import pg from "pg";

const { Pool } = pg;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function decodeSecret(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new Error("WEBHOOK_ATTESTATION_SECRET must be an unpadded base64url 32-byte key.");
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== 32 || decoded.toString("base64url") !== value) {
    throw new Error("WEBHOOK_ATTESTATION_SECRET must be an unpadded base64url 32-byte key.");
  }
  return decoded;
}

export async function provisionWebhookAttestationKey(): Promise<void> {
  const databaseUrl = required("CONTROL_PLANE_MIGRATION_URL");
  const keyId = required("WEBHOOK_ATTESTATION_KEY_ID");
  if (!/^[a-z][a-z0-9._-]{0,63}$/u.test(keyId)) {
    throw new Error("WEBHOOK_ATTESTATION_KEY_ID is invalid.");
  }
  const secret = decodeSecret(required("WEBHOOK_ATTESTATION_SECRET"));
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    application_name: "albert-webhook-attestation-provisioner",
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE albert_control_migration_owner");
    await client.query(
      "SELECT control_plane.install_webhook_attestation_key($1, $2::bytea)",
      [keyId, secret],
    );
    await client.query("SELECT control_plane.assert_webhook_attestation_ready($1)", [keyId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    secret.fill(0);
    client.release();
    await pool.end();
  }
  process.stdout.write(`Provisioned webhook attestation key ${keyId}.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await provisionWebhookAttestationKey();
}
