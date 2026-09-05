import { randomBytes } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { execFile, spawn } from "node:child_process";
import { Client } from "pg";
import {
  applyControlPlaneAdminUpgrades,
  assertControlPlaneAdminIdentity,
  assertProtectedAdminDatabaseUrl,
} from "./admin-bootstrap-upgrades.js";

const projectRoot = resolve(import.meta.dirname, "..");
const environmentPath = resolve(projectRoot, ".env.local");
const login = "albert_anthropic_control_runtime";
const group = "albert_anthropic_control";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required in .env.local.`);
  return value;
}

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(value)) throw new Error("Unsafe PostgreSQL identifier.");
  return `"${value}"`;
}

function literal(value: string): string {
  if (value.includes("\u0000")) throw new Error("PostgreSQL password cannot contain NUL.");
  return `'${value.replaceAll("'", "''")}'`;
}

async function readLine(prompt: string, secret = false): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Run this setup from an interactive Terminal.");
  }
  process.stdout.write(prompt);
  const input = process.stdin;
  const priorRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");
  let value = "";
  try {
    for await (const chunk of input) {
      for (const character of String(chunk)) {
        if (character === "\u0003") throw new Error("Setup cancelled.");
        if (character === "\r" || character === "\n") {
          process.stdout.write("\n");
          return value;
        }
        if (character === "\u007f") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            if (!secret) process.stdout.write("\b \b");
          }
          continue;
        }
        if (character >= " ") {
          value += character;
          if (!secret) process.stdout.write(character);
        }
      }
    }
  } finally {
    input.setRawMode(priorRaw ?? false);
    input.pause();
  }
  throw new Error("Terminal input closed before setup completed.");
}

function configuredControlPooler(): Readonly<{ projectRef: string; url: URL }> {
  const projectRef = required("ALBERT_CONTROL_PLANE_PROJECT_REF");
  if (!/^[a-z0-9]{20}$/u.test(projectRef)) throw new Error("The control-plane project ref is invalid.");
  const deployed = new URL(required("CONTROL_PLANE_DATABASE_URL"));
  if (!deployed.hostname.endsWith(".pooler.supabase.com") || deployed.port !== "5432") {
    throw new Error("Local setup requires the Supabase session pooler on port 5432.");
  }
  if (!decodeURIComponent(deployed.username).endsWith(`.${projectRef}`)) {
    throw new Error("The configured control-plane URL belongs to a different Supabase project.");
  }
  return Object.freeze({ projectRef, url: deployed });
}

function configuredDeployerUrl(): string {
  const deployerUrl = required("CONTROL_PLANE_ADMIN_DATABASE_URL");
  assertProtectedAdminDatabaseUrl(deployerUrl);
  const deployer = new URL(deployerUrl);
  const { projectRef } = configuredControlPooler();
  if (decodeURIComponent(deployer.username) !== `albert_control_deployer.${projectRef}`) {
    throw new Error("CONTROL_PLANE_ADMIN_DATABASE_URL must use the dedicated control-plane deployer login.");
  }
  return deployerUrl;
}

function buildRuntimeUrl(runtimePassword: string): string {
  const { projectRef, url: deployed } = configuredControlPooler();
  const runtime = new URL(deployed);
  runtime.username = `${login}.${projectRef}`;
  runtime.password = runtimePassword;
  runtime.searchParams.set("sslmode", "require");
  return runtime.toString();
}

function buildConnections(databasePassword: string, runtimePassword: string) {
  const { projectRef, url: deployed } = configuredControlPooler();
  const admin = new URL(deployed);
  admin.username = `postgres.${projectRef}`;
  admin.password = databasePassword;
  admin.searchParams.set("sslmode", "require");
  assertProtectedAdminDatabaseUrl(admin.toString());
  return Object.freeze({ adminUrl: admin.toString(), runtimeUrl: buildRuntimeUrl(runtimePassword) });
}

async function runControlPlaneMigrations(deployerUrl: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "scripts/migrate.ts", "--target=control-plane"],
      {
        cwd: projectRoot,
        env: {
          ...process.env,
          CONTROL_PLANE_DATABASE_URL: deployerUrl,
          ALBERT_REQUIRE_DEPLOYER_LOGIN: "true",
        },
        stdio: "inherit",
      },
    );
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`Control-plane migration failed (${signal ?? `exit ${code ?? "unknown"}`}).`));
    });
  });
}

