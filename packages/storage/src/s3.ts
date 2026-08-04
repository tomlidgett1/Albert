const RAW_BUCKET = "raw-payloads";
const SAFE_REGION = /^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/u;
const PROJECT_REF = /^[a-z0-9]{20}$/u;

export type RawStorageMachinePurpose = "sync" | "webhook" | "deletion";

const READINESS_ID = "00000000000000000000000000";

/**
 * Fixed non-customer objects used to prove that a machine session is mapped
 * through Storage RLS. These keys are never part of a tenant deletion scope.
 */
export function rawStorageReadinessKey(
  purpose: Exclude<RawStorageMachinePurpose, "deletion">,
): string {
  const stream = purpose === "webhook" ? "webhook_xero" : "albert_readiness";
  const suffix = purpose === "webhook" ? "json.gz" : "jsonl.gz";
  return [
    "tenant",
    READINESS_ID,
    "connection",
    READINESS_ID,
    "stream",
    stream,
    "date",
    "2000-01-01",
    `batch-${READINESS_ID}.${suffix}`,
  ].join("/");
}

export function rawStorageMachineEmail(purpose: RawStorageMachinePurpose): string {
  return `raw-storage-${purpose}@machine.albert.invalid`;
}

export type RawStorageS3Config = Readonly<{
  endpoint: string;
  authUrl: string;
  region: string;
  accessKeyId: string;
  legacyAnonKey: string;
  machinePurpose: RawStorageMachinePurpose;
  machineEmail: string;
  machinePassword: string;
  bucket: typeof RAW_BUCKET;
}>;

export type RawStoragePage = Readonly<{
  keys: readonly string[];
  continuationToken?: string;
}>;

export type RawStorageConfigOptions = Readonly<{
  machinePurpose: RawStorageMachinePurpose;
  passwordEnvironmentName: string;
}>;

function required(
  source: Readonly<Record<string, string | undefined>>,
  name: string,
): string {
  const value = source[name];
  if (!value?.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}

function jwtPayload(value: string, name: string): Readonly<Record<string, unknown>> {
  if (value.startsWith("sb_publishable_")) {
    throw new Error(`${name} must be the legacy anon JWT; publishable keys cannot authenticate S3 sessions.`);
  }
  const segments = value.split(".");
  if (segments.length !== 3) throw new Error(`${name} must be a legacy Supabase JWT.`);
  try {
    const parsed = JSON.parse(Buffer.from(segments[1]!, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
    return parsed as Readonly<Record<string, unknown>>;
  } catch {
    throw new Error(`${name} must be a legacy Supabase JWT.`);
  }
}

function storageCoordinates(endpoint: string): Readonly<{
  endpoint: string;
  authUrl: string;
  local: boolean;
  projectRef?: string;
}> {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    throw new Error("SUPABASE_STORAGE_S3_ENDPOINT is not a valid URL.");
  }
  if (
    parsed.username || parsed.password || parsed.search || parsed.hash ||
    parsed.pathname.replace(/\/+$/u, "") !== "/storage/v1/s3"
  ) {
    throw new Error("SUPABASE_STORAGE_S3_ENDPOINT must be the S3 endpoint from Supabase Storage settings.");
  }
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
  if (local) {
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Local Supabase Storage S3 must use HTTP or HTTPS.");
    }
    return Object.freeze({
      endpoint: parsed.toString().replace(/\/$/u, ""),
      authUrl: parsed.origin,
      local: true,
    });
  }
  const match = /^([a-z0-9]{20})\.storage\.supabase\.co$/u.exec(parsed.hostname);
  if (parsed.protocol !== "https:" || !match) {
    throw new Error(
      "SUPABASE_STORAGE_S3_ENDPOINT must use the direct HTTPS project Storage hostname.",
    );
  }
  return Object.freeze({
    endpoint: parsed.toString().replace(/\/$/u, ""),
    authUrl: `https://${match[1]}.supabase.co`,
    local: false,
    projectRef: match[1],
  });
}

export function loadRawStorageS3Config(
  source: Readonly<Record<string, string | undefined>>,
  options: RawStorageConfigOptions,
): RawStorageS3Config {
  const expectedPasswordName =
    `ALBERT_RAW_STORAGE_${options.machinePurpose.toUpperCase()}_PASSWORD`;
  if (expectedPasswordName !== options.passwordEnvironmentName) {
    throw new Error("Raw Storage machine purpose and password secret name do not match.");
  }
  const coordinates = storageCoordinates(required(source, "SUPABASE_STORAGE_S3_ENDPOINT"));
  const region = required(source, "SUPABASE_STORAGE_S3_REGION");
  if (!SAFE_REGION.test(region)) throw new Error("SUPABASE_STORAGE_S3_REGION is invalid.");
  // Production cells are Sydney-only. Local dogfood against a Tokyo control
  // project must sign Storage S3 requests with that project's real region.
  const remoteRegions: readonly string[] = source.NODE_ENV === "production"
    ? ["ap-southeast-2"]
    : ["ap-southeast-2", "ap-northeast-1"];
  if (coordinates.local ? region !== "local" : !remoteRegions.includes(region)) {
    throw new Error(
      coordinates.local
        ? "Local Supabase Storage S3 must use region local."
        : source.NODE_ENV === "production"
          ? "Production Supabase Storage S3 must use region ap-southeast-2."
          : "Supabase Storage S3 region must match the control-plane project region.",
    );
  }

  const accessKeyId = required(source, "SUPABASE_STORAGE_S3_ACCESS_KEY_ID");
  if (coordinates.local) {
    if (accessKeyId !== "stub") {
      throw new Error("Local Supabase Storage S3 session credentials must use access key ID stub.");
    }
  } else if (!PROJECT_REF.test(accessKeyId) || accessKeyId !== coordinates.projectRef) {
    throw new Error("Supabase Storage S3 access key ID must equal the selected project ref.");
  }

  const legacyAnonKey = required(source, "SUPABASE_STORAGE_S3_LEGACY_ANON_KEY");
  const anonClaims = jwtPayload(legacyAnonKey, "SUPABASE_STORAGE_S3_LEGACY_ANON_KEY");
  if (anonClaims.role !== "anon") {
    throw new Error("SUPABASE_STORAGE_S3_LEGACY_ANON_KEY must carry the anon role.");
  }
  if (
    !coordinates.local && typeof anonClaims.ref === "string" && anonClaims.ref !== accessKeyId
  ) {
    throw new Error("The legacy anon key does not belong to the selected Supabase project.");
  }

  const machinePassword = source[options.passwordEnvironmentName];
  if (
    !machinePassword || machinePassword.trim() !== machinePassword ||
    Buffer.byteLength(machinePassword, "utf8") < 32 || machinePassword.length > 256 ||
    /[\u0000-\u001f\u007f]/u.test(machinePassword)
  ) {
    throw new Error(`${options.passwordEnvironmentName} must be a 32 to 256 byte machine secret without surrounding whitespace.`);
  }

  return Object.freeze({
    endpoint: coordinates.endpoint,
    authUrl: coordinates.authUrl,
    region,
    accessKeyId,
    legacyAnonKey,
    machinePurpose: options.machinePurpose,
    machineEmail: rawStorageMachineEmail(options.machinePurpose),
    machinePassword,
    bucket: RAW_BUCKET,
  });
}
