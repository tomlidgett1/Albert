import { Client, type ClientConfig } from "pg";
import { pathToFileURL } from "node:url";

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
    Object.freeze({ login: "albert_operator_diagnostic_control_runtime", group: "albert_operator_diagnostic_control", passwordEnvironmentName: "ALBERT_OPERATOR_DIAGNOSTIC_CONTROL_DB_PASSWORD", connectionLimit: 8, statementTimeout: "5s" }),
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
    Object.freeze({ login: "albert_operator_diagnostic_analytical_runtime", group: "diagnostic_ro", passwordEnvironmentName: "ALBERT_OPERATOR_DIAGNOSTIC_ANALYTICAL_DB_PASSWORD", connectionLimit: 8, statementTimeout: "5s" }),
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
    rolinherit: boolean;
    rolsuper: boolean;
    rolcreaterole: boolean;
    rolcreatedb: boolean;
    rolreplication: boolean;
    rolbypassrls: boolean;
  }>(
    `SELECT rolcanlogin,rolinherit,rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls
       FROM pg_catalog.pg_roles WHERE rolname=$1`,
    [group],
  );
  const role = result.rows[0];
  if (!role) throw new Error(`Required group ${group} is missing; run the bootstrap first.`);
  if (role.rolcanlogin || role.rolinherit || role.rolsuper || role.rolcreaterole || role.rolcreatedb || role.rolreplication || role.rolbypassrls) {
    throw new Error(`Required group ${group} has unsafe role attributes.`);
  }
  const parents = await client.query<{ role_name: string; admin_option: boolean }>(
    `SELECT parent.rolname AS role_name,membership.admin_option
       FROM pg_catalog.pg_auth_members AS membership
       JOIN pg_catalog.pg_roles AS parent ON parent.oid=membership.roleid
       JOIN pg_catalog.pg_roles AS member ON member.oid=membership.member
      WHERE member.rolname=$1`,
    [group],
  );
  if (parents.rowCount) {
    throw new Error(`Required group ${group} must not inherit or hold membership in another role.`);
  }
}

async function reconcileLogin(client: Client, spec: LoginSpec): Promise<void> {
  await assertGroup(client, spec.group);
  const login = identifier(spec.login);
  const group = identifier(spec.group);
  const existingRole = await client.query<{
    rolcanlogin: boolean;
    rolinherit: boolean;
    rolsuper: boolean;
    rolcreaterole: boolean;
    rolcreatedb: boolean;
    rolreplication: boolean;
    rolbypassrls: boolean;
    rolconnlimit: number;
  }>(
    `SELECT rolcanlogin,rolinherit,rolsuper,rolcreaterole,rolcreatedb,
            rolreplication,rolbypassrls,rolconnlimit
       FROM pg_catalog.pg_roles
      WHERE rolname=$1`,
    [spec.login],
  );
  const prior = existingRole.rows[0];
  if (
    prior
    && (prior.rolsuper
      || prior.rolcreaterole
      || prior.rolcreatedb
      || prior.rolreplication
      || prior.rolbypassrls)
  ) {
    throw new Error(
      `Existing runtime login ${spec.login} has unsafe role attributes; protected postgres will not rewrite a privileged role.`,
    );
  }
  if (!prior) {
    await client.query(`CREATE ROLE ${login} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
  }

  // Supabase's protected postgres identity has CREATEROLE but is not a
  // superuser. Its supautils hook rejects ALTER ROLE statements that restate
  // SUPERUSER/CREATEDB/CREATEROLE/REPLICATION/BYPASSRLS, even when every value
  // is false. The existing-role guard above fails closed on those attributes;
  // this statement changes only the ordinary properties postgres may manage.
  await client.query(
    `ALTER ROLE ${login} WITH LOGIN NOINHERIT CONNECTION LIMIT ${spec.connectionLimit} PASSWORD ${literal(password(spec.passwordEnvironmentName))}`,
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
  const reconciledMemberships = await client.query<{
    role_name: string;
    admin_option: boolean;
  }>(
    `SELECT parent.rolname AS role_name,membership.admin_option
       FROM pg_catalog.pg_auth_members AS membership
       JOIN pg_catalog.pg_roles AS parent ON parent.oid=membership.roleid
       JOIN pg_catalog.pg_roles AS member ON member.oid=membership.member
      WHERE member.rolname=$1`,
    [spec.login],
  );
  if (
    reconciledMemberships.rows.length !== 1
    || reconciledMemberships.rows[0]?.role_name !== spec.group
    || reconciledMemberships.rows[0]?.admin_option
  ) {
    throw new Error(`Runtime login ${spec.login} does not have exactly one non-admin group membership.`);
  }
  const reconciledRole = await client.query<{
    rolcanlogin: boolean;
    rolinherit: boolean;
    rolsuper: boolean;
    rolcreaterole: boolean;
    rolcreatedb: boolean;
    rolreplication: boolean;
    rolbypassrls: boolean;
    rolconnlimit: number;
  }>(
    `SELECT rolcanlogin,rolinherit,rolsuper,rolcreaterole,rolcreatedb,
            rolreplication,rolbypassrls,rolconnlimit
       FROM pg_catalog.pg_roles
      WHERE rolname=$1`,
    [spec.login],
  );
  const verified = reconciledRole.rows[0];
  if (
    !verified
    || !verified.rolcanlogin
    || verified.rolinherit
    || verified.rolsuper
    || verified.rolcreaterole
    || verified.rolcreatedb
    || verified.rolreplication
    || verified.rolbypassrls
    || verified.rolconnlimit !== spec.connectionLimit
  ) {
    throw new Error(`Runtime login ${spec.login} did not converge to its safe role attributes.`);
  }
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

function requestedCells(arguments_:readonly string[]):readonly CellSpec[]{
  const target=arguments_.find((value)=>value.startsWith("--target="));
  if(arguments_.some((value)=>!value.startsWith("--target="))){
    throw new Error("Only --target=control-plane|analytical is supported.");
  }
  if(!target)return[controlPlane,analytical];
  const value=target.slice("--target=".length);
  if(value==="control-plane")return[controlPlane];
  if(value==="analytical")return[analytical];
  throw new Error("--target must be control-plane or analytical.");
}

export async function provisionRuntimeLogins(arguments_:readonly string[]=process.argv.slice(2)):Promise<void>{
  const selected=requestedCells(arguments_);
  const targets=selected.map((cell)=>({
    cell,
    url:databaseUrl(cell.adminUrlEnvironmentName),
  }));
  if(targets.length===2&&targets[0]!.url===targets[1]!.url){
    throw new Error("Control-plane and analytical administrator URLs must be different.");
  }
  for(const target of targets)await provisionCell(target.cell,target.url);
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  await provisionRuntimeLogins();
}
