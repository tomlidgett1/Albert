import { loadReplicaWorkerId } from "../../../packages/shared/src/index.js";
import { assertProductionRuntimeBoundary } from "../../../packages/config/src/production-boundary.js";

export type TransformWorkerConfig = Readonly<{
  controlPlaneDatabaseUrl:string;
  transformDatabaseUrl:string;
  mappingVersion:string;
  workerId:string;
  workerConcurrency:number;
  queueSlaSeconds:number;
  snapshotClaimBatchSize:number;
  snapshotMaxClaimsPerRun:number;
  serviceVersion:string;
  port:number;
  metricsPort:number;
}>;

function required(source:NodeJS.ProcessEnv,name:string):string{
  const value=source[name]?.trim();
  if(!value)throw new Error(`Albert transform worker is missing ${name}.`);
  return value;
}

function postgresUrl(value:string,name:string):string{
  try{
    const parsed=new URL(value);
    if(parsed.protocol!=="postgres:"&&parsed.protocol!=="postgresql:")throw new Error();
  }catch{
    throw new Error(`${name} is not a PostgreSQL URL.`);
  }
  return value;
}

function boundedInteger(
  source:NodeJS.ProcessEnv,
  name:string,
  fallback:number,
  minimum:number,
  maximum:number,
):number{
  const value=Number(source[name]??fallback);
  if(!Number.isInteger(value)||value<minimum||value>maximum){
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

export function loadTransformWorkerConfig(source:NodeJS.ProcessEnv=process.env):TransformWorkerConfig{
  assertProductionRuntimeBoundary(source,{
    label:"transform worker",controlProject:true,analyticalRegion:true,
    storageRegion:false,modelDataResidency:false,lightspeedProduct:false,
    databaseLogins:{
      TRANSFORM_CONTROL_PLANE_DATABASE_URL:"albert_transform_control_runtime",
      TRANSFORM_DATABASE_URL:"albert_transform_analytical_runtime",
    },
    distinctDatabaseVariables:["TRANSFORM_CONTROL_PLANE_DATABASE_URL","TRANSFORM_DATABASE_URL"],
  });
  const mappingVersion=source.ALBERT_MAPPING_VERSION?.trim()||"m2-v1";
  if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(mappingVersion)){
    throw new Error("ALBERT_MAPPING_VERSION is invalid.");
  }
  const workerId=loadReplicaWorkerId(
    source,
    "ALBERT_TRANSFORM_WORKER_ID",
    "Albert transform worker is missing ALBERT_TRANSFORM_WORKER_ID.",
  );
  const port=Number(source.PORT??"8080");
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error("PORT is invalid.");
  const metricsPort=boundedInteger(source,"ALBERT_METRICS_PORT",9091,1,65535);
  if(metricsPort===port)throw new Error("ALBERT_METRICS_PORT must differ from PORT.");
  const workerConcurrency=boundedInteger(source,"ALBERT_WORKER_CONCURRENCY",8,1,64);
  const queueSlaSeconds=boundedInteger(source,"ALBERT_QUEUE_SLA_SECONDS",120,30,3600);
  const snapshotClaimBatchSize=boundedInteger(
    source,"ALBERT_SNAPSHOT_CLAIM_BATCH_SIZE",workerConcurrency,1,100,
  );
  const snapshotMaxClaimsPerRun=boundedInteger(
    source,"ALBERT_SNAPSHOT_MAX_CLAIMS_PER_RUN",20_000,100,100_000,
  );
  return Object.freeze({
    controlPlaneDatabaseUrl:postgresUrl(
      required(source,"TRANSFORM_CONTROL_PLANE_DATABASE_URL"),
      "TRANSFORM_CONTROL_PLANE_DATABASE_URL",
    ),
    transformDatabaseUrl:postgresUrl(required(source,"TRANSFORM_DATABASE_URL"),"TRANSFORM_DATABASE_URL"),
    mappingVersion,
    workerId,
    workerConcurrency,
    queueSlaSeconds,
    snapshotClaimBatchSize,
    snapshotMaxClaimsPerRun,
    serviceVersion:source.ALBERT_SERVICE_VERSION?.trim()||"development",
    port,
    metricsPort,
  });
}
