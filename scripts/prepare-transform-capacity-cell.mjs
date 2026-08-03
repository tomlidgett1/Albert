import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import pg from "pg";

const { Client } = pg;

function required(name) {
  const value = process.env[name]?.trim();
  assert.ok(value, `${name} is required to prepare the dedicated capacity cell.`);
  return value;
}

export async function prepareTransformCapacityCell() {
  const releaseSha = required("GITHUB_SHA");
  const cellId = required("ALBERT_CAPACITY_STAGING_CELL_ID");
  const expectedFingerprint = required("ALBERT_CAPACITY_CORPUS_FINGERPRINT");
  assert.match(expectedFingerprint, /^[a-f0-9]{64}$/u, "Capacity corpus fingerprint is invalid.");
  assert.match(releaseSha, /^[a-f0-9]{40}$/u, "Capacity candidate SHA is invalid.");
  assert.equal(
    required("ALBERT_CAPACITY_RESET_APPROVED"),
    `reset-staging-capacity:${releaseSha}:${cellId}`,
    "Capacity reset approval is not bound to the exact candidate and staging cell.",
  );
  const databaseUrl = required("CAPACITY_CONTROL_PLANE_MIGRATION_URL");
  const parsed = new URL(databaseUrl);
  assert.ok(["postgres:", "postgresql:"].includes(parsed.protocol), "Capacity control URL is not PostgreSQL.");
  assert.match(decodeURIComponent(parsed.username), /^albert_control_deployer(?:\.[a-z0-9]{20})?$/u,
    "Capacity preparation requires the dedicated control deployer login.");
  assert.ok(["require", "verify-ca", "verify-full"].includes(parsed.searchParams.get("sslmode") ?? ""),
    "Capacity preparation requires TLS.");

  const client = new Client({ connectionString: databaseUrl,
    application_name: `albert-capacity-prepare/${releaseSha}` });
  await client.connect();
  try {
    await client.query("begin");
    await client.query("set local role albert_control_migration_owner");
    const corpus = await client.query(`
      with latest_snapshot as (
        select tenant.tenant_id,max(stat.snapshot_at) as snapshot_at
          from control_plane.tenants tenant
          left join control_plane.pipeline_stats stat on stat.tenant_id=tenant.tenant_id
         where tenant.status='active' and tenant.slug like 'capacity-%'
         group by tenant.tenant_id
      ), volume as (
        select latest_snapshot.tenant_id,
               coalesce(sum(stat.row_count) filter(where starts_with(stat.schema_name,'source_')),0)::bigint as source_rows,
               coalesce(sum(stat.row_count) filter(where stat.schema_name in ('core','mart')),0)::bigint as canonical_rows
          from latest_snapshot
          left join control_plane.pipeline_stats stat
            on stat.tenant_id=latest_snapshot.tenant_id
           and stat.snapshot_at=latest_snapshot.snapshot_at
         group by latest_snapshot.tenant_id
      )
      select count(*)::integer as tenants,
             count(*) filter(where greatest(source_rows,canonical_rows) between 1 and 999)::integer as micro,
             count(*) filter(where greatest(source_rows,canonical_rows) between 1000 and 9999)::integer as small,
             count(*) filter(where greatest(source_rows,canonical_rows)>=10000)::integer as medium,
             count(*) filter(where source_rows=0 or canonical_rows=0)::integer as empty,
             encode(extensions.digest(
               string_agg(tenant_id||':'||source_rows::text||':'||canonical_rows::text,
                 ',' order by tenant_id),'sha256'
             ),'hex')::text as fingerprint
        from volume`);
    const row = corpus.rows[0];
    assert.equal(Number(row.tenants), 20_000, "Dedicated capacity corpus must contain exactly 20,000 active capacity tenants.");
    assert.ok(Number(row.micro) >= 2_000, "Capacity corpus requires at least 2,000 micro tenants.");
    assert.ok(Number(row.small) >= 10_000, "Capacity corpus requires at least 10,000 small tenants.");
    assert.ok(Number(row.medium) >= 4_000, "Capacity corpus requires at least 4,000 medium tenants.");
    assert.equal(Number(row.empty), 0, "Capacity corpus contains empty tenants.");
    assert.equal(row.fingerprint, expectedFingerprint,
      "Capacity corpus differs from the independently approved fingerprint.");
    const connectionCoverage = await client.query(`
      select count(*)::integer as missing
        from control_plane.tenants tenant
       where tenant.status='active' and tenant.slug like 'capacity-%'
         and (
           not exists(select 1 from control_plane.connections connection
                       where connection.tenant_id=tenant.tenant_id
                         and connection.status in ('connected','degraded'))
           or exists(select 1 from control_plane.deletion_requests request
                      where request.tenant_id=tenant.tenant_id
                        and request.status in ('queued','running','retry_wait','verifying','failed'))
         )`);
    assert.equal(Number(connectionCoverage.rows[0]?.missing), 0,
      "Every capacity tenant must have a live connection and no active deletion request.");
    const nonCapacity = await client.query(
      "select count(*)::integer as count from control_plane.tenants where slug not like 'capacity-%'",
    );
    assert.equal(Number(nonCapacity.rows[0]?.count), 0,
      "Capacity reset refused because the cell contains a non-capacity tenant.");
    const activeLeases = await client.query(`select count(*)::integer as count
      from control_plane.transform_maintenance_leases
      where completed_at is null and expires_at>clock_timestamp()`);
    assert.equal(Number(activeLeases.rows[0]?.count), 0,
      "Capacity reset refused because a transform process still owns an active lease.");
    await client.query("delete from control_plane.transform_maintenance_leases");
    await client.query("delete from control_plane.transform_capacity_participant_observations");
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareTransformCapacityCell().then(() => {
    process.stdout.write("dedicated transform capacity cell prepared\n");
  }).catch((error) => {
    process.stderr.write(`capacity cell preparation failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
