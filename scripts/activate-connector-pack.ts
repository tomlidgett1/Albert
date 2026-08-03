import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { isConnectorPackVersion } from "../packages/connector-sdk/src/contract.js";

type ConnectorId = "lightspeed-r" | "xero" | "deputy";

export type ConnectorPackActivationInput = Readonly<{
  databaseUrl: string;
  connectorId: ConnectorId;
  candidatePackVersion: string;
  expectedActivePackVersion: string;
  checkOnly: boolean;
}>;

function requiredOption(values:ReadonlyMap<string,string>,name:string):string{
  const value=values.get(name)?.trim();
  if(!value)throw new Error(`--${name} is required.`);
  return value;
}

function migrationDatabaseUrl(source:NodeJS.ProcessEnv):string{
  const value=source.ANALYTICAL_MIGRATION_URL?.trim();
  if(!value)throw new Error("ANALYTICAL_MIGRATION_URL is required.");
  let parsed:URL;
  try{parsed=new URL(value);}catch{throw new Error("ANALYTICAL_MIGRATION_URL must be a PostgreSQL URL.");}
  if(parsed.protocol!=="postgres:"&&parsed.protocol!=="postgresql:"){
    throw new Error("ANALYTICAL_MIGRATION_URL must be a PostgreSQL URL.");
  }
  if(parsed.username!=="albert_analytical_deployer"){
    throw new Error("Connector-pack activation requires the dedicated albert_analytical_deployer login.");
  }
  const local=["127.0.0.1","localhost","::1","[::1]"].includes(parsed.hostname);
  const sslMode=parsed.searchParams.get("sslmode")?.toLowerCase();
  if(!local&&!sslMode?.match(/^(?:require|verify-ca|verify-full)$/u)){
    throw new Error("Remote ANALYTICAL_MIGRATION_URL must require TLS with sslmode=require or stronger.");
  }
  return value;
}

export function loadConnectorPackActivationInput(
  source:NodeJS.ProcessEnv=process.env,
  arguments_:readonly string[]=process.argv.slice(2),
):ConnectorPackActivationInput{
  const values=new Map<string,string>();
  let checkOnly=false;
  for(const argument of arguments_){
    if(argument==="--check"){
      if(checkOnly)throw new Error("--check may be specified only once.");
      checkOnly=true;
      continue;
    }
    const match=/^--(connector|candidate|expected-active)=(.+)$/u.exec(argument);
    if(!match)throw new Error(`Unknown connector-pack activation option: ${argument}`);
    const name=match[1]!;
    if(values.has(name))throw new Error(`--${name} may be specified only once.`);
    values.set(name,match[2]!);
  }
  const connector=requiredOption(values,"connector");
  if(connector!=="lightspeed-r"&&connector!=="xero"&&connector!=="deputy"){
    throw new Error("--connector must be lightspeed-r, xero, or deputy.");
  }
  const candidatePackVersion=requiredOption(values,"candidate");
  const expectedActivePackVersion=requiredOption(values,"expected-active");
  if(!isConnectorPackVersion(candidatePackVersion)||!isConnectorPackVersion(expectedActivePackVersion)){
    throw new Error("Connector pack versions must be release-grade semantic versions.");
  }
  if(candidatePackVersion===expectedActivePackVersion){
    throw new Error("The candidate and expected active pack versions must differ.");
  }
  return Object.freeze({
    databaseUrl:migrationDatabaseUrl(source),connectorId:connector,
    candidatePackVersion,expectedActivePackVersion,checkOnly,
  });
}

export async function runConnectorPackActivation(input:ConnectorPackActivationInput):Promise<Readonly<Record<string,unknown>>>{
  const client=new Client({
    connectionString:input.databaseUrl,
    application_name:"albert-connector-pack-activation",
    connectionTimeoutMillis:10_000,
  });
  await client.connect();
  try{
    await client.query("begin");
    try{
      await client.query("set local lock_timeout='5min'");
      await client.query("set local idle_in_transaction_session_timeout='6min'");
      await client.query("set local role albert_migration_owner");
      const identity=await client.query<{current_user:string;session_user:string}>(
        "select current_user,session_user",
      );
      if(identity.rows[0]?.current_user!=="albert_migration_owner"||
         identity.rows[0]?.session_user!=="albert_analytical_deployer"){
        throw new Error("Dedicated analytical migration identity was not established.");
      }
      const functionName=input.checkOnly
        ?"semantic_internal.connector_pack_activation_status"
        :"semantic_internal.activate_connector_pack";
      const result=await client.query<{result:Readonly<Record<string,unknown>>}>(
        `select ${functionName}($1::text,$2::text,$3::text) as result`,
        [input.connectorId,input.candidatePackVersion,input.expectedActivePackVersion],
      );
      const summary=result.rows[0]?.result;
      if(!summary||typeof summary!=="object"||Array.isArray(summary)){
        throw new Error("Connector-pack activation returned invalid evidence.");
      }
      if(summary.ready!==true){
        throw new Error(`Connector-pack candidate is not ready: ${JSON.stringify(summary)}`);
      }
      await client.query("commit");
      return Object.freeze({...summary});
    }catch(error){
      await client.query("rollback").catch(()=>undefined);
      throw error;
    }
  }finally{
    await client.end();
  }
}

async function main():Promise<void>{
  const input=loadConnectorPackActivationInput();
  const summary=await runConnectorPackActivation(input);
  process.stdout.write(`${input.checkOnly?"ready":"activated"} ${input.connectorId} ${input.candidatePackVersion} ${JSON.stringify(summary)}\n`);
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  await main();
}
