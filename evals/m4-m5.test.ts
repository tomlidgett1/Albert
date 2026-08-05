import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Decimal4, DIMENSION_IDS, FACT_IDS, factDeclarations } from "../packages/canonical-schema/src/index.js";
import { compileSemanticQuery, SemanticCompilerError } from "../packages/compiler/src/index.js";
import { buildRegistry, loadRegistryFile, parseRegistryDocument } from "../packages/semantic-registry/src/index.js";
import { semanticBundleHash } from "../services/semantic-query/src/index.js";
import { evaluateFixtureQuery } from "./fixture-engine.js";
import { FIXTURE_NOW,FIXTURE_TENANT_ID,retailFixtureRows } from "./fixtures/retail.js";
import { seedGoldenQuestions } from "./golden/questions.js";

const registryPath=resolve("packages/semantic-registry/registry/registry.yaml");
const registry=loadRegistryFile(registryPath);
const capabilities=new Set([...registry.metrics.values()].flatMap((metric)=>metric.requiredCapabilities));
const context={tenantId:FIXTURE_TENANT_ID,role:"owner" as const,capabilities,now:FIXTURE_NOW,timezone:"Australia/Melbourne",tradingDayCutoff:"00:00",fiscalYearStartMonth:7,fiscalYearStartDay:1,weekStartsOn:1,tenantParameters:{active_customer_days:90,lapsed_customer_days:180,stock_velocity_days:30}};
const march={type:"absolute" as const,from:"2026-03-01T00:00:00.000Z",to:"2026-04-01T00:00:00.000Z"};

test("registry publishes the generated 51-contract, 8-Topic model",()=>{
  assert.equal(registry.metrics.size,51);assert.equal(registry.topics.size,8);
  const domains=[...registry.metrics].reduce<Record<string,number>>((counts,[id])=>{const domain=id.split(".")[0] as string;counts[domain]=(counts[domain]??0)+1;return counts;},{});
  assert.deepEqual(domains,{commerce:14,customers:7,inventory:7,workforce:6,finance:9,composites:8});
});

test("canonical executable declarations contain exactly sixteen dimensions and thirteen facts",()=>{
  assert.equal(DIMENSION_IDS.length,16);assert.equal(FACT_IDS.length,13);assert.equal(factDeclarations.length,13);
  for(const fact of factDeclarations){assert.deepEqual(fact.primaryKey,["tenant_id","id"]);assert.ok(fact.grain);assert.ok(fact.timeRoles.includes(fact.defaultTimeRole));for(const relationship of fact.relationships)assert.ok(["many_to_one","one_to_one"].includes(relationship.cardinality));}
});

test("exact decimal arithmetic never crosses a binary float boundary",()=>{
  assert.equal(Decimal4.from("0.1000").add("0.2000").toString(),"0.3000");
  assert.equal(Decimal4.from("1.0000").divide("6.0000").toString(),"0.1667");
  assert.equal(Decimal4.from("-1.0000").divide("6.0000").toString(),"-0.1667");
});

test("single-fact compiler injects tenant scope and parameterises hostile values",()=>{
  const hostile="Carlton' OR 1=1 --";
  const compiled=compileSemanticQuery({topic:"sales_performance",metrics:["net_sales_ex_gst","gross_margin_pct"],dimensions:["location"],filters:[{field:"location",op:"eq",values:[hostile]}],time:{field:"business_date",range:march,compare:"none"},sort:[{metric:"net_sales_ex_gst",dir:"desc"}],limit:20,parameters:{}},registry,context);
  assert.equal(compiled.parameters[0],FIXTURE_TENANT_ID);assert.ok(compiled.parameters.includes(hostile));assert.ok(!compiled.sql.includes(hostile));
  assert.match(compiled.sql,/f\."tenant_id" = \$1/);assert.doesNotMatch(compiled.sql,/workforce_time_entry|finance_journal_line/);assert.ok(!("tenantId" in (compiled as unknown as Record<string,unknown>)));
});

