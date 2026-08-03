import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServiceLogger,safeErrorEvidence } from "../../../packages/observability/src/index.js";
import { createPostgresSemanticComposition,type ClosablePgPool,type SemanticServiceComposition } from "./composition.js";
import { OpenAIEmbeddingProvider } from "./embeddings.js";
import { startSemanticNodeServer } from "./node-server.js";

const logger=createServiceLogger("semantic-query");

type PgModule=Readonly<{Pool:new(options:Readonly<{connectionString:string;max?:number;application_name?:string}>)=>ClosablePgPool}>;

export async function startSemanticServiceFromEnvironment(environment:NodeJS.ProcessEnv=process.env):Promise<Readonly<{close:()=>Promise<void>;url:string}>>{
  const signingSecret=required(environment,"ALBERT_SEMANTIC_SIGNING_SECRET");
  if(new TextEncoder().encode(signingSecret).byteLength<32)throw new Error("ALBERT_SEMANTIC_SIGNING_SECRET must be at least 32 bytes.");
  const composition=environment.ALBERT_SEMANTIC_COMPOSITION_MODULE
    ? await loadExternalComposition(environment.ALBERT_SEMANTIC_COMPOSITION_MODULE,signingSecret)
    : await createEnvironmentPostgresComposition(environment);
  return startSemanticNodeServer({
    composition,signingSecret,
    host:environment.ALBERT_SEMANTIC_HOST??"127.0.0.1",
    port:integerEnvironment(environment.ALBERT_SEMANTIC_PORT,8788),
    shutdownGraceMs:integerEnvironment(environment.ALBERT_SEMANTIC_SHUTDOWN_GRACE_MS,10_000),
  });
}

async function createEnvironmentPostgresComposition(environment:NodeJS.ProcessEnv):Promise<SemanticServiceComposition>{
  const pg=await loadPg();
  const analyticalDatabaseUrl=required(environment,"ANALYTICAL_DATABASE_URL");
  const controlPlanePool=new pg.Pool({connectionString:required(environment,"CONTROL_PLANE_DATABASE_URL"),max:integerEnvironment(environment.ALBERT_CONTROL_PLANE_POOL_SIZE,4),application_name:"albert-semantic-control"});
  const analyticalReadPool=new pg.Pool({connectionString:analyticalDatabaseUrl,max:integerEnvironment(environment.ALBERT_ANALYTICAL_READ_POOL_SIZE,10),application_name:"albert-semantic-read"});
  const semanticMetadataPool=new pg.Pool({connectionString:required(environment,"ALBERT_SEMANTIC_METADATA_DATABASE_URL"),max:integerEnvironment(environment.ALBERT_SEMANTIC_METADATA_POOL_SIZE,4),application_name:"albert-semantic-metadata"});
  try{
    const embeddingProvider=new OpenAIEmbeddingProvider({apiKey:required(environment,"OPENAI_API_KEY"),baseURL:required(environment,"OPENAI_BASE_URL"),timeoutMs:integerEnvironment(environment.ALBERT_EMBEDDING_TIMEOUT_MS,20_000)});
    return createPostgresSemanticComposition({registryPath:resolve(environment.ALBERT_SEMANTIC_REGISTRY_PATH??"packages/semantic-registry/registry/registry.yaml"),controlPlanePool,analyticalReadPool,semanticMetadataPool,embeddingProvider,cacheTtlSeconds:integerEnvironment(environment.ALBERT_SEMANTIC_CACHE_TTL_SECONDS,300),statementTimeoutMs:integerEnvironment(environment.ALBERT_SEMANTIC_STATEMENT_TIMEOUT_MS,10_000)});
  }catch(error){await Promise.all([controlPlanePool.end?.(),analyticalReadPool.end?.(),semanticMetadataPool.end?.()]);throw error;}
}

async function loadExternalComposition(modulePath:string,signingSecret:string):Promise<SemanticServiceComposition>{
  const compositionModule=await import(pathToFileURL(resolve(modulePath)).href) as Readonly<{createSemanticComposition?:(input:Readonly<{signingSecret:string}>)=>Promise<SemanticServiceComposition>|SemanticServiceComposition}>;
  if(!compositionModule.createSemanticComposition)throw new Error("ALBERT_SEMANTIC_COMPOSITION_MODULE must export createSemanticComposition().");
  return compositionModule.createSemanticComposition({signingSecret});
}

async function loadPg():Promise<PgModule>{
  try{
    const dynamicImport=Function("specifier","return import(specifier)") as (specifier:string)=>Promise<unknown>;
    const pgModule=await dynamicImport("pg") as {default?:PgModule;Pool?:PgModule["Pool"]};
    const resolved=pgModule.default??pgModule;
    if(!resolved.Pool)throw new Error("pg Pool export is unavailable.");
    return resolved as PgModule;
  }catch(error){throw new Error(`The semantic service image must provide the pg package: ${error instanceof Error?error.message:String(error)}`);}
}

function required(environment:NodeJS.ProcessEnv,key:string):string{const value=environment[key]?.trim();if(!value)throw new Error(`${key} is required.`);return value;}
function integerEnvironment(value:string|undefined,fallback:number):number{if(value===undefined)return fallback;const parsed=Number(value);if(!Number.isInteger(parsed)||parsed<1)throw new Error(`Expected a positive integer environment value, received ${value}.`);return parsed;}

if(import.meta.url===pathToFileURL(process.argv[1]??"").href){
  const running=await startSemanticServiceFromEnvironment();
  logger.info("service_started",{url:running.url});
  let stopping=false;const stop=async(signal:string)=>{if(stopping)return;stopping=true;logger.info("service_stopping",{signal});try{await running.close();process.exitCode=0;}catch(error){logger.error("service_shutdown_failed",safeErrorEvidence(error));process.exitCode=1;}};
  process.once("SIGTERM",()=>{void stop("SIGTERM");});process.once("SIGINT",()=>{void stop("SIGINT");});
}
