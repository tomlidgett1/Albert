import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { PostgresQueryClient } from "../../packages/queue/src/index.js";
import type { TransactionalPostgres } from "../../services/sync-workers/src/database.js";
import { loadTransformWorkerConfig } from "../../services/transform-worker/src/config.js";
import { PostgresCanonicalTransformQueue } from "../../services/transform-worker/src/queue.js";

const IDS={
  tenant:"01J00000000000000000000001",
  job:"01J00000000000000000000002",
  batch:"01J00000000000000000000003",
  run:"01J00000000000000000000004",
  connection:"01J00000000000000000000005",
  lease:"01J00000000000000000000006",
} as const;

test("transform configuration has an isolated two-database process boundary",()=>{
  const config=loadTransformWorkerConfig({
    TRANSFORM_CONTROL_PLANE_DATABASE_URL:"postgresql://transform-control.invalid/albert",
    TRANSFORM_DATABASE_URL:"postgresql://transform.invalid/albert",
    ALBERT_TRANSFORM_WORKER_ID:"canonical-1",
  } as unknown as NodeJS.ProcessEnv);
  assert.equal(config.workerId,"canonical-1");
  assert.equal(config.mappingVersion,"m2-v1");
  assert.equal(config.workerConcurrency,8);
  assert.equal(config.queueSlaSeconds,120);
  assert.equal(config.snapshotClaimBatchSize,8);
  assert.equal(config.snapshotMaxClaimsPerRun,20_000);
  assert.equal(config.metricsPort,9091);
  assert.equal("analyticalDatabaseUrl" in config,false);
  assert.equal("tokenEncryptionKey" in config,false);
  assert.throws(()=>loadTransformWorkerConfig({
    TRANSFORM_CONTROL_PLANE_DATABASE_URL:"postgresql://transform-control.invalid/albert",
    ALBERT_TRANSFORM_WORKER_ID:"canonical-1",
  } as unknown as NodeJS.ProcessEnv),/TRANSFORM_DATABASE_URL/);
  assert.throws(()=>loadTransformWorkerConfig({
    CONTROL_PLANE_DATABASE_URL:"postgresql://overprivileged.invalid/albert",
    TRANSFORM_DATABASE_URL:"postgresql://transform.invalid/albert",
    ALBERT_TRANSFORM_WORKER_ID:"canonical-1",
  } as unknown as NodeJS.ProcessEnv),/TRANSFORM_CONTROL_PLANE_DATABASE_URL/);
  assert.equal(loadTransformWorkerConfig({
    TRANSFORM_CONTROL_PLANE_DATABASE_URL:"postgresql://transform-control.invalid/albert",
    TRANSFORM_DATABASE_URL:"postgresql://transform.invalid/albert",
    ALBERT_TRANSFORM_WORKER_ID:"canonical-1",
    FLY_MACHINE_ID:"90801abcdef123",
  } as unknown as NodeJS.ProcessEnv).workerId,"canonical-1:90801abcdef123");
  assert.throws(()=>loadTransformWorkerConfig({
    TRANSFORM_CONTROL_PLANE_DATABASE_URL:"postgresql://transform-control.invalid/albert",
    TRANSFORM_DATABASE_URL:"postgresql://transform.invalid/albert",
    ALBERT_TRANSFORM_WORKER_ID:"canonical-1",
    ALBERT_WORKER_CONCURRENCY:"65",
  } as unknown as NodeJS.ProcessEnv),/ALBERT_WORKER_CONCURRENCY/);
});

test("canonical queue parses a fenced, typed claim and never accepts malformed domains",async()=>{
  const queries:{sql:string;values:readonly unknown[]}[]=[];
  const row={
    tenant_id:IDS.tenant,transform_job_id:IDS.job,batch_id:IDS.batch,
    sync_run_id:IDS.run,connection_id:IDS.connection,connection_generation:"7",
    connector_id:"xero",
    stream:"journals",domains:["finance_journal_line"],mapping_version:"m2-v1",
    backfill_complete:false,attempt_count:"2",lease_token:IDS.lease,
    lease_expires_at:"2026-08-03T01:00:00.000Z",
  };
  const queryClient:PostgresQueryClient={
    async query<Row extends Record<string,unknown>=Record<string,unknown>>(sql:string,values:readonly unknown[]=[]){
      queries.push({sql,values});
      if(sql.includes("claim_canonical_transform_job"))return{rows:[row as unknown as Row]};
      return{rows:[] as Row[]};
    },
  };
  const database:TransactionalPostgres={
    ...queryClient,
    async transaction<T>(work:(client:PostgresQueryClient)=>Promise<T>){
      return work(queryClient);
    },
  };
  const queue=new PostgresCanonicalTransformQueue(database);
  const claim=await queue.claim({workerId:"canonical-1",mappingVersion:"m2-v1",leaseSeconds:900});
  assert.equal(claim?.job.connectorId,"xero");
  assert.equal(claim?.job.connectionGeneration,7);
  assert.deepEqual(claim?.job.domains,["finance_journal_line"]);
  assert.equal(claim?.job.attemptCount,2);
  assert.match(queries[0]!.sql,/set local role albert_transform_control/i);
  assert.match(queries[1]!.sql,/claim_canonical_transform_job/);

  row.domains=["finance;drop table core"];
  await assert.rejects(
    queue.claim({workerId:"canonical-1",mappingVersion:"m2-v1",leaseSeconds:900}),
    /invalid_domains/,
  );
});