test("capability failures are structured and happen before execution",()=>{
  assert.throws(()=>compileSemanticQuery({topic:"sales_performance",metrics:["net_sales_ex_gst"],dimensions:[],filters:[],time:{field:"business_date",range:march,compare:"none"},sort:[],limit:20,parameters:{}},registry,{...context,capabilities:new Set()}),(error)=>error instanceof SemanticCompilerError&&error.code==="MISSING_CAPABILITY");
});

test("snapshot sums are rejected by the compiler",()=>{
  const document=parseRegistryDocument(readFileSync(registryPath,"utf8"));
  const modified={...document,metrics:document.metrics.map((metric)=>metric.id==="inventory.stock_on_hand_value"?{...metric,aggregation:"sum" as const,calculation:{op:"sum" as const,field:"stock_value"}}:metric)};
  const unsafe=buildRegistry(modified);
  assert.throws(()=>compileSemanticQuery({topic:"inventory_health",metrics:["stock_on_hand_value"],dimensions:[],filters:[],time:{field:"snapshot_date",range:{type:"absolute",from:"2026-03-01T00:00:00.000Z",to:"2026-04-01T00:00:00.000Z"},compare:"none"},sort:[],limit:20,parameters:{}},unsafe,context),(error)=>error instanceof SemanticCompilerError&&error.code==="SNAPSHOT_SUM_FORBIDDEN");
});

test("composites aggregate independently then full-outer-align",()=>{
  const compiled=compileSemanticQuery({kind:"composite",topic:"workforce_sales",metrics:["labour_cost_pct_of_sales","sales_per_labour_hour"],queries:[
    {topic:"sales_performance",metrics:["net_sales_ex_gst"],dimensions:["business_date","location","worker"],filters:[],time:{field:"business_date",range:march,compare:"none"},parameters:{}},
    {topic:"workforce_labour",metrics:["worked_hours","labour_cost"],dimensions:["business_date","location","worker"],filters:[],time:{field:"business_date",range:march,compare:"none"},parameters:{}}
  ],alignOn:["business_date","location","worker"],sort:[{metric:"sales_per_labour_hour",dir:"desc"}],limit:20,parameters:{}},registry,context);
  assert.match(compiled.sql,/WITH q0 AS/);assert.match(compiled.sql,/FULL OUTER JOIN q1/);assert.equal(compiled.sourceTables.length,2);
  const salesPosition=compiled.sql.indexOf('FROM "mart"."commerce_sales_event"');const labourPosition=compiled.sql.indexOf('FROM "mart"."workforce_day_worker_location"');const alignmentPosition=compiled.sql.indexOf("FULL OUTER JOIN q1");
  assert.ok(salesPosition>=0&&labourPosition>=0&&alignmentPosition>salesPosition&&alignmentPosition>labourPosition);
});

