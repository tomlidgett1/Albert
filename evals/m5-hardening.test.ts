import test from "node:test";
import assert from "node:assert/strict";
import { resolve } from "node:path";
import {
  compileSemanticQuery,
  resolveTenantTimeRange,
  SemanticCompilerError,
} from "../packages/compiler/src/index.js";
import { loadRegistryFile } from "../packages/semantic-registry/src/index.js";
import {
  PostgresDataHealthProvider,
  OpenAIEmbeddingProvider,
  PostgresCatalogueSearchProvider,
  PostgresSourceCatalogueProvider,
  PostgresSemanticPublicationVerifier,
  PostgresSemanticReadDatabase,
  PostgresSemanticResultCache,
  signSemanticHttpRequest,
  startSemanticNodeServer,
  type PgClientLike,
  type PgPoolLike,
  type SemanticServiceComposition,
  type SemanticToolExecutor,
} from "../services/semantic-query/src/index.js";
import { FIXTURE_NOW,FIXTURE_TENANT_ID } from "./fixtures/retail.js";

const registry=loadRegistryFile(resolve("packages/semantic-registry/registry/registry.yaml"));
const capabilities=new Set([...registry.metrics.values()].flatMap((metric)=>metric.requiredCapabilities));
const baseContext={
  tenantId:FIXTURE_TENANT_ID,role:"owner" as const,capabilities,now:FIXTURE_NOW,timezone:"Australia/Melbourne",
  tradingDayCutoff:"04:00",fiscalYearStartMonth:7,fiscalYearStartDay:1,weekStartsOn:1,
  tenantParameters:{active_customer_days:60,lapsed_customer_days:120,stock_velocity_days:45},
};

test("tenant calendar resolves zoned trading cutoffs rather than UTC midnight",()=>{
  const range=resolveTenantTimeRange({type:"today"},"2026-08-02T17:00:00.000Z",{
    timezone:"Australia/Melbourne",tradingDayCutoff:"04:00",fiscalYearStartMonth:7,fiscalYearStartDay:1,weekStartsOn:1,
  });
  // 03:00 Melbourne belongs to the preceding business date. Its 04:00
  // boundaries are 18:00 UTC during AEST.
  assert.deepEqual(range,{from:"2026-08-01T18:00:00.000Z",to:"2026-08-02T18:00:00.000Z",fromBusinessDate:"2026-08-02",toBusinessDate:"2026-08-03"});
  const fiscal=resolveTenantTimeRange({type:"year_to_date"},"2026-08-03T12:00:00.000Z",{
    timezone:"Australia/Melbourne",tradingDayCutoff:"04:00",fiscalYearStartMonth:7,fiscalYearStartDay:1,weekStartsOn:1,
  });
  assert.equal(fiscal.fromBusinessDate,"2026-07-01");assert.equal(fiscal.from,"2026-06-30T18:00:00.000Z");
  const nonMonthBoundaryQuarter=resolveTenantTimeRange({type:"quarter_to_date"},"2026-10-10T12:00:00.000Z",{
    timezone:"Australia/Melbourne",tradingDayCutoff:"04:00",fiscalYearStartMonth:7,fiscalYearStartDay:15,weekStartsOn:1,
  });
  assert.equal(nonMonthBoundaryQuarter.fromBusinessDate,"2026-07-15");
});

test("prior-period comparison compiles two aggregates and aligned deltas",()=>{
  const compiled=compileSemanticQuery({topic:"sales_performance",metrics:["net_sales_ex_gst"],dimensions:["location"],filters:[],time:{field:"business_date",range:{type:"month_to_date"},compare:"same_period_prior_month"},sort:[],limit:20,parameters:{}},registry,{...baseContext,now:"2026-08-03T12:00:00.000Z"});
  assert.match(compiled.sql,/WITH current_period AS/);assert.match(compiled.sql,/comparison_period AS/);assert.match(compiled.sql,/FULL OUTER JOIN comparison_period/);
  assert.ok(compiled.resultColumns.includes("net_sales_ex_gst__comparison"));assert.ok(compiled.resultColumns.includes("net_sales_ex_gst__change_pct"));
  assert.equal(compiled.resolvedTime.fromBusinessDate,"2026-08-01");assert.equal(compiled.resolvedTime.comparisonFromBusinessDate,"2026-07-01");
  assert.equal(compiled.parameters[0],FIXTURE_TENANT_ID);
});

