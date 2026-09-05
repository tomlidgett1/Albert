/**
 * Lightspeed R-Series full-account API ingester.
 *
 * Fastest documented path for a complete pull:
 *   - V3 cursor pagination (`after` / `next`)
 *   - One walk per scan group with the group's collapsed `load_relations`
 *     union (one Sale.json walk fills sales + lines + payments + …)
 *   - Adaptive leaky-bucket pacing from live rate-limit headers
 *
 * Usage:
 *   npx tsx scripts/lightspeed-full-ingest.mts --probe
 *   npx tsx scripts/lightspeed-full-ingest.mts --ingest
 *   npx tsx scripts/lightspeed-full-ingest.mts --ingest --only=Sale,Item,Customer
 *   npx tsx scripts/lightspeed-full-ingest.mts --ingest --include-catalog
 *   npx tsx scripts/lightspeed-full-ingest.mts --report
 *
 * CatalogVendorItem is the Lightspeed vendor catalogue master (not the store's
 * own Item/ItemShop inventory). It is skipped by default.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { ulid } from "ulid";
import { Pool } from "pg";

const execFileAsync = promisify(execFile);

import { loadEncodedAes256Keyring } from "../packages/security/src/index.js";
import {
  makeNamespacedSourceKey,
  type OAuthCredentialSecret,
} from "../packages/connector-sdk/src/index.js";
import {
  AesKeyringWrapper,
  EnvelopeCryptography,
  PostgresCredentialVault,
} from "../services/sync-workers/src/credential-vault.js";
import { PgTransactionalDatabase } from "../services/sync-workers/src/postgres.js";
import {
  prepareTypedStaging,
  upsertTypedStagingRecords,
  type TypedStagingRecord,
} from "../services/sync-workers/src/typed-staging.js";
import {
  buildScanPlan,
  collapseRelations,
  type ScanGroup,
} from "../connectors/lightspeed-r/scan-plan.js";
import {
  afterTokenFrom,
  assertRelationsPresent,
  parseEnvelope,
  projectPage,
  MAX_PAGE_SIZE,
} from "../connectors/lightspeed-r/fetch-core.js";
import { LightspeedRateGovernor } from "../connectors/lightspeed-r/rate-governor.js";
import { lightspeedRManifest } from "../connectors/lightspeed-r/manifest.js";
import { LIGHTSPEED_STREAMS } from "../connectors/lightspeed-r/streams.js";
import { lightspeedSchemas } from "../connectors/lightspeed-r/schemas.js";

/**
 * Member-need relation union from the connector's live-proven Sale/Item walks.
 * The raw group union from tables.json includes deep enrichments that Lightspeed
 * rejects on collection queries (400 InvalidQueryException).
 *
 * Sale stays on the bare production trio (Customer + SaleLines + SalePayments).
 * Deep InventorySales / Signatures / SaleAccounts expansions make each page
 * huge and are not needed for core sales staging throughput.
 */
function safeGroupRelations(group: ScanGroup): readonly string[] {
  if (group.resource === "Sale") {
    return collapseRelations(["Customer", "SaleLines", "SalePayments"]);
  }
  const shared = new Set<string>();
  for (const sibling of group.members) {
    if (sibling.projectFrom) shared.add(sibling.projectFrom.split(".")[0]!);
    for (const relation of sibling.table.loadRelations) {
      if (!sibling.projectFrom) {
        shared.add(relation);
      } else if (relation.startsWith(`${sibling.projectFrom.split(".")[0]}.`)) {
        shared.add(relation);
      }
    }
  }
  return collapseRelations([...shared]);
}

const TENANT_ID = "01KZ4ZMVF5QNQ4TX35VF3WDJBM";
const CONNECTION_ID = "01KZ54B1PCKM1MHSNHY4XT6DEX";
const ACCOUNT_ID = "168990";
const API_ORIGIN = "https://api.lightspeedapp.com";
const TOKEN_ENDPOINT = "https://cloud.lightspeedapp.com/auth/oauth/token";
const OUT_DIR = resolve(".albert-lightspeed-full-ingest");

/** Vendor catalogue master, not Ashburton's own stock. Skip by default. */
const DEFAULT_SKIP_RESOURCES = Object.freeze(["CatalogVendorItem"] as const);

type Mode = "probe" | "ingest" | "report";

type GroupResult = Readonly<{
  resource: string;
  path: string;
  status: "ok" | "empty" | "unavailable" | "error";
  httpStatus?: number;
  pages: number;
  leaderRecords: number;
  projectedByTable: Readonly<Record<string, number>>;
  stagedByTable: Readonly<Record<string, number>>;
  quarantined: number;
  error?: string;
  durationMs: number;
}>;