test("flagship gross profit per worked hour is governed, capability-gated and denominator-safe",()=>{
  const query={
    kind:"composite" as const,topic:"workforce_sales",metrics:["gross_profit_per_labour_hour"],queries:[
      {topic:"sales_performance",metrics:["gross_margin"],dimensions:["worker"],filters:[],time:{field:"business_date",range:march,compare:"none" as const},parameters:{}},
      {topic:"workforce_labour",metrics:["worked_hours"],dimensions:["worker"],filters:[],time:{field:"business_date",range:march,compare:"none" as const},parameters:{}},
    ],alignOn:["worker"],sort:[{metric:"gross_profit_per_labour_hour",dir:"desc" as const}],limit:20,parameters:{},
  };
  const compiled=compileSemanticQuery(query,registry,context);
  assert.deepEqual(compiled.sourceTables,["mart.commerce_sales_event","mart.workforce_day_worker_location"]);
  assert.match(compiled.sql,/FULL OUTER JOIN q1/u);
  assert.match(compiled.sql,/"gross_margin"[^\n]*\/ NULLIF\([^\n]*"worked_hours"[^\n]*, 0\)/u);
  assert.doesNotMatch(compiled.sql,/commerce_order_line[\s\S]*JOIN[\s\S]*workforce_time_entry/iu);
  assert.ok(compiled.resultColumns.includes("gross_profit_per_labour_hour"));
  const evidence=compiled.validationEvidence.metrics.find((metric)=>metric.metricId==="composites.gross_profit_per_labour_hour");
  assert.ok(evidence);
  assert.ok(evidence.testKinds.includes("aggregate_then_align"));
  assert.ok(evidence.testKinds.includes("cost_coverage"));
  assert.ok(evidence.testKinds.includes("worker_attribution_coverage"));
  assert.deepEqual(evaluateFixtureQuery(query,registry,retailFixtureRows),[
    {worker:"Jo",gross_margin:"30.0000",worked_hours:"5.0000",gross_profit_per_labour_hour:"6.0000"},
    {worker:"Sam",gross_margin:"96.0000",worked_hours:"18.0000",gross_profit_per_labour_hour:"5.3333"},
  ]);

  const missingWorkerAttribution=new Set(context.capabilities);
  missingWorkerAttribution.delete("commerce.order_lines.worker_attribution");
  assert.throws(
    ()=>compileSemanticQuery(query,registry,{...context,capabilities:missingWorkerAttribution}),
    (error)=>error instanceof SemanticCompilerError&&error.code==="MISSING_CAPABILITY",
  );
  const missingCost=new Set(context.capabilities);
  missingCost.delete("commerce.order_lines.cost");
  assert.throws(
    ()=>compileSemanticQuery(query,registry,{...context,capabilities:missingCost}),
    (error)=>error instanceof SemanticCompilerError&&error.code==="MISSING_CAPABILITY",
  );
});

test("semantic bundle hashes are canonical and sensitive to watermarks and identity graph state",()=>{
  const graph={version:4,hash:"a".repeat(32)};
  const left=semanticBundleHash({registryVersion:"1.0.0",overlayVersion:"3",identityGraph:graph,packVersions:{xero:"2",lightspeed:"1"},sourceWatermarks:{b:"2",a:"1"},ir:{metrics:["net_sales_ex_gst"]}});
  const reordered=semanticBundleHash({registryVersion:"1.0.0",overlayVersion:"3",identityGraph:graph,packVersions:{lightspeed:"1",xero:"2"},sourceWatermarks:{a:"1",b:"2"},ir:{metrics:["net_sales_ex_gst"]}});
  const changed=semanticBundleHash({registryVersion:"1.0.0",overlayVersion:"3",identityGraph:graph,packVersions:{lightspeed:"1",xero:"2"},sourceWatermarks:{a:"1",b:"3"},ir:{metrics:["net_sales_ex_gst"]}});
  const graphChanged=semanticBundleHash({registryVersion:"1.0.0",overlayVersion:"3",identityGraph:{version:5,hash:"b".repeat(32)},packVersions:{lightspeed:"1",xero:"2"},sourceWatermarks:{a:"1",b:"2"},ir:{metrics:["net_sales_ex_gst"]}});
  assert.equal(left,reordered);assert.notEqual(left,changed);assert.notEqual(left,graphChanged);assert.match(left,/^[a-f0-9]{64}$/);
});

test("fixture numeric suite calculates governed commerce metrics exactly",()=>{
  const rows=evaluateFixtureQuery({topic:"sales_performance",metrics:["net_sales_ex_gst","gross_takings_inc_gst","transactions","avg_order_value","units_sold","items_per_transaction","discount_rate","refund_amount","refund_rate","gross_margin","gross_margin_pct"],dimensions:[],filters:[],time:{field:"business_date",range:march,compare:"none"},sort:[],limit:20,parameters:{}},registry,retailFixtureRows);
  assert.deepEqual(rows,[{net_sales_ex_gst:"210.0000",gross_takings_inc_gst:"231.0000",transactions:"3.0000",avg_order_value:"77.0000",units_sold:"21.0000",items_per_transaction:"7.0000",discount_rate:"3.8023",refund_amount:"22.0000",refund_rate:"8.6957",gross_margin:"126.0000",gross_margin_pct:"60.0000"}]);
});

