import { pathToFileURL } from "node:url";
import { assertEmbeddedServiceBuildIdentity } from "../../../packages/config/src/build-identity.js";
import { assertProductionRuntimeBoundary } from "../../../packages/config/src/production-boundary.js";
import {
  PostgresOperatorDiagnosticControlStore,
  PostgresOperatorDiagnosticReadStore,
  type DiagnosticPgPool,
} from "./database.js";
import { startOperatorDiagnosticNodeServer } from "./node-server.js";

type ClosablePool = DiagnosticPgPool & Readonly<{
  end(): Promise<void>;
  on(event: "error", listener: (error: Error) => void): void;
}>;
type PgModule = Readonly<{
  Pool: new (options: Readonly<{
    connectionString: string;
    max: number;
    application_name: string;
    connectionTimeoutMillis: number;
    idleTimeoutMillis: number;
    ssl?: Readonly<{ rejectUnauthorized: boolean }>;
  }>) => ClosablePool;
}>;

export async function startOperatorDiagnosticServiceFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<Readonly<{ close(): Promise<void>; url: string }>> {
  const releaseSha = assertEmbeddedServiceBuildIdentity(environment);
  assertProductionRuntimeBoundary(environment, {
    label: "operator diagnostic",
    controlProject: true,
    analyticalRegion: true,
    storageRegion: false,
    modelDataResidency: false,
    lightspeedProduct: false,
    databaseLogins: {
      OPERATOR_DIAGNOSTIC_CONTROL_PLANE_DATABASE_URL: "albert_operator_diagnostic_control_runtime",
      OPERATOR_DIAGNOSTIC_ANALYTICAL_DATABASE_URL: "albert_operator_diagnostic_analytical_runtime",
    },
    distinctDatabaseVariables: [
      "OPERATOR_DIAGNOSTIC_CONTROL_PLANE_DATABASE_URL",
      "OPERATOR_DIAGNOSTIC_ANALYTICAL_DATABASE_URL",
    ],
  });
  const signingSecret = required(environment, "ALBERT_OPERATOR_DIAGNOSTIC_SIGNING_SECRET");
  if (new TextEncoder().encode(signingSecret).byteLength < 32) {
    throw new Error("ALBERT_OPERATOR_DIAGNOSTIC_SIGNING_SECRET must be at least 32 bytes.");
  }
  const pg = await loadPg();
  const controlPool = createDiagnosticPool(
    pg,
    required(environment, "OPERATOR_DIAGNOSTIC_CONTROL_PLANE_DATABASE_URL"),
    "albert-operator-diagnostic-control",
    environment,
  );
  const analyticalPool = createDiagnosticPool(
    pg,
    required(environment, "OPERATOR_DIAGNOSTIC_ANALYTICAL_DATABASE_URL"),
    "albert-operator-diagnostic-read",
    environment,
  );
  try {
    return await startOperatorDiagnosticNodeServer({
      controlStore: new PostgresOperatorDiagnosticControlStore(controlPool),
      readStore: new PostgresOperatorDiagnosticReadStore(analyticalPool),
      signingSecret,
      host: environment.ALBERT_OPERATOR_DIAGNOSTIC_HOST ?? "127.0.0.1",
      port: boundedInteger(environment.ALBERT_OPERATOR_DIAGNOSTIC_PORT, 8790, 1, 65_535),
      closeStores: async () => { await Promise.all([controlPool.end(), analyticalPool.end()]); },
      releaseSha,
      deploymentId: environment.ALBERT_DEPLOYMENT_ID?.trim() || null,
    });
  } catch (error) {
    await Promise.all([controlPool.end(), analyticalPool.end()]);
    throw error;
  }
}

async function loadPg(): Promise<PgModule> {
  const dynamicImport = Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
  const pgModule = await dynamicImport("pg") as { default?: PgModule; Pool?: PgModule["Pool"] };
  const resolved = pgModule.default ?? pgModule;
  if (!resolved.Pool) throw new Error("The operator diagnostic image must provide pg.");
  return resolved as PgModule;
}

function compatiblePostgresUrl(connectionString: string): string {
  const url = new URL(connectionString);
  const sslMode = url.searchParams.get("sslmode")?.toLowerCase();
  if (!sslMode) {
    url.searchParams.set("sslmode", "require");
  }
  if ((url.searchParams.get("sslmode") ?? "require").toLowerCase() === "require" && !url.searchParams.has("uselibpqcompat")) {
    url.searchParams.set("uselibpqcompat", "true");
  }
  return url.toString();
}

function createDiagnosticPool(
  pg: PgModule,
  connectionString: string,
  applicationName: string,
  environment: NodeJS.ProcessEnv,
): ClosablePool {
  const pool = new pg.Pool({
    connectionString: compatiblePostgresUrl(connectionString),
    max: boundedInteger(environment.ALBERT_OPERATOR_DIAGNOSTIC_POOL_SIZE, 4, 1, 8),
    application_name: applicationName,
    connectionTimeoutMillis: 4_000,
    idleTimeoutMillis: 30_000,
    ssl: { rejectUnauthorized: false },
  });
  pool.on("error", () => undefined);
  return pool;
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function boundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Expected an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const running = await startOperatorDiagnosticServiceFromEnvironment();
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try { await running.close(); } catch { process.exitCode = 1; }
  };
  process.once("SIGTERM", () => { void stop(); });
  process.once("SIGINT", () => { void stop(); });
}
