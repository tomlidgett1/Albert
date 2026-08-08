import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { isConnectorPackVersion } from "../packages/connector-sdk/src/contract.js";

type ConnectorId="lightspeed-r"|"xero"|"deputy"|"square"|"shopify"|"stripe"|"momence"|"meta-ads"|"google-ads";
type RetirementReason="disconnected"|"tenant_deleting";

export type ConnectorPackConnectionRetirementInput=Readonly<{
  controlPlaneDatabaseUrl:string;
  analyticalDatabaseUrl:string;
  tenantId:string;
  connectionId:string;
  connectorId:ConnectorId;
  candidatePackVersion:string;
  expectedActivePackVersion:string;
}>;

export type ControlPlaneRetirementSnapshot=Readonly<{
  tenantId:string;
  tenantStatus:string;
  connectionId:string;
  connectorKey:string;
  connectionStatus:string;
  authHealth:string;
  connectionGeneration:string;
  disconnectedAt:string|null;
  deletionRequestId:string;
  deletionScope:string;
  deletionConnectionId:string|null;
  deletionStatus:string;
  deletionRequestedAt:string;
  deletionApprovedAt:string|null;
  auditTenantId:string;
  auditId:string;
  auditAction:string;
  auditResourceType:string;
  auditResourceId:string|null;
  auditMetadata:unknown;
  auditOccurredAt:string;
}>;

export type DerivedControlPlaneRetirementEvidence=Readonly<{
  retirementReason:RetirementReason;
  controlPlaneAuditId:string;
  controlPlaneEvidenceSha256:string;
  canonicalEvidence:string;
}>;

type LifecycleRow=Readonly<{
  tenant_id:string;
  tenant_status:string;
  connection_id:string;
  connector_key:string;
  connection_status:string;
  auth_health:string;
  connection_generation:string;
  disconnected_at:Date|string|null;
}>;

type IntentAuditRow=Readonly<{
  deletion_request_id:string;
  deletion_scope:string;
  deletion_connection_id:string|null;
  deletion_status:string;
  deletion_requested_at:Date|string;
  deletion_approved_at:Date|string|null;
  audit_tenant_id:string;
  audit_id:string;
  audit_action:string;
  audit_resource_type:string;
  audit_resource_id:string|null;
  audit_metadata:unknown;
  audit_occurred_at:Date|string;
}>;

const ulidPattern=/^[0-9A-HJKMNP-TV-Z]{26}$/u;
const activeDeletionStatuses=new Set([
  "queued","running","retry_wait","verifying","failed","completed",
]);

function migrationUrl(
  source:NodeJS.ProcessEnv,
  environmentName:"CONTROL_PLANE_MIGRATION_URL"|"ANALYTICAL_MIGRATION_URL",
  expectedLogin:"albert_control_deployer"|"albert_analytical_deployer",
):string{
  const value=source[environmentName]?.trim();
  if(!value)throw new Error(`${environmentName} is required.`);
  let parsed:URL;
  try{parsed=new URL(value);}catch{throw new Error(`${environmentName} must be a PostgreSQL URL.`);}
  if(!["postgres:","postgresql:"].includes(parsed.protocol)||parsed.username!==expectedLogin){
    throw new Error(`${environmentName} must use the dedicated ${expectedLogin} login.`);
  }
  const local=["127.0.0.1","localhost","::1","[::1]"].includes(parsed.hostname);
  const sslMode=parsed.searchParams.get("sslmode")?.toLowerCase();
  if(!local&&!sslMode?.match(/^(?:require|verify-ca|verify-full)$/u)){
    throw new Error(`Remote ${environmentName} must require TLS with sslmode=require or stronger.`);
  }
  return value;
}

function options(arguments_:readonly string[]):ReadonlyMap<string,string>{
  const values=new Map<string,string>();
  for(const argument of arguments_){
    const match=/^--([a-z-]+)=(.+)$/u.exec(argument);
    if(!match)throw new Error(`Unknown connection-retirement option: ${argument}`);
    if(values.has(match[1]!))throw new Error(`--${match[1]} may be specified only once.`);
    values.set(match[1]!,match[2]!);
  }
  return values;
}

function required(values:ReadonlyMap<string,string>,name:string):string{
  const value=values.get(name)?.trim();
  if(!value)throw new Error(`--${name} is required.`);
  return value;
}

