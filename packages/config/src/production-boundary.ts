export type ProductionRuntimeBoundary = Readonly<{
  label: string;
  controlProject: boolean;
  analyticalRegion: boolean;
  storageRegion: boolean;
  modelDataResidency: boolean;
  lightspeedProduct: boolean;
  databaseLogins: Readonly<Record<string, string>>;
  distinctDatabaseVariables?: readonly [string, string];
}>;

const SYDNEY_REGION = "ap-southeast-2";
const AU_OPENAI_BASE_URL = "https://au.api.openai.com/v1";

function required(source: NodeJS.ProcessEnv, name: string): string {
  const value = source[name]?.trim();
  if (!value) throw new Error(`${name} is required in production.`);
  return value;
}

function postgresUrl(value: string, name: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a PostgreSQL URL.`);
  }
  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new Error(`${name} must be a PostgreSQL URL.`);
  }
  return parsed;
}

function decodedLogin(url: URL, name: string): string {
  try {
    return decodeURIComponent(url.username);
  } catch {
    throw new Error(`${name} contains an invalid login name.`);
  }
}

function assertDatabaseBoundary(
  source: NodeJS.ProcessEnv,
  name: string,
  expectedLogin: string,
  controlProjectRef?: string,
): string {
  const parsed = postgresUrl(required(source, name), name);
  if (["localhost", "127.0.0.1", "::1"].includes(parsed.hostname)) {
    throw new Error(`${name} must not target a local database in production.`);
  }
  const sslMode = parsed.searchParams.get("sslmode")?.toLowerCase();
  if (!sslMode || !["require", "verify-ca", "verify-full"].includes(sslMode)) {
    throw new Error(`${name} must require TLS in production.`);
  }
  const login = decodedLogin(parsed, name);
  if (!new RegExp(`^${expectedLogin}(?:\\.[a-z0-9]{20})?$`, "u").test(login)) {
    throw new Error(`${name} must use the ${expectedLogin} login.`);
  }
  if (
    controlProjectRef && parsed.hostname !== `db.${controlProjectRef}.supabase.co` &&
    !login.endsWith(`.${controlProjectRef}`)
  ) {
    throw new Error(`${name} does not target the selected Supabase control project.`);
  }
  const database = parsed.pathname.replace(/^\/+/, "") || "postgres";
  const poolerProjectRef = /\.([a-z0-9]{20})$/u.exec(login)?.[1];
  return `${parsed.hostname.toLowerCase()}:${parsed.port || "5432"}/${database}` +
    (poolerProjectRef ? `#${poolerProjectRef}` : "");
}

/**
 * Production-only trust-boundary validation shared by service entry points.
 * The caller supplies only that process's database identities, so bundling one
 * worker cannot pull another worker's credential vocabulary into its image.
 */
export function assertProductionRuntimeBoundary(
  source: NodeJS.ProcessEnv,
  boundary: ProductionRuntimeBoundary,
): void {
  if (source.NODE_ENV !== "production") return;

  if (!boundary.label.trim()) throw new Error("Production runtime boundary label is required.");

  if (required(source, "ALBERT_CONTROL_PLANE_REGION") !== SYDNEY_REGION) {
    throw new Error("ALBERT_CONTROL_PLANE_REGION must be ap-southeast-2 in production.");
  }
  if (
    boundary.analyticalRegion &&
    required(source, "ALBERT_ANALYTICAL_REGION") !== SYDNEY_REGION
  ) {
    throw new Error("ALBERT_ANALYTICAL_REGION must be ap-southeast-2 in production.");
  }
  if (
    boundary.storageRegion &&
    required(source, "SUPABASE_STORAGE_S3_REGION") !== SYDNEY_REGION
  ) {
    throw new Error("SUPABASE_STORAGE_S3_REGION must be ap-southeast-2 in production.");
  }
  if (boundary.modelDataResidency) {
    if (required(source, "ALBERT_MODEL_DATA_RESIDENCY_REGION") !== "au") {
      throw new Error("ALBERT_MODEL_DATA_RESIDENCY_REGION must be au in production.");
    }
    if (required(source, "ALBERT_MODEL_DATA_CONTROL_APPROVED") !== "true") {
      throw new Error("ALBERT_MODEL_DATA_CONTROL_APPROVED requires explicit production approval.");
    }
    if (required(source, "OPENAI_BASE_URL").replace(/\/+$/u, "") !== AU_OPENAI_BASE_URL) {
      throw new Error("OPENAI_BASE_URL must use the approved OpenAI AU data-residency endpoint in production.");
    }
  }
  if (
    boundary.lightspeedProduct &&
    required(source, "ALBERT_LIGHTSPEED_PRODUCT") !== "r-series"
  ) {
    throw new Error("ALBERT_LIGHTSPEED_PRODUCT must explicitly confirm r-series.");
  }

  const serviceVersion = required(source, "ALBERT_SERVICE_VERSION");
  if (!/^[a-f0-9]{40}$/u.test(serviceVersion)) {
    throw new Error("ALBERT_SERVICE_VERSION must be the full release Git SHA.");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(required(source, "ALBERT_DEPLOYMENT_ID"))) {
    throw new Error("ALBERT_DEPLOYMENT_ID is invalid.");
  }

  const controlProjectRef = boundary.controlProject
    ? required(source, "ALBERT_CONTROL_PLANE_PROJECT_REF")
    : undefined;
  if (controlProjectRef && !/^[a-z0-9]{20}$/u.test(controlProjectRef)) {
    throw new Error("ALBERT_CONTROL_PLANE_PROJECT_REF is invalid.");
  }
  if (controlProjectRef && boundary.storageRegion) {
    let storage: URL;
    try {
      storage = new URL(required(source, "SUPABASE_STORAGE_S3_ENDPOINT"));
    } catch {
      throw new Error("SUPABASE_STORAGE_S3_ENDPOINT is invalid.");
    }
    if (
      storage.protocol !== "https:" ||
      storage.hostname !== `${controlProjectRef}.storage.supabase.co` ||
      storage.pathname.replace(/\/+$/u, "") !== "/storage/v1/s3" ||
      storage.username || storage.password || storage.search || storage.hash
    ) {
      throw new Error("SUPABASE_STORAGE_S3_ENDPOINT does not match the selected control project.");
    }
  }

  const targets = new Map<string, string>();
  for (const [name, expectedLogin] of Object.entries(boundary.databaseLogins)) {
    targets.set(
      name,
      assertDatabaseBoundary(
        source,
        name,
        expectedLogin,
        name.includes("CONTROL_PLANE") ? controlProjectRef : undefined,
      ),
    );
  }
  if (boundary.distinctDatabaseVariables) {
    const [left, right] = boundary.distinctDatabaseVariables;
    if (targets.get(left) === targets.get(right)) {
      throw new Error(`${left} and ${right} must target separate databases.`);
    }
  }
}
