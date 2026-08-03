import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Client, type ClientConfig } from "pg";

type Target="control-plane"|"analytical"|"both";

type ProvisioningInput=Readonly<{
  target:Target;
  controlPlaneAdminDatabaseUrl?:string;
  analyticalAdminDatabaseUrl?:string;
  keyId:string;
  secretBase64:string;
  activeAt:string;
  retireAt:string;
  previousKeyId?:string;
  previousRetireAt?:string;
}>;

type Cell=Readonly<{
  label:"control-plane"|"analytical";
  databaseUrl:string;
  migrationRole:"albert_control_migration_owner"|"albert_migration_owner";
  installSql:string;
  retireSql:string;
  pruneSql:string;
  readySql:string;
  inspectSql:string;
}>;

function required(source:NodeJS.ProcessEnv,name:string):string{
  const value=source[name]?.trim();
  if(!value)throw new Error(`${name} is required.`);
  return value;
}

function optional(source:NodeJS.ProcessEnv,name:string):string|undefined{
  return source[name]?.trim()||undefined;
}

function postgresUrl(value:string,name:string):string{
  let parsed:URL;
  try{parsed=new URL(value);}catch{throw new Error(`${name} must be a PostgreSQL URL.`);}
  if(parsed.protocol!=="postgres:"&&parsed.protocol!=="postgresql:"){
    throw new Error(`${name} must be a PostgreSQL URL.`);
  }
  if(!["localhost","127.0.0.1","::1"].includes(parsed.hostname)){
    const sslMode=parsed.searchParams.get("sslmode")?.toLowerCase();
    if(!sslMode||["disable","allow","prefer"].includes(sslMode)){
      throw new Error(`${name} must require TLS for a remote database.`);
    }
  }
  return value;
}

function timestamp(value:string,name:string):string{
  if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u.test(value)){
    throw new Error(`${name} must be an RFC 3339 UTC timestamp.`);
  }
  const parsed=new Date(value);
  if(Number.isNaN(parsed.valueOf()))throw new Error(`${name} is invalid.`);
  return parsed.toISOString();
}

function targetFromArguments(arguments_:readonly string[]):Target{
  const targetArgument=arguments_.find((value)=>value.startsWith("--target="));
  if(arguments_.some((value)=>!value.startsWith("--target="))){
    throw new Error("Only --target=control-plane|analytical is supported.");
  }
  if(!targetArgument)return"both";
  const value=targetArgument.slice("--target=".length);
  if(value!=="control-plane"&&value!=="analytical"){
    throw new Error("--target must be control-plane or analytical.");
  }
  return value;
}

function canonicalSecret(value:string):Buffer{
  if(value.length<44||value.length>88||value.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/u.test(value)){
    throw new Error("ANALYTICAL_CAPABILITY_SECRET_BASE64 must be canonical padded base64.");
  }
  const decoded=Buffer.from(value,"base64");
  if(decoded.byteLength<32||decoded.byteLength>64||decoded.toString("base64")!==value){
    decoded.fill(0);
    throw new Error("ANALYTICAL_CAPABILITY_SECRET_BASE64 must contain 32 to 64 bytes.");
  }
  return decoded;
}

