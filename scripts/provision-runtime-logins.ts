import { Client, type ClientConfig } from "pg";

type LoginSpec = Readonly<{
  login: string;
  group: string;
  passwordEnvironmentName: string;
  connectionLimit: number;
  statementTimeout: string;
}>;

type CellSpec = Readonly<{
  label: string;
  adminUrlEnvironmentName: string;
  logins: readonly LoginSpec[];
}>;

const controlPlane: CellSpec = Object.freeze({
  label: "control-plane",
  adminUrlEnvironmentName: "CONTROL_PLANE_ADMIN_DATABASE_URL",
  logins: Object.freeze([
    Object.freeze({ login: "albert_control_deployer", group: "albert_control_migration_owner", passwordEnvironmentName: "ALBERT_CONTROL_DEPLOYER_DB_PASSWORD", connectionLimit: 4, statementTimeout: "5min" }),
    Object.freeze({ login: "albert_sync_control_runtime", group: "albert_sync_control", passwordEnvironmentName: "ALBERT_SYNC_CONTROL_DB_PASSWORD", connectionLimit: 24, statementTimeout: "30s" }),
    Object.freeze({ login: "albert_transform_control_runtime", group: "albert_transform_control", passwordEnvironmentName: "ALBERT_TRANSFORM_CONTROL_DB_PASSWORD", connectionLimit: 12, statementTimeout: "30s" }),
    Object.freeze({ login: "albert_semantic_control_runtime", group: "albert_semantic_control", passwordEnvironmentName: "ALBERT_SEMANTIC_CONTROL_DB_PASSWORD", connectionLimit: 12, statementTimeout: "15s" }),
    Object.freeze({ login: "albert_webhook_control_runtime", group: "albert_webhook_control", passwordEnvironmentName: "ALBERT_WEBHOOK_CONTROL_DB_PASSWORD", connectionLimit: 24, statementTimeout: "15s" }),
    Object.freeze({ login: "albert_deletion_control_runtime", group: "albert_deletion_control", passwordEnvironmentName: "ALBERT_DELETION_CONTROL_DB_PASSWORD", connectionLimit: 12, statementTimeout: "5min" }),
  ]),
});

const analytical: CellSpec = Object.freeze({
  label: "analytical",
  adminUrlEnvironmentName: "ANALYTICAL_ADMIN_DATABASE_URL",
  logins: Object.freeze([
    Object.freeze({ login: "albert_analytical_deployer", group: "albert_migration_owner", passwordEnvironmentName: "ALBERT_ANALYTICAL_DEPLOYER_DB_PASSWORD", connectionLimit: 4, statementTimeout: "5min" }),
    Object.freeze({ login: "albert_ingest_runtime", group: "ingest_rw", passwordEnvironmentName: "ALBERT_INGEST_DB_PASSWORD", connectionLimit: 20, statementTimeout: "2min" }),
    Object.freeze({ login: "albert_transform_analytical_runtime", group: "transform_rw", passwordEnvironmentName: "ALBERT_TRANSFORM_DB_PASSWORD", connectionLimit: 20, statementTimeout: "5min" }),
    Object.freeze({ login: "albert_semantic_read_runtime", group: "semantic_ro", passwordEnvironmentName: "ALBERT_SEMANTIC_READ_DB_PASSWORD", connectionLimit: 24, statementTimeout: "15s" }),
    Object.freeze({ login: "albert_semantic_metadata_runtime", group: "semantic_meta_rw", passwordEnvironmentName: "ALBERT_SEMANTIC_METADATA_DB_PASSWORD", connectionLimit: 12, statementTimeout: "15s" }),
    Object.freeze({ login: "albert_deletion_analytical_runtime", group: "deletion_rw", passwordEnvironmentName: "ALBERT_DELETION_DB_PASSWORD", connectionLimit: 8, statementTimeout: "5min" }),
  ]),
});

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function databaseUrl(name: string): string {
  const value = required(name);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a PostgreSQL URL.`);
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(`${name} must be a PostgreSQL URL.`);
  }
  if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
    const sslMode = parsed.searchParams.get("sslmode");
    if (!sslMode || ["disable", "allow", "prefer"].includes(sslMode)) {
      throw new Error(`${name} must require TLS for a remote database.`);
    }
  }
  return value;
}

function password(name: string): string {
  const value = required(name);
  if (Buffer.byteLength(value, "utf8") < 32 || Buffer.byteLength(value, "utf8") > 256) {
    throw new Error(`${name} must contain between 32 and 256 bytes.`);
  }
  return value;
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) throw new Error("Unsafe PostgreSQL identifier.");
  return `"${value}"`;
}

function literal(value: string): string {
  if (value.includes("\u0000")) throw new Error("PostgreSQL password cannot contain NUL.");
  return `'${value.replaceAll("'", "''")}'`;
}

