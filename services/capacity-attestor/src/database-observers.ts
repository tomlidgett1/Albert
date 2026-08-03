import type { CapacityAttestationRequest } from "./contracts.js";

type Row = Readonly<Record<string, unknown>>;

export interface CapacityPgClient {
  query(sql: string, parameters?: readonly unknown[]): Promise<Readonly<{ rows: readonly Row[] }>>;
  release(): void;
}

export interface CapacityPgPool {
  connect(): Promise<CapacityPgClient>;
  end?(): Promise<void>;
}

export type DatabasePressureSample = Readonly<{
  maxConnections: number;
  connections: number;
  lockWaiters: number;
  deadlocks: number;
}>;

export type ControlCapacitySample = Readonly<{
  observedAt: string;
  maintenanceDue: number;
  activeMaintenanceLeases: number;
  transformQueueDepth: number;
  oldestVisibleJobAgeSeconds: number;
  completedClaims: number;
  participantCount: number;
  pressure: DatabasePressureSample;
}>;

export type CapacityParticipant = Readonly<{
  participantId: string;
  workerId: string;
  releaseSha: string;
  completedClaims: number;
  controlPoolAcquireP95Ms: number;
  analyticalPoolAcquireP95Ms: number;
  errorCount: number;
}>;

export type ControlRunDetail = Readonly<{
  completedClaims: number;
  distinctTenants: number;
  p95TenantMs: number;
  p99TenantMs: number;
  startedAt: string;
  completedAt: string;
  participants: readonly CapacityParticipant[];
  workload: Readonly<{
    completedTenants: number;
    sourceRows: Readonly<{ p50: number; p95: number; max: number }>;
    canonicalRows: Readonly<{ p50: number; p95: number; max: number }>;
    strata: readonly Readonly<{ id: "micro" | "small" | "medium"; minRows: number; maxRows: number | null; count: number }>[];
    corpusFingerprint: string;
  }>;
}>;

const PRESSURE_SQL = `
  select current_user as login,
         current_setting('max_connections')::integer as max_connections,
         (select count(*) from pg_catalog.pg_stat_activity where datname=current_database())::integer as connections,
         (select count(*) from pg_catalog.pg_stat_activity
           where datname=current_database() and wait_event_type='Lock')::integer as lock_waiters,
         coalesce((select deadlocks from pg_catalog.pg_stat_database where datname=current_database()),0)::bigint as deadlocks`;

export class PostgresCapacityControlObserver {
  constructor(
    private readonly pool: CapacityPgPool,
    private readonly expectedLogin = "albert_capacity_control_observer",
    private readonly clock: () => number = Date.now,
  ) {}

  async ready(): Promise<boolean> {
    try {
      return await this.read(async (client) => {
        const result = await client.query(`
          select current_user=$1
                   and not role.rolsuper and not role.rolcreatedb and not role.rolcreaterole
                   and not role.rolreplication and not role.rolbypassrls and not role.rolinherit
                   and not exists(
                     select 1 from pg_catalog.pg_auth_members membership
                      where membership.member=role.oid
                   )
                   and has_table_privilege(current_user,'control_plane.tenants','select')
                   and has_table_privilege(current_user,'control_plane.connections','select')
                   and has_table_privilege(current_user,'control_plane.deletion_requests','select')
                   and has_table_privilege(current_user,'control_plane.canonical_transform_jobs','select')
                   and has_table_privilege(current_user,'control_plane.transform_maintenance_leases','select')
                   and has_table_privilege(current_user,'control_plane.transform_capacity_participant_observations','select')
                   and has_table_privilege(current_user,'control_plane.pipeline_stats','select')
                   and not has_table_privilege(current_user,'control_plane.tenants','insert')
                   and not has_table_privilege(current_user,'control_plane.tenants','update')
                   and not has_table_privilege(current_user,'control_plane.tenants','delete')
                   as ready
            from pg_catalog.pg_roles role where role.rolname=current_user`, [this.expectedLogin]);
        return result.rows[0]?.ready === true;
      });
    } catch {
      return false;
    }
  }

