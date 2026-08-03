import { Buffer } from "node:buffer";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import { Client } from "pg";
import {
  loadRawStorageS3Config,
  rawStorageMachineEmail,
  type RawStorageS3Config,
  type RawStorageMachinePurpose,
} from "../packages/storage/src/s3.js";
import { S3RawDeletionObjectStore } from "../packages/storage/src/s3-deletion.js";
import { S3RawIngestionObjectStore } from "../packages/storage/src/s3-ingestion.js";
import { assertProtectedAdminDatabaseUrl } from "./admin-bootstrap-upgrades.js";

const PURPOSES = Object.freeze([
  "sync",
  "webhook",
  "deletion",
] as const satisfies readonly RawStorageMachinePurpose[]);

type PrincipalRow = Readonly<{
  purpose: RawStorageMachinePurpose;
  auth_user_id: string;
  credential_generation: string | number;
}>;

type AuthDirectoryRow = Readonly<{
  id: string;
  email: string | null;
  raw_app_meta_data: unknown;
}>;

export type RawStorageMachineProvisioningConfig = Readonly<{
  authUrl: string;
  adminServiceRoleKey: string;
  adminDatabaseUrl: string;
  generation: number;
  passwords: Readonly<Record<RawStorageMachinePurpose, string>>;
  storage: Readonly<Record<RawStorageMachinePurpose, RawStorageS3Config>>;
}>;

function required(source: NodeJS.ProcessEnv, name: string, trim = true): string {
  const value = source[name];
  if (!value || (trim ? !value.trim() : value.length === 0)) throw new Error(`${name} is required.`);
  return trim ? value.trim() : value;
}

function jwtRole(value: string): string | undefined {
  try {
    const segments = value.split(".");
    if (segments.length !== 3) return undefined;
    const payload = JSON.parse(Buffer.from(segments[1]!, "base64url").toString("utf8")) as unknown;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
    const role = (payload as Readonly<Record<string, unknown>>).role;
    return typeof role === "string" ? role : undefined;
  } catch {
    return undefined;
  }
}

function assertMachinePassword(value: string, name: string): string {
  if (
    value.trim() !== value || Buffer.byteLength(value, "utf8") < 32 ||
    value.length > 256 || /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(`${name} must be a 32 to 256 byte machine secret without surrounding whitespace.`);
  }
  return value;
}

export function loadRawStorageMachineProvisioningConfig(
  source: NodeJS.ProcessEnv = process.env,
): RawStorageMachineProvisioningConfig {
  const authUrl = required(source, "SUPABASE_AUTH_URL").replace(/\/+$/u, "");
  let parsed: URL;
  try {
    parsed = new URL(authUrl);
  } catch {
    throw new Error("SUPABASE_AUTH_URL must be a Supabase project origin.");
  }
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
  if (
    parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash ||
    (local ? !["http:", "https:"].includes(parsed.protocol) : parsed.protocol !== "https:")
  ) {
    throw new Error("SUPABASE_AUTH_URL must be a clean Supabase project origin.");
  }
  const projectRef = source.ALBERT_CONTROL_PLANE_PROJECT_REF?.trim();
  if (!local && (!projectRef || parsed.hostname !== `${projectRef}.supabase.co`)) {
    throw new Error("SUPABASE_AUTH_URL must match ALBERT_CONTROL_PLANE_PROJECT_REF.");
  }
  const adminServiceRoleKey = required(source, "SUPABASE_AUTH_ADMIN_SERVICE_ROLE_KEY");
  if (jwtRole(adminServiceRoleKey) !== "service_role") {
    throw new Error("SUPABASE_AUTH_ADMIN_SERVICE_ROLE_KEY must be the protected legacy service-role JWT.");
  }
  const generation = Number(required(source, "ALBERT_RAW_STORAGE_CREDENTIAL_GENERATION"));
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("ALBERT_RAW_STORAGE_CREDENTIAL_GENERATION must be a positive safe integer.");
  }
  const passwords = Object.freeze({
    sync: assertMachinePassword(
      required(source, "ALBERT_RAW_STORAGE_SYNC_PASSWORD", false),
      "ALBERT_RAW_STORAGE_SYNC_PASSWORD",
    ),
    webhook: assertMachinePassword(
      required(source, "ALBERT_RAW_STORAGE_WEBHOOK_PASSWORD", false),
      "ALBERT_RAW_STORAGE_WEBHOOK_PASSWORD",
    ),
    deletion: assertMachinePassword(
      required(source, "ALBERT_RAW_STORAGE_DELETION_PASSWORD", false),
      "ALBERT_RAW_STORAGE_DELETION_PASSWORD",
    ),
  });
  if (new Set(Object.values(passwords)).size !== PURPOSES.length) {
    throw new Error("Each raw Storage machine principal requires distinct password material.");
  }
  const adminDatabaseUrl = required(source, "CONTROL_PLANE_ADMIN_DATABASE_URL");
  assertProtectedAdminDatabaseUrl(adminDatabaseUrl);
  const storage = Object.freeze({
    sync: loadRawStorageS3Config(source, {
      machinePurpose: "sync",
      passwordEnvironmentName: "ALBERT_RAW_STORAGE_SYNC_PASSWORD",
    }),
    webhook: loadRawStorageS3Config(source, {
      machinePurpose: "webhook",
      passwordEnvironmentName: "ALBERT_RAW_STORAGE_WEBHOOK_PASSWORD",
    }),
    deletion: loadRawStorageS3Config(source, {
      machinePurpose: "deletion",
      passwordEnvironmentName: "ALBERT_RAW_STORAGE_DELETION_PASSWORD",
    }),
  });
  return Object.freeze({
    authUrl,
    adminServiceRoleKey,
    adminDatabaseUrl,
    generation,
    passwords,
    storage,
  });
}