test("staging success and transform enqueue share the control-plane commit transaction",async()=>{
  const [store,migration,pipeline,queue,bootstrap]=await Promise.all([
    readFile(new URL("../../services/sync-workers/src/control-plane-store.ts",import.meta.url),"utf8"),
    readFile(new URL("../../infra/migrations/control-plane/0004_m4_canonical_projections.sql",import.meta.url),"utf8"),
    readFile(new URL("../../services/sync-workers/src/canonical-pipeline.ts",import.meta.url),"utf8"),
    readFile(new URL("../../services/transform-worker/src/queue.ts",import.meta.url),"utf8"),
    readFile(new URL("../../infra/bootstrap/control_plane_role.sql",import.meta.url),"utf8"),
  ]);
  assert.match(store,/this\.db\.transaction\(async \(client\).*enqueue_canonical_transform_job[\s\S]*status = 'succeeded'/s);
  assert.match(migration,/FOR UPDATE SKIP LOCKED/);
  assert.match(migration,/lease_token/);
  assert.match(migration,/canonical_transform_tenant_watermarks/);
  assert.match(pipeline,/set local role transform_rw/i);
  assert.match(pipeline,/set local role albert_transform_control/i);
  assert.match(queue,/database\.transaction[\s\S]*set local role albert_transform_control/i);
  assert.match(bootstrap,/CREATE ROLE albert_transform_control[\s\S]*NOLOGIN/);
  assert.match(migration,/assert_transform_control_boundary[\s\S]*oauth_token_refs/);
  assert.match(migration,/transform control login must be a member only of albert_transform_control/);
  assert.match(migration,/rolsuper OR role\.rolcreatedb OR role\.rolcreaterole[\s\S]*role\.rolbypassrls/);
  assert.doesNotMatch(
    migration,
    /GRANT EXECUTE ON FUNCTION control_plane\.claim_canonical_transform_job\([^;]+TO service_role/s,
  );
  assert.doesNotMatch(
    migration,
    /GRANT SELECT,INSERT,UPDATE,DELETE ON control_plane\.canonical_transform_jobs TO service_role/,
  );
});

test("transform sources cannot load connector credentials and sync cannot write canonical rows",async()=>{
  const [transformMain,transformConfig,syncMain,syncIndex]=await Promise.all([
    readFile(new URL("../../services/transform-worker/src/main.ts",import.meta.url),"utf8"),
    readFile(new URL("../../services/transform-worker/src/config.ts",import.meta.url),"utf8"),
    readFile(new URL("../../services/sync-workers/src/main.ts",import.meta.url),"utf8"),
    readFile(new URL("../../services/sync-workers/src/index.ts",import.meta.url),"utf8"),
  ]);
  const transformSource=`${transformMain}\n${transformConfig}`;
  assert.doesNotMatch(transformSource,/CredentialVault|ProductionConnectorFactory|RawBatchWriter|TOKEN_ENCRYPTION_KEY|CLIENT_SECRET/);
  assert.match(transformConfig,/TRANSFORM_CONTROL_PLANE_DATABASE_URL/);
  assert.doesNotMatch(transformConfig,/required\(source,"CONTROL_PLANE_DATABASE_URL"\)/);
  assert.doesNotMatch(syncMain,/TRANSFORM_DATABASE_URL|CanonicalTransformPipeline|transform_rw/);
  assert.doesNotMatch(syncIndex,/canonical-pipeline/);
});

test("canonical execution retains immutable lineage and refreshes governed quality evidence",async()=>{
  const [foundation,quality,executable,pipeline]=await Promise.all([
    readFile(new URL("../../infra/migrations/analytical/0010_m4_canonical_foundation.sql",import.meta.url),"utf8"),
    readFile(new URL("../../infra/migrations/analytical/0020_m4_transforms_quality_and_marts.sql",import.meta.url),"utf8"),
    readFile(new URL("../../infra/migrations/analytical/0050_m4_executable_canonical_pipeline.sql",import.meta.url),"utf8"),
    readFile(new URL("../../services/sync-workers/src/canonical-pipeline.ts",import.meta.url),"utf8"),
  ]);
  assert.match(foundation,/canonical fact lineage is immutable/);
  assert.match(executable,/Every tenant-owned[\s\S]*sync_run_id text[\s\S]*SET NOT NULL/);
  assert.match(executable,/protect_canonical_sync_run/);
  assert.match(executable,/canonical_record_state[\s\S]*connection_id text NOT NULL[\s\S]*source_object_type text NOT NULL[\s\S]*mapping_version text NOT NULL/);
  assert.match(pipeline,/tenant_id:job\.tenantId,id,\.\.\.resolved,sync_run_id:row\.sync_run_id/);
  assert.match(executable,/finance_status_lookup[\s\S]*workforce_leave_status_lookup[\s\S]*inventory_movement_type_lookup/);
  assert.match(quality,/line_maths[\s\S]*ON CONFLICT \(tenant_id,run_id,check_id\) DO UPDATE SET/);
  assert.match(executable,/staging_acceptance[\s\S]*ON CONFLICT \(tenant_id,run_id,check_id\) DO UPDATE SET/);
  assert.match(executable,/md5\('identity-review-a\|'[\s\S]*md5\('identity-review-b\|'/);
});
