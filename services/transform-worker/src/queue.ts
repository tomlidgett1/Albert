import type { PostgresQueryClient } from "../../../packages/queue/src/index.js";
import type { TransactionalPostgres } from "../../sync-workers/src/database.js";
import type {
  CanonicalTransformQueueMetric,
  ClaimedCanonicalTransformJob,
  DurableCanonicalTransformQueue,
} from "./types.js";

const ULID=/^[0-9A-HJKMNP-TV-Z]{26}$/;
const CONNECTORS=new Set(["lightspeed-r","xero","deputy","square","shopify","stripe","momence","meta-ads","google-ads"]);
const STATUSES=new Set(["queued","running","retry_wait","succeeded","failed"]);

async function withTransformControlRole<T>(
  database:TransactionalPostgres,
  work:(client:PostgresQueryClient)=>Promise<T>,
):Promise<T>{
  return database.transaction(async(client)=>{
    await client.query("set local role albert_transform_control");
    return work(client);
  });
}

type ClaimRow=Readonly<{
  tenant_id:string;
  transform_job_id:string;
  batch_id:string;
  sync_run_id:string;
  connection_id:string;
  connection_generation:number|string;
  connector_id:string;
  stream:string;
  domains:string[];
  mapping_version:string;
  backfill_complete:boolean;
  attempt_count:number|string;
  lease_token:string;
  lease_expires_at:string|Date;
}>;

function integer(value:unknown,name:string):number{
  const parsed=Number(value);
  if(!Number.isSafeInteger(parsed)||parsed<0)throw new Error(`canonical_queue_invalid_${name}`);
  return parsed;
}

function timestamp(value:unknown,name:string):string{
  const parsed=value instanceof Date?value:new Date(String(value));
  if(Number.isNaN(parsed.valueOf()))throw new Error(`canonical_queue_invalid_${name}`);
  return parsed.toISOString();
}

function claimFromRow(row:ClaimRow,workerId:string):ClaimedCanonicalTransformJob{
  for(const [name,value] of [
    ["tenant_id",row.tenant_id],["transform_job_id",row.transform_job_id],
    ["batch_id",row.batch_id],["sync_run_id",row.sync_run_id],
    ["connection_id",row.connection_id],["lease_token",row.lease_token],
  ] as const){
    if(!ULID.test(value))throw new Error(`canonical_queue_invalid_${name}`);
  }
  if(!CONNECTORS.has(row.connector_id))throw new Error("canonical_queue_invalid_connector_id");
  if(!row.stream?.trim()||!row.mapping_version?.trim())throw new Error("canonical_queue_invalid_job_metadata");
  const connectionGeneration=integer(row.connection_generation,"connection_generation");
  if(connectionGeneration<1)throw new Error("canonical_queue_invalid_connection_generation");
  if(!Array.isArray(row.domains)||!row.domains.length||row.domains.some((domain)=>!/^[a-z][a-z0-9_]*$/.test(domain))){
    throw new Error("canonical_queue_invalid_domains");
  }
  const connectorId=row.connector_id as "lightspeed-r"|"xero"|"deputy"|"square"|"shopify"|"stripe"|"momence"|"meta-ads"|"google-ads";
  return Object.freeze({
    workerId,
    leaseToken:row.lease_token,
    leaseExpiresAt:timestamp(row.lease_expires_at,"lease_expires_at"),
    job:Object.freeze({
      tenantId:row.tenant_id,
      transformJobId:row.transform_job_id,
      batchId:row.batch_id,
      syncRunId:row.sync_run_id,
      connectionId:row.connection_id,
      connectionGeneration,
      connectorId,
      stream:row.stream,
      domains:Object.freeze([...new Set(row.domains)]),
      mappingVersion:row.mapping_version,
      backfillComplete:row.backfill_complete,
      attemptCount:integer(row.attempt_count,"attempt_count"),
    }),
  });
}

export class PostgresCanonicalTransformQueue implements DurableCanonicalTransformQueue{
  constructor(private readonly database:TransactionalPostgres){}

  async preflight():Promise<void>{
    await withTransformControlRole(this.database,async(client)=>{
      const role=await client.query<{role_name:string}>(
        "select current_user as role_name",
      );
      if(role.rows[0]?.role_name!=="albert_transform_control"){
        throw new Error("transform_control_database_role_not_ready");
      }
      await client.query("select control_plane.assert_transform_control_boundary()");
      await client.query("select * from control_plane.canonical_transform_queue_metrics()");
    });
  }

  async claim(input:Readonly<{workerId:string;mappingVersion:string;leaseSeconds:number}>):Promise<ClaimedCanonicalTransformJob|null>{
    const result=await withTransformControlRole(this.database,(client)=>client.query<ClaimRow>(
        `select tenant_id,transform_job_id,batch_id,sync_run_id,connection_id,
                connection_generation,connector_id,stream,domains,mapping_version,backfill_complete,
                attempt_count,lease_token,lease_expires_at
           from control_plane.claim_canonical_transform_job_v2($1::text,$2::text,$3::integer)`,
        [input.workerId,input.mappingVersion,input.leaseSeconds],
      ));
    return result.rows[0]?claimFromRow(result.rows[0],input.workerId):null;
  }

