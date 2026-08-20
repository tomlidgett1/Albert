/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * Albert V3 Cube configuration.
 *
 * The Lightspeed staging tables in Supabase carry FORCE ROW LEVEL SECURITY
 * whose policy calls ingestion.current_tenant_id(), which in turn verifies a
 * signed analytical capability held in the `albert.tenant_capability` GUC.
 * A plain Cube connection therefore sees zero rows.
 *
 * This config mirrors the trusted bridge pattern (cube-playground/bridge):
 *   1. Every request's security context must carry the authenticated
 *      either a running Albert turn or a claimed dashboard refresh lease.
 *   2. A custom Postgres driver issues a turn-bound capability from the
 *      control plane (`control_plane.issue_semantic_analytical_capability`)
 *      and applies `SET ROLE semantic_ro` plus the capability GUC on every
 *      pooled connection before Cube's generated SQL runs.
 *   3. Row-level security then enforces tenant isolation *inside Postgres*;
 *      queryRewrite additionally refuses requests with no tenant claim and
 *      pins a tenant_id filter as defence in depth.
 *
 * Env (see docker-compose env_file):
 *   ALBERT_SEMANTIC_READ_DATABASE_URL     analytical DB login with semantic_ro membership
 *   ALBERT_SEMANTIC_CONTROL_DATABASE_URL  control-plane login able to issue capabilities
 *   (falls back to ANALYTICAL_DATABASE_URL / CONTROL_PLANE_DATABASE_URL)
 */

const PostgresDriver = require('@cubejs-backend/postgres-driver');
const { CubejsServerCore } = require('@cubejs-backend/server-core');
const { Pool } = require('pg');
const { parse: parseConnectionString } = require('pg-connection-string');

const CAPABILITY_REFRESH_MS = 45_000;

/**
 * Orchestrator creation must be idempotent under concurrent first calls.
 *
 * Every Albert turn gets its own orchestrator (see contextToOrchestratorId),
 * so the first request of a turn always creates one. Cube's own
 * `CubejsServerCore.getOrchestratorApi` is check-then-set across awaits: two
 * calls for a *new* orchestrator id that land in the same tick both miss the
 * storage lookup and each build a full OrchestratorApi (query orchestrator,
 * cache, queue, driver pool); the second silently overwrites the first.
 * The API gateway does exactly that for `compareDateRange` (and `total`)
 * queries: `Promise.all` over the sub-queries, each calling `getAdapterApi`.
 *
 * With the in-memory queue driver both queue instances share one state
 * object (keyed by the queue prefix) but keep independent queue-id counters,
 * so their processing ids collide. The instance that lost the processing-lock
 * race believes it holds the lock (same id), frees it on "Skip processing",
 * and when the real execution finishes Cube drops the rows as an "Orphaned
 * execution result". The query then sits in `active` until the stalled-query
 * sweep (~2 min); every poll answers "Continue wait", Albert gives up at 90 s
 * and the owner sees "Unavailable". Reproduced on 2026-08-19: a fresh turn
 * whose first data query is a compareDateRange query never returns; the same
 * query on a warmed turn returns in ~1 s.
 *
 * The guard below serialises creation per orchestrator id: concurrent callers
 * await the same in-flight promise, and the storage lookup remains the fast
 * path for warmed turns. It patches the prototype before `cubejs server`
 * instantiates the core (cube.js is required first), and refuses to start if
 * the internals it relies on have moved, so a Cube upgrade cannot silently
 * reintroduce the race. Upstream: cube-js/cube, server-core getOrchestratorApi.
 */
function installIdempotentOrchestratorCreation(ServerCore) {
  const original = ServerCore && ServerCore.prototype && ServerCore.prototype.getOrchestratorApi;
  if (typeof original !== 'function') {
    throw new Error('Albert Cube config: CubejsServerCore.prototype.getOrchestratorApi is missing; the orchestrator idempotency guard cannot be installed.');
  }
  if (original.albertIdempotent) return;
  const source = Function.prototype.toString.call(original);
  if (!source.includes('this.orchestratorStorage') || !source.includes('this.contextToOrchestratorId')) {
    throw new Error('Albert Cube config: CubejsServerCore.getOrchestratorApi no longer uses orchestratorStorage/contextToOrchestratorId; review the orchestrator idempotency guard before upgrading Cube.');
  }
  // One pending-creation map per server core instance.
  const pendingByCore = new WeakMap();
  const patched = async function getOrchestratorApi(context) {
    if (!this.orchestratorStorage || typeof this.contextToOrchestratorId !== 'function') {
      throw new Error('Albert Cube config: server core lacks orchestratorStorage/contextToOrchestratorId; the orchestrator idempotency guard is unsound.');
    }
    const orchestratorId = await this.contextToOrchestratorId(context);
    if (this.orchestratorStorage.has(orchestratorId)) {
      return this.orchestratorStorage.get(orchestratorId);
    }
    let pending = pendingByCore.get(this);
    if (!pending) {
      pending = new Map();
      pendingByCore.set(this, pending);
    }
    let creation = pending.get(orchestratorId);
    if (!creation) {
      creation = Promise.resolve()
        .then(() => original.call(this, context))
        .finally(() => {
          if (pending.get(orchestratorId) === creation) pending.delete(orchestratorId);
        });
      pending.set(orchestratorId, creation);
    }
    return creation;
  };
  patched.albertIdempotent = true;
  ServerCore.prototype.getOrchestratorApi = patched;
}