test("compiler rejects plans above the trusted estimated-cost ceiling",()=>{
  const query={topic:"sales_performance",metrics:["net_sales_ex_gst"],dimensions:["location"],filters:[],time:{field:"business_date",range:{type:"month_to_date"},compare:"same_period_prior_month"},sort:[],limit:20,parameters:{}};
  assert.throws(
    ()=>compileSemanticQuery(query,registry,{...baseContext,maxEstimatedCost:0}),
    (error)=>error instanceof SemanticCompilerError
      && error.code==="QUERY_BUDGET_EXCEEDED"
      && typeof error.details.estimatedCost==="number"
      && error.details.maxEstimatedCost===0,
  );
});

test("composite prior-period comparison independently aggregates, aligns and compares every metric",()=>{
  const current={type:"absolute" as const,from:"2026-03-01T00:00:00.000Z",to:"2026-03-16T00:00:00.000Z"};
  const compare="same_period_prior_month" as const;
  const compiled=compileSemanticQuery({kind:"composite",topic:"workforce_sales",metrics:["sales_per_labour_hour"],queries:[
    {topic:"sales_performance",metrics:["net_sales_ex_gst"],dimensions:["location"],filters:[],time:{field:"business_date",range:current,compare},parameters:{}},
    {topic:"workforce_labour",metrics:["worked_hours"],dimensions:["location"],filters:[],time:{field:"business_date",range:current,compare},parameters:{}},
  ],alignOn:["location"],sort:[{metric:"sales_per_labour_hour",dir:"desc"}],limit:20,parameters:{}},registry,baseContext);
  assert.match(compiled.sql,/WITH current_composite AS/);assert.match(compiled.sql,/comparison_composite AS/);
  assert.match(compiled.sql,/WITH q0 AS/);assert.match(compiled.sql,/WITH p0 AS/);
  assert.match(compiled.sql,/FULL OUTER JOIN comparison_composite/);assert.match(compiled.sql,/"sales_per_labour_hour__change_pct"/);
  assert.ok(compiled.resultColumns.includes("net_sales_ex_gst__comparison"));assert.ok(compiled.resultColumns.includes("sales_per_labour_hour__change"));
  assert.equal(compiled.resolvedTime.compare,compare);assert.equal(compiled.resolvedTime.comparisonFromBusinessDate,"2026-02-01");
  assert.equal(compiled.sourceTables.length,2);
});

test("snapshot SQL selects latest row per entity before summing",()=>{
  const compiled=compileSemanticQuery({topic:"inventory_health",metrics:["stock_on_hand_units"],dimensions:["product.category"],filters:[],time:{field:"snapshot_date",range:{type:"last_n_days",days:30},compare:"none"},sort:[],limit:20,parameters:{}},registry,baseContext);
  assert.match(compiled.sql,/SUM\(f\."quantity_on_hand"\) FILTER/);assert.match(compiled.sql,/COALESCE\(snapshot_identity0\."resolved_entity_id", snapshot_latest\."product_variant_id"\) IS NOT DISTINCT FROM COALESCE\(identity0\."resolved_entity_id", f\."product_variant_id"\)/);
  assert.match(compiled.sql,/snapshot_latest\."stock_location_id" IS NOT DISTINCT FROM f\."stock_location_id"/);assert.doesNotMatch(compiled.sql,/ARRAY_AGG/);
});

test("trusted overlay windows drive customer and stock scans and reject model overrides",()=>{
  const active=compileSemanticQuery({topic:"customers_retention",metrics:["active_customers"],dimensions:[],filters:[],time:{field:"last_order_at",range:{type:"today"},compare:"none"},sort:[],limit:20,parameters:{}},registry,baseContext);
  assert.match(active.sql,/f\."last_order_at" >= \$\d+/);assert.equal(active.resolvedTime.toBusinessDate,"2026-03-16");
  assert.equal(daysBetween(active.resolvedTime.fromBusinessDate,active.resolvedTime.toBusinessDate),60);
  const stock=compileSemanticQuery({topic:"inventory_health",metrics:["stock_cover_days"],dimensions:[],filters:[],time:{field:"snapshot_date",range:{type:"today"},compare:"none"},sort:[],limit:20,parameters:{}},registry,baseContext);
  assert.equal(daysBetween(stock.resolvedTime.fromBusinessDate,stock.resolvedTime.toBusinessDate),45);
  assert.match(stock.sql,/SUM\(f\."units_sold"\) FILTER/);
  assert.match(stock.sql,/f\."business_date" >= \(CAST\(\$\d+ AS date\) - CAST\(\$\d+ AS integer\)\)/);
  assert.doesNotMatch(stock.sql,/AVG\(f\."units_sold"\)/);
  assert.ok(stock.parameters.includes(45));
  assert.throws(()=>compileSemanticQuery({topic:"customers_retention",metrics:["active_customers"],dimensions:[],filters:[],time:{field:"last_order_at",range:{type:"today"},compare:"none"},sort:[],limit:20,parameters:{active_customer_days:999}},registry,baseContext),(error)=>error instanceof SemanticCompilerError&&error.code==="INVALID_PARAMETER");
});