async function assertGroup(client: Client, group: string): Promise<void> {
  const result = await client.query<{
    rolcanlogin: boolean;
    rolsuper: boolean;
    rolcreaterole: boolean;
    rolcreatedb: boolean;
    rolreplication: boolean;
    rolbypassrls: boolean;
  }>(
    `SELECT rolcanlogin,rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls
       FROM pg_catalog.pg_roles WHERE rolname=$1`,
    [group],
  );
  const role = result.rows[0];
  if (!role) throw new Error(`Required group ${group} is missing; run the bootstrap first.`);
  if (role.rolcanlogin || role.rolsuper || role.rolcreaterole || role.rolcreatedb || role.rolreplication || role.rolbypassrls) {
    throw new Error(`Required group ${group} has unsafe role attributes.`);
  }
}

async function reconcileLogin(client: Client, spec: LoginSpec): Promise<void> {
  await assertGroup(client, spec.group);
  const login = identifier(spec.login);
  const group = identifier(spec.group);
  const roleExists = await client.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=$1) AS exists",
    [spec.login],
  );
  if (!roleExists.rows[0]?.exists) {
    await client.query(`CREATE ROLE ${login} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  }

  await client.query(
    `ALTER ROLE ${login} WITH LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT ${spec.connectionLimit} PASSWORD ${literal(password(spec.passwordEnvironmentName))}`,
  );
  const memberships = await client.query<{ role_name: string }>(
    `SELECT parent.rolname AS role_name
       FROM pg_catalog.pg_auth_members AS membership
       JOIN pg_catalog.pg_roles AS parent ON parent.oid=membership.roleid
       JOIN pg_catalog.pg_roles AS member ON member.oid=membership.member
      WHERE member.rolname=$1`,
    [spec.login],
  );
  for (const membership of memberships.rows) {
    await client.query(`REVOKE ${identifier(membership.role_name)} FROM ${login}`);
  }
  await client.query(`GRANT ${group} TO ${login}`);
  await client.query(`GRANT CONNECT ON DATABASE ${identifier(String((await client.query<{ database_name: string }>("SELECT current_database() AS database_name")).rows[0]?.database_name))} TO ${login}`);
  await client.query(`ALTER ROLE ${login} SET statement_timeout = ${literal(spec.statementTimeout)}`);
  await client.query(`ALTER ROLE ${login} SET lock_timeout = '10s'`);
  await client.query(`ALTER ROLE ${login} SET idle_in_transaction_session_timeout = '60s'`);
  await client.query(`ALTER ROLE ${login} SET search_path = 'pg_catalog'`);
}

async function provisionCell(spec: CellSpec, connectionString: string): Promise<void> {
  const config: ClientConfig = {
    connectionString,
    application_name: `albert-runtime-provisioner/${spec.label}`,
    connectionTimeoutMillis: 10_000,
  };
  const client = new Client(config);
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`albert:runtime-logins:${spec.label}`]);
    for (const login of spec.logins) await reconcileLogin(client, login);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
  process.stdout.write(`reconciled ${spec.logins.length} constrained ${spec.label} logins\n`);
}

const controlUrl = databaseUrl(controlPlane.adminUrlEnvironmentName);
const analyticalUrl = databaseUrl(analytical.adminUrlEnvironmentName);
if (controlUrl === analyticalUrl) throw new Error("Control-plane and analytical administrator URLs must be different.");

await provisionCell(controlPlane, controlUrl);
await provisionCell(analytical, analyticalUrl);