function hasPurposeMetadata(value: unknown, purpose: RawStorageMachinePurpose): boolean {
  return Boolean(
    value && typeof value === "object" && !Array.isArray(value) &&
    (value as Readonly<Record<string, unknown>>).albert_machine_principal === true &&
    (value as Readonly<Record<string, unknown>>).albert_raw_storage_purpose === purpose,
  );
}

function assertManagedUser(user: User, purpose: RawStorageMachinePurpose): void {
  if (
    user.email?.toLowerCase() !== rawStorageMachineEmail(purpose) ||
    !hasPurposeMetadata(user.app_metadata, purpose)
  ) {
    throw new Error(`Auth returned an identity that is not the ${purpose} raw Storage principal.`);
  }
}

async function createOrRotateUser(
  auth: SupabaseClient["auth"]["admin"],
  existing: AuthDirectoryRow | undefined,
  purpose: RawStorageMachinePurpose,
  password: string,
): Promise<User> {
  const attributes = {
    email: rawStorageMachineEmail(purpose),
    password,
    email_confirm: true,
    app_metadata: {
      albert_machine_principal: true,
      albert_raw_storage_purpose: purpose,
    },
    user_metadata: { display_name: `Albert raw Storage ${purpose} principal` },
  } as const;
  const result = existing
    ? await auth.updateUserById(existing.id, attributes)
    : await auth.createUser(attributes);
  if (result.error || !result.data.user) {
    throw new Error(`Failed to provision the ${purpose} raw Storage machine principal.`);
  }
  assertManagedUser(result.data.user, purpose);
  return result.data.user;
}

