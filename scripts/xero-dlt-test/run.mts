/**
 * Secure launcher for the isolated dlt Xero landing test.
 *
 * It reuses Albert's encrypted credential vault, refreshes the connected Xero
 * token when needed, derives the endpoint plan from the pinned Xero spec, and
 * gives Python only short-lived process environment values. Nothing is copied
 * into .dlt/secrets.toml or committed to disk.
 *
 * Usage:
 *   npx tsx scripts/xero-dlt-test/run.mts --plan
 *   XERO_DLT_PYTHON=/path/to/python npx tsx scripts/xero-dlt-test/run.mts --ingest
 */
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { loadEncodedAes256Keyring } from "../../packages/security/src/index.js";
import type { ConnectorContext } from "../../packages/connector-sdk/src/index.js";
import {
  AesKeyringWrapper,
  EnvelopeCryptography,
  PostgresCredentialVault,
} from "../../services/sync-workers/src/credential-vault.js";
import { PgTransactionalDatabase } from "../../services/sync-workers/src/postgres.js";
import { XeroConnector } from "../../connectors/xero/index.js";
import { XERO_SCAN_PLAN } from "../../connectors/xero/scan-plan.js";
import {
  XERO_API_PROFILES,
  baseParams,
  endpointPath,
  extraParamPasses,
} from "../../connectors/xero/spec-sync.js";

type Environment = Record<string, string>;

function loadEnv(): Environment {
  const output = { ...process.env } as Environment;
  let contents = "";
  try { contents = readFileSync(resolve(".env.local"), "utf8"); } catch { return output; }
  for (const line of contents.split("\n")) {
    const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (!match) continue;
    let value = match[2]!;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    output[match[1]!] ??= value;
  }
  return output;
}

function required(env: Environment, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value.replace(/^"|"$/gu, "");
}

function dltPostgresUrl(value: string): string {
  const url = new URL(value);
  // `uselibpqcompat` configures node-postgres' URL parser. psycopg2 forwards
  // unknown query parameters to libpq, where this Node-only flag is invalid.
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase() === "uselibpqcompat") url.searchParams.delete(key);
  }
  return url.toString();
}