test("fixture numeric suite groups categories without fan-out",()=>{
  const rows=evaluateFixtureQuery({topic:"sales_performance",metrics:["net_sales_ex_gst"],dimensions:["product.category"],filters:[],time:{field:"business_date",range:march,compare:"none"},sort:[{metric:"net_sales_ex_gst",dir:"desc"}],limit:20,parameters:{}},registry,retailFixtureRows);
  assert.deepEqual(rows,[{"product.category":"Coffee",net_sales_ex_gst:"160.0000"},{"product.category":"Food",net_sales_ex_gst:"50.0000"}]);
});

test("fixture numeric suite respects latest-value inventory semantics",()=>{
  const rows=evaluateFixtureQuery({topic:"inventory_health",metrics:["stock_on_hand_units","stock_on_hand_value","stock_cover_days"],dimensions:["product.category"],filters:[],time:{field:"snapshot_date",range:{type:"absolute",from:"2026-03-15T00:00:00.000Z",to:"2026-03-16T00:00:00.000Z"},compare:"none"},sort:[],limit:20,parameters:{}},registry,retailFixtureRows);
  assert.deepEqual(rows,[{"product.category":"Coffee",stock_on_hand_units:"100.0000",stock_on_hand_value:"400.0000",stock_cover_days:"25.0000"},{"product.category":"Food",stock_on_hand_units:"20.0000",stock_on_hand_value:"100.0000",stock_cover_days:"4.0000"},{"product.category":"Supplies",stock_on_hand_units:"30.0000",stock_on_hand_value:"60.0000",stock_cover_days:"0.0000"}]);
});

test("all seed golden questions declare route and answer-state expectations",()=>{
  assert.equal(seedGoldenQuestions.length,25);assert.ok(seedGoldenQuestions.every((question)=>question.expectedRoute&&question.expectedState));
  assert.equal(seedGoldenQuestions.find((question)=>question.id==="workforce-best")?.expectedState,"clarification");
  assert.equal(seedGoldenQuestions.find((question)=>question.id==="finance-profit")?.expectedState,"clarification");
  assert.equal(seedGoldenQuestions.find((question)=>question.id==="honesty-footfall")?.expectedState,"unavailable");
  assert.equal(seedGoldenQuestions.find((question)=>question.id==="exploration-staff-discount")?.expectedRoute,"source_exploration");
});

test("analytical migrations permanently encode isolation, lineage, source-neutrality and projection",()=>{
  const foundation=readFileSync(resolve("infra/migrations/analytical/0010_m4_canonical_foundation.sql"),"utf8");
  const transforms=readFileSync(resolve("infra/migrations/analytical/0020_m4_transforms_quality_and_marts.sql"),"utf8");
  assert.match(foundation,/FORCE ROW LEVEL SECURITY/);assert.match(foundation,/tenant_id = core\.current_tenant_id\(\)/);
  assert.match(foundation,/canonical fact lineage is immutable/);assert.match(foundation,/numeric\(19,4\)/);assert.doesNotMatch(foundation,/CREATE TYPE .* AS ENUM/i);
  assert.doesNotMatch(`${foundation}\n${transforms}`,/PARTITION OF|PARTITION BY RANGE|PARTITION BY LIST/i);
  assert.match(transforms,/pipeline_stats_projection_outbox/);assert.match(transforms,/FULL OUTER JOIN/);assert.doesNotMatch(transforms,/lightspeed|xero|deputy/i);
});