installIdempotentOrchestratorCreation(CubejsServerCore);

function requiredEnv(names) {
  for (const name of names) {
    const value = process.env[name] && process.env[name].trim();
    if (value) return value;
  }
  throw new Error(`None of ${names.join(', ')} are configured for the Albert Cube driver.`);
}

function pgConfigFromUrl(url) {
  const parsed = parseConnectionString(url);
  const config = {
    host: parsed.host,
    port: parsed.port ? Number(parsed.port) : 5432,
    database: parsed.database,
    user: parsed.user,
    password: parsed.password,
  };
  // Supabase requires TLS; its certificate chain is not in the default store.
  if (parsed.ssl || /sslmode=(require|prefer|verify)/.test(url) || !/localhost|127\.0\.0\.1/.test(String(parsed.host))) {
    config.ssl = { rejectUnauthorized: false };
  }
  return config;
}

async function issueSemanticReadCapability({
  tenantId,
  conversationId,
  turnId,
  dashboardTileId,
  dashboardRefreshLeaseId,
}) {
  const controlUrl = requiredEnv([
    'ALBERT_SEMANTIC_CONTROL_DATABASE_URL',
    'CONTROL_PLANE_DATABASE_URL',
  ]);
  const pool = new Pool({
    ...pgConfigFromUrl(controlUrl),
    max: 1,
    connectionTimeoutMillis: 20_000,
    idleTimeoutMillis: 5_000,
    application_name: 'albert-cube-capability',
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE albert_semantic_control');
    const dashboardRefresh = dashboardTileId && dashboardRefreshLeaseId;
    const result = await client.query(
      dashboardRefresh
        ? `SELECT control_plane.issue_dashboard_analytical_capability(
             $1::text, $2::text, $3::text, 'semantic_read'::text
           ) AS capability`
        : `SELECT control_plane.issue_semantic_analytical_capability(
             $1::text, $2::text, $3::text, 'semantic_read'::text
           ) AS capability`,
      dashboardRefresh
        ? [tenantId, dashboardTileId, dashboardRefreshLeaseId]
        : [tenantId, conversationId, turnId],
    );
    const capability = result.rows[0] && result.rows[0].capability;
    if (typeof capability !== 'string' || capability.length < 100 || capability.length > 4096) {
      throw new Error('Control plane returned an invalid analytical capability.');
    }
    await client.query('COMMIT');
    return capability;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* keep original */ }
    throw error;
  } finally {
    client.release();
    await pool.end().catch(() => undefined);
  }
}

class CapabilityPostgresDriver extends PostgresDriver {
  constructor(options, albertContext) {
    super(options);
    this.albertContext = albertContext;
    this.capability = null;
    this.capabilityIssuedAt = 0;
    this.capabilityPromise = null;
  }

  async currentCapability() {
    const now = Date.now();
    if (this.capability && now - this.capabilityIssuedAt < CAPABILITY_REFRESH_MS) {
      return this.capability;
    }
    if (!this.capabilityPromise) {
      this.capabilityPromise = issueSemanticReadCapability(this.albertContext)
        .then((capability) => {
          this.capability = capability;
          this.capabilityIssuedAt = Date.now();
          this.capabilityPromise = null;
          return capability;
        })
        .catch((error) => {
          this.capabilityPromise = null;
          throw error;
        });
    }
    return this.capabilityPromise;
  }

  async prepareConnection(conn, options) {
    await super.prepareConnection(conn, options);
    const {
      tenantId,
      conversationId,
      turnId,
      dashboardTileId,
      dashboardRefreshLeaseId,
    } = this.albertContext;
    const conversationTurn = conversationId && turnId;
    const dashboardRefresh = dashboardTileId && dashboardRefreshLeaseId;
    if (!tenantId || (!conversationTurn && !dashboardRefresh)) {
      // Connection-health probes (SELECT 1) run without a security context;
      // any query against RLS-protected staging tables will fail in Postgres
      // with a clear "analytical capability" error rather than leaking rows.
      return;
    }
    const capability = await this.currentCapability();
    await conn.query('SET ROLE semantic_ro');
    await conn.query({
      text: "SELECT set_config('albert.tenant_capability', $1, false)",
      values: [capability],
    });
  }
}