  async sample(request: CapacityAttestationRequest): Promise<ControlCapacitySample> {
    return this.read(async (client) => {
      const workerPrefix = `capacity:${request.capacityRunId}:%`;
      const result = await client.query(`
        with due as (
          select count(*)::integer as count
            from control_plane.tenants tenant
           where tenant.status='active'
             and exists(select 1 from control_plane.connections connection
                         where connection.tenant_id=tenant.tenant_id
                           and connection.status in ('connected','degraded'))
             and not exists(select 1 from control_plane.deletion_requests request
                             where request.tenant_id=tenant.tenant_id
                               and request.status in ('queued','running','retry_wait','verifying','failed'))
             and not exists(select 1 from control_plane.transform_maintenance_leases recent
                             where recent.tenant_id=tenant.tenant_id
                               and recent.purpose='pipeline_snapshot'
                               and (recent.expires_at>statement_timestamp()
                                    or recent.completed_at>statement_timestamp()-interval '50 minutes'))
        ), leases as (
          select count(*) filter(where completed_at is null and expires_at>statement_timestamp())::integer as active,
                 count(*) filter(where worker_id like $1 escape '\\' and completed_at is not null)::integer as completed
            from control_plane.transform_maintenance_leases
        ), queue as (
          select count(*) filter(where status in ('queued','retry_wait'))::integer as depth,
                 coalesce(extract(epoch from statement_timestamp()-min(created_at)
                   filter(where status in ('queued','retry_wait'))),0)::integer as oldest
            from control_plane.canonical_transform_jobs
        ), participants as (
          select count(*)::integer as count
            from control_plane.transform_capacity_participant_observations
           where run_id=$2 and release_sha=$3
        )
        select due.count as maintenance_due,leases.active,leases.completed,
               queue.depth,queue.oldest,participants.count as participant_count
          from due cross join leases cross join queue cross join participants`,
      [workerPrefix, request.capacityRunId, request.candidateSha]);
      const pressure = await this.pressure(client);
      const row = one(result.rows, "capacity control sample");
      return Object.freeze({
        observedAt: new Date(this.clock()).toISOString(),
        maintenanceDue: nonnegative(row.maintenance_due, "maintenance due"),
        activeMaintenanceLeases: nonnegative(row.active, "active maintenance leases"),
        transformQueueDepth: nonnegative(row.depth, "transform queue depth"),
        oldestVisibleJobAgeSeconds: nonnegative(row.oldest, "oldest transform job"),
        completedClaims: nonnegative(row.completed, "completed claims"),
        participantCount: nonnegative(row.participant_count, "participant count"),
        pressure,
      });
    });
  }