test("lapsed customers compile as an as-of population before the trusted cutoff",()=>{
  const compiled=compileSemanticQuery({topic:"customers_retention",metrics:["lapsed_customers"],dimensions:[],filters:[],time:{field:"last_order_at",range:{type:"today"},compare:"none"},sort:[],limit:20,parameters:{}},registry,baseContext);
  assert.match(compiled.sql,/FILTER \(WHERE f\."last_order_at" < \$\d+\)/);
  assert.doesNotMatch(compiled.sql,/WHERE f\."tenant_id" = \$1\n\s+AND f\."last_order_at" >=/);
  assert.match(compiled.sql,/AND f\."last_order_at" < \$\d+/);
  assert.ok(compiled.parameters.includes("2025-11-15T17:00:00.000Z"));
});

test("Postgres semantic reader sets semantic_ro, tenant scope and read-only transaction",async()=>{
  const statements:string[]=[];const client:PgClientLike={async query(sql){statements.push(sql);return{rows:sql==="SELECT governed"?[{value:"1.0000"}]:[]};},release(){statements.push("RELEASE");}};
  const database=new PostgresSemanticReadDatabase({async connect(){return client;}});
  const result=await database.queryAsSemanticRole({tenantId:FIXTURE_TENANT_ID,sql:"SELECT governed",parameters:[FIXTURE_TENANT_ID],statementTimeoutMs:1000});
  assert.deepEqual(result.rows,[{value:"1.0000"}]);assert.deepEqual(statements.slice(0,4),["BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY","SET LOCAL ROLE semantic_ro","SELECT set_config('albert.tenant_id', $1, true)","SELECT set_config('statement_timeout', $1, true)"]);assert.ok(statements.some((sql)=>sql.includes("pg_advisory_xact_lock_shared")));assert.ok(statements.includes("COMMIT"));
});

test("Postgres semantic reader rejects a changed identity graph in the query snapshot",async()=>{
  const statements:string[]=[];const client:PgClientLike={async query(sql){statements.push(sql);if(sql.includes("FROM semantic_internal.identity_graph_state"))return{rows:[{version:"2",graph_hash:"b".repeat(32)}]};return{rows:[]};},release(){}};
  const database=new PostgresSemanticReadDatabase({async connect(){return client;}});
  await assert.rejects(
    ()=>database.queryAsSemanticRole({tenantId:FIXTURE_TENANT_ID,sql:"SELECT governed",parameters:[FIXTURE_TENANT_ID],statementTimeoutMs:1000,expectedIdentityGraph:{version:1,hash:"a".repeat(32)}}),
    (error)=>error instanceof Error&&"code" in error&&(error as Error&{code?:string}).code==="IDENTITY_GRAPH_CHANGED",
  );
  assert.ok(statements.includes("ROLLBACK"));assert.ok(!statements.includes("SELECT governed"));
});

test("Postgres data-health and cache adapters use governed metadata boundaries",async()=>{
  const healthRequests:unknown[][]=[];
  const health=new PostgresDataHealthProvider({async queryAsSemanticRole(request){healthRequests.push([...request.parameters]);assert.match(request.sql,/quality\.current_scoped_health\(\$1,\$2::text\[\],\$3::text\[\]\)/);return{rows:[{check_id:"line_maths",domain:"commerce",status:"passed",details:{}}],durationMs:1};}},registry);
  const snapshot=await health.getForTopic({tenantId:FIXTURE_TENANT_ID,role:"owner",conversationId:"c",turnId:"t"},"sales_performance");assert.equal(snapshot.status,"passed");
  assert.equal(healthRequests[0]?.[0],FIXTURE_TENANT_ID);
  assert.deepEqual(new Set(healthRequests[0]?.[1] as string[]),new Set(["connector","canonical","commerce"]));
  assert.deepEqual(healthRequests[0]?.[2],["commerce.order_lines"]);
  const response={state:"verified" as const,provenance:{bundleHash:"a".repeat(64),registryVersion:"1.0.0",identityGraph:{version:0,hash:"d41d8cd98f00b204e9800998ecf8427e"},sources:[],sourceWatermarks:{},sourceDetails:[],definitionsApplied:[],definitionDetails:[]},validation:{status:"passed" as const,checks:[],warnings:[]},performance:{cacheHit:false,durationMs:1,rowCount:0}};
  const statements:string[]=[];const pool:PgPoolLike={async connect(){return{async query(sql){statements.push(sql);if(sql.includes("SELECT response"))return{rows:[{response}]};return{rows:[]};},release(){}};}};
  const cache=new PostgresSemanticResultCache(pool);const key=`${FIXTURE_TENANT_ID}:${"a".repeat(64)}`;assert.deepEqual(await cache.get(key),response);await cache.set(key,response,60);assert.ok(statements.includes("SET LOCAL ROLE semantic_meta_rw"));assert.ok(statements.some((sql)=>sql.includes("INSERT INTO semantic_internal.result_cache")));
});

