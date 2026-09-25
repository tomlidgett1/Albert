import assert from "node:assert/strict";
import { createHash, createPublicKey } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import {
  assertControlPlaneAdminIdentity,
  assertProtectedAdminDatabaseUrl,
} from "./admin-bootstrap-upgrades.js";

const LOGIN = "albert_vendor_attestor_runtime";
const GROUP = "albert_vendor_connection_attestor";

export interface VendorAttestorPublicKeyMaterial {
  readonly keyId: string;
  readonly publicKeyDer: Buffer;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function literal(value: string): string {
  if (value.includes("\u0000")) throw new Error("PostgreSQL password cannot contain NUL.");
  return `'${value.replaceAll("'", "''")}'`;
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/u.test(value)) {
    throw new Error(`Unsafe PostgreSQL identifier: ${value}`);
  }
  return `"${value}"`;
}

function strictBase64(name: string, value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error(`${name} must be canonical padded base64.`);
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    decoded.fill(0);
    throw new Error(`${name} must be canonical padded base64.`);
  }
  return decoded;
}

export function parseVendorAttestorPublicKey(value: string): VendorAttestorPublicKeyMaterial {
  const publicKeyBytes = strictBase64("ALBERT_VENDOR_ATTESTOR_ED25519_PUBLIC_KEY_BASE64", value);
  try {
    const publicKey = createPublicKey({ key: publicKeyBytes, format: "der", type: "spki" });
    assert.equal(publicKey.asymmetricKeyType, "ed25519", "Vendor attestor public key must be Ed25519.");
    const publicKeyDer = Buffer.from(publicKey.export({ type: "spki", format: "der" }));
    return {
      publicKeyDer,
      keyId: `ed25519:${createHash("sha256").update(publicKeyDer).digest("hex")}`,
    };
  } finally {
    publicKeyBytes.fill(0);
  }
}

export async function provisionVendorConnectionAttestor(): Promise<void> {
  const databaseUrl = required("CONTROL_PLANE_ADMIN_DATABASE_URL");
  assertProtectedAdminDatabaseUrl(databaseUrl);
  const password = required("ALBERT_VENDOR_ATTESTOR_DB_PASSWORD");
  assert.ok(Buffer.byteLength(password, "utf8") >= 32 && Buffer.byteLength(password, "utf8") <= 256,
    "ALBERT_VENDOR_ATTESTOR_DB_PASSWORD must contain between 32 and 256 bytes.");
  const { publicKeyDer, keyId } = parseVendorAttestorPublicKey(
    required("ALBERT_VENDOR_ATTESTOR_ED25519_PUBLIC_KEY_BASE64"),
  );
  assert.equal(required("ALBERT_VENDOR_ATTESTOR_KEY_ID"), keyId,
    "ALBERT_VENDOR_ATTESTOR_KEY_ID must match the public key.");
  const toolRef = required("ALBERT_VENDOR_ATTESTOR_TOOL_REF");
  const buildDigest = required("ALBERT_VENDOR_ATTESTOR_BUILD_DIGEST");
  const admissionKey = strictBase64(
    "ALBERT_VENDOR_ATTESTOR_ADMISSION_HMAC_KEY_BASE64",
    required("ALBERT_VENDOR_ATTESTOR_ADMISSION_HMAC_KEY_BASE64"),
  );
  assert.equal(admissionKey.byteLength, 32, "Vendor attestor admission HMAC key must contain 32 bytes.");
  const client = new Client({
    connectionString: databaseUrl,
    application_name: "albert-vendor-attestor-provisioner",
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  try {
    await assertControlPlaneAdminIdentity(client);
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", ["albert:vendor-attestor-provision"]);
    const group = await client.query<{
      rolcanlogin: boolean; rolinherit: boolean; rolsuper: boolean;
      rolcreaterole: boolean; rolcreatedb: boolean; rolreplication: boolean; rolbypassrls: boolean;
    }>(`select rolcanlogin,rolinherit,rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls
          from pg_catalog.pg_roles where rolname=$1`, [GROUP]);
    const role = group.rows[0];
    if (!role || role.rolcanlogin || role.rolinherit || role.rolsuper || role.rolcreaterole ||
      role.rolcreatedb || role.rolreplication || role.rolbypassrls) {
      throw new Error("Vendor attestor NOLOGIN group is missing or unsafe; apply administrator upgrade 0010.");
    }
    const existing = await client.query<{
      rolsuper: boolean; rolcreaterole: boolean; rolcreatedb: boolean;
      rolreplication: boolean; rolbypassrls: boolean;
    }>(`select rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls
          from pg_catalog.pg_roles where rolname=$1`, [LOGIN]);
    const existingLogin = existing.rows[0];
    if (existingLogin && (existingLogin.rolsuper || existingLogin.rolcreaterole ||
      existingLogin.rolcreatedb || existingLogin.rolreplication || existingLogin.rolbypassrls)) {
      throw new Error(
        "Existing vendor attestor runtime login has unsafe role attributes; protected postgres will not rewrite a privileged role.",
      );
    }
    if (!existingLogin) {
      await client.query(`create role ${LOGIN} nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);
    }
    // Managed Supabase postgres may change ordinary role properties but its
    // supautils hook rejects restating privileged attributes. The guard above
    // fails closed before this ordinary-property mutation.
    await client.query(
      `alter role ${identifier(LOGIN)} with nologin noinherit connection limit 4`,
    );
    const memberships = await client.query<{ role_name: string }>(
      `select parent.rolname as role_name from pg_catalog.pg_auth_members membership
       join pg_catalog.pg_roles parent on parent.oid=membership.roleid
       join pg_catalog.pg_roles member on member.oid=membership.member
       where member.rolname=$1`, [LOGIN],
    );
    for (const membership of memberships.rows) {
      if (membership.role_name !== GROUP) {
        await client.query(`revoke ${identifier(membership.role_name)} from ${identifier(LOGIN)}`);
      }
    }
    await client.query(`grant ${identifier(GROUP)} to ${identifier(LOGIN)}`);
    await client.query(`alter role ${identifier(LOGIN)} with login password ${literal(password)}`);
    await client.query(`alter role ${identifier(LOGIN)} set statement_timeout='25s'`);
    await client.query(`alter role ${identifier(LOGIN)} set lock_timeout='2s'`);
    await client.query(`alter role ${identifier(LOGIN)} set idle_in_transaction_session_timeout='30s'`);
    await client.query(`alter role ${identifier(LOGIN)} set search_path='pg_catalog'`);
    await client.query(
      "select extensions.albert_configure_vendor_attestor_verifier($1,$2,$3,$4,$5)",
      [keyId, Buffer.from(publicKeyDer).toString("base64"), toolRef, buildDigest, Buffer.from(admissionKey).toString("base64")],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    admissionKey.fill(0);
    await client.end();
  }
  process.stdout.write(`provisioned ${LOGIN} and pinned ${keyId}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await provisionVendorConnectionAttestor();
}