function timestamp(value:Date|string|null,name:string,nullable:false):string;
function timestamp(value:Date|string|null,name:string,nullable:true):string|null;
function timestamp(value:Date|string|null,name:string,nullable:boolean):string|null{
  if(value===null){
    if(nullable)return null;
    throw new Error(`${name} is missing from control-plane evidence.`);
  }
  const date=value instanceof Date?value:new Date(value);
  if(Number.isNaN(date.valueOf()))throw new Error(`${name} is not a valid timestamp.`);
  return date.toISOString();
}

function stableValue(value:unknown):unknown{
  if(value===null||typeof value==="string"||typeof value==="boolean")return value;
  if(typeof value==="number"){
    if(!Number.isFinite(value))throw new Error("Control-plane evidence contains a non-finite number.");
    return value;
  }
  if(value instanceof Date)return value.toISOString();
  if(Array.isArray(value))return value.map(stableValue);
  if(typeof value==="object"){
    return Object.fromEntries(
      Object.entries(value as Record<string,unknown>)
        .sort(([left],[right])=>left<right?-1:left>right?1:0)
        .map(([key,entry])=>[key,stableValue(entry)]),
    );
  }
  throw new Error("Control-plane evidence contains an unsupported value.");
}

export function canonicalControlPlaneRetirementEvidence(value:unknown):string{
  return JSON.stringify(stableValue(value));
}

function auditMetadata(value:unknown):Readonly<Record<string,unknown>>{
  if(value===null||typeof value!=="object"||Array.isArray(value)){
    throw new Error("The control-plane audit metadata is not an object.");
  }
  return value as Readonly<Record<string,unknown>>;
}

export function deriveConnectionRetirementEvidence(
  snapshot:ControlPlaneRetirementSnapshot,
  expected:Pick<ConnectorPackConnectionRetirementInput,"tenantId"|"connectionId"|"connectorId">,
):DerivedControlPlaneRetirementEvidence{
  if(!ulidPattern.test(snapshot.tenantId)||snapshot.tenantId!==expected.tenantId||
     !ulidPattern.test(snapshot.connectionId)||snapshot.connectionId!==expected.connectionId||
     snapshot.connectorKey!==expected.connectorId){
    throw new Error("The locked control-plane connection identity does not match the requested retirement.");
  }
  if(!activeDeletionStatuses.has(snapshot.deletionStatus)){
    throw new Error("The control-plane deletion intent is not durably active or completed.");
  }
  if(snapshot.auditTenantId!==snapshot.tenantId||!ulidPattern.test(snapshot.auditId)){
    throw new Error("The control-plane audit identity is invalid or cross-tenant.");
  }
  if(!ulidPattern.test(snapshot.deletionRequestId)){
    throw new Error("The control-plane deletion request identity is invalid.");
  }
  const metadata=auditMetadata(snapshot.auditMetadata);
  const tenantDeleting=snapshot.tenantStatus==="deleting";
  let retirementReason:RetirementReason;
  if(tenantDeleting){
    if(snapshot.connectionStatus!=="blocked"&&snapshot.connectionStatus!=="disconnected"){
      throw new Error("A deleting tenant connection is not fenced from new sync work.");
    }
    if(snapshot.authHealth!=="revoked"||snapshot.deletionScope!=="tenant"||
       snapshot.deletionConnectionId!==null||snapshot.deletionApprovedAt===null||
       snapshot.auditAction!=="tenant.deletion_requested"||
       snapshot.auditResourceType!=="deletion_request"||
       snapshot.auditResourceId!==snapshot.deletionRequestId){
      throw new Error("The tenant-deletion audit does not prove this connection is permanently inactive.");
    }
    retirementReason="tenant_deleting";
  }else{
    if(snapshot.connectionStatus!=="disconnected"||snapshot.authHealth!=="revoked"||
       snapshot.disconnectedAt===null||snapshot.deletionScope!=="connection"||
       snapshot.deletionConnectionId!==snapshot.connectionId||
       snapshot.deletionRequestedAt!==snapshot.disconnectedAt||
       snapshot.auditAction!=="connection.disconnect_requested"||
       snapshot.auditResourceType!=="connection"||
       snapshot.auditResourceId!==snapshot.connectionId||
       metadata.deletion_request_id!==snapshot.deletionRequestId||
       String(metadata.connection_generation)!==snapshot.connectionGeneration){
      throw new Error("The disconnect audit does not prove this exact connection generation is inactive.");
    }
    retirementReason="disconnected";
  }

  const evidence=Object.freeze({
    schemaVersion:"connector_pack_connection_retirement_control_evidence_v1",
    retirementReason,
    tenant:Object.freeze({tenantId:snapshot.tenantId,deletionInProgress:tenantDeleting}),
    connection:Object.freeze({
      connectionId:snapshot.connectionId,connectorKey:snapshot.connectorKey,
      connectionStatus:snapshot.connectionStatus,authHealth:snapshot.authHealth,
      connectionGeneration:snapshot.connectionGeneration,
      disconnectedAt:snapshot.disconnectedAt,
    }),
    deletionIntent:Object.freeze({
      deletionRequestId:snapshot.deletionRequestId,scope:snapshot.deletionScope,
      connectionId:snapshot.deletionConnectionId,requestedAt:snapshot.deletionRequestedAt,
      approvedAt:snapshot.deletionApprovedAt,
    }),
    audit:Object.freeze({
      tenantId:snapshot.auditTenantId,auditId:snapshot.auditId,
      action:snapshot.auditAction,resourceType:snapshot.auditResourceType,
      resourceId:snapshot.auditResourceId,metadata,
      occurredAt:snapshot.auditOccurredAt,
    }),
  });
  const canonicalEvidence=canonicalControlPlaneRetirementEvidence(evidence);
  return Object.freeze({
    retirementReason,controlPlaneAuditId:snapshot.auditId,canonicalEvidence,
    controlPlaneEvidenceSha256:createHash("sha256").update(canonicalEvidence,"utf8").digest("hex"),
  });
}

