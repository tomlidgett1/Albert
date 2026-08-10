/**
 * Xero full-account ingester.
 *
 * Drives the real connector (connectors/xero) over every stream the spec
 * declares, against the live tenant, and stages each page through the same
 * typed-staging path the sync worker uses. It exists because the deployed
 * worker runs the previously released pack; this pulls a complete account with
 * the current one.
 *
 * Fastest documented path for a complete pull:
 *   - Xero allows 5 concurrent requests and 60/minute per organisation, so the
 *     pacer holds a global minute budget and streams run in parallel up to the
 *     concurrency limit. Wall clock is bounded by the minute budget, not by
 *     how many streams there are.
 *   - Rate headers (X-MinLimit-Remaining, X-DayLimit-Remaining, Retry-After)
 *     are read from live responses and slow the pacer before Xero has to
 *     reject anything.
 *   - Staging batches per page on a small pool: the analytical database runs
 *     near its connection ceiling, so this never widens it.
 *
 * Usage:
 *   npx tsx scripts/xero-full-ingest.mts --ingest
 *   npx tsx scripts/xero-full-ingest.mts --ingest --only=xero_invoices,xero_contacts
 *   npx tsx scripts/xero-full-ingest.mts --ingest --skip-optional
 *   npx tsx scripts/xero-full-ingest.mts --report
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Pool } from "pg";
import { ulid } from "ulid";

import { loadEncodedAes256Keyring } from "../packages/security/src/index.js";
import {
  makeNamespacedSourceKey,
  type ConnectorContext,
  type RawSourceRecord,
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
  XERO_SCAN_PLAN,
  type XeroSpecTable,
} from "../connectors/xero/scan-plan.js";
import {
  XERO_API_PROFILES,
  baseParams,
  endpointPath,
  extraParamPasses,
  fanOutAncestry,
  projectStreamRows,
  resolveFanOutIds,
  templatedParents,
  unwrapEnvelope,
} from "../connectors/xero/spec-sync.js";
import { XeroConnector } from "../connectors/xero/index.js";
import { xeroManifest } from "../connectors/xero/manifest.js";
import { XERO_STREAMS } from "../connectors/xero/streams.js";

const OUT_DIR = resolve("/private/tmp/claude-502/-Users-user-Documents-Albert/1916f64e-61ca-47dd-849a-b19038f43140/scratchpad/xero/run");
const STATE_FILE = resolve(OUT_DIR, "ingest-state.json");
/**
 * Parents already fetched, per fan-out family. Without this every window
 * restarts each family from its first parent, so a family larger than one
 * window's budget can never finish however many times it runs.
 */
const FANOUT_PROGRESS_FILE = resolve(OUT_DIR, "fanout-progress.json");

function loadFanOutProgress(): Map<string, Set<string>> {
  try {
    const raw = JSON.parse(readFileSync(FANOUT_PROGRESS_FILE, "utf8")) as Record<string, string[]>;
    return new Map(Object.entries(raw).map(([key, ids]) => [key, new Set(ids)]));
  } catch {
    return new Map();
  }
}

function saveFanOutProgress(progressByFamily: ReadonlyMap<string, Set<string>>): void {
  try {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(FANOUT_PROGRESS_FILE, JSON.stringify(
      Object.fromEntries([...progressByFamily].map(([key, ids]) => [key, [...ids]])),
    ));
  } catch { /* best effort */ }
}

/* ------------------------------------------------------------------ */
/* Environment                                                         */
/* ------------------------------------------------------------------ */

function loadEnv(): Record<string, string> {
  const out: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const file of [".env.local"]) {
    let text: string;
    try { text = readFileSync(resolve(file), "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/u.exec(line);
      if (!match) continue;
      let value = match[2]!;
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      out[match[1]!] = value;
    }
  }
  return out;
}

