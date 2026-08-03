import type { ConnectorId } from "../packages/connector-sdk/src/index.js";
import type {
  CanonicalCompatibilityReplayHook,
  CanonicalHookDatabase,
  CanonicalHookDatabaseValue,
  CanonicalDossierContributorHook,
  CanonicalReferenceLookupHook,
  CanonicalReplayCandidateHandle,
  CanonicalStagingRow,
} from "../services/sync-workers/src/canonical-contract.js";
import type { PostgresQueryClient } from "../packages/queue/src/index.js";
import { lightspeedRCompatibilityReplay } from "./lightspeed-r/compatibility-replay.js";
import { lightspeedRManifest } from "./lightspeed-r/manifest.js";
import {
  xeroDossierContributor,
  xeroReferenceLookup,
} from "./xero/canonical-policy.js";
import { xeroManifest } from "./xero/manifest.js";

/** Explicit composition root for connector-owned canonical runtime hooks. */
const compatibilityReplayById = new Map<ConnectorId, CanonicalCompatibilityReplayHook>([
  [lightspeedRManifest.id, lightspeedRCompatibilityReplay],
]);

const referenceLookupById = new Map<ConnectorId, CanonicalReferenceLookupHook>([
  [xeroManifest.id, xeroReferenceLookup],
]);

const dossierContributors: readonly CanonicalDossierContributorHook[] = Object.freeze([
  xeroDossierContributor,
]);

type HookDatabaseOperation = Readonly<{
  sql: string;
  parameters: readonly ("bounded_string" | "positive_integer")[];
  maxRows: number;
  connectionScoped?: boolean;
  validate?: (
    values: readonly CanonicalHookDatabaseValue[],
    scope: ConnectorHookDatabaseScope,
  ) => boolean;
}>;

export type ConnectorHookDatabaseScope = Readonly<{
  tenantId: string;
  connectionId?: string;
  batchId?: string;
  syncRunId?: string;
  mappingVersion?: string;
  connectionGeneration?: number;
}>;

export type ConnectorHookDatabaseBinding = Readonly<{
  database: CanonicalHookDatabase;
  assertReplaySelection(
    eligible:boolean,
    handles: readonly CanonicalReplayCandidateHandle[],
  ): void;
  resolveReplayCandidate(handle: CanonicalReplayCandidateHandle): CanonicalStagingRow;
  materializedReplaySourceRecordIds(
    handle: CanonicalReplayCandidateHandle,
  ): Promise<ReadonlySet<string>>;
  checkpointReplayCandidate(handle: CanonicalReplayCandidateHandle): Promise<void>;
  finalizeReplay(): Promise<void>;
}>;

const compatibilityCandidateLimit = 100;

/**
 * Exact reviewed SQL capabilities for installed hooks. The generic transform
 * runtime owns the real client and rejects every operation absent from this
 * composition-root allowlist.
 */
export type ConnectorHookRegistrationId =
  | "lightspeed-r.compatibility-replay"
  | "xero.reference-lookup"
  | "xero.dossier";

