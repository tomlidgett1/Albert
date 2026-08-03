import { CanonicalTransformProcessor } from "./processor.js";
import type { DurableCanonicalTransformQueue } from "./types.js";

export type TransformWorkerHealth=Readonly<{
  ready:boolean;
  startedAt:string;
  workerId:string;
  concurrency:number;
  activeJobs:number;
  lastClaimAt:string|null;
  lastCompletionAt:string|null;
  lastSnapshotAt:string|null;
  lastIdentityProjectionAt:string|null;
  lastErrorCode:string|null;
  lastIdentityProjectionErrorCode:string|null;
}>;

function wait(milliseconds:number,signal:AbortSignal):Promise<void>{
  return new Promise((resolve)=>{
    if(signal.aborted)return resolve();
    const timer=setTimeout(resolve,milliseconds);
    signal.addEventListener("abort",()=>{clearTimeout(timer);resolve();},{once:true});
  });
}

export class CanonicalTransformWorkerService{
  private readonly startedAt=new Date().toISOString();
  private ready=false;
  private activeJobs=0;
  private lastClaimAt:string|null=null;
  private lastCompletionAt:string|null=null;
  private lastSnapshotAt:string|null=null;
  private lastIdentityProjectionAt:string|null=null;
  private lastErrorCode:string|null=null;
  private lastIdentityProjectionErrorCode:string|null=null;
  private snapshotRunning=false;
  private identityProjectionRunning=false;

  constructor(
    private readonly workerId:string,
    private readonly mappingVersion:string,
    private readonly queue:DurableCanonicalTransformQueue,
    private readonly processor:CanonicalTransformProcessor,
    private readonly snapshotAllTenants:()=>Promise<number>,
    private readonly reconcileIdentityDecisions:()=>Promise<number>,
    private readonly options:Readonly<{
      leaseSeconds?:number;
      emptyPollDelayMs?:number;
      snapshotIntervalMs?:number;
      identityProjectionIntervalMs?:number;
      concurrency?:number;
    }>={},
  ){
    if(!workerId.trim())throw new Error("A stable transform worker id is required.");
    const concurrency=options.concurrency??1;
    if(!Number.isInteger(concurrency)||concurrency<1||concurrency>64){
      throw new Error("Transform worker concurrency must be an integer between 1 and 64.");
    }
  }

  health():TransformWorkerHealth{
    return Object.freeze({
      ready:this.ready,startedAt:this.startedAt,workerId:this.workerId,
      concurrency:this.options.concurrency??1,
      activeJobs:this.activeJobs,lastClaimAt:this.lastClaimAt,
      lastCompletionAt:this.lastCompletionAt,lastSnapshotAt:this.lastSnapshotAt,
      lastIdentityProjectionAt:this.lastIdentityProjectionAt,
      lastErrorCode:this.lastErrorCode,
      lastIdentityProjectionErrorCode:this.lastIdentityProjectionErrorCode,
    });
  }

  async run(signal:AbortSignal):Promise<void>{
    await this.queue.preflight();
    this.ready=true;
    void this.runSnapshot();
    const snapshotTimer=setInterval(()=>{
      void this.runSnapshot();
    },this.options.snapshotIntervalMs??3_600_000);
    snapshotTimer.unref();
    void this.runIdentityProjection();
    const identityProjectionTimer=setInterval(()=>{
      void this.runIdentityProjection();
    },this.options.identityProjectionIntervalMs??1_000);
    identityProjectionTimer.unref();
    try{
      await Promise.all(Array.from(
        {length:this.options.concurrency??1},
        ()=>this.runLane(signal),
      ));
    }finally{
      clearInterval(snapshotTimer);
      clearInterval(identityProjectionTimer);
      this.ready=false;
    }
  }

  private async runLane(signal:AbortSignal):Promise<void>{
    while(!signal.aborted){
      let claim;
      try{
        claim=await this.queue.claim({
          workerId:this.workerId,
          mappingVersion:this.mappingVersion,
          leaseSeconds:this.options.leaseSeconds??900,
        });
      }catch{
        this.lastErrorCode="transform_queue_claim_failed";
        await wait(1_000,signal);
        continue;
      }
      if(!claim){await wait(this.options.emptyPollDelayMs??500,signal);continue;}
      this.lastClaimAt=new Date().toISOString();
      this.activeJobs+=1;
      const leaseSeconds=this.options.leaseSeconds??900;
      const extension=setInterval(()=>{
        void this.queue.extendLease(claim,leaseSeconds).catch(()=>{
          this.lastErrorCode="transform_lease_extension_failed";
        });
      },Math.max(30_000,Math.floor(leaseSeconds*1_000/3)));
      extension.unref();
      try{
        const outcome=await this.processor.process(claim);
        if(outcome.status==="completed"){
          this.lastCompletionAt=new Date().toISOString();
          this.lastErrorCode=null;
        }else if(outcome.status==="continuation_scheduled"){
          this.lastErrorCode=null;
        }else{
          this.lastErrorCode=outcome.failure.code;
        }
      }catch{
        this.lastErrorCode="transform_job_processing_failed";
      }finally{
        clearInterval(extension);
        this.activeJobs-=1;
      }
    }
  }

  private async runSnapshot():Promise<void>{
    if(this.snapshotRunning)return;
    this.snapshotRunning=true;
    try{
      await this.snapshotAllTenants();
      this.lastSnapshotAt=new Date().toISOString();
    }catch{
      this.lastErrorCode="transform_snapshot_failed";
    }finally{this.snapshotRunning=false;}
  }

  private async runIdentityProjection():Promise<void>{
    if(this.identityProjectionRunning)return;
    this.identityProjectionRunning=true;
    try{
      const processed=await this.reconcileIdentityDecisions();
      this.lastIdentityProjectionErrorCode=null;
      if(processed>0)this.lastIdentityProjectionAt=new Date().toISOString();
    }catch{
      this.lastIdentityProjectionErrorCode="identity_projection_reconciliation_failed";
    }finally{this.identityProjectionRunning=false;}
  }
}