  async extendLease(claim:ClaimedCanonicalTransformJob,leaseSeconds:number):Promise<string>{
    const result=await withTransformControlRole(this.database,(client)=>client.query<{deadline:string|Date}>(
        `select control_plane.extend_canonical_transform_lease(
           $1::text,$2::text,$3::text,$4::text,$5::integer
         ) as deadline`,
        [claim.job.tenantId,claim.job.transformJobId,claim.workerId,claim.leaseToken,leaseSeconds],
      ));
    return timestamp(result.rows[0]?.deadline,"lease_deadline");
  }

  async complete(claim:ClaimedCanonicalTransformJob,result:Readonly<Record<string,unknown>>):Promise<void>{
    await withTransformControlRole(this.database,(client)=>client.query(
        `select control_plane.complete_canonical_transform_job(
           $1::text,$2::text,$3::text,$4::text,$5::jsonb
         )`,
        [claim.job.tenantId,claim.job.transformJobId,claim.workerId,claim.leaseToken,JSON.stringify(result)],
      ).then(()=>undefined));
  }

  async continueReplay(
    claim:ClaimedCanonicalTransformJob,
    progress:Readonly<{kind:"compatibility_replay";pending:true;candidates:number;commands:number;progressToken:string}>,
    delaySeconds:number,
  ):Promise<number>{
    if(!Number.isSafeInteger(delaySeconds)||delaySeconds<0||delaySeconds>300||
        !Number.isSafeInteger(progress.candidates)||progress.candidates<0||progress.candidates>1_000||
        !Number.isSafeInteger(progress.commands)||progress.commands<0||progress.commands>5_000||
        progress.candidates+progress.commands<1||!/^[a-f0-9]{64}$/u.test(progress.progressToken)){
      throw new Error("canonical_queue_invalid_continuation");
    }
    const result=await withTransformControlRole(this.database,(client)=>client.query<{continuation_count:number|string}>(
      `select control_plane.continue_canonical_transform_job(
         $1::text,$2::text,$3::text,$4::text,$5::jsonb,$6::integer
       ) as continuation_count`,
      [claim.job.tenantId,claim.job.transformJobId,claim.workerId,claim.leaseToken,
        JSON.stringify(progress),delaySeconds],
    ));
    return integer(result.rows[0]?.continuation_count,"continuation_count");
  }

  async retryOrFail(
    claim:ClaimedCanonicalTransformJob,
    error:Readonly<{code:string;retryable:boolean}>,
    options:Readonly<{retryDelaySeconds:number;maxAttempts:number}>,
  ):Promise<"retry_wait"|"failed">{
    if(!Number.isSafeInteger(options.retryDelaySeconds)||options.retryDelaySeconds<0||options.retryDelaySeconds>86_400){
      throw new Error("canonical_queue_invalid_retry_delay");
    }
    if(!Number.isSafeInteger(options.maxAttempts)||options.maxAttempts<1||options.maxAttempts>100){
      throw new Error("canonical_queue_invalid_max_attempts");
    }
    const code=/^[a-z][a-z0-9_.-]{0,119}$/u.test(error.code)
      ? error.code
      : "unexpected_transform_failure";
    const safeError={
      code,
      retryable:error.retryable,
    };
    const result=await withTransformControlRole(this.database,(client)=>client.query<{outcome:string}>(
        `select control_plane.retry_or_fail_canonical_transform_job(
           $1::text,$2::text,$3::text,$4::text,$5::jsonb,$6::integer,$7::integer
         ) as outcome`,
        [
          claim.job.tenantId,claim.job.transformJobId,claim.workerId,claim.leaseToken,
          JSON.stringify(safeError),Math.max(1,options.retryDelaySeconds),options.maxAttempts,
        ],
      ));
    const outcome=result.rows[0]?.outcome;
    if(outcome!=="retry_wait"&&outcome!=="failed")throw new Error("canonical_queue_invalid_failure_outcome");
    return outcome;
  }

  async metrics():Promise<readonly CanonicalTransformQueueMetric[]>{
    const result=await withTransformControlRole(this.database,(client)=>client.query<{status:string;job_count:number|string;oldest_age_seconds:number|string}>(
        "select status,job_count,oldest_age_seconds from control_plane.canonical_transform_queue_metrics()",
      ));
    return result.rows.map((row)=>{
      if(!STATUSES.has(row.status))throw new Error("canonical_queue_invalid_status");
      return Object.freeze({
        status:row.status as CanonicalTransformQueueMetric["status"],
        jobCount:integer(row.job_count,"job_count"),
        oldestAgeSeconds:integer(row.oldest_age_seconds,"oldest_age_seconds"),
      });
    });
  }
}
