import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalTransformPipeline } from "../../services/sync-workers/src/canonical-pipeline.js";
import {
  CanonicalTransformProcessor,
  type TransformProcessOutcome,
} from "../../services/transform-worker/src/processor.js";
import { PostgresCanonicalTransformQueue } from "../../services/transform-worker/src/queue.js";
import { CanonicalTransformWorkerService } from "../../services/transform-worker/src/service.js";
import type {
  ClaimedCanonicalTransformJob,
  DurableCanonicalTransformQueue,
} from "../../services/transform-worker/src/types.js";

const claim:ClaimedCanonicalTransformJob=Object.freeze({
  workerId:"transform-outcome-test",
  leaseToken:"01J00000000000000000000001",
  leaseExpiresAt:"2026-08-04T00:15:00.000Z",
  job:Object.freeze({
    tenantId:"01J00000000000000000000002",
    transformJobId:"01J00000000000000000000003",
    batchId:"01J00000000000000000000004",
    syncRunId:"01J00000000000000000000005",
    connectionId:"01J00000000000000000000006",
    connectionGeneration:1,
    connectorId:"xero",
    stream:"invoices",
    domains:Object.freeze(["accounting"]),
    mappingVersion:"m2-v1",
    backfillComplete:false,
    attemptCount:1,
  }),
});

function processorHarness(input:Readonly<{
  failure?:Error;
  queueOutcome?:"retry_wait"|"failed";
}>={}){
  let persistedFailure:Readonly<{code:string;retryable:boolean}>|null=null;
  let completed=0;
  const queue={
    async complete(){completed+=1;},
    async retryOrFail(
      _claim:ClaimedCanonicalTransformJob,
      failure:Readonly<{code:string;retryable:boolean}>,
    ){
      persistedFailure=failure;
      return input.queueOutcome??"retry_wait";
    },
  } as unknown as DurableCanonicalTransformQueue;
  const pipeline={
    async transformBatch(){
      if(input.failure)throw input.failure;
      return {canonicalRows:3,qualityStatus:"passed"};
    },
  } as unknown as CanonicalTransformPipeline;
  return{
    processor:new CanonicalTransformProcessor(queue,pipeline),
    completed:()=>completed,
    persistedFailure:()=>persistedFailure,
  };
}

test("transform processor returns completed only after the durable completion transition",async()=>{
  const harness=processorHarness();
  assert.deepEqual(await harness.processor.process(claim),{status:"completed"});
  assert.equal(harness.completed(),1);
  assert.equal(harness.persistedFailure(),null);
});

test("retry outcome persists a bounded code and rejects arbitrary exception leakage",async()=>{
  const secret="Bearer sk-super-secret account@example.com";
  const harness=processorHarness({
    failure:new Error(`vendor exploded ${secret}`),
    queueOutcome:"retry_wait",
  });

  const outcome=await harness.processor.process(claim);
  assert.deepEqual(outcome,{
    status:"retry_scheduled",
    failure:{code:"unexpected_transform_failure",retryable:true},
    retryDelaySeconds:30,
  });
  assert.deepEqual(harness.persistedFailure(),{
    code:"unexpected_transform_failure",
    retryable:true,
  });
  assert.doesNotMatch(JSON.stringify({outcome,failure:harness.persistedFailure()}),/sk-super-secret|account@example\.com|Bearer/u);
});

test("permanent transform failures return failed with no message detail",async()=>{
  const harness=processorHarness({
    failure:new Error("canonical_mapping_version_mismatch:Bearer sk-never-persist"),
    queueOutcome:"failed",
  });

  assert.deepEqual(await harness.processor.process(claim),{
    status:"failed",
    failure:{code:"canonical_mapping_version_mismatch",retryable:false},
    retryDelaySeconds:0,
  });
  assert.deepEqual(harness.persistedFailure(),{
    code:"canonical_mapping_version_mismatch",
    retryable:false,
  });
  assert.doesNotMatch(JSON.stringify(harness.persistedFailure()),/sk-never-persist|Bearer/u);
});