  async detail(request: CapacityAttestationRequest): Promise<ControlRunDetail> {
    return this.read(async (client) => {
      const prefix = `capacity:${request.capacityRunId}:%`;
      const leaseResult = await client.query(`
        select count(*)::integer as completed_claims,
               count(distinct tenant_id)::integer as distinct_tenants,
               coalesce(percentile_cont(0.95) within group(
                 order by extract(epoch from (completed_at-claimed_at))*1000),0)::numeric as p95_ms,
               coalesce(percentile_cont(0.99) within group(
                 order by extract(epoch from (completed_at-claimed_at))*1000),0)::numeric as p99_ms,
               min(claimed_at) as started_at,max(completed_at) as completed_at
          from control_plane.transform_maintenance_leases
         where worker_id like $1 escape '\\' and completed_at is not null`, [prefix]);
      const participantResult = await client.query(`
        select participant_id,worker_id,release_sha,completed_claims,
               control_pool_acquire_p95_ms,analytical_pool_acquire_p95_ms,error_count
          from control_plane.transform_capacity_participant_observations
         where run_id=$1 order by participant_id`, [request.capacityRunId]);
      const workloadResult = await client.query(`
        with completed as (
          select distinct tenant_id
            from control_plane.transform_maintenance_leases
           where worker_id like $1 escape '\\' and completed_at is not null
        ), latest_snapshot as (
          select completed.tenant_id,max(stat.snapshot_at) as snapshot_at
            from completed join control_plane.pipeline_stats stat using(tenant_id)
           group by completed.tenant_id
        ), volume as (
          select latest_snapshot.tenant_id,
                 coalesce(sum(stat.row_count) filter(where starts_with(stat.schema_name,'source_')),0)::bigint as source_rows,
                 coalesce(sum(stat.row_count) filter(where stat.schema_name in ('core','mart')),0)::bigint as canonical_rows
            from latest_snapshot join control_plane.pipeline_stats stat
              on stat.tenant_id=latest_snapshot.tenant_id and stat.snapshot_at=latest_snapshot.snapshot_at
           group by latest_snapshot.tenant_id
        )
        select count(*)::integer as completed_tenants,
               coalesce(percentile_cont(0.50) within group(order by source_rows),0)::numeric as source_p50,
               coalesce(percentile_cont(0.95) within group(order by source_rows),0)::numeric as source_p95,
               coalesce(max(source_rows),0)::bigint as source_max,
               coalesce(percentile_cont(0.50) within group(order by canonical_rows),0)::numeric as canonical_p50,
               coalesce(percentile_cont(0.95) within group(order by canonical_rows),0)::numeric as canonical_p95,
               coalesce(max(canonical_rows),0)::bigint as canonical_max,
               count(*) filter(where greatest(source_rows,canonical_rows) between 1 and 999)::integer as micro,
               count(*) filter(where greatest(source_rows,canonical_rows) between 1000 and 9999)::integer as small,
               count(*) filter(where greatest(source_rows,canonical_rows)>=10000)::integer as medium,
               encode(extensions.digest(string_agg(
                 tenant_id||':'||source_rows::text||':'||canonical_rows::text,',' order by tenant_id
               ),'sha256'),'hex')::text as corpus_fingerprint
          from volume`, [prefix]);
      const lease = one(leaseResult.rows, "capacity lease detail");
      const workload = one(workloadResult.rows, "capacity workload detail");
      const startedAt = timestamp(lease.started_at, "capacity started at");
      const completedAt = timestamp(lease.completed_at, "capacity completed at");
      const participants = participantResult.rows.map((row): CapacityParticipant => Object.freeze({
        participantId: text(row.participant_id, "participant id"),
        workerId: text(row.worker_id, "worker id"),
        releaseSha: text(row.release_sha, "participant release SHA"),
        completedClaims: nonnegative(row.completed_claims, "participant claims"),
        controlPoolAcquireP95Ms: finite(row.control_pool_acquire_p95_ms, "control pool p95"),
        analyticalPoolAcquireP95Ms: finite(row.analytical_pool_acquire_p95_ms, "analytical pool p95"),
        errorCount: nonnegative(row.error_count, "participant errors"),
      }));
      return Object.freeze({
        completedClaims: nonnegative(lease.completed_claims, "completed claims"),
        distinctTenants: nonnegative(lease.distinct_tenants, "distinct tenants"),
        p95TenantMs: finite(lease.p95_ms, "tenant p95"),
        p99TenantMs: finite(lease.p99_ms, "tenant p99"),
        startedAt,
        completedAt,
        participants: Object.freeze(participants),
        workload: Object.freeze({
          completedTenants: nonnegative(workload.completed_tenants, "workload tenants"),
          sourceRows: Object.freeze({
            p50: finite(workload.source_p50, "source p50"),
            p95: finite(workload.source_p95, "source p95"),
            max: nonnegative(workload.source_max, "source max"),
          }),
          canonicalRows: Object.freeze({
            p50: finite(workload.canonical_p50, "canonical p50"),
            p95: finite(workload.canonical_p95, "canonical p95"),
            max: nonnegative(workload.canonical_max, "canonical max"),
          }),
          strata: Object.freeze([
            Object.freeze({ id: "micro" as const, minRows: 1, maxRows: 999, count: nonnegative(workload.micro, "micro count") }),
            Object.freeze({ id: "small" as const, minRows: 1_000, maxRows: 9_999, count: nonnegative(workload.small, "small count") }),
            Object.freeze({ id: "medium" as const, minRows: 10_000, maxRows: null, count: nonnegative(workload.medium, "medium count") }),
          ]),
          corpusFingerprint: text(workload.corpus_fingerprint, "corpus fingerprint"),
        }),
      });
    });
  }

