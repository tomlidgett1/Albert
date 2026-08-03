import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { DurableSyncQueue } from "../../packages/queue/src/index.js";
import { SyncWorkerService } from "../../services/sync-workers/src/service.js";
import type { SyncJobProcessor } from "../../services/sync-workers/src/worker.js";
import { CanonicalTransformWorkerService } from "../../services/transform-worker/src/service.js";
import type { CanonicalTransformProcessor } from "../../services/transform-worker/src/processor.js";
import type { DurableCanonicalTransformQueue } from "../../services/transform-worker/src/types.js";

async function until(predicate:()=>boolean,timeoutMs=2_000):Promise<void>{
  const deadline=Date.now()+timeoutMs;
  while(!predicate()){
    if(Date.now()>deadline)throw new Error("worker_scale_test_timeout");
    await new Promise((resolve)=>setTimeout(resolve,5));
  }
}

test("sync worker runs the configured number of independently draining lanes",async()=>{
  let issued=0;
  let active=0;
  let maximumActive=0;
  const queue={
    async preflight(){},
    async claim(){
      issued+=1;
      return issued<=4?({messageId:String(issued)} as never):null;
    },
    async extendVisibility(){return new Date().toISOString();},
  } as unknown as DurableSyncQueue;
  const processor={
    async process(_claim:unknown,signal:AbortSignal){
      active+=1;
      maximumActive=Math.max(maximumActive,active);
      await new Promise<void>((resolve)=>signal.addEventListener("abort",()=>resolve(),{once:true}));
      active-=1;
      return {status:"completed" as const};
    },
  } as unknown as SyncJobProcessor;
  const service=new SyncWorkerService("sync-scale-test",queue,processor,{
    concurrency:4,emptyPollDelayMs:5,
  });
  const abort=new AbortController();
  const running=service.run(abort.signal);
  await until(()=>service.health().activeJobs===4);
  assert.equal(service.health().concurrency,4);
  assert.equal(maximumActive,4);
  abort.abort();
  await running;
  assert.equal(service.health().activeJobs,0);
  assert.equal(service.health().ready,false);
});

test("transform worker runs bounded lanes and drains active work on shutdown",async()=>{
  let issued=0;
  let active=0;
  let maximumActive=0;
  let release:()=>void=()=>undefined;
  const gate=new Promise<void>((resolve)=>{release=resolve;});
  const queue={
    async preflight(){},
    async claim(){
      issued+=1;
      return issued<=3?({job:{},leaseToken:String(issued)} as never):null;
    },
    async extendLease(){return new Date().toISOString();},
  } as unknown as DurableCanonicalTransformQueue;
  const processor={
    async process(){
      active+=1;
      maximumActive=Math.max(maximumActive,active);
      await gate;
      active-=1;
      return {status:"completed" as const};
    },
  } as unknown as CanonicalTransformProcessor;
  const service=new CanonicalTransformWorkerService(
    "transform-scale-test","m2-v1",queue,processor,
    async()=>0,async()=>0,
    {concurrency:3,emptyPollDelayMs:5,snapshotIntervalMs:60_000,identityProjectionIntervalMs:60_000},
  );
  const abort=new AbortController();
  const running=service.run(abort.signal);
  await until(()=>service.health().activeJobs===3);
  assert.equal(service.health().concurrency,3);
  assert.equal(maximumActive,3);
  abort.abort();
  release();
  await running;
  assert.equal(service.health().activeJobs,0);
  assert.equal(service.health().ready,false);
});

test("fleet capacity, maintenance draining, autoscaling, and retention remain one contract",async()=>{
  const [pipeline,controlRetention,analyticalRetention,syncAutoscaler,transformAutoscaler,release]=
    await Promise.all([
      readFile(new URL("../../services/sync-workers/src/canonical-pipeline.ts",import.meta.url),"utf8"),
      readFile(new URL("../../infra/migrations/control-plane/0048_m4_pipeline_history_retention.sql",import.meta.url),"utf8"),
      readFile(new URL("../../infra/migrations/analytical/0089_m4_pipeline_history_retention.sql",import.meta.url),"utf8"),
      readFile(new URL("../../deploy/fly-autoscalers/sync-worker.toml",import.meta.url),"utf8"),
      readFile(new URL("../../deploy/fly-autoscalers/transform-worker.toml",import.meta.url),"utf8"),
      readFile(new URL("../../.github/workflows/release.yml",import.meta.url),"utf8"),
    ]);

  assert.match(pipeline,/while\(claimedCount<maxClaims\)/u);
  assert.match(pipeline,/Promise\.allSettled\(claims\.rows\.map/u);
  assert.match(pipeline,/Math\.min\(claimBatchSize,maxClaims-claimedCount\)/u);
  assert.match(pipeline,/transformMaintenanceMetrics/u);
  assert.match(controlRetention,/statement_timestamp\(\)-interval '48 hours'/u);
  assert.match(controlRetention,/statement_timestamp\(\)-interval '400 days'/u);
  assert.match(analyticalRetention,/published_at<statement_timestamp\(\)-interval '24 hours'/u);
  assert.match(analyticalRetention,/session_user<>'albert_transform_analytical_runtime'/u);
  assert.doesNotMatch(analyticalRetention,/published_at IS NULL[^;]*DELETE/isu);
  assert.match(syncAutoscaler,/min\(40, 2 \+ queue_pressure\)/u);
  assert.match(transformAutoscaler,/albert_transform_maintenance_due/u);
  assert.match(release,/TARGET_FLOOR:[^\n]*transform_machine_floor/u);
  assert.match(release,/test "\$TARGET_FLOOR" -ge 2[\s\S]*test "\$TARGET_FLOOR" -le 40/u);
  assert.match(release,/running_count[^\n]*machines list[\s\S]*if \[ "\$running_count" -lt "\$TARGET_FLOOR" \]; then[\s\S]*scale count "\$TARGET_FLOOR"/u);
  assert.doesNotMatch(release,/if \[ "\$running_count" -gt "\$TARGET_FLOOR" \][\s\S]*scale count/u);

  const tenantCount=20_000;
  const maximumMachines=40;
  const lanesPerMachine=8;
  const averageSecondsAvailable=3_600*maximumMachines*lanesPerMachine/tenantCount;
  assert.equal(averageSecondsAvailable,57.6);
});

test("worker concurrency is fail-closed outside its reviewed bound",()=>{
  const queue={} as DurableSyncQueue;
  const processor={} as SyncJobProcessor;
  assert.throws(
    ()=>new SyncWorkerService("sync",queue,processor,{concurrency:0}),
    /between 1 and 64/,
  );
  assert.throws(
    ()=>new CanonicalTransformWorkerService(
      "transform","m2-v1",{} as DurableCanonicalTransformQueue,
      {} as CanonicalTransformProcessor,async()=>0,async()=>0,{concurrency:65},
    ),
    /between 1 and 64/,
  );
});