function required(env: Record<string, string>, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

const cleanUrl = (value: string): string => value.trim().replace(/^"|"$/gu, "");

function progress(payload: Readonly<Record<string, unknown>>): void {
  const line = JSON.stringify({ at: new Date().toISOString(), ...payload });
  console.log(line);
  try {
    mkdirSync(OUT_DIR, { recursive: true });
    appendFileSync(resolve(OUT_DIR, "ingest-live.log"), `${line}\n`, "utf8");
  } catch { /* best effort */ }
}

/* ------------------------------------------------------------------ */
/* Rate pacing                                                         */
/* ------------------------------------------------------------------ */

/**
 * Xero publishes 60 calls/minute and 5 concurrent per organisation. The pacer
 * keeps a rolling minute window slightly under the published ceiling and backs
 * off from the vendor's own remaining-budget headers, so the run never spends
 * its daily allowance on rejected calls.
 */
class XeroPacer {
  private readonly times: number[] = [];
  private waitUntil = 0;
  private minuteLimit = 55;
  requests = 0;
  throttles = 0;
  dayRemaining: number | null = null;

  async take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      if (now < this.waitUntil) {
        await sleep(this.waitUntil - now);
        continue;
      }
      while (this.times.length > 0 && now - this.times[0]! > 60_000) this.times.shift();
      if (this.times.length < this.minuteLimit) {
        this.times.push(now);
        this.requests += 1;
        return;
      }
      await sleep(Math.max(250, 60_000 - (now - this.times[0]!) + 50));
    }
  }

  observe(response: Response): void {
    // A header that is absent reads as null, and Number(null) is 0 — treating
    // that as "retry after 0 seconds" would make every successful response look
    // like a throttle. Only react to headers the vendor actually sent.
    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfter = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
    if (response.status === 429) {
      this.throttles += 1;
      const seconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 5;
      this.waitUntil = Math.max(this.waitUntil, Date.now() + seconds * 1_000);
    }
    const minuteHeader = response.headers.get("x-minlimit-remaining");
    const minuteRemaining = minuteHeader === null ? Number.NaN : Number(minuteHeader);
    if (Number.isFinite(minuteRemaining) && minuteRemaining <= 3) {
      this.waitUntil = Math.max(this.waitUntil, Date.now() + 5_000);
    }
    const dayHeader = response.headers.get("x-daylimit-remaining");
    const dayRemaining = dayHeader === null ? Number.NaN : Number(dayHeader);
    if (Number.isFinite(dayRemaining)) this.dayRemaining = dayRemaining;
  }
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/* ------------------------------------------------------------------ */
/* Staging                                                             */
/* ------------------------------------------------------------------ */


/** The `{Endpoint}` segment a templated fan-out path was issued against. */
function parentEndpointOf(path: string): string {
  const segments = path.split("/").filter(Boolean);
  const index = segments.findIndex((segment) => /^[0-9a-f-]{8,}$/iu.test(segment));
  return index > 0 ? segments[index - 1]! : segments[segments.length - 2] ?? "";
}