test("semantic runtime fails closed when the active registry publication is absent or mismatched",async()=>{
  const statements:string[]=[];let publishedHash="b".repeat(64);
  const pool:PgPoolLike={async connect(){return{async query(sql){statements.push(sql);return sql.includes("semantic_publications")?{rows:[{registry_version:"1.0.0",registry_hash:publishedHash}]}:{rows:[]};},release(){}};}};
  const verifier=new PostgresSemanticPublicationVerifier(pool,"1.0.0","b".repeat(64));
  assert.equal(await verifier.matchesActivePublication(),true);await verifier.assertActivePublication();
  publishedHash="c".repeat(64);assert.equal(await verifier.matchesActivePublication(),false);
  await assert.rejects(()=>verifier.assertActivePublication(),/does not match the single active/);
  assert.ok(statements.includes("BEGIN TRANSACTION READ ONLY"));assert.ok(statements.includes("SET LOCAL ROLE albert_semantic_control"));
});

test("catalogue embeddings pin model, dimensions and reject malformed provider output",async()=>{
  const requests:unknown[]=[];
  const embedding=Array.from({length:1536},(_,index)=>index/1536);
  const provider=new OpenAIEmbeddingProvider({client:{embeddings:{async create(input){requests.push(input);return{data:[{index:0,embedding}]};}}}});
  assert.equal((await provider.embedQuery(" sales   performance ")).length,1536);
  assert.deepEqual(requests,[{model:"text-embedding-3-large",input:["sales performance"],dimensions:1536,encoding_format:"float"}]);
  const malformed=new OpenAIEmbeddingProvider({client:{embeddings:{async create(){return{data:[{index:0,embedding:[1,2]}]};}}}});
  await assert.rejects(()=>malformed.embedQuery("sales"),/exactly 1536 finite dimensions/);
});

