import type { CanonicalTransformPipeline } from "../../sync-workers/src/canonical-pipeline.js";
import type { ClaimedCanonicalTransformJob,DurableCanonicalTransformQueue } from "./types.js";

function transformFailure(error:unknown):Readonly<{
  code:string;
  detail:string;
  retryable:boolean;
  retryDelaySeconds:number;
}>{
  const detail=error instanceof Error?error.message:"unknown_transform_error";
  const code=detail.split(":",1)[0]!.replace(/[^a-z0-9_.-]/gi,"_").toLowerCase();
  const permanent=/(_invalid|_unsupported|_mismatch|_non_authoritative|mapper_empty|mapper_missing|manifest_missing|staging_contract_missing|scope_not_established)$/.test(code);
  return{code,detail,retryable:!permanent,retryDelaySeconds:code.includes("reference_missing")?15:30};
}

export class CanonicalTransformProcessor{
  constructor(
    private readonly queue:DurableCanonicalTransformQueue,
    private readonly pipeline:CanonicalTransformPipeline,
  ){}

  async process(claim:ClaimedCanonicalTransformJob):Promise<void>{
    try{
      const result=await this.pipeline.transformBatch(
        claim.job,
        claim.job.stream,
        claim.job.domains,
        claim.job.backfillComplete,
        true,
      );
      await this.queue.complete(claim,{...result,mappingVersion:claim.job.mappingVersion});
    }catch(error){
      const failure=transformFailure(error);
      await this.queue.retryOrFail(
        claim,
        {code:failure.code,retryable:failure.retryable,detail:failure.detail},
        {retryDelaySeconds:failure.retryDelaySeconds,maxAttempts:12},
      );
    }
  }
}