export function loadAnalyticalCapabilityProvisioningInput(
  source:NodeJS.ProcessEnv=process.env,
  arguments_:readonly string[]=process.argv.slice(2),
):ProvisioningInput{
  const target=targetFromArguments(arguments_);
  const keyId=required(source,"ANALYTICAL_CAPABILITY_KEY_ID");
  if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u.test(keyId)){
    throw new Error("ANALYTICAL_CAPABILITY_KEY_ID is invalid.");
  }
  const activeAt=timestamp(required(source,"ANALYTICAL_CAPABILITY_ACTIVE_AT"),"ANALYTICAL_CAPABILITY_ACTIVE_AT");
  const retireAt=timestamp(required(source,"ANALYTICAL_CAPABILITY_RETIRE_AT"),"ANALYTICAL_CAPABILITY_RETIRE_AT");
  if(new Date(retireAt).valueOf()<=new Date(activeAt).valueOf()+10*60_000){
    throw new Error("The capability key lifetime must exceed ten minutes.");
  }
  if(new Date(retireAt).valueOf()<=Date.now()+10*60_000){
    throw new Error("ANALYTICAL_CAPABILITY_RETIRE_AT must retain a ten-minute release window.");
  }
  const secretBase64=required(source,"ANALYTICAL_CAPABILITY_SECRET_BASE64");
  const secret=canonicalSecret(secretBase64);
  secret.fill(0);
  const previousKeyId=optional(source,"ANALYTICAL_CAPABILITY_PREVIOUS_KEY_ID");
  const rawPreviousRetireAt=optional(source,"ANALYTICAL_CAPABILITY_PREVIOUS_RETIRE_AT");
  if(Boolean(previousKeyId)!==Boolean(rawPreviousRetireAt)){
    throw new Error("Previous capability key id and retirement timestamp must be provided together.");
  }
  if(previousKeyId&&!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u.test(previousKeyId)){
    throw new Error("ANALYTICAL_CAPABILITY_PREVIOUS_KEY_ID is invalid.");
  }
  if(previousKeyId===keyId)throw new Error("The replacement and previous capability key ids must differ.");
  const previousRetireAt=rawPreviousRetireAt
    ? timestamp(rawPreviousRetireAt,"ANALYTICAL_CAPABILITY_PREVIOUS_RETIRE_AT")
    : undefined;
  if(previousRetireAt&&new Date(previousRetireAt).valueOf()<=Date.now()+10*60_000){
    throw new Error("Previous key retirement must retain a ten-minute token drain window.");
  }
  const controlPlaneAdminDatabaseUrl=target==="analytical"
    ? undefined
    : postgresUrl(required(source,"CONTROL_PLANE_ADMIN_DATABASE_URL"),"CONTROL_PLANE_ADMIN_DATABASE_URL");
  const analyticalAdminDatabaseUrl=target==="control-plane"
    ? undefined
    : postgresUrl(required(source,"ANALYTICAL_ADMIN_DATABASE_URL"),"ANALYTICAL_ADMIN_DATABASE_URL");
  if(target==="both"&&controlPlaneAdminDatabaseUrl===analyticalAdminDatabaseUrl){
    throw new Error("Control-plane and analytical administrator URLs must be different.");
  }
  return Object.freeze({
    target,controlPlaneAdminDatabaseUrl,analyticalAdminDatabaseUrl,keyId,
    secretBase64,activeAt,retireAt,previousKeyId,previousRetireAt,
  });
}

function cells(input:ProvisioningInput):readonly Cell[]{
  const values:Cell[]=[];
  if(input.analyticalAdminDatabaseUrl){
    values.push(Object.freeze({
      label:"analytical",databaseUrl:input.analyticalAdminDatabaseUrl,
      migrationRole:"albert_migration_owner",
      installSql:"select capability_internal.install_verification_key($1,$2,$3::timestamptz,$4::timestamptz) as fingerprint",
      retireSql:"select capability_internal.retire_verification_key($1,$2::timestamptz)",
      pruneSql:"select capability_internal.prune_retired_verification_keys()",
      readySql:"select capability_internal.assert_verifier_ready()",
      inspectSql:"select key_id,fingerprint,active_at,retire_at from capability_internal.verification_keys where key_id=$1",
    }));
  }
  if(input.controlPlaneAdminDatabaseUrl){
    values.push(Object.freeze({
      label:"control-plane",databaseUrl:input.controlPlaneAdminDatabaseUrl,
      migrationRole:"albert_control_migration_owner",
      installSql:"select control_plane.install_analytical_capability_key($1,$2,$3::timestamptz,$4::timestamptz) as fingerprint",
      retireSql:"select control_plane.retire_analytical_capability_key($1,$2::timestamptz)",
      pruneSql:"select control_plane.prune_retired_analytical_capability_keys()",
      readySql:"select control_plane.assert_analytical_capability_issuer_ready()",
      inspectSql:"select key_id,fingerprint,active_at,retire_at from control_plane.analytical_capability_keys where key_id=$1",
    }));
  }
  return values;
}

async function connect(cell:Cell):Promise<Client>{
  const config:ClientConfig={
    connectionString:cell.databaseUrl,
    application_name:`albert-capability-key-provisioner/${cell.label}`,
    connectionTimeoutMillis:10_000,
  };
  const client=new Client(config);
  await client.connect();
  return client;
}

