import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { DefaultSemanticToolExecutor,MemorySemanticResultCache,compileSourceQuery,createSemanticHttpHandler,signSemanticHttpRequest,type SemanticServiceDependencies,type SemanticToolExecutor } from "../services/semantic-query/src/index.js";
import { loadRegistryFile } from "../packages/semantic-registry/src/index.js";
import { FIXTURE_NOW,FIXTURE_TENANT_ID } from "./fixtures/retail.js";

const registry=loadRegistryFile(resolve("packages/semantic-registry/registry/registry.yaml"));
const allCapabilities=new Set([...registry.metrics.values()].flatMap((metric)=>metric.requiredCapabilities));
const trusted={tenantId:FIXTURE_TENANT_ID,role:"owner" as const,conversationId:"01J00000000000000000000002",turnId:"01J00000000000000000000003"};

test("service executes only through semantic read boundary, caches by bundle and never returns SQL",async()=>{
  let databaseCalls=0;let healthCalls=0;const audits:Array<{cacheHit:boolean;resultDigest:string}>=[];
  const dependencies:SemanticServiceDependencies={registry,contextProvider:{async load(){return{timezone:"Australia/Melbourne",tradingDayCutoff:"00:00",fiscalYearStartMonth:7,fiscalYearStartDay:1,weekStartsOn:1,tenantParameters:{active_customer_days:90,lapsed_customer_days:180,stock_velocity_days:30},capabilities:allCapabilities,overlayVersion:"overlay-1",identityGraphVersion:0,identityGraphHash:"d41d8cd98f00b204e9800998ecf8427e",defaults:{},dossier:{},packVersions:{lightspeed:"1"},sourceWatermarks:{"connection-1":"2026-03-15T11:00:00Z"},sourceDetails:[{connectorId:"lightspeed",connectionId:"connection-1",label:"Lightspeed",dataThrough:"2026-03-15T11:00:00Z"}],authorityByConcept:{operational_sales:"connection-1"}};}},database:{async queryAsSemanticRole(request){databaseCalls+=1;assert.equal(request.tenantId,FIXTURE_TENANT_ID);assert.equal(request.parameters[0],FIXTURE_TENANT_ID);return{rows:[{__key_worker:"01J00000000000000000000004",worker:"Sam",net_sales_ex_gst:"210.0000"}],durationMs:12};}},cache:new MemorySemanticResultCache(()=>Date.parse(FIXTURE_NOW)),sourceCatalogue:{async listFields(){return[];}},dataHealth:{async getForTopic(){healthCalls+=1;return healthCalls===1?{status:"passed",checks:[{checkId:"line_maths",status:"passed"}]}:{status:"warning",checks:[{checkId:"line_maths",status:"warning"}]};}},audit:{async append(record){audits.push(record);},async promoteSourceField(){return"promotion-1";}},publicationEvidence:{async inspect(){return{registryVersion:registry.version,registryHash:"f".repeat(64),activePublicationMatches:true};}},clock:()=>new Date(FIXTURE_NOW)};
  const service=new DefaultSemanticToolExecutor(dependencies);const input={topic:"sales_performance",metrics:["net_sales_ex_gst"],dimensions:["worker"],filters:[],time:{field:"business_date",range:{type:"absolute",from:"2026-03-01T00:00:00.000Z",to:"2026-04-01T00:00:00.000Z"},compare:"none"},sort:[],limit:20,parameters:{}};
  const first=await service.execute("run_semantic_query",input,trusted);const second=await service.execute("run_semantic_query",input,trusted);
  assert.equal(first.state,"verified");assert.equal(first.performance.cacheHit,false);assert.equal(second.state,"qualified");assert.equal(second.performance.cacheHit,true);assert.equal(databaseCalls,1);assert.equal(healthCalls,2);assert.deepEqual(audits.map(({cacheHit})=>cacheHit),[false,true]);assert.match(audits[0]!.resultDigest,/^[a-f0-9]{64}$/);assert.equal(audits[1]!.resultDigest,audits[0]!.resultDigest);
  assert.deepEqual(first.data?.rows,[{worker:"Sam",net_sales_ex_gst:"210.0000"}]);assert.deepEqual(first.data?.filterRefs,[{worker:"01J00000000000000000000004"}]);assert.deepEqual(second.data?.filterRefs,first.data?.filterRefs);
  assert.doesNotMatch(JSON.stringify(first),/compiledSql|SELECT|sql/i);
});