export function loadConnectorPackConnectionRetirementInput(
  source:NodeJS.ProcessEnv=process.env,
  arguments_:readonly string[]=process.argv.slice(2),
):ConnectorPackConnectionRetirementInput{
  const values=options(arguments_);
  const allowed=new Set(["tenant","connection","connector","candidate","expected-active"]);
  const unknown=[...values.keys()].filter((name)=>!allowed.has(name));
  if(unknown.length)throw new Error(`Unknown connection-retirement option: --${unknown[0]}`);
  const tenantId=required(values,"tenant"),connectionId=required(values,"connection");
  if(!ulidPattern.test(tenantId)||!ulidPattern.test(connectionId)){
    throw new Error("Tenant and connection ids must be ULIDs.");
  }
  const connector=required(values,"connector");
  if(connector!=="lightspeed-r"&&connector!=="xero"&&connector!=="deputy"&&connector!=="square"&&connector!=="shopify"&&connector!=="stripe"&&connector!=="momence"&&connector!=="meta-ads"&&connector!=="google-ads"){
    throw new Error("--connector must be one of: lightspeed-r, xero, deputy, square, shopify, stripe, momence, meta-ads, google-ads.");
  }
  const candidatePackVersion=required(values,"candidate");
  const expectedActivePackVersion=required(values,"expected-active");
  if(!isConnectorPackVersion(candidatePackVersion)||
     !isConnectorPackVersion(expectedActivePackVersion)||
     candidatePackVersion===expectedActivePackVersion){
    throw new Error("Candidate and expected-active must be distinct release-grade semantic versions.");
  }
  return Object.freeze({
    controlPlaneDatabaseUrl:migrationUrl(
      source,"CONTROL_PLANE_MIGRATION_URL","albert_control_deployer",
    ),
    analyticalDatabaseUrl:migrationUrl(
      source,"ANALYTICAL_MIGRATION_URL","albert_analytical_deployer",
    ),
    tenantId,connectionId,connectorId:connector,
    candidatePackVersion,expectedActivePackVersion,
  });
}

function snapshot(lifecycle:LifecycleRow,intent:IntentAuditRow):ControlPlaneRetirementSnapshot{
  return Object.freeze({
    tenantId:lifecycle.tenant_id,tenantStatus:lifecycle.tenant_status,
    connectionId:lifecycle.connection_id,connectorKey:lifecycle.connector_key,
    connectionStatus:lifecycle.connection_status,authHealth:lifecycle.auth_health,
    connectionGeneration:lifecycle.connection_generation,
    disconnectedAt:timestamp(lifecycle.disconnected_at,"disconnected_at",true),
    deletionRequestId:intent.deletion_request_id,deletionScope:intent.deletion_scope,
    deletionConnectionId:intent.deletion_connection_id,deletionStatus:intent.deletion_status,
    deletionRequestedAt:timestamp(intent.deletion_requested_at,"requested_at",false),
    deletionApprovedAt:timestamp(intent.deletion_approved_at,"approved_at",true),
    auditTenantId:intent.audit_tenant_id,auditId:intent.audit_id,
    auditAction:intent.audit_action,auditResourceType:intent.audit_resource_type,
    auditResourceId:intent.audit_resource_id,auditMetadata:intent.audit_metadata,
    auditOccurredAt:timestamp(intent.audit_occurred_at,"occurred_at",false),
  });
}