const hookDatabaseOperations = new Map<string, ReadonlyMap<string, HookDatabaseOperation>>([
  ["lightspeed-r.compatibility-replay", new Map<string, HookDatabaseOperation>([
    ["compatibility.replay_generation", {
      sql: `select candidate.connection_generation,$4::bigint as expected_connection_generation
              from (select semantic_internal.lightspeed_supplier_replay_generation(
                     $1::text,$2::text,$3::text
                   ) as connection_generation) candidate`,
      parameters: ["bounded_string", "bounded_string", "bounded_string", "positive_integer"],
      maxRows: 1,
      connectionScoped: true,
      validate: (values, scope) =>
        values[2] === scope.batchId && values[3] === scope.connectionGeneration,
    }],
    ["compatibility.replay_candidates", {
      sql: `select staged.*,origin.source_object_type,
                   origin_manifest.connector_version as predecessor_connector_version,
                   origin_manifest.api_version as predecessor_api_version,
                   origin.normalized_schema_version as predecessor_schema_version,
                   origin.stream as predecessor_stream
              from source_lightspeed.orders staged
              join ingestion.source_records origin
                on origin.tenant_id=staged.tenant_id
               and origin.namespaced_source_key=staged.namespaced_source_key
               and origin.connection_id=staged.connection_id
               and origin.connector_key='lightspeed-r' and origin.stream='orders'
               and origin.source_object_type='Order'
               and origin.source_record_id=staged.source_record_id
               and origin.payload_hash=staged.payload_hash
               and origin.normalized_schema_version='1.0.0'
              join ingestion.batch_manifests origin_manifest
                on origin_manifest.tenant_id=origin.tenant_id
               and origin_manifest.batch_id=origin.payload_batch_id
               and origin_manifest.connection_id=origin.connection_id
               and origin_manifest.sync_run_id=origin.sync_run_id
               and origin_manifest.connector_key='lightspeed-r'
               and origin_manifest.connector_version='1.0.0'
               and origin_manifest.api_version=$6
               and origin_manifest.stream='orders'
              left join semantic_internal.lightspeed_order_dependency_replay_audit audit
                on audit.tenant_id=staged.tenant_id
               and audit.connection_id=staged.connection_id
               and audit.connection_generation=$4::bigint
               and audit.source_order_namespaced_key=staged.namespaced_source_key
               and audit.source_order_payload_hash=staged.payload_hash
               and audit.source_order_mapping_version=staged.mapping_version
             where staged.tenant_id=$1 and staged.connection_id=$2
               and staged.mapping_version=$3 and not staged.tombstone
               and nullif(btrim(staged.vendor_id),'') is not null
               and btrim(staged.vendor_id)<>'0'
               and audit.tenant_id is null
               and (
                 jsonb_typeof(staged.order_lines->'OrderLine')='object'
                 or (jsonb_typeof(staged.order_lines->'OrderLine')='array'
                     and jsonb_array_length(staged.order_lines->'OrderLine')>0)
                 or (jsonb_typeof(staged.order_lines)='array'
                     and jsonb_array_length(staged.order_lines)>0)
               )
             order by staged.namespaced_source_key
             limit $5::integer`,
      parameters: [
        "bounded_string", "bounded_string", "bounded_string",
        "positive_integer", "positive_integer", "bounded_string",
      ],
      maxRows: compatibilityCandidateLimit,
      connectionScoped: true,
      validate: (values, scope) =>
        values[2] === scope.mappingVersion &&
        values[3] === scope.connectionGeneration &&
        values[4] === compatibilityCandidateLimit &&
        values[5] === lightspeedRManifest.apiVersion,
    }],
    ["compatibility.materialized_records", {
      sql: `select state.source_record_id
              from semantic_internal.canonical_record_state state
             where state.tenant_id=$1
               and state.canonical_table='purchase_order_line'
               and state.connection_id=$2
               and state.batch_id=$3
               and state.sync_run_id=$4
               and state.payload_hash=$5
               and state.mapping_version=$6
               and state.source_object_type='OrderLine'
             limit 5001`,
      parameters: [
        "bounded_string", "bounded_string", "bounded_string",
        "bounded_string", "bounded_string", "bounded_string",
      ],
      maxRows: 5_000,
      connectionScoped: true,
      validate: (values, scope) => values[5] === scope.mappingVersion,
    }],
    ["compatibility.record_replay", {
      sql: `select semantic_internal.record_lightspeed_order_dependency_replay(
              $1::text,$2::text,$3::text,$4::text,$5::text,$6::text,$7::text
            ) as recorded`,
      parameters: [
        "bounded_string", "bounded_string", "bounded_string", "bounded_string",
        "bounded_string", "bounded_string", "bounded_string",
      ],
      maxRows: 1,
      connectionScoped: true,
      validate: (values, scope) =>
        values[2] === scope.batchId && values[3] === scope.syncRunId &&
        values[6] === scope.mappingVersion,
    }],
    ["compatibility.finalize", {
      sql: `select semantic_internal.finalize_lightspeed_supplier_replay_gate(
              $1::text,$2::text,$3::text
            ) as result`,
      parameters: ["bounded_string", "bounded_string", "bounded_string"],
      maxRows: 1,
      connectionScoped: true,
      validate: (values, scope) => values[2] === scope.batchId,
    }],
  ])],
  ["xero.reference-lookup", new Map<string, HookDatabaseOperation>([
    ["reference.natural_key_candidates", {
      sql: `select account.source_record_id,source.source_object_type
              from source_xero.accounts account
              join ingestion.source_records source
                on source.tenant_id=account.tenant_id
               and source.connection_id=account.connection_id
               and source.namespaced_source_key=account.namespaced_source_key
               and source.connector_key='xero'
               and source.stream='accounts'
               and source.source_object_type='Account'
               and source.source_record_id=account.source_record_id
               and source.payload_hash=account.payload_hash
               and source.payload_batch_id=account.payload_batch_id
              join quality.connector_stream_page_evidence evidence
                on evidence.tenant_id=account.tenant_id
               and evidence.batch_id=account.payload_batch_id
               and evidence.connection_id=account.connection_id
               and evidence.connection_generation=$4::bigint
               and evidence.stream='accounts'
             where account.tenant_id=$1 and account.connection_id=$2
               and account.code=$3 and not account.tombstone
             order by account.source_updated_at desc nulls last limit 2`,
      parameters: [
        "bounded_string", "bounded_string", "bounded_string", "positive_integer",
      ],
      maxRows: 2,
      connectionScoped: true,
      validate:(values,scope)=>values[3]===scope.connectionGeneration,
    }],
  ])],
  ["xero.dossier", new Map<string, HookDatabaseOperation>([
    ["dossier.latest_source", {
      sql: `select base_currency,sales_tax_basis,tax_number,
                   coalesce(source.updated_date_utc,source.source_updated_at,source.ingested_at) as observed_at
              from source_xero.organisation source
              join ingestion.batch_manifests manifest
                on manifest.tenant_id=source.tenant_id
               and manifest.batch_id=source.payload_batch_id
               and manifest.connection_id=source.connection_id
               and manifest.connector_key='xero' and manifest.stream='organisation'
              join quality.connector_stream_page_evidence evidence
                on evidence.tenant_id=source.tenant_id
               and evidence.batch_id=source.payload_batch_id
               and evidence.connection_id=source.connection_id
               and evidence.connection_generation=$3::bigint
               and evidence.stream='organisation'
             where source.tenant_id=$1 and source.connection_id=$2
               and not source.tombstone
             order by coalesce(source.updated_date_utc,source.source_updated_at,source.ingested_at) desc,
                      source.namespaced_source_key
             limit 1`,
      parameters: ["bounded_string","bounded_string","positive_integer"],
      maxRows: 1,
      connectionScoped: true,
      validate:(values,scope)=>values[2]===scope.connectionGeneration,
    }],
  ])],
]);