test("service reloads and recompiles once when identity graph changes before query execution",async()=>{
  let contextLoads=0;let databaseCalls=0;
  const service=new DefaultSemanticToolExecutor({
    registry,
    contextProvider:{async load(){contextLoads+=1;const version=contextLoads;return{timezone:"Australia/Melbourne",tradingDayCutoff:"00:00",fiscalYearStartMonth:7,fiscalYearStartDay:1,weekStartsOn:1,tenantParameters:{active_customer_days:90,lapsed_customer_days:180,stock_velocity_days:30},capabilities:allCapabilities,overlayVersion:"overlay-1",identityGraphVersion:version,identityGraphHash:(version===1?"a":"b").repeat(32),defaults:{},dossier:{},packVersions:{lightspeed:"1"},sourceWatermarks:{"connection-1":"2026-03-15T11:00:00Z"},sourceDetails:[{connectorId:"lightspeed",connectionId:"connection-1",label:"Lightspeed",dataThrough:"2026-03-15T11:00:00Z"}],authorityByConcept:{operational_sales:"connection-1"}};}},
    database:{async queryAsSemanticRole(request){databaseCalls+=1;if(databaseCalls===1){const error=Object.assign(new Error("changed"),{code:"IDENTITY_GRAPH_CHANGED"});throw error;}assert.deepEqual(request.expectedIdentityGraph,{version:2,hash:"b".repeat(32)});return{rows:[{net_sales_ex_gst:"210.0000"}],durationMs:2};}},
    cache:new MemorySemanticResultCache(()=>Date.parse(FIXTURE_NOW)),sourceCatalogue:{async listFields(){return[];}},
    dataHealth:{async getForTopic(){return{status:"passed",checks:[{checkId:"line_maths",status:"passed"}]};}},
    audit:{async append(){},async promoteSourceField(){return"promotion-1";}},publicationEvidence:{async inspect(){return{registryVersion:registry.version,registryHash:"f".repeat(64),activePublicationMatches:true};}},clock:()=>new Date(FIXTURE_NOW),
  });
  const response=await service.execute("run_semantic_query",{topic:"sales_performance",metrics:["net_sales_ex_gst"],dimensions:[],filters:[],time:{field:"business_date",range:{type:"absolute",from:"2026-03-01T00:00:00.000Z",to:"2026-04-01T00:00:00.000Z"},compare:"none"},sort:[],limit:20,parameters:{}},trusted);
  assert.equal(contextLoads,2);assert.equal(databaseCalls,2);assert.deepEqual(response.provenance.identityGraph,{version:2,hash:"b".repeat(32)});
});

test("in-process executor rejects tenant scope smuggled inside model input",async()=>{
  const service=new DefaultSemanticToolExecutor({registry,contextProvider:{async load(){throw new Error("must fail before context lookup");}},database:{async queryAsSemanticRole(){throw new Error("unreachable");}},cache:new MemorySemanticResultCache(),sourceCatalogue:{async listFields(){return[];}},dataHealth:{async getForTopic(){throw new Error("unreachable");}},audit:{async append(){},async promoteSourceField(){return"unreachable";}}});
  await assert.rejects(()=>service.execute("run_semantic_query",{topic:"sales_performance",parameters:{tenant_id:"another"}},trusted),/must not contain trusted tenant scope/);
});

test("source exploration is single-source, allowlisted, PII-gated and parameterised",()=>{
  const catalogue=[
    {connectionId:"connection-1",connectorId:"lightspeed",sourceSchema:"source_lightspeed",sourceTable:"sales",sourceField:"discount_reason",fieldType:"text" as const,piiClass:"business" as const,authorityConcept:"operational_sales",definition:"Recorded discount reason.",packVersion:"1"},
    {connectionId:"connection-1",connectorId:"lightspeed",sourceSchema:"source_lightspeed",sourceTable:"sales",sourceField:"customer_email",fieldType:"text" as const,piiClass:"customer_contact" as const,authorityConcept:"operational_sales",definition:"Customer email.",packVersion:"1"}
  ];
  const hostile="staff' OR TRUE --";const compiled=compileSourceQuery({connectionId:"connection-1",sourceTable:"sales",fields:["discount_reason"],aggregates:[],groupBy:[],filters:[{field:"discount_reason",op:"eq",values:[hostile]}],limit:10},FIXTURE_TENANT_ID,"owner",catalogue);
  assert.ok(compiled.parameters.includes(hostile));assert.ok(!compiled.sql.includes(hostile));assert.match(compiled.sql,/tenant_id=\$1 AND s\.connection_id=\$2/);
  assert.equal(compiled.budget.maxRows,500);assert.ok(compiled.budget.estimatedCost>0);
  assert.throws(()=>compileSourceQuery({connectionId:"connection-1",sourceTable:"sales",fields:["discount_reason"],limit:10},FIXTURE_TENANT_ID,"owner",catalogue,0),/exceeds the 0 cost budget/);
  assert.throws(()=>compileSourceQuery({connectionId:"connection-1",sourceTable:"sales",fields:["customer_email"],limit:10},FIXTURE_TENANT_ID,"owner",catalogue),/PII classification/);
  assert.throws(()=>compileSourceQuery({connectionId:"connection-1",sourceTable:"sales",fields:["discount_reason"],limit:10},FIXTURE_TENANT_ID,"owner",[...catalogue,{...catalogue[0]!,connectionId:"connection-2"}]),/exactly one connection/);
});

test("HTTP handler uses canonical method/path/body signature and rejects replay on another tool",async()=>{
  const calls:string[]=[];const stub:SemanticToolExecutor={async execute(name){calls.push(name);return{state:"verified",provenance:{bundleHash:"a".repeat(64),registryVersion:"1",identityGraph:{version:0,hash:"d41d8cd98f00b204e9800998ecf8427e"},sources:[],sourceWatermarks:{},sourceDetails:[],definitionsApplied:[],definitionDetails:[]},validation:{status:"passed",checks:[],warnings:[]},performance:{cacheHit:false,durationMs:0,rowCount:0}};}};
  const secret="semantic-internal-secret-at-least-thirty-two-bytes";const now=Date.parse(FIXTURE_NOW);const body=JSON.stringify({...trusted,input:{name:"commerce.net_sales_ex_gst"}});const path="/v1/tools/get_definition";const headers=await signSemanticHttpRequest(path,body,secret,now);
  const handler=createSemanticHttpHandler(stub,{hmacSecret:secret,clock:()=>now});
  const accepted=await handler(new Request(`https://semantic.internal${path}`,{method:"POST",headers,body}));assert.equal(accepted.status,200);assert.deepEqual(calls,["get_definition"]);
  const replayed=await handler(new Request("https://semantic.internal/v1/tools/get_capabilities",{method:"POST",headers,body}));assert.equal(replayed.status,401);
});
