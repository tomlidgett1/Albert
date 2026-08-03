import type { CanonicalTransformPipeline } from "../../sync-workers/src/canonical-pipeline.js";
import type { ClaimedCanonicalTransformJob,DurableCanonicalTransformQueue } from "./types.js";

export type TransformFailureEvidence=Readonly<{
  code:string;
  retryable:boolean;
  retryDelaySeconds:number;
}>;

export type TransformProcessOutcome=
  | Readonly<{status:"completed"}>
  | Readonly<{
      status:"retry_scheduled"|"failed";
      failure:Readonly<{code:string;retryable:boolean}>;
      retryDelaySeconds:number;
    }>;

const databaseFailureCodes:Readonly<Record<string,Readonly<{code:string;retryable:boolean}>>>=Object.freeze({
  "40001":Object.freeze({code:"database_serialization_conflict",retryable:true}),
  "40P01":Object.freeze({code:"database_deadlock",retryable:true}),
  "42501":Object.freeze({code:"database_permission_denied",retryable:false}),
  "57P01":Object.freeze({code:"database_unavailable",retryable:true}),
  "08000":Object.freeze({code:"database_unavailable",retryable:true}),
  "08003":Object.freeze({code:"database_unavailable",retryable:true}),
  "08006":Object.freeze({code:"database_unavailable",retryable:true}),
  "23503":Object.freeze({code:"database_integrity_violation",retryable:false}),
  "23505":Object.freeze({code:"database_integrity_violation",retryable:false}),
});

const trustedTransformCode=/^(?:canonical|transform|readiness|identity|source_authority|dossier|projection|reconciliation|capability|analytical|database|unsafe)_[a-z0-9_.-]{1,100}$/u;

/** Convert arbitrary exceptions to a bounded code-only operational record. */
export function transformFailure(error:unknown):TransformFailureEvidence{
  if(error&&typeof error==="object"){
    const candidate=error as Readonly<{code?:unknown;name?:unknown}>;
    if(typeof candidate.code==="string"&&databaseFailureCodes[candidate.code]){
      const mapped=databaseFailureCodes[candidate.code]!;
      return Object.freeze({...mapped,retryDelaySeconds:mapped.retryable?30:0});
    }
    if(candidate.name==="AbortError"||candidate.name==="TimeoutError"){
      return Object.freeze({code:"transform_operation_timeout",retryable:true,retryDelaySeconds:30});
    }
    if(candidate.name==="TypeError"||candidate.name==="SyntaxError"){
      return Object.freeze({code:"transform_internal_error",retryable:false,retryDelaySeconds:0});
    }
  }
  const message=error instanceof Error?error.message:"";
  const candidate=message.split(":",1)[0]!.trim().toLowerCase();
  const code=trustedTransformCode.test(candidate)
    ? candidate
    : "unexpected_transform_failure";
  const permanent=/(_invalid|_unsupported|_mismatch|_non_authoritative|mapper_empty|mapper_missing|manifest_missing|staging_contract_missing|scope_not_established)$/.test(code);
  return Object.freeze({
    code,
    retryable:!permanent,
    retryDelaySeconds:permanent?0:code.includes("reference_missing")?15:30,
  });
}

export class CanonicalTransformProcessor{
  constructor(
    private readonly queue:DurableCanonicalTransformQueue,
    private readonly pipeline:CanonicalTransformPipeline,
  ){}

  async process(claim:ClaimedCanonicalTransformJob):Promise<TransformProcessOutcome>{
    try{
      const result=await this.pipeline.transformBatch(
        claim.job,
        claim.job.stream,
        claim.job.domains,
        claim.job.backfillComplete,
        true,
        {
          kind:"canonical_transform",
          tenantId:claim.job.tenantId,
          transformJobId:claim.job.transformJobId,
          workerId:claim.workerId,
          leaseToken:claim.leaseToken,
        },
      );
      await this.queue.complete(claim,{...result,mappingVersion:claim.job.mappingVersion});
      return Object.freeze({status:"completed"});
    }catch(error){
      const failure=transformFailure(error);
      const outcome=await this.queue.retryOrFail(
        claim,
        {code:failure.code,retryable:failure.retryable},
        {retryDelaySeconds:failure.retryDelaySeconds,maxAttempts:12},
      );
      return Object.freeze({
        status:outcome==="retry_wait"?"retry_scheduled":"failed",
        failure:Object.freeze({
          code:failure.code,
          retryable:outcome==="retry_wait",
        }),
        retryDelaySeconds:failure.retryDelaySeconds,
      });
    }
  }
}