export function connectorHookDatabase(
  registrationId: string,
  client: PostgresQueryClient,
  scope: ConnectorHookDatabaseScope,
): CanonicalHookDatabase {
  return connectorHookDatabaseBinding(registrationId,client,scope).database;
}

export function connectorHookDatabaseBinding(
  registrationId: string,
  client: PostgresQueryClient,
  scope: ConnectorHookDatabaseScope,
): ConnectorHookDatabaseBinding {
  const operations = hookDatabaseOperations.get(registrationId);
  if (!operations) throw new Error(`canonical_hook_database_missing:${registrationId}`);
  const candidates = new WeakMap<object,CanonicalStagingRow>();
  let issued:readonly CanonicalReplayCandidateHandle[]|undefined;
  const execute=async<Row extends Readonly<Record<string, unknown>>>(
    operation:string,
    values:readonly CanonicalHookDatabaseValue[],
  ):Promise<readonly Row[]>=>{
    const policy = operations.get(operation);
    if (!policy) throw new Error("canonical_hook_database_operation_denied");
    if (!hookDatabaseParametersValid(values, policy.parameters) ||
        values[0] !== scope.tenantId ||
        (policy.connectionScoped &&
          (!scope.connectionId || values[1] !== scope.connectionId)) ||
        (policy.validate && !policy.validate(values, scope))) {
      throw new Error("canonical_hook_database_parameters_invalid");
    }
    const result = await client.query<Row>(policy.sql, [...values]);
    if (result.rows.length > policy.maxRows) {
      throw new Error("canonical_hook_database_result_unbounded");
    }
    if(operation==="compatibility.replay_generation"){
      const generation=(result.rows[0] as {connection_generation?:unknown}|undefined)?.connection_generation;
      if(generation!==null&&generation!==undefined&&Number(generation)!==scope.connectionGeneration){
        throw new Error("canonical_dependency_replay_generation_stale");
      }
    }
    return Object.freeze(result.rows.map((row) => Object.freeze({ ...row })));
  };
  const database:CanonicalHookDatabase=Object.freeze({
    async run<Row extends Readonly<Record<string, unknown>>>(
      operation: string,
      values: readonly CanonicalHookDatabaseValue[],
    ): Promise<readonly Row[]> {
      if(operation.startsWith("compatibility.")&&
          operation!=="compatibility.replay_generation"){
        throw new Error("canonical_hook_database_operation_denied");
      }
      return execute<Row>(operation,values);
    },
    async replayCandidates(
      operation:string,
      values:readonly CanonicalHookDatabaseValue[],
    ):Promise<readonly CanonicalReplayCandidateHandle[]> {
      if(operation!=="compatibility.replay_candidates"||issued){
        throw new Error("canonical_hook_database_operation_denied");
      }
      const rows=await execute<CanonicalStagingRow&Readonly<{
        predecessor_connector_version:unknown;
        predecessor_api_version:unknown;
        predecessor_schema_version:unknown;
        predecessor_stream:unknown;
      }>>(operation,values);
      issued=Object.freeze(rows.map((candidate)=>{
        const {
          predecessor_connector_version:connectorVersion,
          predecessor_api_version:apiVersion,
          predecessor_schema_version:schemaVersion,
          predecessor_stream:predecessorStream,
          ...row
        }=candidate;
        if(registrationId!=="lightspeed-r.compatibility-replay"||
            connectorVersion!=="1.0.0"||apiVersion!==lightspeedRManifest.apiVersion||
            schemaVersion!=="1.0.0"||predecessorStream!=="orders"){
          throw new Error("canonical_dependency_replay_predecessor_invalid");
        }
        const handle=Object.freeze({}) as CanonicalReplayCandidateHandle;
        candidates.set(handle,Object.freeze(row) as CanonicalStagingRow);
        return handle;
      }));
      return issued;
    },
  });
  const requireCandidate=(handle:CanonicalReplayCandidateHandle):CanonicalStagingRow=>{
    const row=candidates.get(handle);
    if(!row)throw new Error("canonical_dependency_replay_candidate_invalid");
    return row;
  };
  return Object.freeze({
    database,
    assertReplaySelection(eligible,handles){
      if(!issued){
        if(!eligible&&handles.length===0)return;
        throw new Error("canonical_dependency_replay_selection_invalid");
      }
      const expected=issued;
      if(!eligible||handles.length!==expected.length||
          new Set(handles).size!==handles.length||
          handles.some((handle,index)=>handle!==expected[index])){
        throw new Error("canonical_dependency_replay_selection_invalid");
      }
    },
    resolveReplayCandidate:requireCandidate,
    async materializedReplaySourceRecordIds(handle){
      const row=requireCandidate(handle);
      if(!scope.connectionId||!scope.mappingVersion){
        throw new Error("canonical_dependency_replay_scope_invalid");
      }
      const materialized=await execute<{source_record_id:string}>(
        "compatibility.materialized_records",
        [scope.tenantId,scope.connectionId,row.payload_batch_id,row.sync_run_id,
          row.payload_hash,scope.mappingVersion],
      );
      return new Set(materialized.map((record)=>record.source_record_id));
    },
    async checkpointReplayCandidate(handle){
      const row=requireCandidate(handle);
      if(!scope.connectionId||!scope.batchId||!scope.syncRunId||!scope.mappingVersion){
        throw new Error("canonical_dependency_replay_scope_invalid");
      }
      const audit=await execute<{recorded:boolean}>(
        "compatibility.record_replay",
        [scope.tenantId,scope.connectionId,scope.batchId,scope.syncRunId,
          row.namespaced_source_key,row.payload_hash,scope.mappingVersion],
      );
      if(audit[0]?.recorded!==true){
        throw new Error(`canonical_dependency_replay_audit_conflict:${row.source_record_id}`);
      }
    },
    async finalizeReplay(){
      if(!scope.connectionId||!scope.batchId){
        throw new Error("canonical_dependency_replay_scope_invalid");
      }
      const finalized=await execute<{result:unknown}>(
        "compatibility.finalize",
        [scope.tenantId,scope.connectionId,scope.batchId],
      );
      const gate=finalized[0]?.result;
      if(!gate||typeof gate!=="object"||Array.isArray(gate)||
          (gate as {ready?:unknown}).ready!==true){
        throw new Error("canonical_dependency_replay_gate_not_ready");
      }
    },
  });
}

function hookDatabaseParametersValid(
  values: readonly CanonicalHookDatabaseValue[],
  kinds: HookDatabaseOperation["parameters"],
): boolean {
  if (values.length !== kinds.length) return false;
  return kinds.every((kind, index) => {
    const value = values[index];
    return kind === "positive_integer"
      ? typeof value === "number" && Number.isSafeInteger(value) && value > 0
      : typeof value === "string" && value.length > 0 && value.length <= 500;
  });
}

export function connectorCompatibilityReplay(
  connectorId: ConnectorId,
): CanonicalCompatibilityReplayHook | undefined {
  return compatibilityReplayById.get(connectorId);
}

export function connectorReferenceLookup(
  connectorId: ConnectorId,
): CanonicalReferenceLookupHook | undefined {
  return referenceLookupById.get(connectorId);
}

export function connectorDossierContributors(): readonly CanonicalDossierContributorHook[] {
  return dossierContributors;
}