async function provisionRuntimeLogin(adminUrl: string, runtimePassword: string): Promise<void> {
  const client = new Client({
    connectionString: adminUrl,
    application_name: "albert-local-anthropic-control-setup",
    connectionTimeoutMillis: 10_000,
  });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["albert:runtime-logins:control-plane"]);
    const authority = await client.query<{
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
    const authorityRole = authority.rows[0];
    if (!authorityRole || authorityRole.rolcanlogin || authorityRole.rolinherit || authorityRole.rolsuper
      || authorityRole.rolcreaterole || authorityRole.rolcreatedb || authorityRole.rolreplication
      || authorityRole.rolbypassrls) {
      throw new Error("The Anthropic control authority is missing or unsafe.");
    }

    const existing = await client.query<{
      rolsuper: boolean;
      rolcreaterole: boolean;
      rolcreatedb: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
    }>(
      `SELECT rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls
         FROM pg_catalog.pg_roles WHERE rolname=$1`,
      [login],
    );
    const prior = existing.rows[0];
    if (prior && (prior.rolsuper || prior.rolcreaterole || prior.rolcreatedb || prior.rolreplication || prior.rolbypassrls)) {
      throw new Error("The existing Anthropic runtime login has unsafe privileges.");
    }
    if (!prior) {
      await client.query(`CREATE ROLE ${identifier(login)} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`);
    }
    await client.query(`ALTER ROLE ${identifier(login)} WITH LOGIN NOINHERIT CONNECTION LIMIT 12 PASSWORD ${literal(runtimePassword)}`);
    const memberships = await client.query<{ role_name: string }>(
      `SELECT parent.rolname AS role_name
         FROM pg_catalog.pg_auth_members AS membership
         JOIN pg_catalog.pg_roles AS parent ON parent.oid=membership.roleid
         JOIN pg_catalog.pg_roles AS member ON member.oid=membership.member
        WHERE member.rolname=$1`,
      [login],
    );
    for (const membership of memberships.rows) {
      await client.query(`REVOKE ${identifier(membership.role_name)} FROM ${identifier(login)}`);
    }
    await client.query(`GRANT ${identifier(group)} TO ${identifier(login)}`);
    await client.query(`GRANT CONNECT ON DATABASE ${identifier(String((await client.query<{ database_name: string }>("SELECT current_database() AS database_name")).rows[0]?.database_name))} TO ${identifier(login)}`);
    await client.query(`ALTER ROLE ${identifier(login)} SET statement_timeout='30s'`);
    await client.query(`ALTER ROLE ${identifier(login)} SET lock_timeout='10s'`);
    await client.query(`ALTER ROLE ${identifier(login)} SET idle_in_transaction_session_timeout='60s'`);
    await client.query(`ALTER ROLE ${identifier(login)} SET search_path='pg_catalog'`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

async function readSupabaseCliAccessToken(): Promise<string> {
  let token = process.env.SUPABASE_ACCESS_TOKEN?.trim() ?? "";
  if (!token && process.platform === "darwin") {
    token = await new Promise<string>((resolvePromise, reject) => {
      execFile(
        "/usr/bin/security",
        ["find-generic-password", "-a", "supabase", "-s", "Supabase CLI", "-w"],
        { encoding: "utf8", timeout: 10_000, maxBuffer: 4_096 },
        (error, stdout) => error ? reject(new Error("The authenticated Supabase CLI credential is unavailable.")) : resolvePromise(stdout.trim()),
      );
    });
    const base64Prefix = "go-keyring-base64:";
    const hexPrefix = "go-keyring-encoded:";
    if (token.startsWith(base64Prefix)) token = Buffer.from(token.slice(base64Prefix.length), "base64").toString("utf8");
    else if (token.startsWith(hexPrefix)) token = Buffer.from(token.slice(hexPrefix.length), "hex").toString("utf8");
  }
  if (!/^sbp_(?:oauth_)?[a-f0-9]{40}$/u.test(token)) {
    throw new Error("Run `supabase login` before automatic local provisioning.");
  }
  return token;
}

async function provisionRuntimeLoginThroughSupabase(runtimePassword: string): Promise<void> {
  const { projectRef } = configuredControlPooler();
  const accessToken = await readSupabaseCliAccessToken();
  const query = `
BEGIN;
SELECT pg_advisory_xact_lock(hashtextextended('albert:runtime-logins:control-plane',0));
DO $albert$
DECLARE membership record;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
     WHERE rolname=${literal(group)}
       AND NOT rolcanlogin AND NOT rolinherit AND NOT rolsuper
       AND NOT rolcreaterole AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls
  ) OR EXISTS (
    SELECT 1
      FROM pg_catalog.pg_auth_members AS m
      JOIN pg_catalog.pg_roles AS member ON member.oid=m.member
     WHERE member.rolname=${literal(group)}
  ) THEN
    RAISE EXCEPTION 'The Anthropic control authority is missing or unsafe.';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
     WHERE rolname=${literal(login)}
       AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls)
  ) THEN
    RAISE EXCEPTION 'The existing Anthropic runtime login has unsafe privileges.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=${literal(login)}) THEN
    CREATE ROLE ${identifier(login)} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
  ALTER ROLE ${identifier(login)} WITH LOGIN NOINHERIT CONNECTION LIMIT 12 PASSWORD ${literal(runtimePassword)};
  FOR membership IN
    SELECT parent.rolname AS role_name
      FROM pg_catalog.pg_auth_members AS m
      JOIN pg_catalog.pg_roles AS parent ON parent.oid=m.roleid
      JOIN pg_catalog.pg_roles AS member ON member.oid=m.member
     WHERE member.rolname=${literal(login)}
  LOOP
    EXECUTE format('REVOKE %I FROM %I',membership.role_name,${literal(login)});
  END LOOP;
END
$albert$;
GRANT ${identifier(group)} TO ${identifier(login)};
DO $albert$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I',current_database(),${literal(login)});
END
$albert$;
ALTER ROLE ${identifier(login)} SET statement_timeout='30s';
ALTER ROLE ${identifier(login)} SET lock_timeout='10s';
ALTER ROLE ${identifier(login)} SET idle_in_transaction_session_timeout='60s';
ALTER ROLE ${identifier(login)} SET search_path='pg_catalog';
COMMIT;`;
  const response = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/database/query`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ query, read_only: false }),
    signal: AbortSignal.timeout(30_000),
  });
  const payload: unknown = await response.json().catch(() => undefined);
  const apiError = payload !== null && typeof payload === "object" && !Array.isArray(payload) && "error" in payload
    ? (payload as { error?: unknown }).error
    : undefined;
  if (!response.ok || apiError) {
    throw new Error(`Supabase runtime provisioning failed safely (HTTP ${response.status}).`);
  }
}

function replaceEnvironmentValue(source: string, name: string, value: string): string {
  const pattern = new RegExp(`^${name}=.*$`, "mu");
  if (pattern.test(source)) return source.replace(pattern, `${name}=${value}`);
  return `${source.replace(/\s*$/u, "")}\n${name}=${value}\n`;
}

async function persistLocalConfiguration(runtimeUrl: string, runtimePassword: string): Promise<void> {
  let source = await readFile(environmentPath, "utf8");
  source = replaceEnvironmentValue(source, "ANTHROPIC_CONTROL_PLANE_DATABASE_URL", runtimeUrl);
  source = replaceEnvironmentValue(source, "ALBERT_ANTHROPIC_CONTROL_DB_PASSWORD", runtimePassword);
  const temporaryPath = `${environmentPath}.anthropic-setup-${process.pid}`;
  await writeFile(temporaryPath, source, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await rename(temporaryPath, environmentPath);
  await chmod(environmentPath, 0o600);
}

async function verifyRuntime(runtimeUrl: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const client = new Client({ connectionString: runtimeUrl, connectionTimeoutMillis: 10_000 });
    let connected = false;
    try {
      await client.connect();
      connected = true;
      await client.query("BEGIN TRANSACTION READ ONLY");
      await client.query(`SET LOCAL ROLE ${identifier(group)}`);
      const result = await client.query<{ ready: boolean }>("SELECT control_plane.assert_anthropic_session_store_ready() AS ready");
      if (!result.rows[0]?.ready) throw new Error("Anthropic session storage is not ready.");
      await client.query("COMMIT");
      return;
    } catch (error) {
      lastError = error;
      if (connected) await client.query("ROLLBACK").catch(() => undefined);
      const code = error !== null && typeof error === "object" && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
      if (attempt === 10 || code !== "28P01") break;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_500));
    } finally {
      if (connected) await client.end().catch(() => undefined);
    }
  }
  throw lastError;
}

async function configure(databasePassword: string): Promise<void> {
  if (process.env.NODE_ENV === "production") throw new Error("This command is local-development only.");
  if (Buffer.byteLength(databasePassword, "utf8") < 8) throw new Error("The Supabase database password is too short.");
  const runtimePassword = Buffer.from(randomBytes(32)).toString("hex");
  const connections = buildConnections(databasePassword, runtimePassword);
  const deployerUrl = configuredDeployerUrl();

  const administrator = new Client({ connectionString: connections.adminUrl, connectionTimeoutMillis: 10_000 });
  await administrator.connect();
  try {
    await assertControlPlaneAdminIdentity(administrator);
    await applyControlPlaneAdminUpgrades(administrator);
  } finally {
    await administrator.end();
  }
  await runControlPlaneMigrations(deployerUrl);
  await provisionRuntimeLogin(connections.adminUrl, runtimePassword);
  await verifyRuntime(connections.runtimeUrl);
  await persistLocalConfiguration(connections.runtimeUrl, runtimePassword);
}

async function automaticMain(): Promise<void> {
  if (process.env.NODE_ENV === "production") throw new Error("This command is local-development only.");
  const runtimePassword = Buffer.from(randomBytes(32)).toString("hex");
  const runtimeUrl = buildRuntimeUrl(runtimePassword);
  await runControlPlaneMigrations(configuredDeployerUrl());
  await provisionRuntimeLoginThroughSupabase(runtimePassword);
  await verifyRuntime(runtimeUrl);
  await persistLocalConfiguration(runtimeUrl, runtimePassword);
  process.stdout.write("Anthropic local database access is configured.\n");
}

async function terminalMain(): Promise<void> {
  process.stdout.write("\nThis will apply pending control-plane upgrades, create or rotate the least-privilege Anthropic runtime login, and save its URL only in .env.local.\n");
  const confirmation = await readLine("Type PROVISION to continue: ");
  if (confirmation !== "PROVISION") throw new Error("Setup cancelled; confirmation did not match.");
  const databasePassword = await readLine("New Supabase database password (hidden): ", true);
  await configure(databasePassword);
  process.stdout.write("\nAnthropic control-plane setup complete. The administrator password was not stored.\n");
}

function page(content: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Albert local Anthropic setup</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
    main { width: min(520px, calc(100vw - 40px)); padding: 28px; border: 1px solid color-mix(in srgb, CanvasText 16%, transparent); border-radius: 18px; }
    h1 { margin: 0 0 10px; font-size: 22px; }
    p { line-height: 1.5; }
    label { display: grid; gap: 7px; margin-top: 18px; font-weight: 650; }
    input { height: 42px; padding: 0 11px; border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); border-radius: 10px; background: Canvas; color: CanvasText; }
    button { margin-top: 22px; height: 40px; padding: 0 18px; border: 0; border-radius: 999px; background: CanvasText; color: Canvas; font-weight: 700; cursor: pointer; }
    small { display: block; margin-top: 18px; opacity: .72; line-height: 1.45; }
  </style>
</head>
<body><main>${content}</main></body>
</html>`;
}

async function webMain(): Promise<void> {
  if (process.env.NODE_ENV === "production") throw new Error("This command is local-development only.");
  const token = Buffer.from(randomBytes(24)).toString("base64url");
  let running = false;
  let completed = false;
  const server = createServer(async (request, response) => {
    const send = (status: number, body: string) => {
      response.writeHead(status, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      });
      response.end(page(body));
    };
    if (request.url !== `/${token}` || !["GET", "POST"].includes(request.method ?? "")) {
      send(404, "<h1>Not found</h1>");
      return;
    }
    if (request.method === "GET") {
      send(200, `<h1>Configure local Anthropic storage</h1>
        <p>This creates or rotates Albert's least-privilege Anthropic database login and writes its URL to <code>.env.local</code>. The Supabase administrator password is used once and is not stored.</p>
        <form method="post" autocomplete="off">
          <label>Confirmation<input name="confirmation" required placeholder="Type PROVISION" spellcheck="false" autocomplete="off"></label>
          <label>New Supabase database password<input name="database_password" type="password" required autocomplete="off"></label>
          <button type="submit">Provision local database access</button>
        </form>
        <small>Local only · bound to 127.0.0.1 · expires after ten minutes</small>`);
      return;
    }
    if (running || completed) {
      send(409, "<h1>Setup is already running or complete</h1>");
      return;
    }
    running = true;
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const raw of request) {
        const chunk = Buffer.from(raw);
        size += chunk.length;
        if (size > 8_192) throw new Error("The setup request is too large.");
        chunks.push(chunk);
      }
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      if (form.get("confirmation") !== "PROVISION") throw new Error("Confirmation must be exactly PROVISION.");
      const password = form.get("database_password") ?? "";
      await configure(password);
      completed = true;
      send(200, "<h1>Setup complete</h1><p>The dedicated Anthropic database login is ready and <code>.env.local</code> has been updated. You may close this page.</p>");
      setTimeout(() => server.close(), 1_000).unref();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Setup failed safely.";
      send(500, `<h1>Setup did not complete</h1><p>${message.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</p><p>Restart the local setup command to try again.</p>`);
      setTimeout(() => server.close(), 1_000).unref();
    } finally {
      running = false;
    }
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local setup server did not bind a TCP port.");
  process.stdout.write(`SETUP_URL=http://127.0.0.1:${address.port}/${token}\n`);
  const expiry = setTimeout(() => server.close(), 10 * 60_000);
  expiry.unref();
  await new Promise<void>((resolvePromise) => server.once("close", resolvePromise));
}

if (process.argv.includes("--web")) await webMain();
else if (process.argv.includes("--supabase-cli")) await automaticMain();
else await terminalMain();
