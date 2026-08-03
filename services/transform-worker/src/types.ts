import type { CanonicalTransformBatch } from "../../sync-workers/src/canonical-contract.js";

export type CanonicalTransformJob = CanonicalTransformBatch & Readonly<{
  transformJobId: string;
  stream: string;
  domains: readonly string[];
  backfillComplete: boolean;
  attemptCount: number;
}>;

export type ClaimedCanonicalTransformJob = Readonly<{
  workerId: string;
  leaseToken: string;
  leaseExpiresAt: string;
  job: CanonicalTransformJob;
}>;

export type CanonicalTransformQueueMetric = Readonly<{
  status: "queued" | "running" | "retry_wait" | "succeeded" | "failed";
  jobCount: number;
  oldestAgeSeconds: number;
}>;

export interface DurableCanonicalTransformQueue {
  preflight(): Promise<void>;
  claim(input: Readonly<{
    workerId: string;
    mappingVersion: string;
    leaseSeconds: number;
  }>): Promise<ClaimedCanonicalTransformJob|null>;
  extendLease(claim:ClaimedCanonicalTransformJob,leaseSeconds:number):Promise<string>;
  complete(
    claim:ClaimedCanonicalTransformJob,
    result:Readonly<Record<string,unknown>>,
  ):Promise<void>;
  retryOrFail(
    claim:ClaimedCanonicalTransformJob,
    error:Readonly<{code:string;retryable:boolean;detail?:string}>,
    options:Readonly<{retryDelaySeconds:number;maxAttempts:number}>,
  ):Promise<"retry_wait"|"failed">;
  metrics():Promise<readonly CanonicalTransformQueueMetric[]>;
}