function albertContextFrom(securityContext) {
  const context = securityContext || {};
  return {
    tenantId: typeof context.tenant_id === 'string' ? context.tenant_id : null,
    conversationId: typeof context.conversation_id === 'string' ? context.conversation_id : null,
    turnId: typeof context.turn_id === 'string' ? context.turn_id : null,
    dashboardTileId: typeof context.dashboard_tile_id === 'string' ? context.dashboard_tile_id : null,
    dashboardRefreshLeaseId: typeof context.dashboard_refresh_lease_id === 'string'
      ? context.dashboard_refresh_lease_id
      : null,
  };
}

/** The first member's cube (or view) name, used to pin the tenant filter. */
function rootCubeOf(query) {
  const members = []
    .concat(query.measures || [])
    .concat(query.dimensions || [])
    .concat((query.timeDimensions || []).map((t) => t.dimension))
    .concat(query.segments || [])
    .concat((query.filters || []).map((f) => f.member || f.dimension).filter(Boolean));
  for (const member of members) {
    if (typeof member === 'string' && member.includes('.')) {
      return member.split('.')[0];
    }
  }
  return null;
}

module.exports = {
  // Cube API scopes are selected by this hook rather than by a JWT `scope`
  // claim automatically. Restrict the release-only token to precisely the two
  // documented endpoints it proves while preserving the established default
  // scopes for all ordinary signed clients.
  contextToApiScopes: (securityContext, defaultScopes) => {
    if (securityContext?.albert_release_smoke !== true) return defaultScopes;
    const requested = securityContext.scope;
    if (!Array.isArray(requested) || requested.length !== 2 ||
        !requested.includes('meta') || !requested.includes('data')) {
      return [];
    }
    return ['meta', 'data'];
  },

  // One compiled data model and one cache namespace per tenant.
  contextToAppId: ({ securityContext }) => {
    const { tenantId } = albertContextFrom(securityContext);
    return `CUBEJS_APP_${tenantId || 'anonymous'}`;
  },

  // Each live turn or dashboard refresh lease gets a distinct driver whose
  // pooled connections carry only that execution's capability.
  contextToOrchestratorId: ({ securityContext }) => {
    const { tenantId, turnId, dashboardRefreshLeaseId } = albertContextFrom(securityContext);
    return `CUBEJS_APP_${tenantId || 'anonymous'}_${turnId || dashboardRefreshLeaseId || 'no-execution'}`;
  },

  driverFactory: ({ securityContext }) => {
    const readUrl = requiredEnv([
      'ALBERT_SEMANTIC_READ_DATABASE_URL',
      'ANALYTICAL_DATABASE_URL',
    ]);
    return new CapabilityPostgresDriver(
      {
        ...pgConfigFromUrl(readUrl),
        max: 4,
        application_name: 'albert-cube-v3',
        // Postgres session time zone for every Cube connection. Cube 1.7.16
        // converts a view's raw `time` dimension to the query time zone
        // TWICE: `((col::timestamptz AT TIME ZONE tz)::timestamptz AT TIME
        // ZONE tz)`. With the default UTC session the inner naive local time
        // is re-read as UTC, so 10:00 Melbourne came out as 20:00 (a roster
        // shift read as "8 pm to 4 am", an invoice due date as 8 pm) and
        // DATE columns as T20:00. Pinning the session to the business time
        // zone makes the second conversion idempotent: naive local ->
        // timestamptz in the same zone -> the same local time. Granularity
        // time dimensions, date-range parameters (sent as UTC instants) and
        // measures are unaffected; CURRENT_DATE becomes the local date, which
        // is what "overdue" should mean. Revisit when Cube fixes view
        // conversion or tenants span time zones.
        storeTimezone: process.env.ALBERT_CUBE_SESSION_TIMEZONE || 'Australia/Melbourne',
      },
      albertContextFrom(securityContext),
    );
  },

  queryRewrite: (query, { securityContext }) => {
    const {
      tenantId,
      conversationId,
      turnId,
      dashboardTileId,
      dashboardRefreshLeaseId,
    } = albertContextFrom(securityContext);
    const conversationTurn = conversationId && turnId;
    const dashboardRefresh = dashboardTileId && dashboardRefreshLeaseId;
    if (!tenantId || (!conversationTurn && !dashboardRefresh)) {
      throw new Error(
        'Albert Cube queries require an authenticated turn or dashboard refresh lease.',
      );
    }
    // Defence in depth. Row-level security (capability-scoped) is the
    // authoritative isolation; this pin makes the intent explicit in SQL and
    // keys Cube's query cache on the tenant filter as well.
    const root = rootCubeOf(query);
    if (root) {
      query.filters = [
        ...(query.filters || []),
        { member: `${root}.tenant_id`, operator: 'equals', values: [tenantId] },
      ];
    }
    return query;
  },
};