function hashPayload(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

type Ids = Readonly<{ tenantId: string; connectionId: string; accountId: string }>;

async function stageRecords(
  pool: Pool,
  ids: Ids,
  stream: string,
  records: readonly RawSourceRecord[],
): Promise<Readonly<{ staged: number; quarantined: number; issue?: string }>> {
  if (records.length === 0) return { staged: 0, quarantined: 0 };
  const client = await pool.connect();
  try {
    const syncRunId = ulid();
    const batchId = ulid();
    const mappingVersion = xeroManifest.packVersion;
    await client.query(
      `insert into ingestion.batch_manifests (
         tenant_id, batch_id, connection_id, sync_run_id, connector_key,
         connector_version, api_version, stream, external_account_reference,
         extracted_at, cursor_start, cursor_end, content_hash,
         schema_fingerprint, record_count, compressed_bytes, object_keys
       ) values (
         $1,$2,$3,$4,'xero',$5,$6,$7,$8, now(), '{}'::jsonb, '{}'::jsonb,
         $9, $10, $11, 0, $12::text[]
       ) on conflict (tenant_id, batch_id) do nothing`,
      [
        ids.tenantId, batchId, ids.connectionId, syncRunId,
        xeroManifest.packVersion, xeroManifest.apiVersion, stream, ids.accountId,
        hashPayload({ stream, batchId, count: records.length }),
        hashPayload({ connector: "xero", stream, packVersion: xeroManifest.packVersion }),
        records.length,
        [`inline:xero:${stream}:${batchId}`],
      ],
    );

    const queryClient = {
      query: async <Row extends Record<string, unknown> = Record<string, unknown>>(
        sql: string, values: readonly unknown[] = [],
      ) => {
        const result = await client.query(sql, [...values]);
        return { rows: result.rows as Row[] };
      },
    };

    let quarantined = 0;
    let issue: string | undefined;
    const prepared: TypedStagingRecord[] = [];
    for (const record of records) {
      if (!record.normalized) { quarantined += 1; issue ??= "no normalized projection"; continue; }
      const typed = prepareTypedStaging("xero", stream, record.normalized);
      if (typed.issues.length > 0) {
        quarantined += 1;
        issue ??= JSON.stringify(typed.issues.slice(0, 3));
        continue;
      }
      prepared.push({
        contract: typed.contract,
        tenantId: ids.tenantId,
        namespacedSourceKey: makeNamespacedSourceKey(
          "xero", ids.accountId, record.sourceObjectType, record.sourceRecordId,
        ),
        connectionId: ids.connectionId,
        externalAccountReference: ids.accountId,
        sourceRecordId: record.sourceRecordId,
        sourceVersion: record.sourceUpdatedAt ?? record.payloadHash,
        sourceUpdatedAt: record.sourceUpdatedAt ?? null,
        payloadHash: record.payloadHash,
        payloadBatchId: batchId,
        syncRunId,
        tombstone: record.normalized.tombstone === true,
        mappingVersion,
        values: typed.values,
      });
    }
    // Postgres refuses an ON CONFLICT DO UPDATE that touches one row twice, so a
    // single duplicated key would abort the entire batch and stage nothing —
    // which is exactly how the history fan-out lost all 1,162 of its rows. Keep
    // the last write per identity and record that it happened.
    const byIdentity = new Map<string, TypedStagingRecord>();
    for (const record of prepared) byIdentity.set(record.namespacedSourceKey, record);
    const deduped = [...byIdentity.values()];
    const collapsed = prepared.length - deduped.length;
    if (collapsed > 0) issue ??= `${collapsed} rows shared an identity within one batch`;

    await upsertTypedStagingRecords(queryClient, deduped, { fastConflict: "overwrite" });
    return { staged: deduped.length, quarantined, ...(issue ? { issue } : {}) };
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------------ */
/* Run                                                                 */
/* ------------------------------------------------------------------ */

type StreamOutcome = Readonly<{
  stream: string;
  pages: number;
  records: number;
  staged: number;
  quarantined: number;
  status: "complete" | "partial" | "unavailable" | "failed";
  detail?: string;
}>;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const env = loadEnv();
  const flag = (name: string): string | undefined => {
    const prefix = `${name}=`;
    return argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
  };
  const positive = (raw: string | undefined, fallback: number, name: string): number => {
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${name} must be a positive number, got "${raw}"`);
    }
    return value;
  };
  const KNOWN = ["--ingest", "--report", "--skip-fanouts", "--include-history"];
  const unknown = argv.filter((a) => !KNOWN.includes(a) && !/^--(only|reserve|max-per-fanout|min-budget|probe-parents)=/u.test(a));
  if (unknown.length > 0) {
    throw new Error(`Unknown option(s): ${unknown.join(", ")}. A typo must never be read as "ingest everything".`);
  }
  if (!argv.includes("--ingest") && !argv.includes("--report")) {
    throw new Error("Specify --ingest to pull, or --report for a read-only summary.");
  }
  const onlyArg = flag("--only");
  const only = onlyArg ? new Set(onlyArg.split(",").map((s) => s.trim())) : null;
  const skipFanOuts = argv.includes("--skip-fanouts");
  const reportOnly = argv.includes("--report") && !argv.includes("--ingest");
  // Leave headroom so the account keeps a working API budget after the run.
  const reserve = positive(flag("--reserve"), 40, "--reserve");
  // History has no "do I have any" flag, so it costs one request per parent.
  // Without a per-family cap the first family eats the whole day and every
  // later one reports nothing — a cap spreads the budget across all of them.
  const maxPerFanOut = positive(flag("--max-per-fanout"), 120, "--max-per-fanout");
  // A retry against an unrefilled budget should cost one call and stop, not
  // crawl every stream discovering the same exhaustion 197 times.
  const minBudget = positive(flag("--min-budget"), 1, "--min-budget") - 1;
  // History costs one call per document — 35,593 of them for this tenant, or
  // roughly five weeks of the account's entire API allowance, during which no
  // other sync could run. It is an audit trail (who changed what, when), not
  // accounting substance, so it is opt-in rather than a default that quietly
  // consumes the budget forever.
  const includeHistory = argv.includes("--include-history");
  // How many parents to spend before concluding a fan-out family returns
  // nothing for this organisation. Cheap insurance: CIS settings are UK-only,
  // and probing 400 AU contacts for them costs a third of the daily budget.
  const PROBE_PARENTS = positive(flag("--probe-parents"), 20, "--probe-parents");

  if (reportOnly) {
    // Read-only by construction: no vendor call, no staging write. The previous
    // build documented --report but never parsed it, so it performed a full
    // live pull of the account instead.
    try {
      const state = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Record<string, unknown>;
      progress({ event: "report", ...state, outcomes: undefined });
    } catch {
      progress({ event: "report", detail: "no run state recorded yet" });
    }
    return;
  }

  const controlUrl = cleanUrl(required(env, "CONTROL_PLANE_ADMIN_DATABASE_URL"));
  const analyticalUrl = cleanUrl(required(env, "ANALYTICAL_ADMIN_DATABASE_URL"));

  const controlDb = new PgTransactionalDatabase(controlUrl, {
    applicationName: "albert-xero-full-ingest",
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
    controlDb,
    new EnvelopeCryptography(new AesKeyringWrapper({
      currentKeyReference: "env:TOKEN_ENCRYPTION_KEY",
      currentKeyVersion: keyring.currentKeyId,
      encodedKeys: keyring.keys,
    })),
  );

  const connection = await controlDb.query<{
    tenant_id: string; connection_id: string; external_account_reference: string;
  }>(
    `select tenant_id, connection_id, external_account_reference
       from control_plane.connections
      where connector_key = 'xero' and status in ('connected','degraded')
      order by created_at desc limit 1`,
  );
  const row = connection.rows[0];
  if (!row) throw new Error("No connected Xero connection");
  const ids: Ids = {
    tenantId: row.tenant_id,
    connectionId: row.connection_id,
    accountId: row.external_account_reference,
  };
  const refRows = await controlDb.query<{ secret_reference: string }>(
    `select secret_reference from control_plane.oauth_token_refs
      where connection_id = $1 order by updated_at desc limit 1`,
    [ids.connectionId],
  );
  const credentialRef = refRows.rows[0]?.secret_reference;
  if (!credentialRef) throw new Error("No oauth token ref for the Xero connection");

  const pacer = new XeroPacer();
  const connector = new XeroConnector({
    clientId: required(env, "XERO_CLIENT_ID"),
    oauthMode: "pkce",
    vault,
    fetcher: (async (input: RequestInfo | URL, init?: RequestInit) => {
      await pacer.take();
      const response = await fetch(input as never, init as never);
      pacer.observe(response);
      return response;
    }) as never,
  });
  const context: ConnectorContext = {
    tenantId: ids.tenantId,
    connectionId: ids.connectionId,
    credentialRef,
  };

  // The admin login is the documented path for a fixture/migration session:
  // core.current_tenant_id() accepts an explicit albert.tenant_id from a
  // migration-owner member, where the runtime ingest login is token-only.
  const pool = new Pool({
    connectionString: analyticalUrl,
    max: 4,
    application_name: "albert-xero-full-ingest",
    // The analytical database runs near its connection ceiling. Without these
    // an exhausted pool blocks forever with no output — a hang that looks
    // exactly like a slow endpoint.
    connectionTimeoutMillis: 30_000,
    idleTimeoutMillis: 10_000,
    statement_timeout: 120_000,
  });
  pool.on("connect", (client) => {
    void client.query("set role albert_migration_owner");
    void client.query("select set_config('albert.tenant_id', $1, false)", [ids.tenantId]);
  });

  // One access token for the whole run; the connector refreshes under a lease
  // when it expires, and we re-read it per walk from the vault.
  const accessToken = async (): Promise<string> => {
    const credential = await vault.read(credentialRef);
    const expiresAt = Date.parse(credential.secret.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt > Date.now() + 120_000) {
      return credential.secret.accessToken;
    }
    const refreshed = await connector.refresh_credentials(context);
    const latest = await vault.read(refreshed.credentialRef);
    return latest.secret.accessToken;
  };

  const streamById = new Map(XERO_STREAMS.map((stream) => [stream.id, stream]));
  const outcomes: StreamOutcome[] = [];
  const started = Date.now();
  const budgetLeft = () => (pacer.dayRemaining === null ? Infinity : pacer.dayRemaining - reserve);

  /** Fetch one JSON body, with the tenant header and the run's access token. */
  const getJson = async (path: string, params: Readonly<Record<string, string>>): Promise<unknown> => {
    const url = new URL(path, "https://api.xero.com");
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const token = await accessToken();
    await pacer.take();
    // A hung TLS connection would otherwise stall the whole backfill silently.
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${token}`,
        "xero-tenant-id": ids.accountId,
      },
      signal: AbortSignal.timeout(60_000),
    });
    pacer.observe(response);
    if (response.status === 304) return {};
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const error = new Error(`HTTP ${response.status} ${path} ${detail.slice(0, 160)}`);
      (error as { status?: number }).status = response.status;
      throw error;
    }
    return await response.json();
  };

  /* ---------- phase 1: one walk per endpoint, every table projected ---------- */
  // UK and NZ payroll share one base path, and a tenant has exactly one payroll
  // region. Without this gate the same payload stages into all three regions'
  // tables — three copies of one truth, two of them lies.
  const organisation = await getJson("/api.xro/2.0/Organisation", {});
  const orgCountry = (() => {
    const list = (organisation as { Organisations?: readonly Record<string, unknown>[] }).Organisations;
    const value = list?.[0]?.CountryCode;
    return typeof value === "string" ? value.toUpperCase() : null;
  })();
  const organisationId = (() => {
    const list = (organisation as { Organisations?: readonly Record<string, unknown>[] }).Organisations;
    const value = list?.[0]?.OrganisationID;
    return typeof value === "string" ? value : null;
  })();
  const payrollRegion = orgCountry === "AU" ? "payroll_au"
    : orgCountry === "NZ" ? "payroll_nz"
    : orgCountry === "GB" ? "payroll_uk"
    : null;
  progress({
    event: "region", country: orgCountry, payroll: payrollRegion ?? "none",
    dayRemaining: pacer.dayRemaining,
  });
  if (minBudget > 0 && pacer.dayRemaining !== null && pacer.dayRemaining < minBudget) {
    progress({
      event: "deferred",
      reason: "daily request budget has not refilled",
      dayRemaining: pacer.dayRemaining,
      required: minBudget,
    });
    await pool.end();
    return;
  }

  const inRegion = (api: string): boolean =>
    !api.startsWith("payroll_") || api === payrollRegion;

  const groups = XERO_SCAN_PLAN.groups
    .filter((group) => inRegion(group.leader.source.api))
    .filter((group) => (only ? group.members.some((member) => only.has(member.table.id)) : true));
  const parentCache = new Map<string, readonly unknown[]>();

  progress({
    event: "start", tenant: ids.accountId,
    groups: groups.length,
    fanOuts: skipFanOuts ? 0 : XERO_SCAN_PLAN.fanOuts.length,
    tables: XERO_SPEC_TABLE_COUNT,
  });

  for (const group of groups) {
    const leader = group.leader;
    const profile = XERO_API_PROFILES[leader.source.api];
    const passes = extraParamPasses(leader, new Date().toISOString());
    const passList = passes.length > 0 ? passes : [{}];
    // Parameters the scan chose are part of the row's identity (the 1099 year),
    // but never appear in the body.
    let walkSynthetics: Record<string, string> = {};
    const records: unknown[] = [];
    let pages = 0;
    let status: StreamOutcome["status"] = "complete";
    let detail: string | undefined;

    try {
      if (budgetLeft() <= 0) throw new Error("daily request budget reserved");
      for (const pass of passList) {
        let page = 1;
        for (;;) {
          const params: Record<string, string> = { ...baseParams(leader), ...pass };
          walkSynthetics = { ...pass };
          if (group.pagination === "page" && profile.pageParam) {
            params[profile.pageParam] = String(page);
            if (profile.pageSizeParam) params[profile.pageSizeParam] = String(profile.pageSize);
            if (profile.supportsOrder && group.modifiedField && leader.recordIdField) {
              params.order = `${group.modifiedField} ASC,${leader.recordIdField} ASC`;
            }
          } else if (group.pagination === "offset") {
            params.offset = String(highestJournalNumber(records));
          }
          let body: unknown;
          try {
            body = await getJson(endpointPath(leader), params);
          } catch (error) {
            // Not every endpoint accepts the ordering its stream declares —
            // Quotes rejects it as a QueryParseException. Ordering is an
            // optimisation for stable paging, never a correctness requirement,
            // so drop it and take the page rather than lose the whole table.
            const status = (error as { status?: number }).status;
            if (status === 400 && "order" in params) {
              const retryParams = { ...params };
              delete retryParams.order;
              body = await getJson(endpointPath(leader), retryParams);
            } else {
              throw error;
            }
          }
          pages += 1;
          const batch = unwrapEnvelope(body, leader);
          records.push(...batch);
          if (group.pagination === "none") break;
          if (batch.length === 0) break;
          if (group.pagination === "page" && batch.length < profile.pageSize && profile.pageSize > 1) break;
          page += 1;
          if (budgetLeft() <= 0) { status = "partial"; detail = "daily request budget reserved"; break; }
          if (pages > 400) { status = "partial"; detail = "page ceiling"; break; }
        }
        if (status === "partial") break;
      }
      parentCache.set(`${leader.source.api} ${leader.source.endpointOp}`, records);
    } catch (error) {
      const httpStatus = (error as { status?: number }).status;
      status = httpStatus === 403 || httpStatus === 404 ? "unavailable" : "failed";
      detail = error instanceof Error ? error.message.slice(0, 180) : String(error);
    }

    for (const member of group.members) {
      const table = member.table;
      if (only && !only.has(table.id)) continue;
      const stream = streamById.get(table.id);
      let staged = 0, quarantined = 0, projected = 0;
      try {
        const rows = projectStreamRows({
          table,
          leaderTable: leader,
          resource: group.resource,
          records,
          recordIdField: stream?.recordIdField ?? table.recordIdField ?? "",
          synthetics: { ...walkSynthetics, OrganisationID: organisationId },
        });
        projected = rows.length;
        const result = await stageRecords(pool, ids, table.id, rows);
        staged = result.staged;
        quarantined = result.quarantined;
        if (result.issue) detail = `quarantine: ${result.issue}`;
      } catch (error) {
        outcomes.push({
          stream: table.id, pages, records: projected, staged, quarantined,
          status: "failed", detail: error instanceof Error ? error.message.slice(0, 180) : String(error),
        });
        continue;
      }
      outcomes.push({ stream: table.id, pages, records: projected, staged, quarantined, status, detail });
    }
    progress({
      event: "group", endpoint: leader.source.endpointOp, api: leader.source.api,
      pages, fetched: records.length, tables: group.members.length,
      done: outcomes.length, requests: pacer.requests, dayRemaining: pacer.dayRemaining,
      elapsedSec: Math.round((Date.now() - started) / 1000), status,
    });
    writeState(outcomes, pacer, XERO_SPEC_TABLE_COUNT, started);
  }

  /* ---------- phase 2: fan-outs, parents served from the walk cache ---------- */
  const fanOutProgress = loadFanOutProgress();
  if (!skipFanOuts) {
    for (const fanOut of XERO_SCAN_PLAN.fanOuts) {
      if (!inRegion(fanOut.table.source.api)) continue;
      if (!includeHistory && /\/History$/u.test(fanOut.endpointOp)) {
        for (const table of [fanOut.table, ...fanOut.members.map((m) => m.table)]) {
          outcomes.push({
            stream: table.id, pages: 0, records: 0, staged: 0, quarantined: 0,
            status: "partial",
            detail: "history deferred: one call per document (35,593), opt in with --include-history",
          });
        }
        continue;
      }
      const targets = [fanOut.table, ...fanOut.members.map((member) => member.table)]
        .filter((table) => (only ? only.has(table.id) : true));
      if (targets.length === 0) continue;
      const rowsByTable = new Map<string, RawSourceRecord[]>();
      let requests = 0;
      let skipped = 0;
      let status: StreamOutcome["status"] = "complete";
      let detail: string | undefined;
      const familyKey = `${fanOut.table.source.api} ${fanOut.endpointOp}`;
      const alreadyDone = fanOutProgress.get(familyKey) ?? new Set<string>();
      const resumed = alreadyDone.size;

      try {
        let candidates: FanOutJob[] = [...fanOutJobs(fanOut, parentCache)];

        // Some sub-resources are only addressable through ids the parent's LIST
        // response omits: an AU pay run carries its Payslips only on its own
        // detail response. Without this hop nine payroll tables can never be
        // fetched at all. The harvested ids are cached, so the hop is paid for
        // once rather than every window.
        if (candidates.length === 0) {
          const ancestry = fanOutAncestry(fanOut);
          const rootTable = ancestry[0];
          const rootStream = rootTable ? XERO_STREAMS.find((x) => x.id === rootTable.id) : undefined;
          const parents = rootTable
            ? parentCache.get(`${rootTable.source.api} ${rootTable.source.endpointOp}`) ?? []
            : [];
          const idField = rootTable?.recordIdField ?? rootStream?.recordIdField ?? "";
          if (rootTable && parents.length > 0 && idField) {
            const harvestKey = `${familyKey}::harvested`;
            const harvested = fanOutProgress.get(harvestKey) ?? new Set<string>();
            const detailBase = endpointPath(rootTable);
            for (const parent of parents) {
              if (budgetLeft() <= 0) break;
              if (parent === null || typeof parent !== "object") continue;
              const parentId = String((parent as Record<string, unknown>)[idField] ?? "").trim();
              if (!parentId) continue;
              const probeKey = `detail:${parentId}`;
              if (harvested.has(probeKey)) continue;
              let detail: unknown;
              try {
                detail = await getJson(`${detailBase}/${encodeURIComponent(parentId)}`, {});
              } catch (error) {
                const httpStatus = (error as { status?: number }).status;
                if (httpStatus === 403 || httpStatus === 404) { harvested.add(probeKey); continue; }
                throw error;
              }
              harvested.add(probeKey);
              for (const record of unwrapEnvelope(detail, rootTable)) {
                for (const id of resolveFanOutIds(fanOut.fanOutParam, record, rootTable)) {
                  harvested.add(id);
                }
              }
              fanOutProgress.set(harvestKey, harvested);
            }
            saveFanOutProgress(fanOutProgress);
            const template = endpointPath(fanOut.table);
            const usesPath = template.includes(`{${fanOut.fanOutParam}}`);
            candidates = [...harvested]
              .filter((id) => !id.startsWith("detail:"))
              .map((id) => ({
                path: usesPath ? template.replace(`{${fanOut.fanOutParam}}`, encodeURIComponent(id)) : template,
                params: usesPath ? {} : { [fanOut.fanOutParam]: id },
                parent: {},
                parentTable: rootTable,
                parentId: id,
              }));
            if (candidates.length > 0) {
              progress({
                event: "fanout-harvested", endpoint: fanOut.endpointOp,
                ids: candidates.length, via: `${detailBase}/{${idField}}`,
              });
            }
          }
        }

        const allJobs = candidates.filter((job) => !alreadyDone.has(job.parentId));
        // Cap PER FAMILY. Slicing the concatenated list means the first family
        // consumes the whole allowance and later families are never requested
        // at all, while the report still claims the fan-out was covered.
        const perFamily = new Map<string, FanOutJob[]>();
        for (const job of allJobs) {
          const key = job.path.split("/").slice(0, 4).join("/");
          const bucket = perFamily.get(key) ?? [];
          if (bucket.length < maxPerFanOut) bucket.push(job);
          perFamily.set(key, bucket);
        }
        const jobs = [...perFamily.values()].flat();
        if (allJobs.length === 0 && resumed === 0) {
          status = "unavailable"; detail = "no reachable parents";
        } else if (allJobs.length === 0) {
          detail = `all ${resumed} parents already fetched in earlier runs`;
        }
        if (jobs.length < allJobs.length) {
          status = "partial";
          detail = `capped at ${jobs.length} of ${allJobs.length} parents`;
        }
        let issuedInFamily = 0;
        for (const job of jobs) {
          if (budgetLeft() <= 0) { status = "partial"; detail = "daily request budget reserved"; break; }
          issuedInFamily += 1;
          if (issuedInFamily > PROBE_PARENTS && resumed === 0) {
            const found = [...rowsByTable.values()].reduce((total, list) => total + list.length, 0);
            if (found === 0) {
              status = "unavailable";
              detail = `no rows from the first ${PROBE_PARENTS} parents — not applicable to this organisation`;
              progress({ event: "fanout-abandoned", endpoint: fanOut.endpointOp, probed: PROBE_PARENTS });
              break;
            }
          }
          if (issuedInFamily % 25 === 0) {
            progress({
              event: "fanout-progress", endpoint: fanOut.endpointOp,
              issued: issuedInFamily, of: jobs.length,
              rows: [...rowsByTable.values()].reduce((total, list) => total + list.length, 0),
              dayRemaining: pacer.dayRemaining,
            });
            writeState(outcomes, pacer, XERO_SPEC_TABLE_COUNT, started);
            saveFanOutProgress(fanOutProgress);
          }
          let body: unknown;
          try {
            body = await getJson(job.path, job.params);
            requests += 1;
          } catch (error) {
            const httpStatus = (error as { status?: number }).status;
            if (httpStatus === 403 || httpStatus === 404) {
              // A refusal is a settled answer for this parent: never pay for it
              // again on a later window.
              skipped += 1;
              alreadyDone.add(job.parentId);
              fanOutProgress.set(familyKey, alreadyDone);
              continue;
            }
            throw error;
          }
          alreadyDone.add(job.parentId);
          fanOutProgress.set(familyKey, alreadyDone);
          for (const table of targets) {
            const stream = streamById.get(table.id);
            const rows = projectStreamRows({
              table,
              leaderTable: fanOut.table,
              resource: stream?.resource ?? fanOut.table.source.envelope ?? table.id,
              records: unwrapEnvelope(body, fanOut.table),
              recordIdField: stream?.recordIdField ?? table.recordIdField ?? "",
              fanOutParent: { record: job.parent, table: job.parentTable },
              synthetics: {
                ...job.params,
                [fanOut.fanOutParam]: job.parentId,
                parentId: job.parentId,
                Guid: job.parentId,
                parentEndpoint: parentEndpointOf(job.path),
                Endpoint: parentEndpointOf(job.path),
                OrganisationID: organisationId,
              },
            });
            const bucket = rowsByTable.get(table.id) ?? [];
            bucket.push(...rows.map((record) => ({
              ...record,
              sourceRecordId: record.sourceRecordId.includes(":")
                ? record.sourceRecordId
                : `${job.parentId}:${record.sourceRecordId}`,
            })));
            rowsByTable.set(table.id, bucket);
          }
        }
      } catch (error) {
        status = "failed";
        detail = error instanceof Error ? error.message.slice(0, 180) : String(error);
      }

      if (skipped > 0 && requests > 0 && skipped === requests) {
        status = "unavailable";
        detail = `every one of ${skipped} parent sub-requests was refused (403/404)`;
      } else if (skipped > 0) {
        detail = `${detail ? `${detail}; ` : ""}${skipped} of ${requests} parent sub-requests refused`;
      }
      for (const table of targets) {
        const rows = rowsByTable.get(table.id) ?? [];
        let staged = 0, quarantined = 0;
        try {
          const result = await stageRecords(pool, ids, table.id, rows);
          staged = result.staged;
          quarantined = result.quarantined;
        } catch (error) {
          outcomes.push({ stream: table.id, pages: requests, records: rows.length, staged, quarantined,
            status: "failed", detail: error instanceof Error ? error.message.slice(0, 180) : String(error) });
          continue;
        }
        outcomes.push({ stream: table.id, pages: requests, records: rows.length, staged, quarantined, status, detail });
      }
      saveFanOutProgress(fanOutProgress);
      progress({
        event: "fanout", endpoint: fanOut.endpointOp, requests, resumed,
        tables: targets.length, done: outcomes.length,
        totalRequests: pacer.requests, dayRemaining: pacer.dayRemaining,
        elapsedSec: Math.round((Date.now() - started) / 1000), status,
      });
      writeState(outcomes, pacer, XERO_SPEC_TABLE_COUNT, started);
    }
  }

  writeState(outcomes, pacer, XERO_SPEC_TABLE_COUNT, started);
  progress({
    event: "done",
    tables: outcomes.length,
    complete: outcomes.filter((o) => o.status === "complete").length,
    partial: outcomes.filter((o) => o.status === "partial").length,
    unavailable: outcomes.filter((o) => o.status === "unavailable").length,
    failed: outcomes.filter((o) => o.status === "failed").length,
    records: outcomes.reduce((total, o) => total + o.records, 0),
    staged: outcomes.reduce((total, o) => total + o.staged, 0),
    quarantined: outcomes.reduce((total, o) => total + o.quarantined, 0),
    requests: pacer.requests, throttles: pacer.throttles,
    dayRemaining: pacer.dayRemaining,
    elapsedSec: Math.round((Date.now() - started) / 1000),
  });
  await pool.end();
}