function resourceName(api: string, endpointOp: string): string {
  return `${api}_${endpointOp.replace(/^GET\s+/u, "")}`
    .replace(/[{}]/gu, "")
    .replace(/[^A-Za-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .toLowerCase();
}

function buildEndpointPlan(): readonly Record<string, unknown>[] {
  const endpoints = new Map<string, {
    api: string;
    endpointOp: string;
    url: string;
    pagination: string;
    pageParam: string | null;
    pageSizeParam: string | null;
    pageSize: number;
    arrayKeys: Set<string>;
    params: Readonly<Record<string, string>>;
    passes: readonly Readonly<Record<string, string>>[];
    availability: string;
  }>();

  for (const group of XERO_SCAN_PLAN.groups) {
    const leader = group.leader;
    const key = `${group.api} ${group.endpointOp}`;
    const existing = endpoints.get(key);
    if (existing) {
      for (const member of group.members) {
        const arrayKey = member.table.source.arrayKey;
        if (arrayKey) existing.arrayKeys.add(arrayKey);
      }
      continue;
    }
    const profile = XERO_API_PROFILES[leader.source.api];
    const arrayKeys = new Set<string>();
    for (const member of group.members) {
      const arrayKey = member.table.source.arrayKey;
      if (arrayKey) arrayKeys.add(arrayKey);
    }
    endpoints.set(key, {
      api: group.api,
      endpointOp: group.endpointOp,
      url: new URL(endpointPath(leader), "https://api.xero.com").toString(),
      pagination: group.pagination,
      pageParam: profile.pageParam,
      pageSizeParam: profile.pageSizeParam,
      pageSize: profile.pageSize,
      arrayKeys,
      params: baseParams(leader),
      passes: extraParamPasses(leader, new Date().toISOString()),
      availability: leader.source.availability,
    });
  }

  return [...endpoints.values()]
    .sort((left, right) => {
      const leftOrg = left.endpointOp === "GET /Organisation" ? 0 : 1;
      const rightOrg = right.endpointOp === "GET /Organisation" ? 0 : 1;
      return leftOrg - rightOrg || `${left.api} ${left.endpointOp}`.localeCompare(`${right.api} ${right.endpointOp}`);
    })
    .map((endpoint) => ({
      ...endpoint,
      arrayKeys: [...endpoint.arrayKeys],
      resourceName: resourceName(endpoint.api, endpoint.endpointOp),
    }));
}

async function runPython(python: string, environment: Record<string, string | undefined>): Promise<number> {
  return await new Promise<number>((done, reject) => {
    const child = spawn(python, [resolve("scripts/xero-dlt-test/pipeline.py")], {
      cwd: process.cwd(),
      env: environment as unknown as NodeJS.ProcessEnv,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`The dlt pipeline exited on signal ${signal}`));
      else done(code ?? 1);
    });
  });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const unknown = argv.filter((arg) => !["--plan", "--ingest"].includes(arg));
  if (unknown.length > 0) throw new Error(`Unknown option(s): ${unknown.join(", ")}`);
  if (argv.length !== 1) throw new Error("Specify exactly one of --plan or --ingest");

  const endpointPlan = buildEndpointPlan();
  if (argv.includes("--plan")) {
    const byApi = Object.groupBy(endpointPlan, (entry) => String(entry.api));
    console.log(JSON.stringify({
      dataset: "XERO_TEST",
      rootEndpoints: endpointPlan.length,
      byApi: Object.fromEntries(Object.entries(byApi).map(([api, rows]) => [api, rows?.length ?? 0])),
      note: "Nested response objects and arrays are normalised by dlt; parent-id history/attachment fan-outs are excluded from this bounded test.",
    }, null, 2));
    return;
  }

  const env = loadEnv();
  const controlDb = new PgTransactionalDatabase(required(env, "CONTROL_PLANE_ADMIN_DATABASE_URL"), {
    applicationName: "albert-xero-dlt-test",
    assumedRole: "albert_control_migration_owner",
    maxConnections: 2,
  });
  try {
    const keyring = loadEncodedAes256Keyring({
      currentKey: required(env, "TOKEN_ENCRYPTION_KEY"),
      currentKeyId: required(env, "TOKEN_ENCRYPTION_KEY_ID"),
      previousKeysJson: env.TOKEN_PREVIOUS_ENCRYPTION_KEYS,
      keyName: "TOKEN_ENCRYPTION_KEY",
      keyIdName: "TOKEN_ENCRYPTION_KEY_ID",
      previousKeysName: "TOKEN_PREVIOUS_ENCRYPTION_KEYS",
      maxPreviousKeys: 4,
    });
    const vault = new PostgresCredentialVault(
      controlDb,
      new EnvelopeCryptography(new AesKeyringWrapper({
        currentKeyReference: "env:TOKEN_ENCRYPTION_KEY",
        currentKeyVersion: keyring.currentKeyId,
        encodedKeys: keyring.keys,
      })),
    );
    const connections = await controlDb.query<{
      tenant_id: string;
      connection_id: string;
      external_account_reference: string;
      secret_reference: string;
    }>(
      `select connection.tenant_id, connection.connection_id,
              connection.external_account_reference, token.secret_reference
         from control_plane.connections connection
         join lateral (
           select secret_reference
             from control_plane.oauth_token_refs
            where tenant_id = connection.tenant_id
              and connection_id = connection.connection_id
            order by updated_at desc limit 1
         ) token on true
        where connection.connector_key = 'xero'
          and connection.status in ('connected','degraded')
        order by connection.created_at desc`,
    );
    if (connections.rows.length !== 1) {
      throw new Error(`Expected exactly one connected Xero account, found ${connections.rows.length}`);
    }
    const connection = connections.rows[0]!;
    const connector = new XeroConnector({
      clientId: required(env, "XERO_CLIENT_ID"),
      oauthMode: "pkce",
      vault,
    });
    const context: ConnectorContext = {
      tenantId: connection.tenant_id,
      connectionId: connection.connection_id,
      credentialRef: connection.secret_reference,
    };
    let credential = await vault.read(connection.secret_reference);
    const expiresAt = Date.parse(credential.secret.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt < Date.now() + 25 * 60_000) {
      const refreshed = await connector.refresh_credentials(context);
      credential = await vault.read(refreshed.credentialRef);
    }

    const python = env.XERO_DLT_PYTHON?.trim() || resolve(".xero-dlt-venv/bin/python");
    const childEnv: Record<string, string | undefined> = {
      PATH: process.env.PATH,
      LANG: process.env.LANG ?? "en_AU.UTF-8",
      LC_ALL: process.env.LC_ALL,
      DLT_TELEMETRY: "false",
      RUNTIME__LOG_LEVEL: "WARNING",
      XERO_DLT_ACCESS_TOKEN: credential.secret.accessToken,
      XERO_DLT_TENANT_ID: connection.external_account_reference,
      XERO_DLT_DESTINATION_URL: dltPostgresUrl(required(env, "ANALYTICAL_ADMIN_DATABASE_URL")),
      XERO_DLT_ENDPOINTS_JSON: JSON.stringify(endpointPlan),
    };
    const exitCode = await runPython(python, childEnv);
    if (exitCode === 75) {
      console.error("The Xero load was safely deferred until the vendor daily allowance resets.");
      process.exitCode = exitCode;
      return;
    }
    if (exitCode !== 0) throw new Error(`The dlt pipeline exited with code ${exitCode}`);
  } finally {
    await controlDb.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
