import type {
  ConnectorCapability,
  RawSourceRecord,
  SyncCursor,
} from "../../../packages/connector-sdk/src/index.js";
import type { SyncJob } from "../../../packages/queue/src/index.js";

export const CONNECTOR_QUALITY_CHECK_IDS = [
  "cursor_completeness",
  "scope_available",
  "retention_limit_recorded",
  "webhook_gap_recovered",
  "delete_handling",
  "schema_drift",
  "enum_drift",
] as const;

export type ConnectorQualityResult = Readonly<{
  checkId: (typeof CONNECTOR_QUALITY_CHECK_IDS)[number];
  status: "passed" | "warning" | "failed" | "blocked";
  observed?: number;
  threshold?: number;
  details: Readonly<Record<string, unknown>>;
}>;

/** Build fail-visible connector checks exclusively from evidence in this run. */
export function buildConnectorQualityResults(input:Readonly<{
  job:SyncJob;
  records:readonly RawSourceRecord[];
  stagedRecordCount:number;
  quarantineCount:number;
  hasMore:boolean;
  nextCursor:SyncCursor|null;
  capabilities:readonly ConnectorCapability[];
}>):readonly ConnectorQualityResult[]{
  const issueCounts=new Map<string,number>();
  let tombstones=0;
  const timestamps:string[]=[];
  for(const record of input.records){
    if(record.normalized?.tombstone)tombstones+=1;
    if(record.sourceUpdatedAt&&!Number.isNaN(Date.parse(record.sourceUpdatedAt)))timestamps.push(record.sourceUpdatedAt);
    for(const issue of record.validationIssues??[]){
      issueCounts.set(issue.code,(issueCounts.get(issue.code)??0)+1);
    }
  }
  timestamps.sort((left,right)=>Date.parse(left)-Date.parse(right));
  const cursorValid=!input.hasMore||input.nextCursor!==null;
  const missingScope=input.capabilities.filter((capability)=>
    capability.support==="unavailable"&&capability.reasonCode==="required_scope_missing");
  const unknownScope=input.capabilities.filter((capability)=>capability.support==="unknown");
  const supported=input.capabilities.filter((capability)=>capability.support==="full"||capability.support==="partial");
  const schemaDrift=issueCounts.get("schema_drift")??0;
  const schemaInvalid=issueCounts.get("schema_invalid")??0;
  const retentionDetails={
    reason:"vendor_retention_not_independently_reported",
    jobType:input.job.type,
    ...(input.job.type==="InitialBackfill"?{phase:input.job.phase,requestedFrom:input.job.range.from,requestedTo:input.job.range.to}:{}),
    ...(timestamps[0]?{firstObservedAt:timestamps[0]}:{}),
    ...(timestamps.at(-1)?{lastObservedAt:timestamps.at(-1)}:{}),
  };
  return Object.freeze([
    result("cursor_completeness",cursorValid?"passed":"blocked",{
      hasMore:input.hasMore,continuationCursorPresent:input.nextCursor!==null,
      evidence:"connector_page_contract",
    },cursorValid?0:1,0),
    result("scope_available",
      missingScope.length?"blocked":unknownScope.length?"warning":supported.length?"passed":"warning",
      {
        observedCapabilities:input.capabilities.map((capability)=>({
          id:capability.id,support:capability.support,reasonCode:capability.reasonCode,
        })),
        missingScopes:missingScope.flatMap((capability)=>capability.requiredScopes??[]),
        reason:missingScope.length?"required_scope_missing":unknownScope.length?"live_probe_incomplete":supported.length?"live_capability_probe_supported":"no_stream_capabilities_observed",
      },missingScope.length,0),
    result("retention_limit_recorded","warning",retentionDetails),
    result("webhook_gap_recovered","warning",{
      reason:input.job.type==="ReconciliationSweep"
        ?"polling_reconciliation_sweep_observed_but_webhook_sequence_not_available"
        :"webhook_gap_state_not_observed_in_this_sync_run",
      jobType:input.job.type,
    }),
    result("delete_handling",tombstones>0?"passed":"warning",{
      tombstonesObserved:tombstones,
      reason:tombstones>0?"source_tombstones_landed":"no_deletion_observation_in_this_run",
      jobType:input.job.type,
    },tombstones,1),
    result("schema_drift",schemaDrift>0?"blocked":input.records.length>0?"passed":"warning",{
      recordsObserved:input.records.length,stagedRecords:input.stagedRecordCount,
      quarantinedRecords:input.quarantineCount,schemaDriftFindings:schemaDrift,
      reason:schemaDrift>0?"undeclared_source_fields_observed":input.records.length>0?"all_observed_fields_dispositioned":"empty_page_has_no_schema_evidence",
    },schemaDrift,0),
    result("enum_drift",schemaInvalid>0?"blocked":"warning",{
      schemaInvalidFindings:schemaInvalid,
      reason:schemaInvalid>0?"typed_source_contract_rejected_records":"no_dedicated_vendor_enum_observation_available",
    },schemaInvalid,0),
  ]);
}

function result(
  checkId:ConnectorQualityResult["checkId"],
  status:ConnectorQualityResult["status"],
  details:Readonly<Record<string,unknown>>,
  observed?:number,
  threshold?:number,
):ConnectorQualityResult{
  return Object.freeze({checkId,status,...(observed===undefined?{}:{observed}),...(threshold===undefined?{}:{threshold}),details:Object.freeze(details)});
}