async function readLockedControlPlaneSnapshot(
  client:Client,input:ConnectorPackConnectionRetirementInput,
):Promise<ControlPlaneRetirementSnapshot>{
  const lifecycle=await client.query<LifecycleRow>(
    `select tenant.tenant_id,tenant.status as tenant_status,
            connection.connection_id,connection.connector_key,
            connection.status as connection_status,connection.auth_health,
            connection.connection_generation::text,connection.disconnected_at
       from control_plane.tenants tenant
       join control_plane.connections connection
         on connection.tenant_id=tenant.tenant_id
      where tenant.tenant_id=$1 and connection.connection_id=$2
        and connection.connector_key=$3
      for update of tenant,connection`,
    [input.tenantId,input.connectionId,input.connectorId],
  );
  if(lifecycle.rows.length!==1){
    throw new Error("The exact control-plane tenant/connection/connector row was not found.");
  }
  const row=lifecycle.rows[0]!;
  const tenantDeleting=row.tenant_status==="deleting";
  const intentSql=tenantDeleting
    ?`select request.deletion_request_id,request.scope as deletion_scope,
             request.connection_id as deletion_connection_id,request.status as deletion_status,
             request.requested_at as deletion_requested_at,
             request.approved_at as deletion_approved_at,
             audit.tenant_id as audit_tenant_id,audit.audit_id,
             audit.action as audit_action,audit.resource_type as audit_resource_type,
             audit.resource_id as audit_resource_id,audit.audit_metadata,
             audit.occurred_at as audit_occurred_at
        from control_plane.deletion_requests request
        join control_plane.audit_log audit
          on audit.tenant_id=request.tenant_id
         and audit.action='tenant.deletion_requested'
         and audit.resource_type='deletion_request'
         and audit.resource_id=request.deletion_request_id
       where request.tenant_id=$1 and request.scope='tenant'
         and request.connection_id is null and request.approved_at is not null
         and request.status=any($2::text[])
       order by request.requested_at desc,audit.occurred_at desc
       limit 2 for share of request,audit`
    :`select request.deletion_request_id,request.scope as deletion_scope,
             request.connection_id as deletion_connection_id,request.status as deletion_status,
             request.requested_at as deletion_requested_at,
             request.approved_at as deletion_approved_at,
             audit.tenant_id as audit_tenant_id,audit.audit_id,
             audit.action as audit_action,audit.resource_type as audit_resource_type,
             audit.resource_id as audit_resource_id,audit.audit_metadata,
             audit.occurred_at as audit_occurred_at
        from control_plane.deletion_requests request
        join control_plane.audit_log audit
          on audit.tenant_id=request.tenant_id
         and audit.action='connection.disconnect_requested'
         and audit.resource_type='connection'
         and audit.resource_id=request.connection_id
         and audit.audit_metadata->>'deletion_request_id'=request.deletion_request_id
         and audit.audit_metadata->>'connection_generation'=$4
       where request.tenant_id=$1 and request.connection_id=$2
         and request.scope='connection' and request.requested_at=$3::timestamptz
         and request.status=any($5::text[])
       order by request.requested_at desc,audit.occurred_at desc
       limit 2 for share of request,audit`;
  const intent=await client.query<IntentAuditRow>(
    intentSql,
    tenantDeleting
      ?[input.tenantId,[...activeDeletionStatuses]]
      :[input.tenantId,input.connectionId,row.disconnected_at,row.connection_generation,
        [...activeDeletionStatuses]],
  );
  if(intent.rows.length!==1){
    throw new Error("A unique, exact control-plane deletion intent and audit were not found.");
  }
  return snapshot(row,intent.rows[0]!);
}

async function establishIdentity(
  client:Client,role:"albert_control_migration_owner"|"albert_migration_owner",
  login:"albert_control_deployer"|"albert_analytical_deployer",
):Promise<void>{
  await client.query("set local lock_timeout='5min'");
  await client.query("set local idle_in_transaction_session_timeout='7min'");
  await client.query(`set local role ${role}`);
  const identity=await client.query<{current_user:string;session_user:string}>(
    "select current_user,session_user",
  );
  if(identity.rows[0]?.current_user!==role||identity.rows[0]?.session_user!==login){
    throw new Error(`Dedicated ${login} migration identity was not established.`);
  }
}

