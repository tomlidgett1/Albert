import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildXeroDossierContributions } from "../../connectors/xero/canonical-policy.js";
import {
  assertDossierContribution,
  buildDossierDraft,
} from "../../services/sync-workers/src/canonical-pipeline.js";

const observedAt="2026-08-03T01:02:03.000Z";

test("dossier draft is deterministic, bounded and carries provenance for every fact",()=>{
  const source={
    location_names:["Brunswick\u0000 Shop","Fitzroy"],locations_observed_at:observedAt,
    channel_names:["In store"],channels_observed_at:observedAt,
    legal_entity_name:"Albert Cycle Co Pty Ltd",base_currency:"aud",entity_observed_at:observedAt,
    sale_count:120, sales_observed_at:observedAt,
    product_count:80,products_observed_at:observedAt,
    hours:[{day:1,opens:32_400,closes:61_200,samples:20}],
    strongest_month:"2026-07-01",quietest_month:"2026-02-01",observed_months:7,
  };
  const contributions=buildXeroDossierContributions({
    base_currency:"aud",sales_tax_basis:"ACCRUALS",
    tax_number:"GST-registered",observed_at:observedAt,
  },{
    legalEntityName:source.legal_entity_name,
    baseCurrency:source.base_currency,
    entityObservedAt:source.entity_observed_at,
  });
  const first=buildDossierDraft(source,contributions);
  const second=buildDossierDraft(source,contributions);
  assert.ok(first);
  assert.deepEqual(first,second);
  assert.equal(first.content.accounting_basis,"Accrual");
  assert.equal(first.content.gst_registration,"Registered");
  assert.equal(first.content.base_currency,"AUD");
  assert.deepEqual(first.content.locations,["Brunswick Shop","Fitzroy"]);
  assert.equal(first.content.trading_hours,"Monday 9:00 am–5:00 pm");
  assert.equal(first.content.seasonality,"Strongest observed month: July; quietest: February");
  assert.match(first.sourceBundleHash,/^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(first.provenance).sort(),Object.keys(first.content).sort());
  for(const evidence of Object.values(first.provenance)){
    assert.equal(evidence.observed_at,observedAt);
    assert.ok(evidence.confidence>=0&&evidence.confidence<=1);
  }
});

test("connector dossier facts are key-owned and bounded",()=>{
  const base={
    key:"base_currency",value:"AUD",source:"Xero Organisation settings",
    observedAt,confidence:1,confirmationState:"source_reported" as const,
    merge:"replace" as const,
  };
  assert.doesNotThrow(()=>assertDossierContribution(base,["base_currency"]));
  assert.throws(
    ()=>assertDossierContribution({...base,key:"industry"},["base_currency"]),
    /dossier_contribution_invalid/u,
  );
  assert.throws(
    ()=>assertDossierContribution({...base,value:"x".repeat(501)},["base_currency"]),
    /dossier_contribution_invalid/u,
  );
});

test("Xero dossier evidence is fenced to the active connection generation",async()=>{
  const registry=await readFile("connectors/canonical-registry.ts","utf8");
  const pack=await readFile("connectors/xero/canonical-policy.ts","utf8");
  assert.match(registry,/evidence\.connection_generation=\$3::bigint/u);
  assert.match(registry,/source\.tenant_id=\$1 and source\.connection_id=\$2/u);
  assert.match(pack,/connection\.connectionId,connection\.connectionGeneration/u);
  assert.match(pack,/ownedKeys:[\s\S]*?base_currency[\s\S]*?accounting_basis[\s\S]*?gst_registration/u);
});

test("dossier draft does not publish unsupported empty inference",()=>{
  assert.equal(buildDossierDraft(undefined),null);
  assert.equal(buildDossierDraft({
    location_names:[],locations_observed_at:null,channel_names:[],channels_observed_at:null,
    legal_entity_name:null,base_currency:null,entity_observed_at:null,
    sale_count:0,sales_observed_at:null,
    product_count:0,products_observed_at:null,hours:[],strongest_month:null,
    quietest_month:null,observed_months:0,
  }),null);
});

test("dossier publication is fixed-function, idempotent, role fenced and audited",async()=>{
  const sql=await readFile("infra/migrations/control-plane/0011_m7_dossier_publication.sql","utf8");
  assert.match(sql,/SECURITY DEFINER/);
  assert.match(sql,/pg_has_role\(session_user, 'albert_transform_control', 'MEMBER'\)/);
  assert.match(sql,/current_setting\('albert\.tenant_id'/);
  assert.match(sql,/source_bundle_hash = p_source_bundle_hash/);
  assert.match(sql,/dossier\.published/);
  assert.match(sql,/REVOKE ALL ON FUNCTION[\s\S]*service_role/);
  assert.match(sql,/GRANT EXECUTE ON FUNCTION[\s\S]*albert_transform_control/);
});