const XERO_SPEC_TABLE_COUNT = XERO_STREAMS.length;

/** Highest JournalNumber seen so far — the Journals feed's offset cursor. */
function highestJournalNumber(records: readonly unknown[]): number {
  let highest = 0;
  for (const record of records) {
    if (record === null || typeof record !== "object") continue;
    const value = Number((record as Record<string, unknown>).JournalNumber);
    if (Number.isSafeInteger(value) && value > highest) highest = value;
  }
  return highest;
}

type FanOutJob = Readonly<{
  path: string;
  params: Readonly<Record<string, string>>;
  parent: unknown;
  parentTable: XeroSpecTable;
  parentId: string;
}>;

/**
 * Sub-requests for a fan-out, with parents taken from the walk cache rather
 * than re-fetched. Under a 1,000-call daily budget, re-walking a parent to
 * discover ids the run already holds is the difference between finishing and
 * running out.
 */
function fanOutJobs(
  fanOut: (typeof XERO_SCAN_PLAN)["fanOuts"][number],
  cache: ReadonlyMap<string, readonly unknown[]>,
): readonly FanOutJob[] {
  const jobs: FanOutJob[] = [];
  const templated = templatedParents(fanOut);
  const families = templated
    ? templated.map((parent) => ({ endpointOp: parent.endpointOp, template: parent.pathTemplate, idParam: parent.idParam }))
    : null;

  if (families) {
    const isAttachments = /\/Attachments$/u.test(fanOut.endpointOp);
    for (const family of families) {
      const parents = cache.get(`accounting ${family.endpointOp}`) ?? [];
      const parentTable = XERO_SCAN_PLAN.groups.find(
        (group) => group.api === "accounting" && group.endpointOp === family.endpointOp,
      )?.leader;
      if (!parentTable) continue;
      for (const parent of parents) {
        if (parent === null || typeof parent !== "object") continue;
        const record = parent as Record<string, unknown>;
        if (isAttachments && record.HasAttachments === false) continue;
        const id = record[family.idParam];
        const text = id === null || id === undefined ? "" : String(id).trim();
        if (!text) continue;
        jobs.push({
          path: `/api.xro/2.0${family.template.replace(`{${family.idParam}}`, encodeURIComponent(text))}`,
          params: {},
          parent,
          parentTable,
          parentId: text,
        });
      }
    }
    return jobs;
  }

  const ancestry = fanOutAncestry(fanOut);
  const rootTable = ancestry[0];
  if (!rootTable || ancestry.length < 2) return jobs;
  const parents = cache.get(`${rootTable.source.api} ${rootTable.source.endpointOp}`) ?? [];
  const template = endpointPath(fanOut.table);
  const param = fanOut.fanOutParam;
  const usesPathParam = template.includes(`{${param}}`);
  for (const parent of parents) {
    if (parent === null || typeof parent !== "object") continue;
    // Resolve through the shared chain so a parent that names its id
    // differently is fetched rather than silently skipped.
    for (const id of resolveFanOutIds(param, parent, rootTable)) {
      jobs.push(
        usesPathParam
          ? {
              path: template.replace(`{${param}}`, encodeURIComponent(id)),
              params: {},
              parent, parentTable: rootTable, parentId: id,
            }
          : { path: template, params: { [param]: id }, parent, parentTable: rootTable, parentId: id },
      );
    }
  }
  return jobs;
}

function writeState(
  outcomes: readonly StreamOutcome[],
  pacer: XeroPacer,
  total: number,
  started: number,
): void {
  try {
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify({
      updatedAt: new Date().toISOString(),
      total,
      done: outcomes.length,
      complete: outcomes.filter((o) => o.status === "complete").length,
      partial: outcomes.filter((o) => o.status === "partial").length,
      unavailable: outcomes.filter((o) => o.status === "unavailable").length,
      failed: outcomes.filter((o) => o.status === "failed").length,
      records: outcomes.reduce((sum, o) => sum + o.records, 0),
      staged: outcomes.reduce((sum, o) => sum + o.staged, 0),
      quarantined: outcomes.reduce((sum, o) => sum + o.quarantined, 0),
      requests: pacer.requests,
      throttles: pacer.throttles,
      dayRemaining: pacer.dayRemaining,
      elapsedSec: Math.round((Date.now() - started) / 1000),
      outcomes,
    }, null, 1));
  } catch { /* best effort */ }
}

main().catch((error) => {
  progress({ event: "fatal", error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
