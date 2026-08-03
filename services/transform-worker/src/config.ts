export type TransformWorkerConfig = Readonly<{
  controlPlaneDatabaseUrl:string;
  transformDatabaseUrl:string;
  mappingVersion:string;
  workerId:string;
  serviceVersion:string;
  port:number;
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

export function loadTransformWorkerConfig(source:NodeJS.ProcessEnv=process.env):TransformWorkerConfig{
  const mappingVersion=source.ALBERT_MAPPING_VERSION?.trim()||"m2-v1";
  if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(mappingVersion)){
    throw new Error("ALBERT_MAPPING_VERSION is invalid.");
  }
  const workerId=required(source,"ALBERT_TRANSFORM_WORKER_ID");
  if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(workerId)){
    throw new Error("ALBERT_TRANSFORM_WORKER_ID is invalid.");
  }
  const port=Number(source.PORT??"8080");
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error("PORT is invalid.");
  return Object.freeze({
    controlPlaneDatabaseUrl:postgresUrl(
      required(source,"TRANSFORM_CONTROL_PLANE_DATABASE_URL"),
      "TRANSFORM_CONTROL_PLANE_DATABASE_URL",
    ),
    transformDatabaseUrl:postgresUrl(required(source,"TRANSFORM_DATABASE_URL"),"TRANSFORM_DATABASE_URL"),
    mappingVersion,
    workerId,
    serviceVersion:source.ALBERT_SERVICE_VERSION?.trim()||"development",
    port,
  });
}