export async function provisionRawStorageMachineUsers(
  config: RawStorageMachineProvisioningConfig,
): Promise<void> {
  const database = new Client({
    connectionString: config.adminDatabaseUrl,
    application_name: "albert-provision-raw-storage-machine-users",
    connectionTimeoutMillis: 10_000,
  });
  const supabase = createClient(config.authUrl, config.adminServiceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });
  await database.connect();
  try {
    const identity = await database.query<{ current_user: string; session_user: string }>(
      "SELECT current_user, session_user",
    );
    if (
      identity.rows[0]?.current_user !== "postgres" ||
      identity.rows[0]?.session_user !== "postgres"
    ) {
      throw new Error("Raw Storage machine provisioning requires the protected postgres login.");
    }
    await database.query("BEGIN");
    try {
      await database.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('albert:raw-storage-machine-users',0))",
      );
      const principalRows = await database.query<PrincipalRow>(
        `SELECT purpose, auth_user_id, credential_generation
           FROM albert_bootstrap.raw_storage_machine_principal
          ORDER BY purpose
          FOR UPDATE`,
      );
      const principals = new Map(principalRows.rows.map((row) => [row.purpose, row]));

      for (const purpose of PURPOSES) {
        const prior = principals.get(purpose);
        const priorGeneration = Number(prior?.credential_generation ?? 0);
        if (priorGeneration > config.generation) {
          throw new Error(`Raw Storage credential generation cannot move backwards for ${purpose}.`);
        }
        const directory = await database.query<AuthDirectoryRow>(
          `SELECT id, email, raw_app_meta_data
             FROM auth.users
            WHERE lower(email)=lower($1)
            ORDER BY id`,
          [rawStorageMachineEmail(purpose)],
        );
        if (directory.rows.length > 1) {
          throw new Error(`Auth contains duplicate ${purpose} raw Storage machine identities.`);
        }
        const existing = directory.rows[0];
        if (existing && !hasPurposeMetadata(existing.raw_app_meta_data, purpose)) {
          throw new Error(`The reserved ${purpose} machine email belongs to a different Auth identity.`);
        }
        if (prior && existing?.id !== prior.auth_user_id) {
          throw new Error(`The ${purpose} principal mapping and Auth directory disagree.`);
        }

        let userId: string;
        if (priorGeneration === config.generation && prior && existing) {
          userId = existing.id;
        } else {
          const user = await createOrRotateUser(
            supabase.auth.admin,
            existing,
            purpose,
            config.passwords[purpose],
          );
          userId = user.id;
          const persisted = await database.query<AuthDirectoryRow>(
            "SELECT id,email,raw_app_meta_data FROM auth.users WHERE id=$1",
            [userId],
          );
          if (
            persisted.rows[0]?.email?.toLowerCase() !== rawStorageMachineEmail(purpose) ||
            !hasPurposeMetadata(persisted.rows[0]?.raw_app_meta_data, purpose)
          ) {
            throw new Error(`The ${purpose} machine identity was not durably persisted.`);
          }
        }

        await database.query(
          `INSERT INTO albert_bootstrap.raw_storage_machine_principal(
             purpose,auth_user_id,credential_generation,active,provisioned_at,rotated_at
           ) VALUES ($1,$2,$3,true,clock_timestamp(),clock_timestamp())
           ON CONFLICT(purpose) DO UPDATE SET
             auth_user_id=excluded.auth_user_id,
             credential_generation=excluded.credential_generation,
             active=true,
             rotated_at=CASE
               WHEN albert_bootstrap.raw_storage_machine_principal.credential_generation
                    < excluded.credential_generation
                 OR albert_bootstrap.raw_storage_machine_principal.auth_user_id
                    <> excluded.auth_user_id
               THEN clock_timestamp()
               ELSE albert_bootstrap.raw_storage_machine_principal.rotated_at
             END`,
          [purpose, userId, config.generation],
        );
      }

      const verification = await database.query<{ valid: boolean }>(
        `SELECT count(*)=3
            AND count(DISTINCT principal.auth_user_id)=3
            AND bool_and(principal.active)
            AND bool_and(principal.credential_generation=$1) AS valid
           FROM albert_bootstrap.raw_storage_machine_principal AS principal
           JOIN auth.users AS auth_user ON auth_user.id=principal.auth_user_id
          WHERE principal.purpose IN ('sync','webhook','deletion')
            AND auth_user.email_confirmed_at IS NOT NULL
            AND auth_user.banned_until IS NULL`,
        [config.generation],
      );
      if (!verification.rows[0]?.valid) {
        throw new Error("Raw Storage machine principal verification failed.");
      }
      await database.query("COMMIT");
    } catch (error) {
      await database.query("ROLLBACK").catch(() => undefined);
      throw error;
    }

    // Exercise the same refreshable session path used by the deployed
    // services. The two ingestion principals create/verify immutable,
    // non-customer sentinels; deletion must be able to enumerate both.
    const syncStorage = new S3RawIngestionObjectStore(config.storage.sync);
    const webhookStorage = new S3RawIngestionObjectStore(config.storage.webhook);
    const deletionStorage = new S3RawDeletionObjectStore(config.storage.deletion);
    try {
      await syncStorage.ready();
      await webhookStorage.ready();
      await deletionStorage.ready();
    } finally {
      syncStorage.destroy();
      webhookStorage.destroy();
      deletionStorage.destroy();
    }
  } finally {
    await database.end();
  }
}

async function main(): Promise<void> {
  const config = loadRawStorageMachineProvisioningConfig();
  await provisionRawStorageMachineUsers(config);
  process.stdout.write(
    `provisioned raw Storage machine principals at generation ${config.generation}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