  private async pressure(client: CapacityPgClient): Promise<DatabasePressureSample> {
    const row = one((await client.query(PRESSURE_SQL)).rows, "control database pressure");
    if (row.login !== this.expectedLogin) throw new Error("Capacity control observer login is not isolated.");
    return pressure(row);
  }

  private async read<T>(operation: (client: CapacityPgClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin transaction isolation level repeatable read read only");
      await client.query("select set_config('statement_timeout','5000ms',true)");
      await client.query("select set_config('lock_timeout','500ms',true)");
      const value = await operation(client);
      await client.query("commit");
      return value;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

export class PostgresCapacityAnalyticalObserver {
  constructor(
    private readonly pool: CapacityPgPool,
    private readonly expectedLogin = "albert_capacity_analytical_observer",
  ) {}

  async ready(): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      const result = await client.query(`
        select current_user=$1
                 and not role.rolsuper and not role.rolcreatedb and not role.rolcreaterole
                 and not role.rolreplication and not role.rolbypassrls and not role.rolinherit
                 and not exists(
                   select 1 from pg_catalog.pg_auth_members membership
                    where membership.member=role.oid
                 )
                 and not has_schema_privilege(current_user,'core','usage')
                 and not has_schema_privilege(current_user,'mart','usage')
                 and not has_schema_privilege(current_user,'source_lightspeed','usage')
                 and not has_schema_privilege(current_user,'source_xero','usage')
                 and not has_schema_privilege(current_user,'source_deputy','usage')
                 as ready
          from pg_catalog.pg_roles role where role.rolname=current_user`, [this.expectedLogin]);
      return result.rows[0]?.ready === true;
    } catch { return false; } finally { client.release(); }
  }

  async sample(): Promise<DatabasePressureSample> {
    const client = await this.pool.connect();
    try {
      await client.query("begin transaction read only");
      await client.query("select set_config('statement_timeout','3000ms',true)");
      const row = one((await client.query(PRESSURE_SQL)).rows, "analytical database pressure");
      if (row.login !== this.expectedLogin) throw new Error("Capacity analytical observer login is not isolated.");
      await client.query("commit");
      return pressure(row);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

function pressure(row: Row): DatabasePressureSample {
  return Object.freeze({
    maxConnections: positive(row.max_connections, "max connections"),
    connections: positive(row.connections, "connections"),
    lockWaiters: nonnegative(row.lock_waiters, "lock waiters"),
    deadlocks: nonnegative(row.deadlocks, "deadlocks"),
  });
}

function one(rows: readonly Row[], label: string): Row {
  if (rows.length !== 1) throw new Error(`${label} returned an invalid row count.`);
  return rows[0]!;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 500) throw new Error(`${label} is invalid.`);
  return value;
}

function timestamp(value: unknown, label: string): string {
  const parsed = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(parsed.valueOf())) throw new Error(`${label} is invalid.`);
  return parsed.toISOString();
}

function finite(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} is invalid.`);
  return parsed;
}

function nonnegative(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} is invalid.`);
  return parsed;
}

function positive(value: unknown, label: string): number {
  const parsed = nonnegative(value, label);
  if (parsed < 1) throw new Error(`${label} must be positive.`);
  return parsed;
}