test("catalogue search performs publication-bound hybrid rank fusion and verifies index readiness",async()=>{
  const statements:{sql:string;parameters:readonly unknown[]}[]=[];
  const pool:PgPoolLike={async connect(){return{async query(sql,parameters=[]){statements.push({sql,parameters});if(sql.includes("document_count"))return{rows:[{document_count:51,compatible_count:51}]};if(sql.includes("semantic_ranked"))return{rows:[{document_id:"topic:sales_performance",semantic_id:"sales_performance",kind:"topic",title:"Sales performance",score:0.03},{document_id:"source_field:lightspeed-r:sales:discount_reason",semantic_id:"source_field:lightspeed-r:sales:discount_reason",kind:"source_field",title:"Discount reason",score:0.02,connector_id:"lightspeed-r",source_table:"sales",source_field:"discount_reason"}]};return{rows:[]};},release(){}};}};
  const embeddingProvider={model:"text-embedding-3-large" as const,dimensions:1536 as const,async embedQuery(){return Array(1536).fill(0.01);},async embedDocuments(){return[];}};
  const provider=new PostgresCatalogueSearchProvider(pool,embeddingProvider,"1.0.0","a".repeat(64),51);
  assert.deepEqual(await provider.search("sales by location",6),[{documentId:"topic:sales_performance",semanticId:"sales_performance",kind:"topic",title:"Sales performance",score:0.03},{documentId:"source_field:lightspeed-r:sales:discount_reason",semanticId:"source_field:lightspeed-r:sales:discount_reason",kind:"source_field",title:"Discount reason",score:0.02,sourceFieldReference:{connectorId:"lightspeed-r",sourceTable:"sales",sourceField:"discount_reason"}}]);
  assert.equal(await provider.ready(),true);
  const hybrid=statements.find(({sql})=>sql.includes("semantic_ranked"));
  assert.ok(hybrid);assert.match(hybrid.sql,/websearch_to_tsquery/);assert.match(hybrid.sql,/OPERATOR\(extensions\.<=>\)/);assert.match(hybrid.sql,/status='published'/);
  assert.match(String(hybrid.parameters[0]),/^\[0\.01,/);assert.equal(hybrid.parameters[2],"1.0.0");
});

test("ranked source catalogue hits are resolved through tenant, role and PII gates",async()=>{
  const requests:{sql:string;parameters:readonly unknown[]}[]=[];
  const sourceField={connection_id:"01J00000000000000000000009",connector_id:"lightspeed-r",source_schema:"source_lightspeed",source_table:"sales",source_field:"discount_reason",field_type:"text",pii_class:"business",authority_concept:"operational_sales",documented_definition:"Reviewed discount reason.",pack_version:"1.0.0"};
  const database={async queryAsSemanticRole(request:{tenantId:string;sql:string;parameters:readonly unknown[]}){requests.push({sql:request.sql,parameters:request.parameters});return{rows:[sourceField],durationMs:1};}};
  const provider=new PostgresSourceCatalogueProvider(database);
  const reference={connectorId:"lightspeed-r",sourceTable:"sales",sourceField:"discount_reason"};
  const owner=await provider.resolveRankedFields({...baseContext,role:"owner",conversationId:"01J00000000000000000000002",turnId:"01J00000000000000000000003"},[reference],12);
  assert.equal(owner[0]?.sourceField,"discount_reason");
  assert.match(requests[0]?.sql??"",/JOIN semantic_internal\.active_source_field_allowlist field/);
  assert.match(requests[0]?.sql??"",/WHERE field\.tenant_id=\$1/);
  assert.doesNotMatch(requests[0]?.sql??"",/JOIN semantic_internal\.source_field_allowlist field/);
  assert.match(requests[0]?.sql??"",/NOT IN \('customer_contact','payroll','sensitive_personal'\)/);
  assert.deepEqual(JSON.parse(String(requests[0]?.parameters[1])),[{connector_id:"lightspeed-r",source_table:"sales",source_field:"discount_reason",rank:1}]);
  await provider.resolveRankedFields({...baseContext,role:"bookkeeper",conversationId:"01J00000000000000000000002",turnId:"01J00000000000000000000003"},[reference],12);
  assert.match(requests[1]?.sql??"",/field\.pii_class='none'/);
  await assert.rejects(()=>provider.resolveRankedFields({...baseContext,role:"owner",conversationId:"01J00000000000000000000002",turnId:"01J00000000000000000000003"},[{...reference,sourceField:'bad"field'}],12),/Invalid governed catalogue field reference/);
});

test("Node semantic service exposes readiness, signed tools and graceful close",async()=>{
  let closed=false;const executor:SemanticToolExecutor={async execute(){return{state:"verified",definition:{id:"commerce.net_sales_ex_gst"},provenance:{bundleHash:"a".repeat(64),registryVersion:"1.0.0",identityGraph:{version:0,hash:"d41d8cd98f00b204e9800998ecf8427e"},sources:[],sourceWatermarks:{},sourceDetails:[],definitionsApplied:[],definitionDetails:[]},validation:{status:"passed",checks:[],warnings:[]},performance:{cacheHit:false,durationMs:0,rowCount:0}};}};
  const composition:SemanticServiceComposition={executor,async readiness(){return{ready:true,checks:{controlPlane:true,analyticalRead:true,semanticMetadata:true}};},async close(){closed=true;}};
  const secret="semantic-specific-signing-secret-at-least-32-bytes";const running=await startSemanticNodeServer({composition,signingSecret:secret,port:0});
  try{
    const readiness=await fetch(`${running.url}/readyz`);assert.equal(readiness.status,200);assert.equal((await readiness.json() as {status:string}).status,"ready");
    const path="/v1/tools/get_definition";const body=JSON.stringify({tenantId:FIXTURE_TENANT_ID,role:"owner",conversationId:"conversation",turnId:"turn",input:{name:"commerce.net_sales_ex_gst"}});const headers=await signSemanticHttpRequest(path,body,secret);
    const response=await fetch(`${running.url}${path}`,{method:"POST",headers,body});assert.equal(response.status,200);
  }finally{await running.close();}
  assert.equal(closed,true);
});

function daysBetween(from:string,to:string):number{return(Date.parse(`${to}T00:00:00Z`)-Date.parse(`${from}T00:00:00Z`))/86_400_000;}