async function transaction<T>(client:Client,cell:Cell,work:()=>Promise<T>):Promise<T>{
  await client.query("begin");
  try{
    await client.query(`set local role "${cell.migrationRole}"`);
    await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))",["albert:analytical-capability-keyring"]);
    const result=await work();
    await client.query("commit");
    return result;
  }catch(error){
    await client.query("rollback").catch(()=>undefined);
    throw error;
  }
}

export async function provisionAnalyticalCapabilityKey(input:ProvisioningInput):Promise<void>{
  const keyMaterial=canonicalSecret(input.secretBase64);
  const expectedFingerprint=createHash("sha256").update(keyMaterial).digest("hex");
  const configuredCells=cells(input);
  const clients:Client[]=[];
  try{
    // Connect to every requested cell before changing either. Installation is
    // verifier-first, then signer: a partial failure can only leave an unused
    // verification key, never a signer producing unverifiable tokens.
    for(const cell of configuredCells)clients.push(await connect(cell));
    for(let index=0;index<configuredCells.length;index+=1){
      const cell=configuredCells[index]!;
      const client=clients[index]!;
      const fingerprint=await transaction(client,cell,async()=>{
        const result=await client.query<{fingerprint:string}>(cell.installSql,[
          input.keyId,input.secretBase64,input.activeAt,input.retireAt,
        ]);
        await client.query(cell.pruneSql);
        await client.query(cell.readySql);
        return result.rows[0]?.fingerprint;
      });
      if(fingerprint!==expectedFingerprint){
        throw new Error(`${cell.label} capability key fingerprint verification failed.`);
      }
    }
    if(input.previousKeyId&&input.previousRetireAt){
      // Stop the signer first, then shorten verifier retention to the identical
      // timestamp. Failure between cells leaves verification available longer.
      for(const label of ["control-plane","analytical"] as const){
        const index=configuredCells.findIndex((cell)=>cell.label===label);
        if(index<0)continue;
        const cell=configuredCells[index]!;
        await transaction(clients[index]!,cell,async()=>{
          await clients[index]!.query(cell.retireSql,[input.previousKeyId,input.previousRetireAt]);
        });
      }
    }
    const inspect=async(keyId:string)=>{
      const rows=[] as Array<Readonly<{
        keyId:string;fingerprint:string;activeAt:string;retireAt:string;
      }>>;
      for(let index=0;index<configuredCells.length;index+=1){
        const cell=configuredCells[index]!;
        const result=await transaction(clients[index]!,cell,async()=>
          clients[index]!.query<{
            key_id:string;fingerprint:string;active_at:string|Date;retire_at:string|Date;
          }>(cell.inspectSql,[keyId]),
        );
        const row=result.rows[0];
        if(!row)throw new Error(`${cell.label} capability key metadata is missing.`);
        rows.push(Object.freeze({
          keyId:row.key_id,fingerprint:row.fingerprint,
          activeAt:new Date(row.active_at).toISOString(),
          retireAt:new Date(row.retire_at).toISOString(),
        }));
      }
      return rows;
    };
    const installed=await inspect(input.keyId);
    for(const metadata of installed){
      if(metadata.keyId!==input.keyId||metadata.fingerprint!==expectedFingerprint
         ||metadata.activeAt!==input.activeAt||metadata.retireAt!==input.retireAt){
        throw new Error("Installed capability key metadata does not match the requested contract.");
      }
    }
    if(installed.length===2&&JSON.stringify(installed[0])!==JSON.stringify(installed[1])){
      throw new Error("Control-plane and analytical capability key metadata differ.");
    }
    if(input.previousKeyId&&input.previousRetireAt){
      const previous=await inspect(input.previousKeyId);
      if(previous.some((metadata)=>metadata.retireAt!==input.previousRetireAt)){
        throw new Error("Previous capability key retirement differs between cells.");
      }
      if(previous.length===2&&JSON.stringify(previous[0])!==JSON.stringify(previous[1])){
        throw new Error("Previous capability key metadata differ between cells.");
      }
    }
  }finally{
    keyMaterial.fill(0);
    await Promise.allSettled(clients.map((client)=>client.end()));
  }
  process.stdout.write(
    `Provisioned and fingerprint-verified capability key ${input.keyId} in ${configuredCells.map((cell)=>cell.label).join(" and ")}.\n`,
  );
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  await provisionAnalyticalCapabilityKey(loadAnalyticalCapabilityProvisioningInput());
}