test("canonical queue preserves terminal transitions with a database-valid delay and exact evidence",async()=>{
  const calls:Array<Readonly<{sql:string;values:readonly unknown[]}>>=[];
  const queue=new PostgresCanonicalTransformQueue({
    async transaction<T>(operation:(client:{
      query(sql:string,values?:readonly unknown[]):Promise<Readonly<{rows:readonly unknown[]}>>;
    })=>Promise<T>):Promise<T>{
      return operation({
        async query(sql:string,values:readonly unknown[]=[]){
          calls.push({sql,values});
          return {rows:[{outcome:"failed"}]};
        },
      });
    },
  } as never);

  assert.equal(await queue.retryOrFail(
    claim,
    {code:"canonical_mapping_version_mismatch",retryable:false},
    {retryDelaySeconds:0,maxAttempts:12},
  ),"failed");
  const transition=calls.find((call)=>call.sql.includes("retry_or_fail_canonical_transform_job"));
  assert.ok(transition);
  assert.deepEqual(JSON.parse(String(transition.values[4])),{
    code:"canonical_mapping_version_mismatch",
    retryable:false,
  });
  assert.equal(transition.values[5],1);
});

test("bounded replay continuation requires durable non-zero progress",async()=>{
  let touchedDatabase=false;
  const queue=new PostgresCanonicalTransformQueue({
    async transaction(){touchedDatabase=true;throw new Error("database_must_not_be_called");},
  } as never);
  await assert.rejects(
    queue.continueReplay(claim,{
      kind:"compatibility_replay",pending:true,candidates:0,commands:0,
      progressToken:"a".repeat(64),
    },1),
    /canonical_queue_invalid_continuation/u,
  );
  assert.equal(touchedDatabase,false);
});

test("processor durably continues replay instead of completing the transform job",async()=>{
  let completed=false;
  let progress:unknown;
  const queue={
    async complete(){completed=true;},
    async continueReplay(_claim:ClaimedCanonicalTransformJob,value:unknown){
      progress=value;return 37;
    },
    async retryOrFail(){return "failed" as const;},
  } as unknown as DurableCanonicalTransformQueue;
  const pipeline={
    async transformBatch(){
      return{
        compatibilityReplayPending:true,
        compatibilityReplayCandidates:1,
        compatibilityReplayCommands:500,
        compatibilityReplayProgressToken:"b".repeat(64),
      };
    },
  } as unknown as CanonicalTransformPipeline;
  const outcome=await new CanonicalTransformProcessor(queue,pipeline).process(claim);
  assert.deepEqual(outcome,{status:"continuation_scheduled",continuationCount:37});
  assert.equal(completed,false);
  assert.deepEqual(progress,{
    kind:"compatibility_replay",pending:true,candidates:1,commands:500,
    progressToken:"b".repeat(64),
  });
});

async function waitUntil(predicate:()=>boolean,timeoutMs=2_000):Promise<void>{
  const deadline=Date.now()+timeoutMs;
  while(!predicate()){
    if(Date.now()>deadline)throw new Error("transform_outcome_test_timeout");
    await new Promise((resolve)=>setTimeout(resolve,5));
  }
}

async function serviceHealthFor(outcome:TransformProcessOutcome){
  let issued=false;
  const queue={
    async preflight(){},
    async claim(){
      if(issued)return null;
      issued=true;
      return claim;
    },
    async extendLease(){return "2026-08-04T00:15:00.000Z";},
  } as unknown as DurableCanonicalTransformQueue;
  const processor={async process(){return outcome;}} as unknown as CanonicalTransformProcessor;
  const service=new CanonicalTransformWorkerService(
    "transform-outcome-test","m2-v1",queue,processor,async()=>0,async()=>0,
    {emptyPollDelayMs:5,snapshotIntervalMs:60_000,identityProjectionIntervalMs:60_000},
  );
  const abort=new AbortController();
  const running=service.run(abort.signal);
  await waitUntil(()=>service.health().activeJobs===0&&service.health().lastClaimAt!==null);
  const health=service.health();
  abort.abort();
  await running;
  return health;
}

test("transform worker health advances completion only for completed work",async()=>{
  const retried=await serviceHealthFor({
    status:"retry_scheduled",
    failure:{code:"database_unavailable",retryable:true},
    retryDelaySeconds:30,
  });
  assert.equal(retried.lastCompletionAt,null);
  assert.equal(retried.lastErrorCode,"database_unavailable");

  const failed=await serviceHealthFor({
    status:"failed",
    failure:{code:"canonical_mapping_version_mismatch",retryable:false},
    retryDelaySeconds:0,
  });
  assert.equal(failed.lastCompletionAt,null);
  assert.equal(failed.lastErrorCode,"canonical_mapping_version_mismatch");

  const completed=await serviceHealthFor({status:"completed"});
  assert.match(completed.lastCompletionAt??"",/^2026-|^20\d{2}-/u);
  assert.equal(completed.lastErrorCode,null);
});
