/**
 * Secure launcher for the isolated dlt Deputy landing test.
 *
 * It reuses Albert's encrypted Deputy OAuth credential, validates the install
 * through the production connector, and gives Python only short-lived process
 * environment values. Nothing is written to .dlt/secrets.toml.
 *
 * Usage:
 *   npx tsx scripts/deputy-dlt-test/run.mts --plan
 *   npx tsx scripts/deputy-dlt-test/run.mts --ingest
 */
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { loadEncodedAes256Keyring } from "../../packages/security/src/index.js";
import {
  AesKeyringWrapper,
  EnvelopeCryptography,
  PostgresCredentialVault,
} from "../../services/sync-workers/src/credential-vault.js";
import { PgTransactionalDatabase } from "../../services/sync-workers/src/postgres.js";

type Environment = Record<string, string>;

/** Official Resource objects from Deputy's Resource API Overview. */
const DEPUTY_RESOURCES = [
  "Address",
  "Category",
  "Comment",
  "Company",
  "CompanyPeriod",
  "Contact",
  "Country",
  "CustomAppData",
  "CustomField",
  "CustomFieldData",
  "Employee",
  "EmployeeAgreement",
  "EmployeeAgreementHistory",
  "EmployeeAppraisal",
  "EmployeeAvailability",
  "EmployeeHistory",
  "EmployeePaycycle",
  "EmployeePaycycleReturn",
  "EmployeeRole",
  "EmployeeSAlaryOpunitCosting",
  "EmployeeWorkplace",
  "EmploymentCondition",
  "EmploymentContract",
  "EmploymentContractLeaveRules",
  "Event",
  "Geo",
  "Journal",
  "Kiosk",
  "Leave",
  "LeaveAccrual",
  "LeavePayLine",
  "LeaveRules",
  "Memo",
  "OperationalUnit",
  "PayPeriod",
  "PayRules",
  "PublicHoliday",
  "Roster",
  "RosterOpen",
  "RosterSwap",
  "SalesData",
  "Schedule",
  "SmsLog",
  "State",
  "StressProfile",
  "SystemUsageBalance",
  "SystemUsageTracking",
  "Task",
  "TaskGroup",
  "TaskGroupSetup",
  "TaskOpunitConfig",
  "TaskSetup",
  "Team",
  "Timesheet",
  "TimesheetPayReturn",
  "TrainingModule",
  "TrainingRecord",
  "Webhook",
] as const;

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
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase() === "uselibpqcompat") url.searchParams.delete(key);
  }
  return url.toString();
}

function deputyBaseUrl(endpointValue: unknown): string {
  if (typeof endpointValue !== "string" || endpointValue.trim().length === 0) {
    throw new Error("The connected Deputy credential has no install endpoint");
  }
  let hostname: string;
  try {
    const candidate = endpointValue.includes("://")
      ? new URL(endpointValue)
      : new URL(`https://${endpointValue}`);
    if (candidate.protocol !== "https:") throw new Error("HTTPS is required");
    hostname = candidate.hostname.toLowerCase();
  } catch {
    throw new Error("The connected Deputy credential has an invalid install endpoint");
  }
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.(?:au|eu|uk|us)\.deputy\.com$/u.test(hostname)) {
    throw new Error("The connected Deputy install is outside an allowed regional host");
  }
  return `https://${hostname}/api/v1/`;
}

async function runPython(python: string, environment: Record<string, string | undefined>): Promise<number> {
  return await new Promise<number>((done, reject) => {
    const child = spawn(python, [resolve("scripts/deputy-dlt-test/pipeline.py")], {
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

  if (argv.includes("--plan")) {
    console.log(JSON.stringify({
      dataset: "DEPUTYNEW",
      resources: DEPUTY_RESOURCES.length,
      pageSize: 500,
      discovery: "GET resource/{name}/INFO",
      extraction: "POST resource/{name}/QUERY, sorted and keyset-paginated by Id",
    }, null, 2));
    return;
  }

  const env = loadEnv();
  const controlDb = new PgTransactionalDatabase(required(env, "CONTROL_PLANE_ADMIN_DATABASE_URL"), {
    applicationName: "albert-deputy-dlt-test",
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
        where connection.connector_key = 'deputy'
          and connection.status in ('connected','degraded')
        order by connection.created_at desc`,
    );
    if (connections.rows.length !== 1) {
      throw new Error(`Expected exactly one connected Deputy account, found ${connections.rows.length}`);
    }
    const connection = connections.rows[0]!;
    const credential = await vault.read(connection.secret_reference);
    if (credential.secret.provider !== "deputy") {
      throw new Error("Connected credential provider is not Deputy");
    }
    if (Date.parse(credential.secret.expiresAt) <= Date.now() + 60_000) {
      throw new Error(
        "The connected Deputy access token is expired; refresh it through a configured sync worker first",
      );
    }
    const baseUrl = deputyBaseUrl(credential.secret.metadata.endpoint);

    const python = env.DEPUTY_DLT_PYTHON?.trim() || resolve(".xero-dlt-venv/bin/python");
    const childEnv: Record<string, string | undefined> = {
      PATH: process.env.PATH,
      LANG: process.env.LANG ?? "en_AU.UTF-8",
      LC_ALL: process.env.LC_ALL,
      DLT_TELEMETRY: "false",
      RUNTIME__LOG_LEVEL: "WARNING",
      DEPUTY_DLT_ACCESS_TOKEN: credential.secret.accessToken,
      DEPUTY_DLT_BASE_URL: baseUrl,
      DEPUTY_DLT_DESTINATION_URL: dltPostgresUrl(required(env, "ANALYTICAL_ADMIN_DATABASE_URL")),
      DEPUTY_DLT_RESOURCES_JSON: JSON.stringify(DEPUTY_RESOURCES),
    };
    const exitCode = await runPython(python, childEnv);
    if (exitCode !== 0) throw new Error(`The dlt pipeline exited with code ${exitCode}`);
  } finally {
    await controlDb.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
