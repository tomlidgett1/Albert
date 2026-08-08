import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";

import { loadRegistryFile } from "../../packages/semantic-registry/src/index.js";
import {
  DefaultSemanticToolExecutor,
  MemorySemanticResultCache,
  type SemanticServiceDependencies,
  type TenantSemanticContext,
} from "../../services/semantic-query/src/index.js";

const registry=loadRegistryFile(resolve("packages/semantic-registry/registry/registry.yaml"));
const tenantId="01J00000000000000000000101";
const xeroA="01J00000000000000000000102";
const xeroB="01J00000000000000000000103";
const legalEntityA="01J00000000000000000000104";
const legalEntityB="01J00000000000000000000105";
const now="2026-08-03T00:00:00.000Z";
const trusted={
  tenantId,role:"owner" as const,
  conversationId:"01J00000000000000000000106",
  turnId:"01J00000000000000000000107",
};

test("one healthy Xero organisation cannot bless an unavailable peer",async()=>{
  let databaseCalls=0;
  const service=financeService(false,async()=>{
    databaseCalls+=1;
    return{rows:[{net_profit:"300.0000"}],durationMs:1};
  });

  await assert.rejects(
    ()=>service.execute("run_semantic_query",financeQuery(),trusted),
    /required capabilities are missing|missing capabilit/iu,
  );
  assert.equal(databaseCalls,0,"capability failure must happen before analytical SQL");
});

test("two authoritative Xero organisations aggregate with isolated contributor provenance",async()=>{
  let databaseCalls=0;
  const service=financeService(true,async()=>{
    databaseCalls+=1;
    return{rows:[{net_profit:"300.0000"}],durationMs:2};
  });

  const response=await service.execute("run_semantic_query",financeQuery(),trusted);

  assert.equal(databaseCalls,1);
  assert.equal(response.state,"verified");
  assert.deepEqual(response.provenance.sourceWatermarks,{
    [xeroA]:now,[xeroB]:now,
  });
  assert.deepEqual(
    response.provenance.sourceDetails.map((source)=>source.connectionId).sort(),
    [xeroA,xeroB],
  );
  const authority=response.validation.checks.find((check)=>check.checkId==="authority_respected");
  assert.ok(authority);
  const concepts=authority.concepts as readonly Readonly<Record<string,unknown>>[];
  assert.deepEqual(concepts.map((proof)=>proof.connectionId).sort(),[xeroA,xeroB]);
  assert.deepEqual(concepts.map((proof)=>proof.scopeId).sort(),[legalEntityA,legalEntityB]);
});

function financeService(
  secondAvailable:boolean,
  query:SemanticServiceDependencies["database"]["queryAsSemanticRole"],
):DefaultSemanticToolExecutor{
  const tenant:TenantSemanticContext={
    timezone:"Australia/Melbourne",tradingDayCutoff:"00:00",
    fiscalYearStartMonth:7,fiscalYearStartDay:1,weekStartsOn:1,
    tenantParameters:{active_customer_days:90,lapsed_customer_days:180,stock_velocity_days:30},
    // This is deliberately existential to reproduce the old bug: Xero A has
    // made the tenant-level set look available even when Xero B is not.
    capabilities:new Set(["finance.journals"]),
    capabilityDetails:[
      capability(xeroA,true),capability(xeroB,secondAvailable),
    ],
    overlayVersion:"overlay-multi-xero",identityGraphVersion:0,
    identityGraphHash:"d41d8cd98f00b204e9800998ecf8427e",defaults:{},dossier:{},
    packVersions:{xero:"1.0.0"},
    sourceWatermarks:{[xeroA]:now,[xeroB]:now},
    sourceDetails:[source(xeroA,"Xero AU"),source(xeroB,"Xero NZ")],
    authorityByConcept:{statutory_finance:xeroA},
    authoritySelections:[
      authority(legalEntityA,xeroA),authority(legalEntityB,xeroB),
    ],
  };
  return new DefaultSemanticToolExecutor({
    registry,contextProvider:{async load(){return tenant;}},
    database:{queryAsSemanticRole:query},
    cache:new MemorySemanticResultCache(()=>Date.parse(now)),
    sourceCatalogue:{async listFields(){return[];}},
    dataHealth:{async getForTopic(){return{status:"passed",checks:[]};}},
    audit:{async append(){},async promoteSourceField(){return"promotion-unused";}},
    publicationEvidence:{async inspect(){return{
      registryVersion:registry.version,registryHash:"f".repeat(64),activePublicationMatches:true,
    };}},
    clock:()=>new Date(now),
  });
}

function capability(connectionId:string,available:boolean){
  return{
    id:"finance.journals",connectorId:"xero",connectionId,available,
    support:(available?"full":"unavailable") as "full"|"unavailable",
    ...(available?{}:{reasonCode:"organisation_not_queryable"}),
    coverage:{stream:"xero_journals"},
  };
}

function source(connectionId:string,label:string){
  return{
    connectorId:"xero",connectionId,label,dataThrough:now,
    connectionStatus:"connected",authHealth:"healthy",authorityEligible:true,
  };
}

function authority(scopeId:string,connectionId:string){
  return{
    concept:"statutory_finance",scopeType:"legal_entity" as const,scopeId,connectionId,
    effectiveFrom:"1970-01-01T00:00:00.000Z",controlEligible:true,
  };
}

function financeQuery(){
  return{
    topic:"profitability_cash",metrics:["finance.net_profit"],dimensions:[],filters:[],
    time:{
      field:"business_date",
      range:{type:"absolute" as const,from:"2026-07-01T00:00:00.000Z",to:"2026-08-01T00:00:00.000Z"},
      compare:"none" as const,
    },
    sort:[],limit:20,parameters:{},
  };
}
