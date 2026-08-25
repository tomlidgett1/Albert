import assert from "node:assert/strict";
import test from "node:test";

import type { ConnectorCapability,RawSourceRecord } from "../../packages/connector-sdk/src/index.js";
import type { SyncJob } from "../../packages/queue/src/index.js";
import {
  CONNECTOR_QUALITY_CHECK_IDS,
  buildConnectorQualityResults,
} from "../../services/sync-workers/src/connector-quality.js";

const job={
  type:"IncrementalSync",connectorId:"xero",stream:"xero_invoices",
} as unknown as SyncJob;
const supported:ConnectorCapability={
  id:"finance.invoices",support:"full",reasonCode:"live_stream_observed",
};

test("connector quality results are complete and evidence-derived",()=>{
  const results=buildConnectorQualityResults({
    job,records:[record()],stagedRecordCount:1,quarantineCount:0,
    hasMore:false,nextCursor:null,capabilities:[supported],
  });
  assert.deepEqual(results.map((result)=>result.checkId),CONNECTOR_QUALITY_CHECK_IDS);
  assert.equal(check(results,"cursor_completeness").status,"passed");
  assert.equal(check(results,"scope_available").status,"passed");
  assert.equal(check(results,"schema_drift").status,"passed");
  assert.equal(check(results,"retention_limit_recorded").status,"warning");
  assert.equal(check(results,"webhook_gap_recovered").status,"warning");
  assert.equal(check(results,"enum_drift").status,"warning");
});

test("missing scopes and observed schema drift fail closed",()=>{
  const missing:ConnectorCapability={
    id:"finance.journals",support:"unavailable",reasonCode:"required_scope_missing",
    requiredScopes:["accounting.journals.read"],
  };
  const results=buildConnectorQualityResults({
    job,records:[record({code:"schema_drift",path:"newField",message:"Undeclared field."})],
    stagedRecordCount:0,quarantineCount:1,hasMore:true,nextCursor:{value:"next"},
    capabilities:[missing],
  });
  assert.equal(check(results,"scope_available").status,"blocked");
  assert.deepEqual(check(results,"scope_available").details.missingScopes,["accounting.journals.read"]);
  assert.equal(check(results,"schema_drift").status,"blocked");
});

function record(issue?:NonNullable<RawSourceRecord["validationIssues"]>[number]):RawSourceRecord{
  return{
    sourceObjectType:"Invoices",sourceRecordId:"invoice-1",
    sourceUpdatedAt:"2026-08-03T00:00:00.000Z",payload:{},payloadHash:"hash",
    normalized:{schemaVersion:"1",fields:{},tombstone:false},
    ...(issue?{validationIssues:[issue]}:{}),
  };
}

function check(
  results:ReturnType<typeof buildConnectorQualityResults>,
  id:(typeof CONNECTOR_QUALITY_CHECK_IDS)[number],
){
  const found=results.find((result)=>result.checkId===id);
  assert.ok(found);
  return found;
}
