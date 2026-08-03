import { createServer,type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { mapDeputyCanonical } from "../../../connectors/deputy/canonical.js";
import { mapLightspeedCanonical } from "../../../connectors/lightspeed-r/canonical.js";
import { mapXeroCanonical } from "../../../connectors/xero/canonical.js";
import { createServiceLogger,safeErrorEvidence } from "../../../packages/observability/src/index.js";
import { CanonicalTransformPipeline } from "../../sync-workers/src/canonical-pipeline.js";
import { PgTransactionalDatabase } from "../../sync-workers/src/postgres.js";
import { loadTransformWorkerConfig } from "./config.js";
import { CanonicalTransformProcessor } from "./processor.js";
import { PostgresCanonicalTransformQueue } from "./queue.js";
import { CanonicalTransformWorkerService } from "./service.js";

const logger=createServiceLogger("transform-worker");

function json(response:ServerResponse,status:number,value:unknown):void{
  const payload=JSON.stringify(value);
  response.writeHead(status,{
    "cache-control":"private, no-store",
    "content-length":Buffer.byteLength(payload),
    "content-type":"application/json; charset=utf-8",
    "x-content-type-options":"nosniff",
  });
  response.end(payload);
}

async function listen(server:ReturnType<typeof createServer>,port:number):Promise<void>{
  await new Promise<void>((resolve,reject)=>{
    const onError=(error:Error)=>{server.off("listening",onListening);reject(error);};
    const onListening=()=>{server.off("error",onError);resolve();};
    server.once("error",onError);
    server.once("listening",onListening);
    server.listen(port,"0.0.0.0");
  });
}

async function closeServer(server:ReturnType<typeof createServer>):Promise<void>{
  server.closeIdleConnections();
  await new Promise<void>((resolve)=>server.close(()=>resolve()));
}

export async function runTransformWorker():Promise<void>{
  const config=loadTransformWorkerConfig();
  const controlDatabase=new PgTransactionalDatabase(config.controlPlaneDatabaseUrl,{
    applicationName:`albert-transform-control/${config.serviceVersion}`,
    maxConnections:6,
  });
  const transformDatabase=new PgTransactionalDatabase(config.transformDatabaseUrl,{
    applicationName:`albert-transform/${config.serviceVersion}`,
    maxConnections:8,
  });
  const queue=new PostgresCanonicalTransformQueue(controlDatabase);
  const pipeline=new CanonicalTransformPipeline(
    transformDatabase,
    controlDatabase,
    config.mappingVersion,
    {
      "lightspeed-r":mapLightspeedCanonical,
      xero:mapXeroCanonical,
      deputy:mapDeputyCanonical,
    },
  );
  const processor=new CanonicalTransformProcessor(queue,pipeline);
  const service=new CanonicalTransformWorkerService(
    config.workerId,
    config.mappingVersion,
    queue,
    processor,
    ()=>pipeline.snapshotAllTenants(),
    ()=>pipeline.reconcileIdentityDecisions(config.workerId),
    {
      leaseSeconds:900,emptyPollDelayMs:500,snapshotIntervalMs:3_600_000,
      identityProjectionIntervalMs:1_000,
    },
  );

  const dependenciesReady=async()=>{
    await Promise.all([
      queue.preflight(),
      pipeline.identityDecisionProjectionMetrics(),
      transformDatabase.transaction(async(client)=>{
        await client.query("set local role transform_rw");
        const role=await client.query<{role_name:string;can_transform:boolean}>(
        `select current_user as role_name,
                pg_has_role(session_user,'transform_rw','member') as can_transform`,
        );
        if(role.rows[0]?.role_name!=="transform_rw"||role.rows[0]?.can_transform!==true){
          throw new Error("transform_database_role_not_ready");
        }
        await client.query("select semantic_internal.assert_transform_runtime_boundary()");
      }),
    ]);
  };
  await dependenciesReady();

  const server=createServer({maxHeaderSize:16*1024},(request,response)=>{
    void (async()=>{
      const pathname=new URL(request.url??"/","http://transform-worker.internal").pathname;
      if(request.method==="GET"&&pathname==="/livez"){
        json(response,200,{live:true,service:"albert-transform-worker"});
        return;
      }
      if(request.method==="GET"&&pathname==="/readyz"){
        const health=service.health();
        if(health.ready){
          try{
            await dependenciesReady();
            json(response,200,{ready:true,workerId:health.workerId,activeJobs:health.activeJobs});
            return;
          }catch{
            // Emit only the non-sensitive readiness state.
          }
        }
        json(response,503,{ready:false});
        return;
      }
      if(request.method==="GET"&&pathname==="/v1/metrics"){
        const health=service.health();
        try{
          const [queueMetrics,identityDecisionProjections]=await Promise.all([
            queue.metrics(),pipeline.identityDecisionProjectionMetrics(),
          ]);
          json(response,200,{worker:health,queue:queueMetrics,identityDecisionProjections});
        }
        catch{json(response,503,{worker:health,queue:[]});}
        return;
      }
      json(response,404,{error:"not_found"});
    })().catch(()=>{
      if(!response.headersSent)json(response,500,{error:"internal_error"});
      else response.destroy();
    });
  });
  server.headersTimeout=10_000;
  server.requestTimeout=15_000;
  server.keepAliveTimeout=5_000;
  server.maxRequestsPerSocket=1_000;
  server.maxHeadersCount=100;

  const abort=new AbortController();
  let shuttingDown=false;
  const beginShutdown=()=>{
    if(shuttingDown)return;
    shuttingDown=true;
    abort.abort();
    void closeServer(server);
  };
  process.once("SIGINT",beginShutdown);
  process.once("SIGTERM",beginShutdown);

  const startedAt=service.health().startedAt;
  const heartbeat=async()=>{
    const health=service.health();
    await controlDatabase.transaction(async(client)=>{
      await client.query("set local role albert_transform_control");
      await client.query(
        `select control_plane.heartbeat_worker(
           $1::text,$2::text,$3::text,$4::timestamptz,$5::integer,$6::jsonb
         )`,
        [
          config.workerId,config.serviceVersion,
          process.env.ALBERT_DEPLOYMENT_ID?.trim()||null,startedAt,health.activeJobs,
          JSON.stringify({
            service:"transform-worker",ready:health.ready,lastClaimAt:health.lastClaimAt,
            lastCompletionAt:health.lastCompletionAt,lastSnapshotAt:health.lastSnapshotAt,
            lastIdentityProjectionAt:health.lastIdentityProjectionAt,
            lastErrorCode:health.lastErrorCode,mappingVersion:config.mappingVersion,
            lastIdentityProjectionErrorCode:health.lastIdentityProjectionErrorCode,
          }),
        ],
      );
    });
  };

  try{
    await listen(server,config.port);
    logger.info("worker_started",{port:config.port,workerId:config.workerId,mappingVersion:config.mappingVersion});
    const heartbeatTimer=setInterval(()=>void heartbeat().catch(()=>undefined),15_000);
    heartbeatTimer.unref();
    try{
      await heartbeat();
      await service.run(abort.signal);
    }finally{clearInterval(heartbeatTimer);}
  }finally{
    logger.info("worker_stopping",{workerId:config.workerId});
    abort.abort();
    process.off("SIGINT",beginShutdown);
    process.off("SIGTERM",beginShutdown);
    if(server.listening)await closeServer(server);
    await Promise.allSettled([controlDatabase.close(),transformDatabase.close()]);
  }
}

const invokedPath=process.argv[1]?pathToFileURL(process.argv[1]).href:"";
if(import.meta.url===invokedPath){
  runTransformWorker().catch((error)=>{
    logger.error("worker_startup_failed",safeErrorEvidence(error));
    process.exitCode=1;
  });
}