function assertAnalyticalResult(
  result:Readonly<Record<string,unknown>>,
  input:ConnectorPackConnectionRetirementInput,
  evidence:DerivedControlPlaneRetirementEvidence,
):void{
  if(result.tenantId!==input.tenantId||result.connectionId!==input.connectionId||
     result.connectorId!==input.connectorId||
     result.candidatePackVersion!==input.candidatePackVersion||
     result.retirementReason!==evidence.retirementReason||
     result.controlPlaneAuditId!==evidence.controlPlaneAuditId||
     result.controlPlaneEvidenceSha256!==evidence.controlPlaneEvidenceSha256){
    throw new Error("The analytical retirement receipt does not match the locked control-plane evidence.");
  }
}

export async function retireConnectorPackConnection(
  input:ConnectorPackConnectionRetirementInput,
):Promise<Readonly<Record<string,unknown>>>{
  const control=new Client({
    connectionString:input.controlPlaneDatabaseUrl,
    application_name:"albert-connector-pack-retirement-control-verifier",
    connectionTimeoutMillis:10_000,
  });
  const analytical=new Client({
    connectionString:input.analyticalDatabaseUrl,
    application_name:"albert-connector-pack-connection-retirement",
    connectionTimeoutMillis:10_000,
  });
  let controlInTransaction=false,analyticalInTransaction=false;
  await control.connect();
  try{
    await analytical.connect();
    await control.query("begin");controlInTransaction=true;
    await establishIdentity(control,"albert_control_migration_owner","albert_control_deployer");
    await control.query(
      `select pg_advisory_xact_lock(
         hashtextextended('connector-pack-retirement:'||$1::text||':'||$2::text,0)
       )`,
      [input.tenantId,input.connectionId],
    );
    const firstSnapshot=await readLockedControlPlaneSnapshot(control,input);
    const evidence=deriveConnectionRetirementEvidence(firstSnapshot,input);

    await analytical.query("begin");analyticalInTransaction=true;
    await establishIdentity(analytical,"albert_migration_owner","albert_analytical_deployer");
    const retirement=await analytical.query<{result:Readonly<Record<string,unknown>>}>(
      `select semantic_internal.retire_connector_pack_connection(
         $1::text,$2::text,$3::text,$4::text,$5::text,$6::text,$7::text,$8::text
       ) as result`,
      [input.tenantId,input.connectionId,input.connectorId,input.candidatePackVersion,
        input.expectedActivePackVersion,evidence.retirementReason,evidence.controlPlaneAuditId,
        evidence.controlPlaneEvidenceSha256],
    );
    const result=retirement.rows[0]?.result;
    if(!result||typeof result!=="object"||Array.isArray(result)){
      throw new Error("Connector-pack connection retirement returned invalid evidence.");
    }
    assertAnalyticalResult(result,input,evidence);

    // Re-read while every exact control-plane row remains locked. Do not make
    // the analytical exception durable if the evidence changed unexpectedly.
    const finalSnapshot=await readLockedControlPlaneSnapshot(control,input);
    const finalEvidence=deriveConnectionRetirementEvidence(finalSnapshot,input);
    if(finalEvidence.controlPlaneAuditId!==evidence.controlPlaneAuditId||
       finalEvidence.controlPlaneEvidenceSha256!==evidence.controlPlaneEvidenceSha256){
      throw new Error("Control-plane retirement evidence changed before analytical commit.");
    }

    await analytical.query("commit");analyticalInTransaction=false;
    await control.query("commit");controlInTransaction=false;
    return Object.freeze({...result,controlPlaneVerified:true});
  }catch(error){
    if(analyticalInTransaction)await analytical.query("rollback").catch(()=>undefined);
    if(controlInTransaction)await control.query("rollback").catch(()=>undefined);
    throw error;
  }finally{
    await Promise.allSettled([analytical.end(),control.end()]);
  }
}

async function main():Promise<void>{
  const input=loadConnectorPackConnectionRetirementInput();
  const result=await retireConnectorPackConnection(input);
  process.stdout.write(`retired ${input.connectorId} ${input.connectionId} ${JSON.stringify(result)}\n`);
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){await main();}