function loadEnv(): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const file of [".env.local", ".env.production.local"]) {
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const raw = line.trim();
      if (!raw || raw.startsWith("#") || !raw.includes("=")) continue;
      const i = raw.indexOf("=");
      const key = raw.slice(0, i).trim();
      let value = raw.slice(i + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!env[key]) env[key] = value;
    }
  }
  return env;
}

function required(env: Record<string, string>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function cleanUrl(url: string): string {
  // Keep vendor URL params intact. Supabase pooler URLs rely on
  // uselibpqcompat=true&sslmode=require under current node-postgres.
  return url;
}

function parseArgs(argv: readonly string[]): Readonly<{
  mode: Mode;
  only: ReadonlySet<string> | null;
  skip: ReadonlySet<string>;
  maxPages: number | null;
}> {
  let mode: Mode = "probe";
  let only: ReadonlySet<string> | null = null;
  let includeCatalog = false;
  const skipExtra = new Set<string>();
  let maxPages: number | null = null;
  for (const arg of argv) {
    if (arg === "--probe") mode = "probe";
    else if (arg === "--ingest") mode = "ingest";
    else if (arg === "--report") mode = "report";
    else if (arg === "--include-catalog") includeCatalog = true;
    else if (arg.startsWith("--only=")) {
      only = new Set(
        arg
          .slice("--only=".length)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
    } else if (arg.startsWith("--skip=")) {
      for (const value of arg.slice("--skip=".length).split(",")) {
        const trimmed = value.trim();
        if (trimmed) skipExtra.add(trimmed);
      }
    } else if (arg.startsWith("--max-pages=")) {
      maxPages = Number(arg.slice("--max-pages=".length));
    }
  }
  const skip = new Set<string>([
    ...(includeCatalog ? [] : DEFAULT_SKIP_RESOURCES),
    ...skipExtra,
  ]);
  return { mode, only, skip, maxPages };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/** Always-durable progress line (survives piped stdout buffering). */
function progress(payload: Readonly<Record<string, unknown>>): void {
  const line = JSON.stringify(payload);
  console.log(line);
  try {
    mkdirSync(OUT_DIR, { recursive: true });
    appendFileSync(resolve(OUT_DIR, "ingest-live.log"), `${line}\n`, "utf8");
  } catch {
    /* best-effort */
  }
}

function hashPayload(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function readAccessToken(
  env: Record<string, string>,
): Promise<Readonly<{ accessToken: string; credentialRef: string }>> {
  const controlUrl = cleanUrl(
    required(env, "CONTROL_PLANE_ADMIN_DATABASE_URL"),
  );
  const db = new PgTransactionalDatabase(controlUrl, {
    applicationName: "albert-lightspeed-full-ingest",
    assumedRole: "albert_control_migration_owner",
  });
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
    db,
    new EnvelopeCryptography(
      new AesKeyringWrapper({
        currentKeyReference: "env:TOKEN_ENCRYPTION_KEY",
        currentKeyVersion: keyring.currentKeyId,
        encodedKeys: keyring.keys,
      }),
    ),
  );

  const refRows = await db.query<{ secret_reference: string }>(
    `select secret_reference
       from control_plane.oauth_token_refs
      where connection_id = $1
      order by updated_at desc
      limit 1`,
    [CONNECTION_ID],
  );
  const credentialRef = refRows.rows[0]?.secret_reference;
  if (!credentialRef) throw new Error(`No oauth token ref for ${CONNECTION_ID}`);

  let credential = await vault.read(credentialRef);
  const expiresAt = Date.parse(credential.secret.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now() + 60_000) {
    // Lightspeed rotates refresh tokens. Never refresh without a durable lease +
    // CAS write: an in-process-only refresh permanently orphans the connection.
    credential = await vault.withRefreshLease(credentialRef, async (lease) => {
      const latest = await vault.read(credentialRef);
      if (latest.revision !== credential.revision) return latest;
      if (!latest.secret.refreshToken) throw new Error("No refresh token available");
      const body = new URLSearchParams({
        client_id: required(env, "LIGHTSPEED_CLIENT_ID"),
        client_secret: required(env, "LIGHTSPEED_CLIENT_SECRET"),
        grant_type: "refresh_token",
        refresh_token: latest.secret.refreshToken,
      });
      const response = await fetch(TOKEN_ENDPOINT, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body,
        signal: lease.abortSignal,
      });
      const text = await response.text();
      if (!response.ok) {
        throw new Error(
          `Token refresh failed HTTP ${response.status}: ${text.slice(0, 300)}`,
        );
      }
      const payload = JSON.parse(text) as Record<string, unknown>;
      const accessToken = String(payload.access_token ?? "");
      const refreshToken = String(payload.refresh_token ?? latest.secret.refreshToken);
      const expiresIn = Number(payload.expires_in ?? 3600);
      if (!accessToken) throw new Error("Token refresh returned no access_token");
      const next: OAuthCredentialSecret = {
        ...latest.secret,
        accessToken,
        refreshToken,
        expiresAt: new Date(Date.now() + Math.max(60, expiresIn) * 1000).toISOString(),
      };
      return vault.compareAndSwap(credentialRef, latest.revision, next, lease.proof);
    });
  }
  await db.close().catch(() => undefined);
  return { accessToken: credential.secret.accessToken, credentialRef };
}

class LightspeedClient {
  // Max throughput against a dedicated ingest run: leave almost no bucket
  // headroom and start with a high burst guess; the governor still snaps to
  // live X-LS-API-* headers and backs off on 429s.
  private readonly governor = new LightspeedRateGovernor({
    headroomUnits: 0,
    initialBurstWindowCap: 12,
    initialCapacity: 60,
    initialDripRate: 2,
  });
  private authRefreshInFlight: Promise<string> | null = null;

  constructor(
    private accessToken: string,
    private readonly refreshAuth?: () => Promise<string>,
  ) {}

  setAccessToken(token: string): void {
    this.accessToken = token;
  }

  get rateState() {
    return this.governor.state;
  }

  private async refreshAccessToken(): Promise<void> {
    if (!this.refreshAuth) return;
    if (!this.authRefreshInFlight) {
      this.authRefreshInFlight = this.refreshAuth().finally(() => {
        this.authRefreshInFlight = null;
      });
    }
    this.accessToken = await this.authRefreshInFlight;
  }

  async getJson(
    path: string,
    params: Readonly<Record<string, string>> = {},
  ): Promise<Readonly<{ status: number; body: unknown; headers: Headers }>> {
    const url = new URL(`/API/V3/Account/${ACCOUNT_ID}/${path}`, API_ORIGIN);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const delay = this.governor.delayFor(1);
      if (delay > 0) await sleep(delay);
      this.governor.commit(1);
      const response = await fetch(url, {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.accessToken}`,
        },
      });
      this.governor.observe(response.headers);
      if (response.status === 429) {
        const retryAfter = Number(response.headers.get("retry-after") ?? "1");
        await sleep(Math.max(500, Math.min(30_000, (Number.isFinite(retryAfter) ? retryAfter : 1) * 1000)));
        continue;
      }
      // Nest may rotate the shared Lightspeed grant mid-run; re-import a fresh
      // token from bike-dashboard and retry instead of failing the whole group.
      if (response.status === 401 && this.refreshAuth && attempt < 3) {
        progress({ phase: "auth_refresh", path, attempt });
        await this.refreshAccessToken();
        continue;
      }
      const text = await response.text();
      let body: unknown = null;
      if (text.length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          body = { raw: text.slice(0, 500) };
        }
      }
      return { status: response.status, body, headers: response.headers };
    }
    throw new Error(`Exceeded retries for ${path}`);
  }
}

/** Re-copy Nest's live Ashburton token into Albert's vault, then return it. */
async function refreshAccessTokenFromBike(
  env: Record<string, string>,
): Promise<string> {
  await execFileAsync(
    process.execPath,
    [
      resolve("node_modules/tsx/dist/cli.mjs"),
      resolve("scripts/bootstrap-lightspeed-from-bike.mts"),
    ],
    {
      cwd: resolve("."),
      env: process.env,
      timeout: 90_000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  const fresh = await readAccessToken(env);
  return fresh.accessToken;
}

let analyticalPool: Pool | null = null;

function getAnalyticalPool(env: Record<string, string>): Pool {
  if (!analyticalPool) {
    analyticalPool = new Pool({
      connectionString: cleanUrl(
        required(env, "ANALYTICAL_ADMIN_DATABASE_URL"),
      ),
      application_name: "albert-lightspeed-full-ingest",
      // Parallel per-stream staging wants a few concurrent clients.
      max: 8,
    });
  }
  return analyticalPool;
}

async function closeAnalyticalPool(): Promise<void> {
  if (!analyticalPool) return;
  const pool = analyticalPool;
  analyticalPool = null;
  await pool.end().catch(() => undefined);
}

async function withAnalytical<T>(
  env: Record<string, string>,
  fn: (pool: Pool) => Promise<T>,
): Promise<T> {
  const pool = getAnalyticalPool(env);
  const client = await pool.connect();
  try {
    await client.query("set role albert_migration_owner");
    await client.query("select set_config('albert.tenant_id', $1, false)", [TENANT_ID]);
  } finally {
    client.release();
  }
  return fn(pool);
}

async function reportCounts(env: Record<string, string>): Promise<Readonly<Record<string, number>>> {
  const plan = buildScanPlan();
  const tables = [
    ...plan.groups.flatMap((g) => g.members.map((m) => m.table.id)),
    ...plan.fanOuts.map((f) => f.table.id),
  ];
  return withAnalytical(env, async (pool) => {
    const client = await pool.connect();
    try {
      await client.query("set role albert_migration_owner");
      await client.query("select set_config('albert.tenant_id', $1, false)", [TENANT_ID]);
      const out: Record<string, number> = {};
      for (const table of tables) {
        const result = await client.query<{ n: string }>(
          `select count(*)::text as n from source_lightspeed.${quoteIdent(table)} where connection_id = $1`,
          [CONNECTION_ID],
        );
        out[table] = Number(result.rows[0]?.n ?? 0);
      }
      return out;
    } finally {
      client.release();
    }
  });
}

function quoteIdent(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error(`Bad ident ${value}`);
  return `"${value}"`;
}

type StageableRecord = Readonly<{
  sourceObjectType: string;
  sourceRecordId: string;
  sourceUpdatedAt?: string;
  payload: Record<string, unknown>;
  payloadHash: string;
  normalized?: { schemaVersion: string; fields: Record<string, unknown> };
}>;

async function stageRecordsOnClient(
  client: import("pg").PoolClient,
  stream: string,
  records: readonly StageableRecord[],
): Promise<Readonly<{ staged: number; quarantined: number }>> {
  if (records.length === 0) return { staged: 0, quarantined: 0 };
  const syncRunId = ulid();
  const batchId = ulid();
  const mappingVersion = lightspeedRManifest.packVersion;
  const contentHash = hashPayload({ stream, batchId, count: records.length });
  const schemaFingerprint = hashPayload({
    connector: "lightspeed-r",
    stream,
    packVersion: lightspeedRManifest.packVersion,
    apiVersion: lightspeedRManifest.apiVersion,
  });
  // Direct API ingest has no object-store keys; satisfy the non-empty check
  // with a stable synthetic key for the in-memory batch.
  const objectKeys = [`inline:lightspeed-r:${stream}:${batchId}`];
  await client.query(
    `insert into ingestion.batch_manifests (
       tenant_id, batch_id, connection_id, sync_run_id, connector_key,
       connector_version, api_version, stream, external_account_reference,
       extracted_at, cursor_start, cursor_end, content_hash,
       schema_fingerprint, record_count, compressed_bytes, object_keys
     ) values (
       $1,$2,$3,$4,'lightspeed-r',$5,$6,$7,$8, now(), '{}'::jsonb, '{}'::jsonb,
       $9, $10, $11, 0, $12::text[]
     ) on conflict (tenant_id, batch_id) do nothing`,
    [
      TENANT_ID,
      batchId,
      CONNECTION_ID,
      syncRunId,
      lightspeedRManifest.packVersion,
      lightspeedRManifest.apiVersion,
      stream,
      ACCOUNT_ID,
      contentHash,
      schemaFingerprint,
      records.length,
      objectKeys,
    ],
  );

  const queryClient = {
    query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      values: readonly unknown[] = [],
    ) => {
      const result = await client.query(sql, [...values]);
      return { rows: result.rows as Row[] };
    },
  };

  let quarantined = 0;
  const preparedRows: TypedStagingRecord[] = [];
  for (const record of records) {
    if (!record.normalized) {
      quarantined += 1;
      continue;
    }
    const prepared = prepareTypedStaging("lightspeed-r", stream, record.normalized);
    if (prepared.issues.length > 0) {
      quarantined += 1;
      continue;
    }
    preparedRows.push({
      contract: prepared.contract,
      tenantId: TENANT_ID,
      namespacedSourceKey: makeNamespacedSourceKey(
        "lightspeed-r",
        ACCOUNT_ID,
        record.sourceObjectType,
        record.sourceRecordId,
      ),
      connectionId: CONNECTION_ID,
      externalAccountReference: ACCOUNT_ID,
      sourceRecordId: record.sourceRecordId,
      sourceVersion: record.sourceUpdatedAt ?? record.payloadHash,
      sourceUpdatedAt: record.sourceUpdatedAt ?? null,
      payloadHash: record.payloadHash,
      payloadBatchId: batchId,
      syncRunId,
      tombstone: false,
      mappingVersion,
      values: prepared.values,
    });
  }

  await upsertTypedStagingRecords(queryClient, preparedRows, {
    fastConflict: "overwrite",
  });
  return { staged: preparedRows.length, quarantined };
}

/**
 * Stage each non-empty stream on its own connection in parallel. Staging, not
 * the vendor drip, is the ceiling once pages are batched.
 */
async function stagePageStreams(
  env: Record<string, string>,
  byStream: ReadonlyMap<string, readonly StageableRecord[]>,
): Promise<Readonly<{ stagedByTable: Record<string, number>; quarantined: number }>> {
  const stagedByTable: Record<string, number> = {};
  let quarantined = 0;
  const pool = getAnalyticalPool(env);
  const entries = [...byStream.entries()].filter(([, records]) => records.length > 0);
  const results = await Promise.all(
    entries.map(async ([streamId, records]) => {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("set local role albert_migration_owner");
        await client.query("select set_config('albert.tenant_id', $1, true)", [TENANT_ID]);
        const result = await stageRecordsOnClient(client, streamId, records);
        await client.query("commit");
        return { streamId, result };
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    }),
  );
  for (const { streamId, result } of results) {
    stagedByTable[streamId] = (stagedByTable[streamId] ?? 0) + result.staged;
    quarantined += result.quarantined;
  }
  return { stagedByTable, quarantined };
}

const allowedFieldsByStream = new Map<string, ReadonlySet<string> | null>();

function allowedFieldsFor(streamId: string): ReadonlySet<string> | null {
  if (allowedFieldsByStream.has(streamId)) {
    return allowedFieldsByStream.get(streamId) ?? null;
  }
  if (!(streamId in lightspeedSchemas)) {
    allowedFieldsByStream.set(streamId, null);
    return null;
  }
  const allowed = new Set(
    lightspeedRManifest.fieldCoverage
      .filter((item) => item.stream === streamId && item.disposition !== "unsupported")
      .map((item) => item.field),
  );
  allowedFieldsByStream.set(streamId, allowed);
  return allowed;
}

/**
 * Fast path for the dedicated ingester: skip Zod per row (dominant CPU cost on
 * dense Sale pages) and just keep field-coverage-approved keys.
 */
function validateRecord(
  streamId: string,
  record: ReturnType<typeof projectPage>[number],
): StageableRecord {
  const allowed = allowedFieldsFor(streamId);
  const payloadFields =
    record.payload && typeof record.payload === "object"
      ? (record.payload as Record<string, unknown>)
      : {};
  const base: StageableRecord = {
    sourceObjectType: record.sourceObjectType,
    sourceRecordId: record.sourceRecordId,
    ...(record.sourceUpdatedAt ? { sourceUpdatedAt: record.sourceUpdatedAt } : {}),
    payload: payloadFields,
    payloadHash: record.payloadHash,
    ...(record.normalized ? { normalized: { schemaVersion: record.normalized.schemaVersion, fields: { ...record.normalized.fields } } } : {}),
  };
  if (!allowed) return base;
  const approved = Object.fromEntries(
    Object.entries(payloadFields).filter(([field]) => allowed.has(field)),
  );
  return {
    ...base,
    normalized: { schemaVersion: lightspeedRManifest.packVersion, fields: approved },
  };
}

async function walkGroup(
  client: LightspeedClient,
  group: ScanGroup,
  options: Readonly<{
    mode: Mode;
    env: Record<string, string>;
    maxPages: number | null;
  }>,
): Promise<GroupResult> {
  const started = Date.now();
  const projectedByTable: Record<string, number> = Object.fromEntries(
    group.members.map((m) => [m.table.id, 0]),
  );
  const stagedByTable: Record<string, number> = Object.fromEntries(
    group.members.map((m) => [m.table.id, 0]),
  );
  let pages = 0;
  let leaderRecords = 0;
  let quarantined = 0;

  try {
    const relations = safeGroupRelations(group);
    // Account is a singleton under /Account/{id}.json, not a collection.
    const path =
      group.resource === "Account"
        ? `Account/${ACCOUNT_ID}.json`
        : group.path;

    const fetchPage = async (after: string | null) => {
      const params: Record<string, string> = {};
      if (after) {
        params.after = after;
      } else {
        params.limit = String(MAX_PAGE_SIZE);
        params.sort = group.idField;
      }
      if (relations.length > 0) {
        params.load_relations = JSON.stringify([...relations]);
      }
      let { status, body } = await client.getJson(path, params);
      // If Lightspeed rejects a relation on the collection query, strip
      // relations and retry once so the leader table still ingests.
      if (
        status === 400 &&
        relations.length > 0 &&
        JSON.stringify(body).includes("relations that are not allowed")
      ) {
        const retryParams = { ...params };
        delete retryParams.load_relations;
        ({ status, body } = await client.getJson(path, retryParams));
      }
      return { status, body };
    };

    // Pipeline: while page N stages, the next HTTP page is already in flight.
    let pendingFetch: Promise<Readonly<{ status: number; body: unknown }>> | null =
      fetchPage(null);

    while (pendingFetch) {
      if (options.maxPages !== null && pages >= options.maxPages) break;
      const { status, body } = await pendingFetch;
      pendingFetch = null;

      if (status === 404) {
        return {
          resource: group.resource,
          path,
          status: "unavailable",
          httpStatus: 404,
          pages,
          leaderRecords,
          projectedByTable,
          stagedByTable,
          quarantined,
          durationMs: Date.now() - started,
        };
      }
      if (status === 403) {
        return {
          resource: group.resource,
          path,
          status: "unavailable",
          httpStatus: 403,
          pages,
          leaderRecords,
          projectedByTable,
          stagedByTable,
          quarantined,
          error: "insufficient_rights",
          durationMs: Date.now() - started,
        };
      }
      if (status >= 400) {
        return {
          resource: group.resource,
          path,
          status: "error",
          httpStatus: status,
          pages,
          leaderRecords,
          projectedByTable,
          stagedByTable,
          quarantined,
          error: JSON.stringify(body).slice(0, 300),
          durationMs: Date.now() - started,
        };
      }

      const page = parseEnvelope(body, group.resource);
      if (relations.length > 0 && page.records.length > 0) {
        try {
          assertRelationsPresent(group, page.records, relations);
        } catch {
          // Sparse or stripped relations: continue with whatever projected.
        }
      }
      pages += 1;
      leaderRecords += page.records.length;

      const nextAfter = afterTokenFrom(page.nextUrl);
      const shouldContinue =
        options.mode !== "probe" &&
        nextAfter !== null &&
        (options.maxPages === null || pages < options.maxPages);
      // Kick the next vendor page off before staging so drip wait + RTT overlap
      // with Postgres work.
      if (shouldContinue) {
        pendingFetch = fetchPage(nextAfter);
      }

      const projected = projectPage(group, page, hashPayload);
      const byStream = new Map<string, StageableRecord[]>();
      for (const raw of projected) {
        const streamId = raw.sourceObjectType;
        projectedByTable[streamId] = (projectedByTable[streamId] ?? 0) + 1;
        const list = byStream.get(streamId) ?? [];
        list.push(validateRecord(streamId, raw));
        byStream.set(streamId, list);
      }

      if (options.mode === "ingest") {
        const pageStarted = Date.now();
        const staged = await stagePageStreams(options.env, byStream);
        for (const [streamId, count] of Object.entries(staged.stagedByTable)) {
          stagedByTable[streamId] = (stagedByTable[streamId] ?? 0) + count;
        }
        quarantined += staged.quarantined;
        progress({
          phase: `${options.mode}:page`,
          resource: group.resource,
          page: pages,
          pageRecords: page.records.length,
          leaderRecords,
          stagedByTable,
          stageMs: Date.now() - pageStarted,
          bucket: client.rateState,
        });
      } else {
        progress({
          phase: `${options.mode}:page`,
          resource: group.resource,
          page: pages,
          pageRecords: page.records.length,
          leaderRecords,
          stagedByTable,
          bucket: client.rateState,
        });
      }

      if (options.mode === "probe" || !shouldContinue) break;
    }

    const anyProjected = Object.values(projectedByTable).some((n) => n > 0);
    return {
      resource: group.resource,
      path: group.path,
      status: anyProjected || leaderRecords > 0 ? "ok" : "empty",
      httpStatus: 200,
      pages,
      leaderRecords,
      projectedByTable,
      stagedByTable,
      quarantined,
      durationMs: Date.now() - started,
    };
  } catch (error) {
    return {
      resource: group.resource,
      path: group.path,
      status: "error",
      pages,
      leaderRecords,
      projectedByTable,
      stagedByTable,
      quarantined,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - started,
    };
  }
}

async function walkFanOuts(
  client: LightspeedClient,
  options: Readonly<{ mode: Mode; env: Record<string, string> }>,
): Promise<GroupResult[]> {
  const plan = buildScanPlan();
  const results: GroupResult[] = [];
  for (const fan of plan.fanOuts) {
    const started = Date.now();
    const tableId = fan.table.id;
    // Resolve a parent id from staging or a cheap parent page.
    let parentId: string | null = null;
    try {
      const parentGroup = plan.groups.find((g) => g.resource === fan.parentResource);
      if (!parentGroup) throw new Error(`No parent group for ${tableId}`);
      const parentPage = await client.getJson(parentGroup.path, {
        limit: "1",
        sort: parentGroup.idField,
      });
      if (parentPage.status === 404) {
        results.push({
          resource: tableId,
          path: fan.endpoint,
          status: "unavailable",
          httpStatus: 404,
          pages: 0,
          leaderRecords: 0,
          projectedByTable: { [tableId]: 0 },
          stagedByTable: { [tableId]: 0 },
          quarantined: 0,
          durationMs: Date.now() - started,
        });
        continue;
      }
      const parsed = parseEnvelope(parentPage.body, fan.parentResource);
      parentId = parsed.records[0]
        ? String(parsed.records[0][parentGroup.idField] ?? "")
        : null;
      if (!parentId) {
        results.push({
          resource: tableId,
          path: fan.endpoint,
          status: "empty",
          httpStatus: 200,
          pages: 0,
          leaderRecords: 0,
          projectedByTable: { [tableId]: 0 },
          stagedByTable: { [tableId]: 0 },
          quarantined: 0,
          durationMs: Date.now() - started,
        });
        continue;
      }
      const endpoint = fan.endpoint
        .replace(/\s*\(.*$/, "")
        .replace(`{${parentGroup.idField}}`, encodeURIComponent(parentId))
        .replace(`{${fan.parentResource.charAt(0).toLowerCase()}${fan.parentResource.slice(1)}ID}`, encodeURIComponent(parentId));
      // Endpoint templates in the spec look like Workorder/{workorderID}/WorkorderImage.json
      const path = endpoint.endsWith(".json") ? endpoint : `${endpoint}.json`;
      const child = await client.getJson(path, { limit: String(MAX_PAGE_SIZE) });
      if (child.status === 404) {
        results.push({
          resource: tableId,
          path,
          status: "unavailable",
          httpStatus: 404,
          pages: 1,
          leaderRecords: 0,
          projectedByTable: { [tableId]: 0 },
          stagedByTable: { [tableId]: 0 },
          quarantined: 0,
          durationMs: Date.now() - started,
        });
        continue;
      }
      if (child.status >= 400) {
        results.push({
          resource: tableId,
          path,
          status: "error",
          httpStatus: child.status,
          pages: 1,
          leaderRecords: 0,
          projectedByTable: { [tableId]: 0 },
          stagedByTable: { [tableId]: 0 },
          quarantined: 0,
          error: JSON.stringify(child.body).slice(0, 300),
          durationMs: Date.now() - started,
        });
        continue;
      }
      const ownResource =
        LIGHTSPEED_STREAMS.find((s) => s.id === tableId)?.resource ?? tableId;
      const envelope = parseEnvelope(child.body, ownResource);
      const projected = envelope.records.map((payload, index) => {
        const idField = fan.table.recordIdField;
        const sourceRecordId = idField && payload[idField] != null
          ? String(payload[idField])
          : `${parentId}:${index}`;
        return validateRecord(tableId, {
          sourceObjectType: tableId,
          sourceRecordId,
          payload,
          payloadHash: hashPayload(payload),
        });
      });
      let staged = 0;
      let quarantined = 0;
      if (options.mode === "ingest" && projected.length > 0) {
        const result = await stagePageStreams(
          options.env,
          new Map([[tableId, projected]]),
        );
        staged = result.stagedByTable[tableId] ?? 0;
        quarantined = result.quarantined;
      }
      results.push({
        resource: tableId,
        path,
        status: projected.length > 0 ? "ok" : "empty",
        httpStatus: 200,
        pages: 1,
        leaderRecords: projected.length,
        projectedByTable: { [tableId]: projected.length },
        stagedByTable: { [tableId]: staged },
        quarantined,
        durationMs: Date.now() - started,
      });
    } catch (error) {
      results.push({
        resource: tableId,
        path: fan.endpoint,
        status: "error",
        pages: 0,
        leaderRecords: 0,
        projectedByTable: { [tableId]: 0 },
        stagedByTable: { [tableId]: 0 },
        quarantined: 0,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started,
      });
    }
  }
  return results;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnv();
  mkdirSync(OUT_DIR, { recursive: true });

  if (args.mode === "report") {
    const counts = await reportCounts(env);
    const nonempty = Object.entries(counts).filter(([, n]) => n > 0);
    const empty = Object.entries(counts).filter(([, n]) => n === 0).map(([t]) => t);
    const summary = {
      connectionId: CONNECTION_ID,
      accountId: ACCOUNT_ID,
      nonemptyTables: nonempty.length,
      emptyTables: empty.length,
      counts,
      empty,
      at: new Date().toISOString(),
    };
    writeFileSync(resolve(OUT_DIR, "report.json"), JSON.stringify(summary, null, 2));
    console.log(JSON.stringify({
      nonemptyTables: summary.nonemptyTables,
      emptyTables: summary.emptyTables,
      empty,
    }, null, 2));
    return;
  }

  progress({
    phase: "start",
    mode: args.mode,
    connectionId: CONNECTION_ID,
    accountId: ACCOUNT_ID,
    streams: LIGHTSPEED_STREAMS.length,
    skip: [...args.skip],
  });

  const { accessToken } = await readAccessToken(env);
  const client = new LightspeedClient(accessToken, () => refreshAccessTokenFromBike(env));
  const plan = buildScanPlan();
  const groups = plan.groups.filter((group) => {
    if (args.skip.has(group.resource)) return false;
    if (
      args.only &&
      !args.only.has(group.resource) &&
      !group.members.some((m) => args.only!.has(m.table.id))
    ) {
      return false;
    }
    return true;
  });
  // High-impact first: sales, then stock + people + ops reference data.
  // Audit/log streams are low impact for agent answers; keep them last.
  const priorityFirst = [
    "Sale",
    "SaleVoid",
    "Item",
    "Employee",
    "EmployeeHours",
    "Customer",
    "Shop",
    "Category",
    "Vendor",
    "Order",
    "Transfer",
    "Register",
    "PaymentType",
    "TaxCategory",
    "Manufacturer",
    "Workorder",
  ];
  const priorityLast = [
    "InventoryCountItem",
    "InventoryCountCalc",
    "InventoryCountReconcile",
    "InventoryLog",
    "DiscountsByDay",
    "PaymentsByDay",
    "TaxesByDay",
    "TaxClassSalesByDay",
    "OrdersByTaxClass",
    "Session",
    "RegisterCount",
  ];
  groups.sort((a, b) => {
    const ai = priorityFirst.indexOf(a.resource);
    const bi = priorityFirst.indexOf(b.resource);
    const al = priorityLast.indexOf(a.resource);
    const bl = priorityLast.indexOf(b.resource);
    const aRank =
      ai !== -1 ? ai : al !== -1 ? priorityFirst.length + 1000 + al : priorityFirst.length;
    const bRank =
      bi !== -1 ? bi : bl !== -1 ? priorityFirst.length + 1000 + bl : priorityFirst.length;
    return aRank - bRank;
  });

  const results: GroupResult[] = [];
  for (const group of groups) {
    const result = await walkGroup(client, group, {
      mode: args.mode,
      env,
      maxPages: args.mode === "probe" ? 1 : args.maxPages,
    });
    results.push(result);
    progress({
      phase: args.mode,
      resource: result.resource,
      status: result.status,
      httpStatus: result.httpStatus,
      pages: result.pages,
      leaderRecords: result.leaderRecords,
      projected: result.projectedByTable,
      staged: result.stagedByTable,
      quarantined: result.quarantined,
      ms: result.durationMs,
      error: result.error,
    });
  }

  if (!args.only || [...args.only].some((id) => id.startsWith("ls_") && id.includes("custom") || id.includes("workorder_image") || id.includes("register_calculated") || id === "CustomField" || id === "Workorder" || id === "Register")) {
    const fanResults = await walkFanOuts(client, { mode: args.mode, env });
    for (const result of fanResults) {
      results.push(result);
      progress({
        phase: `${args.mode}:fanout`,
        resource: result.resource,
        status: result.status,
        httpStatus: result.httpStatus,
        leaderRecords: result.leaderRecords,
        staged: result.stagedByTable,
        ms: result.durationMs,
        error: result.error,
      });
    }
  }

  const counts = await reportCounts(env);
  const nonempty = Object.entries(counts).filter(([, n]) => n > 0).length;
  const empty = Object.entries(counts).filter(([, n]) => n === 0).map(([t]) => t);
  const summary = {
    mode: args.mode,
    at: new Date().toISOString(),
    groups: results,
    nonemptyTables: nonempty,
    emptyTables: empty.length,
    empty,
    counts,
  };
  writeFileSync(
    resolve(OUT_DIR, `${args.mode}-${Date.now()}.json`),
    JSON.stringify(summary, null, 2),
  );
  progress({
    phase: "done",
    mode: args.mode,
    groupResults: {
      ok: results.filter((r) => r.status === "ok").length,
      empty: results.filter((r) => r.status === "empty").length,
      unavailable: results.filter((r) => r.status === "unavailable").length,
      error: results.filter((r) => r.status === "error").length,
    },
    nonemptyTables: nonempty,
    emptyTables: empty.length,
    empty,
  });
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    void closeAnalyticalPool();
  });
