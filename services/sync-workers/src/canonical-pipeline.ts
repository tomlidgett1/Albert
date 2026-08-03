import { createHash } from "node:crypto";
import {
  connectorCompatibilityReplay,
  connectorDossierContributors,
  connectorHookDatabase,
  connectorHookDatabaseBinding,
  connectorReferenceLookup,
} from "../../../connectors/canonical-registry.js";
import {
  connectorManifest,
  connectorManifests,
} from "../../../connectors/registry.js";
import {
  type SourceAuthorityConcept,
} from "../../../packages/canonical-schema/src/index.js";
import {
  buildStagingContracts,
  stagingColumnName,
  stagingSchema,
  type ConnectorId,
  type ConnectorManifest,
  type FieldCoverage,
  type StagingFieldContract,
  type StagingStreamContract,
  type StreamContract,
} from "../../../packages/connector-sdk/src/index.js";
import type { PostgresQueryClient } from "../../../packages/queue/src/index.js";
import type { TransactionalPostgres } from "./database.js";
import {
  isCanonicalSourceReference,
  type CanonicalEntityType,
  type CanonicalCategoryAssignmentCommand,
  type CanonicalDossierFactContribution,
  type CanonicalEventLinkCommand,
  type CanonicalIdentityHintCommand,
  type CanonicalMappingContext,
  type CanonicalProjectionCommand,
  type CanonicalProjectionTable,
  type CanonicalStagingRow,
  type CanonicalStreamMapper,
  type CanonicalTransformBatch,
  type CanonicalUpsertCommand,
} from "./canonical-contract.js";

const stagingContracts = buildStagingContracts(connectorManifests);
const stagingByStream = new Map(stagingContracts.map((contract) => [`${contract.connectorId}:${contract.stream}`, contract]));
type TableConfig = Readonly<{
  rank: number;
  columns: ReadonlySet<string>;
  fact: boolean;
}>;

const tableColumns: Readonly<Record<CanonicalProjectionTable, TableConfig>> = Object.freeze({
  calendar_day: config(0, false, ["calendar_date","calendar_year","calendar_quarter","calendar_month","iso_week","day_of_week","is_weekend"]),
  legal_entity: config(10, false, ["name","abn","base_currency","active"]),
  location: config(20, false, ["name","timezone","legal_entity_id","active"]),
  register: config(30, false, ["location_id","name","active"]),
  channel: config(30, false, ["name","channel_type","active"]),
  person: config(30, false, ["display_name"]),
  customer_account: config(40, false, ["person_id","display_name","first_order_at","last_order_at"]),
  worker: config(40, false, ["person_id","display_name","active"]),
  employment_episode: config(50, false, ["worker_id","legal_entity_id","effective_from","effective_to","status"]),
  supplier: config(40, false, ["name","abn","active"]),
  product: config(30, false, ["name","active"]),
  product_variant: config(40, false, ["product_id","name","sku","barcode","active"]),
  product_category: config(40, false, ["parent_category_id","name","active"]),
  gl_account: config(40, false, ["legal_entity_id","code","name","account_class","active"]),
  tax_code: config(30, false, ["name","rate","input_or_output"]),
  stock_location: config(40, false, ["location_id","name","active"]),
  commerce_order: config(100, true, ["location_id","register_id","channel_id","customer_account_id","worker_id","ordered_at","completed_at","fulfilled_at","business_date","status","voided","internal_transaction","gross_amount","discount_amount","net_amount_inc_tax","tax_amount","net_amount_ex_tax","total_cost","currency"]),
  commerce_order_line: config(110, true, ["order_id","line_number","product_variant_id","location_id","register_id","channel_id","customer_account_id","worker_id","tax_code_id","ordered_at","completed_at","fulfilled_at","business_date","order_status","voided","internal_transaction","quantity","unit_price","unit_cost","gross_amount","discount_amount","net_amount_inc_tax","tax_amount","net_amount_ex_tax","total_cost","currency"]),
  commerce_payment: config(120, true, ["order_id","location_id","channel_id","paid_at","business_date","tender_type","status","amount","currency"]),
  commerce_refund_line: config(130, true, ["original_order_line_id","location_id","product_variant_id","worker_id","refunded_at","business_date","quantity","refund_amount_inc_tax","tax_amount","refund_amount_ex_tax","total_cost_reversed","currency"]),
  inventory_movement: config(100, true, ["product_variant_id","stock_location_id","movement_type","occurred_at","business_date","quantity_delta","unit_cost","total_cost","currency"]),
  inventory_balance_snapshot: config(100, true, ["product_variant_id","stock_location_id","snapshot_at","snapshot_date","quantity_on_hand","unit_cost","stock_value","currency"]),
  purchase_order_line: config(100, true, ["purchase_order_ref","line_number","supplier_id","product_variant_id","stock_location_id","ordered_at","expected_at","received_at","business_date","status","ordered_quantity","received_quantity","unit_cost","total_cost","currency"]),
  finance_journal_line: config(100, true, ["journal_id","line_number","legal_entity_id","gl_account_id","tax_code_id","location_id","posted_at","business_date","status","debit_amount","credit_amount","tax_amount","currency"]),
  finance_invoice_line: config(100, true, ["invoice_id","line_number","invoice_type","legal_entity_id","customer_account_id","supplier_id","gl_account_id","tax_code_id","location_id","issued_at","due_at","paid_at","business_date","status","quantity","unit_amount","net_amount_ex_tax","tax_amount","net_amount_inc_tax","outstanding_amount","currency"]),
  finance_bank_transaction: config(100, true, ["legal_entity_id","gl_account_id","location_id","transaction_at","posted_at","business_date","status","amount","tax_amount","currency"]),
  workforce_shift: config(100, true, ["worker_id","employment_episode_id","location_id","starts_at","ends_at","business_date","status","rostered_minutes","estimated_cost","currency"]),
  workforce_time_entry: config(100, true, ["worker_id","employment_episode_id","location_id","starts_at","ends_at","approved_at","business_date","status","worked_minutes","overtime_minutes","labour_cost","currency"]),
  workforce_leave: config(100, true, ["worker_id","employment_episode_id","location_id","starts_at","ends_at","business_date","status","leave_type","leave_minutes","leave_cost","currency"]),
});

export type CanonicalTransformResult = Readonly<{
  batchId: string;
  replayed: boolean;
  stagedRows: number;
  quarantinedRows: number;
  commandCount: number;
  canonicalRows: number;
  metadataRows: number;
  qualityStatus: "passed" | "warning" | "failed" | "blocked";
  partialQualityStatus: "passed" | "warning" | "failed" | "blocked";
  completeQualityStatus: "passed" | "warning" | "failed" | "blocked";
  dataReadyThrough: string | null;
  compatibilityReplayPending: boolean;
  compatibilityReplayCandidates: number;
  compatibilityReplayCommands: number;
  compatibilityReplayProgressToken: string | null;
}>;

export type ReadinessQualityEvidence = Readonly<{
  checkId: string;
  status: CanonicalTransformResult["qualityStatus"] | null;
  blocksPartialReadiness: boolean;
}>;

/**
 * Resolve quality against the readiness tier being claimed. Bounded recent
 * coverage may carry disclosed full-history/reconciliation limitations, while
 * complete coverage remains gated by every mandatory readiness check.
 */
export function resolveReadinessQualityStatus(
  evidence: readonly ReadinessQualityEvidence[],
  backfillComplete: boolean,
): CanonicalTransformResult["qualityStatus"] {
  if (evidence.length === 0) return "blocked";
  let failed = false;
  let warning = false;
  for (const check of evidence) {
    const blocksThisTier = backfillComplete || check.blocksPartialReadiness;
    if (check.status === null || check.status === "blocked") {
      if (blocksThisTier) return "blocked";
      warning = true;
      continue;
    }
    if (check.status === "failed") {
      if (blocksThisTier) failed = true;
      else warning = true;
      continue;
    }
    if (check.status === "warning") warning = true;
  }
  return failed ? "failed" : warning ? "warning" : "passed";
}

export type TransformCapabilityEvidence =
  | Readonly<{
    kind:"canonical_transform";
    tenantId:string;
    transformJobId:string;
    workerId:string;
    leaseToken:string;
  }>
  | Readonly<{
    kind:"identity_projection";
    tenantId:string;
    projectionId:string;
    workerId:string;
    leaseToken:string;
  }>
  | Readonly<{
    kind:"pipeline_snapshot";
    tenantId:string;
    authorizationId:string;
    workerId:string;
    leaseToken:string;
  }>;

export type CanonicalMapperRegistry = Readonly<Record<ConnectorId, CanonicalStreamMapper>>;

export type IsolatedCanonicalMapping = Readonly<{
  accepted: readonly Readonly<{
    row: CanonicalStagingRow;
    commands: readonly CanonicalProjectionCommand[];
  }>[];
  rejected: readonly Readonly<{
    row: CanonicalStagingRow;
    errorCode: string;
    errorSummary: string;
  }>[];
}>;

/**
 * A typed source row is the atomic mapping boundary. Vendor data defects are
 * retained as explicit rejections while valid peer rows continue through the
 * same batch. Lineage mismatches remain systemic and are never downgraded to a
 * quarantine record.
 */
export function isolateCanonicalMappings(
  rows: readonly CanonicalStagingRow[],
  job: CanonicalTransformBatch,
  stream: string,
  mappingVersion: string,
  mapper: CanonicalStreamMapper,
  context: CanonicalMappingContext,
): IsolatedCanonicalMapping {
  const accepted: Array<{
    row: CanonicalStagingRow;
    commands: readonly CanonicalProjectionCommand[];
  }> = [];
  const rejected: Array<{
    row: CanonicalStagingRow;
    errorCode: string;
    errorSummary: string;
  }> = [];
  for (const row of rows) {
    assertStagingLineage(row, job, mappingVersion);
    try {
      const commands = mapper(stream, row, context);
      if (!Array.isArray(commands) || commands.length === 0) {
        throw new Error(`canonical_mapper_empty:${job.connectorId}:${stream}:${row.source_record_id}`);
      }
      accepted.push({ row, commands });
    } catch (error) {
      const failure = canonicalMappingFailure(error);
      rejected.push({ row, ...failure });
    }
  }
  return Object.freeze({
    accepted: Object.freeze(accepted),
    rejected: Object.freeze(rejected),
  });
}

export class CanonicalTransformPipeline {
  constructor(
    private readonly analytical: TransactionalPostgres,
    private readonly control: TransactionalPostgres,
    private readonly mappingVersion: string,
    private readonly mappers: CanonicalMapperRegistry,
    private readonly clock: () => Date = () => new Date(),
  ) {
    if (!mappingVersion.trim()) throw new Error("A canonical mapping version is required.");
  }

  private async withTransformAuthorization<T>(
    authorization:TransformCapabilityEvidence|undefined,
    operation:(capability:string|undefined)=>Promise<T>,
  ):Promise<T>{
    if(!authorization)return operation(undefined);
    return this.control.transaction(async(client)=>{
      await establishControlWorkerRole(client);
      const query=authorization.kind==="canonical_transform"
        ? {
          sql:`select control_plane.issue_transform_job_analytical_capability(
                 $1::text,$2::text,$3::text,$4::text
               ) as capability`,
          values:[authorization.tenantId,authorization.transformJobId,
            authorization.workerId,authorization.leaseToken] as const,
        }
        : authorization.kind==="identity_projection"
          ? {
            sql:`select control_plane.issue_identity_projection_analytical_capability(
                   $1::text,$2::text,$3::text,$4::text
                 ) as capability`,
            values:[authorization.tenantId,authorization.projectionId,
              authorization.workerId,authorization.leaseToken] as const,
          }
          : {
            sql:`select control_plane.issue_transform_maintenance_analytical_capability(
                   $1::text,$2::text,$3::text
                 ) as capability`,
            values:[authorization.authorizationId,authorization.workerId,
              authorization.leaseToken] as const,
          };
      const result=await client.query<{capability:unknown}>(query.sql,query.values);
      const capability=result.rows[0]?.capability;
      if(typeof capability!=="string"||capability.length<100||capability.length>4096){
        throw new Error("transform_analytical_capability_invalid");
      }
      // Keep the evidence rows locked until the analytical callback commits.
      // Reconnect/deletion therefore cannot invalidate the generation midway.
      return operation(capability);
    });
  }

  async transformBatch(
    job: CanonicalTransformBatch,
    stream: string,
    domains: readonly string[],
    backfillComplete: boolean,
    publishControl = true,
    authorization?:TransformCapabilityEvidence,
  ): Promise<CanonicalTransformResult> {
    if(job.mappingVersion!==this.mappingVersion){
      throw new Error(`canonical_mapping_version_mismatch:${job.mappingVersion}`);
    }
    const contract = requireStagingContract(job.connectorId, stream);
    const manifest = requireManifest(job.connectorId);
    const streamContract = requireStreamContract(manifest, stream);
    const streamAuthority = streamContract.authorityConcept;
    const mapper = this.mappers[job.connectorId];
    if (!mapper) throw new Error(`canonical_mapper_missing:${job.connectorId}`);
    const mappingContext = await loadMappingContext(this.control, job);

    const result = await this.withTransformAuthorization(authorization,(capability)=>
      this.analytical.transaction(async (client) => {
      await establishTransformScope(client, job.tenantId,capability);
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`canonical:${job.tenantId}`]);
      const existing = await client.query<TransformCommitRow>(
        `select staged_rows, quarantined_rows, command_count, canonical_rows,
                metadata_rows, quality_status,partial_quality_status,
                complete_quality_status,data_ready_through
           from semantic_internal.canonical_transform_commits
          where tenant_id=$1 and batch_id=$2 and mapping_version=$3
          for update`,
        [job.tenantId, job.batchId, this.mappingVersion],
      );
      if (existing.rows[0]) return transformResult(job.batchId, true, existing.rows[0]);

      await assertLandingCommit(client, job, stream, this.mappingVersion);
      await publishAuthorityDefaults(client, job);
      const rows = await loadStagingRows(client, contract, job, this.mappingVersion);
      const isolated = isolateCanonicalMappings(
        rows,job,stream,this.mappingVersion,mapper,mappingContext,
      );
      for (const rejection of isolated.rejected) {
        await recordCanonicalMappingQuarantine(
          client,job,stream,rejection.row,rejection.errorCode,rejection.errorSummary,
        );
      }
      const commands = isolated.accepted.flatMap(({ row,commands: mapped }) =>
        mapped.map((command) => ({ command,row }))
      );
      commands.sort((left, right) => commandRank(left.command) - commandRank(right.command));

      let canonicalRows = 0;
      let metadataRows = 0;
      const appliedCommands: CanonicalProjectionCommand[] = [];
      const previouslyMaterializedDates:string[]=[];
      for (const item of commands) {
        assertCanonicalCommandAdmission(item.command,streamContract);
        if (item.command.kind === "dimension" || item.command.kind === "fact") {
          const outcome=await executeUpsert(
            client,job,item.row,item.command,streamAuthority,
          );
          if (outcome.applied) {
            canonicalRows += 1;
            appliedCommands.push(item.command);
            previouslyMaterializedDates.push(...outcome.previousDates);
          }
        } else if (item.command.kind === "category_assignment") {
          if(await executeCategoryAssignment(client, job, item.row, item.command))canonicalRows += 1;
        } else if (item.command.kind === "event_link") {
          await executeEventLink(client, job, item.row, item.command, this.mappingVersion);
          metadataRows += 1;
        } else if (item.command.kind === "identity_hint") {
          await persistIdentityHint(client, job, item.row, item.command);
          metadataRows += 1;
        } else {
          metadataRows += 1;
        }
      }

      const commandCount=commands.length;

      // Healing happens only after every projection command for the accepted
      // rows has succeeded in this transaction. A later failure rolls back the
      // canonical writes and leaves the prior dead-letter record open.
      for (const accepted of isolated.accepted) {
        await resolveCanonicalMappingQuarantine(client,job,stream,accepted.row);
      }

      await publishCapabilities(client, job, manifest, stream, rows);
      await publishSourceAllowlist(client, job, manifest, contract);
      await generateIdentitySuggestions(client, job.tenantId);
      const acceptedRows = isolated.accepted.map(({ row }) => row);
      const readyThrough = latestSourceTimestamp(acceptedRows);
      const dateBounds = canonicalDateBounds(appliedCommands,previouslyMaterializedDates);
      if (dateBounds) {
        await ensureCalendarDays(client,dateBounds);
        await refreshMarts(client, job.tenantId, dateBounds);
        await client.query(
          "select core.refresh_daily_settlement_links($1,$2::date,$3::date,$4)",
          [job.tenantId,dateBounds.from,dateBounds.to,job.syncRunId],
        );
      }
      // Invariants must observe the newly refreshed marts and settlement links,
      // never the prior committed analytical state.
      // Refresh connector checks here as well: the ingest-side rollup precedes
      // the control-plane run commit, while a release attestation must be
      // causally newer than that durable completion evidence.
      await client.query("select quality.refresh_connector_quality_rollup($1,$2)", [
        job.tenantId,job.syncRunId,
      ]);
      await client.query("select quality.run_all_invariants($1,$2)", [job.tenantId, job.syncRunId]);
      await client.query(
        "select quality.record_canonical_mapping_quality($1,$2,$3::bigint,$4::bigint)",
        [job.tenantId,job.syncRunId,rows.length,isolated.rejected.length],
      );
      // The quality evidence and its snapshot live in Postgres, so use the
      // same clock for their causal ordering. An application-host timestamp
      // can be ahead of the database or lose sub-millisecond precision and be
      // rejected as either future-dated or older than the quality results.
      const snapshotClock = await client.query<{snapshot_at:string}>(
        "select clock_timestamp()::text as snapshot_at",
      );
      const snapshotAt=snapshotClock.rows[0]?.snapshot_at;
      if(!snapshotAt||!Number.isFinite(Date.parse(snapshotAt))){
        throw new Error("pipeline_snapshot_database_clock_invalid");
      }
      await client.query(
        "select quality.snapshot_all_pipeline_stats($1,$2::timestamptz,$3::text[],$4::jsonb,$5::text)",
        [job.tenantId, snapshotAt, [...new Set(domains)], JSON.stringify({ [job.connectionId]: readyThrough }),job.syncRunId],
      );
      const qualityStatuses = await readinessQualityStatuses(client,job.tenantId,job.syncRunId);
      const qualityStatus=backfillComplete
        ? qualityStatuses.complete
        : qualityStatuses.partial;
      await enqueueReadinessProjection(
        client,job,domains,backfillComplete,qualityStatuses,readyThrough,snapshotAt,
      );
      await client.query(
        `insert into semantic_internal.canonical_transform_commits (
           tenant_id,batch_id,sync_run_id,connection_id,connector_id,stream,mapping_version,
           staged_rows,quarantined_rows,command_count,canonical_rows,metadata_rows,
           quality_status,partial_quality_status,complete_quality_status,
           data_ready_through,completed_at
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now())`,
        [job.tenantId,job.batchId,job.syncRunId,job.connectionId,job.connectorId,stream,
          this.mappingVersion,rows.length,isolated.rejected.length,commandCount,
          canonicalRows,metadataRows,qualityStatus,qualityStatuses.partial,
          qualityStatuses.complete,readyThrough],
      );
      return {
        batchId:job.batchId,replayed:false,stagedRows:rows.length,
        quarantinedRows:isolated.rejected.length,commandCount,
        canonicalRows,metadataRows,qualityStatus,
        partialQualityStatus:qualityStatuses.partial,
        completeQualityStatus:qualityStatuses.complete,
        dataReadyThrough:readyThrough,
        compatibilityReplayPending:false,
        compatibilityReplayCandidates:0,
        compatibilityReplayCommands:0,
        compatibilityReplayProgressToken:null,
      } satisfies CanonicalTransformResult;
    }));

    const compatibilityReplay=await this.drainCompatibilityReplay(
      job,stream,mapper,mappingContext,authorization,
    );

    if(publishControl&&!compatibilityReplay.pending){
      await this.publishPendingControlProjections(job.tenantId, job.batchId,authorization);
      await this.refreshDossier(job.tenantId,authorization);
    }
    return Object.freeze({
      ...result,
      compatibilityReplayPending:compatibilityReplay.pending,
      compatibilityReplayCandidates:compatibilityReplay.candidates,
      compatibilityReplayCommands:compatibilityReplay.commands,
      compatibilityReplayProgressToken:compatibilityReplay.progressToken,
    });
  }

  /**
   * Compatibility projection is deliberately outside the terminal page's
   * transform transaction. Each bounded chunk commits its exact audit
   * progress, so a worker crash or lease hand-off resumes from the first
   * unaudited record instead of restarting an unbounded historical scan.
   */
  private async drainCompatibilityReplay(
    job:CanonicalTransformBatch,
    stream:string,
    mapper:CanonicalStreamMapper,
    context:CanonicalMappingContext,
    authorization:TransformCapabilityEvidence|undefined,
  ):Promise<Readonly<{pending:boolean;candidates:number;commands:number;progressToken:string|null}>>{
    const hook=connectorCompatibilityReplay(job.connectorId);
    if(!hook?.handles(job,stream))return Object.freeze({pending:false,candidates:0,commands:0,progressToken:null});
    if(!Number.isSafeInteger(hook.candidateLimit)||hook.candidateLimit<1||hook.candidateLimit>1_000||
        !Number.isSafeInteger(hook.commandLimit)||hook.commandLimit<1||hook.commandLimit>5_000){
      throw new Error("canonical_dependency_replay_budget_invalid");
    }
    const manifest=requireManifest(job.connectorId);
    const sourceContract=requireStreamContract(manifest,hook.sourceStream);
    return this.withTransformAuthorization(authorization,(capability)=>
      this.analytical.transaction(async(client)=>{
        await establishTransformScope(client,job.tenantId,capability);
        await client.query(
          "select pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`canonical:${job.tenantId}`],
        );
        const binding=connectorHookDatabaseBinding(hook.databaseRegistrationId,client,{
          tenantId:job.tenantId,connectionId:job.connectionId,
          batchId:job.batchId,syncRunId:job.syncRunId,
          mappingVersion:job.mappingVersion,connectionGeneration:job.connectionGeneration,
        });
        const selection=await hook.selectChunk({database:binding.database,job});
        binding.assertReplaySelection(selection.eligible,selection.candidates);
        if(!selection.eligible){
          if(selection.candidates.length)throw new Error("canonical_dependency_replay_selection_invalid");
          return Object.freeze({pending:false,candidates:0,commands:0,progressToken:null});
        }
        let commandCount=0;
        let checkpointCount=0;
        let pending=false;
        const appliedCommands:CanonicalProjectionCommand[]=[];
        const previousDates:string[]=[];
        const progressEvidence:string[]=[];
        for(const handle of selection.candidates){
          const row=binding.resolveReplayCandidate(handle);
          const sourceJob=Object.freeze({...job,batchId:row.payload_batch_id,syncRunId:row.sync_run_id});
          assertStagingLineage(row,sourceJob,job.mappingVersion);
          if(row.source_object_type!==sourceContract.resource||row.tombstone!==false||
              !row.namespaced_source_key.trim()||!row.source_record_id.trim()||
              !/^[a-f0-9]{64}$/u.test(row.payload_hash)){
            throw new Error(`canonical_dependency_replay_lineage_invalid:${row.source_record_id}`);
          }
          const mapped=mapper(hook.sourceStream,row,context);
          if(!Array.isArray(mapped)||!mapped.length){
            throw new Error(`canonical_dependency_replay_mapper_empty:${row.source_record_id}`);
          }
          const upserts:CanonicalUpsertCommand[]=[];
          const identities=new Set<string>();
          for(const command of mapped){
            assertCanonicalCommandAdmission(command,sourceContract);
            if(command.kind!=="dimension"&&command.kind!=="fact"){
              throw new Error(`canonical_dependency_replay_command_unsupported:${command.kind}`);
            }
            const identity=`${command.kind}\u001f${command.table}\u001f${command.sourceObjectType}\u001f${command.sourceRecordId}`;
            if(identities.has(identity)){
              throw new Error(`canonical_dependency_replay_command_duplicate:${command.sourceRecordId}`);
            }
            identities.add(identity);
            upserts.push(command);
          }
          const materialized=await binding.materializedReplaySourceRecordIds(handle);
          if([...materialized].some((sourceRecordId)=>
            !upserts.some((command)=>command.sourceRecordId===sourceRecordId))){
            throw new Error("canonical_dependency_replay_materialized_scope_invalid");
          }
          const missing=upserts.filter((command)=>!materialized.has(command.sourceRecordId));
          const selected=missing.slice(0,hook.commandLimit-commandCount);
          for(const command of selected){
            const outcome=await executeUpsert(
              client,sourceJob,row,command,sourceContract.authorityConcept,
            );
            commandCount+=1;
            progressEvidence.push(`command\u001f${row.namespaced_source_key}\u001f${command.kind}\u001f${command.table}\u001f${command.sourceObjectType}\u001f${command.sourceRecordId}`);
            if(outcome.applied){
              appliedCommands.push(command);
              previousDates.push(...outcome.previousDates);
            }
          }
          if(selected.length<missing.length){pending=true;break;}
          await binding.checkpointReplayCandidate(handle);
          checkpointCount+=1;
          progressEvidence.push(`checkpoint\u001f${row.namespaced_source_key}\u001f${row.payload_hash}`);
          if(commandCount>=hook.commandLimit&&checkpointCount<selection.candidates.length){
            pending=true;
            break;
          }
        }
        if(selection.candidates.length>0&&commandCount+checkpointCount===0){
          throw new Error("canonical_dependency_replay_no_progress");
        }
        pending=pending||selection.candidates.length===hook.candidateLimit;
        const dateBounds=canonicalDateBounds(appliedCommands,previousDates);
        if(dateBounds){
          await ensureCalendarDays(client,dateBounds);
          await refreshMarts(client,job.tenantId,dateBounds);
          await client.query(
            "select core.refresh_daily_settlement_links($1,$2::date,$3::date,$4)",
            [job.tenantId,dateBounds.from,dateBounds.to,job.syncRunId],
          );
          await client.query("select quality.run_all_invariants($1,$2)",[job.tenantId,job.syncRunId]);
        }
        if(!pending)await binding.finalizeReplay();
        return Object.freeze({
          pending,candidates:checkpointCount,commands:commandCount,
          progressToken:progressEvidence.length
            ?createHash("sha256").update(progressEvidence.join("\n")).digest("hex")
            :null,
        });
      })
    );
  }

  async publishPendingControlProjections(
    tenantId:string,
    batchId?:string,
    authorization?:TransformCapabilityEvidence,
  ):Promise<void>{
    await this.withTransformAuthorization(authorization,async(capability)=>{
      const pending=await this.analytical.transaction(async(client)=>{
        await establishTransformScope(client,tenantId,capability);
        const filter=batchId?" and batch_id=$2":"";
        const parameters=batchId?[tenantId,batchId]:[tenantId];
        const readiness=await client.query<ReadinessProjectionRow>(
          `select * from semantic_internal.readiness_projection_outbox where tenant_id=$1 and published_at is null${filter} order by created_at`,
          parameters,
        );
        const reviews=await client.query<IdentityReviewProjectionRow>(
          "select * from semantic_internal.identity_review_projection_outbox where tenant_id=$1 and published_at is null order by created_at",
          [tenantId],
        );
        const stats=await client.query<PipelineStatProjectionRow>(
          "select * from semantic_internal.pipeline_table_stats_projection_outbox where tenant_id=$1 and published_at is null order by snapshot_at,schema_name,table_name",
          [tenantId],
        );
        return{readiness:readiness.rows,reviews:reviews.rows,stats:stats.rows};
      });
      if(!pending.readiness.length&&!pending.reviews.length&&!pending.stats.length)return;

      await this.control.transaction(async(client)=>{
        await establishControlTransformScope(client,tenantId);
        for(const row of pending.readiness)await projectReadiness(client,row);
        for(const row of pending.reviews)await projectIdentityReview(client,row);
        for(const row of pending.stats)await projectPipelineStat(client,row);
        await client.query("select control_plane.retain_pipeline_history($1::text)",[tenantId]);
      });
      await this.analytical.transaction(async(client)=>{
        await establishTransformScope(client,tenantId,capability);
        const publishedAt=this.clock().toISOString();
        if(pending.readiness.length)await markPublished(client,"readiness_projection_outbox","projection_id",pending.readiness.map((row)=>row.projection_id),publishedAt);
        if(pending.reviews.length)await markPublished(client,"identity_review_projection_outbox","projection_id",pending.reviews.map((row)=>row.projection_id),publishedAt);
        if(pending.stats.length)await markPublished(client,"pipeline_table_stats_projection_outbox","projection_id",pending.stats.map((row)=>row.projection_id),publishedAt);
        await client.query("select semantic_internal.retain_pipeline_history($1::text)",[tenantId]);
      });
    });
  }

  async snapshotAllTenants(
    workerId:string,
    options:Readonly<{claimBatchSize?:number;maxClaims?:number}>={},
  ):Promise<number>{
    if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(workerId)){
      throw new Error("transform_snapshot_worker_id_invalid");
    }
    const claimBatchSize=options.claimBatchSize??8;
    const maxClaims=options.maxClaims??20_000;
    if(!Number.isInteger(claimBatchSize)||claimBatchSize<1||claimBatchSize>100){
      throw new Error("transform_snapshot_claim_batch_size_invalid");
    }
    if(!Number.isInteger(maxClaims)||maxClaims<1||maxClaims>100_000){
      throw new Error("transform_snapshot_max_claims_invalid");
    }
    const snapshotAt=this.clock().toISOString();
    let completed=0;
    let claimedCount=0;
    let firstFailure:unknown;
    while(claimedCount<maxClaims){
      const claims=await this.control.transaction(async(client)=>{
        await establishControlWorkerRole(client);
        return client.query<TransformMaintenanceClaimRow>(
          `select authorization_id,tenant_id,lease_token,expires_at,source_watermarks
             from control_plane.claim_transform_maintenance_leases($1::text,$2::integer)`,
          [workerId,Math.min(claimBatchSize,maxClaims-claimedCount)],
        );
      });
      if(claims.rows.length===0)break;
      claimedCount+=claims.rows.length;
      const outcomes=await Promise.allSettled(claims.rows.map(async(claim)=>{
        const authorization:TransformCapabilityEvidence=Object.freeze({
          kind:"pipeline_snapshot",tenantId:claim.tenant_id,
          authorizationId:claim.authorization_id,workerId,leaseToken:claim.lease_token,
        });
        await this.withTransformAuthorization(authorization,(capability)=>
          this.analytical.transaction(async(client)=>{
            await establishTransformScope(client,claim.tenant_id,capability);
            await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))",[`canonical:${claim.tenant_id}`]);
            await client.query(
              "select quality.snapshot_all_pipeline_stats($1,$2::timestamptz,$3::text[],$4::jsonb)",
              [claim.tenant_id,snapshotAt,[],JSON.stringify(claim.source_watermarks)],
            );
          }),
        );
        await this.publishPendingControlProjections(claim.tenant_id,undefined,authorization);
        await this.refreshDossier(claim.tenant_id,authorization);
        await this.control.transaction(async(client)=>{
          await establishControlWorkerRole(client);
          await client.query(
            "select control_plane.complete_transform_maintenance($1::text,$2::text,$3::text)",
            [claim.authorization_id,workerId,claim.lease_token],
          );
        });
      }));
      for(const outcome of outcomes){
        if(outcome.status==="fulfilled")completed+=1;
        else firstFailure??=outcome.reason;
      }
    }
    await this.control.transaction(async(client)=>{
      await establishControlWorkerRole(client);
      await client.query("select control_plane.retain_transform_maintenance_history()");
    });
    if(firstFailure)throw firstFailure;
    return completed;
  }

  async reconcileIdentityDecisions(workerId:string,limit=25):Promise<number>{
    if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(workerId)){
      throw new Error("identity_projection_worker_id_invalid");
    }
    if(!Number.isInteger(limit)||limit<1||limit>100){
      throw new Error("identity_projection_limit_invalid");
    }
    let processed=0;
    while(processed<limit){
      const claimed=await this.control.transaction(async(client)=>{
        await establishControlWorkerRole(client);
        return client.query<IdentityDecisionProjectionRow>(
          `select * from control_plane.claim_identity_decision_projection(
             $1::text,$2::integer
           )`,
          [workerId,120],
        );
      });
      const claim=claimed.rows[0];
      if(!claim)break;
      try{
        const authorization:TransformCapabilityEvidence=Object.freeze({
          kind:"identity_projection",tenantId:claim.tenant_id,
          projectionId:claim.projection_id,workerId,leaseToken:claim.lease_token,
        });
        const applied=await this.withTransformAuthorization(authorization,(capability)=>
          this.analytical.transaction(async(client)=>{
            await establishTransformScope(client,claim.tenant_id,capability);
            const result=await client.query<{result:unknown}>(
              `select semantic_internal.apply_identity_decision(
                 $1::text,$2::text,$3::text,$4::integer,$5::text,$6::text,
                 $7::jsonb,$8::uuid,$9::timestamptz
               ) as result`,
              [
                claim.tenant_id,claim.decision_id,claim.identity_review_task_id,
                Number(claim.decision_version),claim.decision,claim.entity_type,
                JSON.stringify(claim.candidate_links),claim.decided_by,isoOrNull(claim.decided_at),
              ],
            );
            // A confirmed location association can unlock email-less worker
            // suggestions immediately. Refresh and generate in the same
            // analytical transaction as the graph decision.
            await client.query("select semantic_internal.refresh_identity_scope_digests($1)",[claim.tenant_id]);
            await client.query("select semantic_internal.generate_identity_review_candidates($1)",[claim.tenant_id]);
            return result;
          }),
        );
        await this.publishPendingControlProjections(claim.tenant_id,undefined,authorization);
        await this.control.transaction(async(client)=>{
          await establishControlWorkerRole(client);
          await client.query(
            `select control_plane.complete_identity_decision_projection(
               $1::text,$2::text,$3::text,$4::text,$5::jsonb
             )`,
            [
              claim.tenant_id,claim.projection_id,workerId,claim.lease_token,
              JSON.stringify(asJsonObject(applied.rows[0]?.result)),
            ],
          );
        });
      }catch(error){
        const failure=identityProjectionFailure(error);
        await this.control.transaction(async(client)=>{
          await establishControlWorkerRole(client);
          await client.query(
            `select control_plane.fail_identity_decision_projection(
               $1::text,$2::text,$3::text,$4::text,$5::jsonb,$6::integer,$7::integer
             )`,
            [
              claim.tenant_id,claim.projection_id,workerId,claim.lease_token,
              JSON.stringify(failure),failure.retryDelaySeconds,12,
            ],
          );
        });
      }
      processed+=1;
    }
    return processed;
  }

  async identityDecisionProjectionMetrics():Promise<readonly IdentityDecisionProjectionMetric[]>{
    const result=await this.control.transaction(async(client)=>{
      await establishControlWorkerRole(client);
      return client.query<IdentityDecisionProjectionMetricRow>(
        "select * from control_plane.identity_decision_projection_metrics()",
      );
    });
    return result.rows.map((row)=>Object.freeze({
      status:row.status,
      jobCount:Number(row.job_count),
      oldestAgeSeconds:Number(row.oldest_age_seconds),
    }));
  }

  async transformMaintenanceMetrics():Promise<Readonly<{
    dueTenants:number;
    activeLeases:number;
    completed24h:number;
    completedP95Ms:number;
  }>>{
    const result=await this.control.transaction(async(client)=>{
      await establishControlWorkerRole(client);
      return client.query<{
        due_tenants:string|number;
        active_leases:string|number;
        completed_24h:string|number;
        completed_p95_ms:string|number;
      }>(
        "select * from control_plane.transform_maintenance_metrics()",
      );
    });
    const row=result.rows[0];
    return Object.freeze({
      dueTenants:Number(row?.due_tenants??0),
      activeLeases:Number(row?.active_leases??0),
      completed24h:Number(row?.completed_24h??0),
      completedP95Ms:Number(row?.completed_p95_ms??0),
    });
  }

  async transformCapacityRunMetrics(
    workerId:string,
    startedAt:string,
  ):Promise<Readonly<{completed:number;completedP95Ms:number}>>{
    if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(workerId)){
      throw new Error("transform_capacity_worker_id_invalid");
    }
    if(!Number.isFinite(Date.parse(startedAt))){
      throw new Error("transform_capacity_started_at_invalid");
    }
    const result=await this.control.transaction(async(client)=>{
      await establishControlWorkerRole(client);
      return client.query<{
        completed_count:string|number;
        completed_p95_ms:string|number;
      }>(
        "select * from control_plane.transform_capacity_run_metrics($1::text,$2::timestamptz)",
        [workerId,startedAt],
      );
    });
    const row=result.rows[0];
    return Object.freeze({
      completed:Number(row?.completed_count??0),
      completedP95Ms:Number(row?.completed_p95_ms??0),
    });
  }

  async recordTransformCapacityParticipant(input:Readonly<{
    runId:string;
    participantId:string;
    workerId:string;
    releaseSha:string;
    startedAt:string;
    completedAt:string;
    completedClaims:number;
    controlPoolAcquireP95Ms:number;
    analyticalPoolAcquireP95Ms:number;
    errorCount:0|1;
  }>):Promise<void>{
    const result=await this.control.transaction(async(client)=>{
      await establishControlWorkerRole(client);
      return client.query(
        `select control_plane.record_transform_capacity_participant(
           $1::text,$2::text,$3::text,$4::text,$5::timestamptz,$6::timestamptz,
           $7::integer,$8::numeric,$9::numeric,$10::integer
         )`,
        [input.runId,input.participantId,input.workerId,input.releaseSha,
          input.startedAt,input.completedAt,input.completedClaims,
          input.controlPoolAcquireP95Ms,input.analyticalPoolAcquireP95Ms,input.errorCount],
      );
    });
    void result;
  }

  async refreshDossier(
    tenantId:string,
    authorization?:TransformCapabilityEvidence,
  ):Promise<boolean>{
    const contributors=connectorDossierContributors();
    const controlEvidence=await this.control.transaction(async(client)=>{
      await establishControlTransformScope(client,tenantId);
      const timezoneResult=await client.query<{timezone:string|null}>(
        `select overlay->>'timezone' as timezone
           from control_plane.tenant_overlays
          where tenant_id=$1 and status='published'
          order by version desc limit 1`,
        [tenantId],
      );
      const connections=await client.query<{
        connection_id:string;
        connection_generation:number|string;
        connector_key:ConnectorId;
      }>(
        `select connection_id,connection_generation,connector_key
           from control_plane.connections
          where tenant_id=$1 and connector_key=any($2::text[])
            and status in ('connected','degraded')
          order by connector_key,connection_id`,
        [tenantId,[...new Set(contributors.map((contributor)=>contributor.connectorId))]],
      );
      return Object.freeze({timezoneResult,connections});
    });
    const timezone=controlEvidence.timezoneResult.rows[0]?.timezone;
    if(!timezone)throw new Error("dossier_timezone_missing");
    try{new Intl.DateTimeFormat("en-AU",{timeZone:timezone}).format(new Date(0));}
    catch{throw new Error("dossier_timezone_invalid");}

    const source=await this.withTransformAuthorization(authorization,(capability)=>
      this.analytical.transaction(async(client)=>{
      await establishTransformScope(client,tenantId,capability);
      const canonical=await client.query<DossierSourceRow>(
        `with location_summary as (
           select coalesce(array_agg(name order by name),'{}'::text[]) as names,
                  max(updated_at) as observed_at
             from core.location where tenant_id=$1 and active
         ), channel_summary as (
           select coalesce(array_agg(name order by name),'{}'::text[]) as names,
                  max(updated_at) as observed_at
             from core.channel where tenant_id=$1 and active
         ), entity_summary as (
           select (array_agg(name order by updated_at desc,id))[1] as name,
                  (array_agg(base_currency order by updated_at desc,id))[1] as base_currency,
                  max(updated_at) as observed_at
             from core.legal_entity where tenant_id=$1 and active
         ), sales_summary as (
           select count(*)::bigint as sale_count,
                  max(coalesce(completed_at,ordered_at)) as observed_at
             from core.commerce_order
            where tenant_id=$1 and not voided and not internal_transaction
         ), product_summary as (
           select count(*)::bigint as product_count,max(updated_at) as observed_at
             from core.product where tenant_id=$1 and active
         ), trading_hours as (
           select coalesce(jsonb_agg(jsonb_build_object(
                    'day',day_number,'opens',opens_at,'closes',closes_at,'samples',sample_count
                  ) order by day_number),'[]'::jsonb) as hours
             from (
               select extract(isodow from completed_at at time zone $2)::integer as day_number,
                      percentile_cont(0.05) within group (
                        order by extract(epoch from (completed_at at time zone $2)::time)
                      ) as opens_at,
                      percentile_cont(0.95) within group (
                        order by extract(epoch from (completed_at at time zone $2)::time)
                      ) as closes_at,
                      count(*)::bigint as sample_count
                 from core.commerce_order
                where tenant_id=$1 and completed_at is not null and not voided
                  and not internal_transaction and completed_at>=now()-interval '90 days'
                group by 1 having count(*)>=3
             ) observed
         ), monthly_sales as (
           select date_trunc('month',business_date)::date as month,
                  sum(net_amount_ex_tax) as net_sales
             from core.commerce_order_line
            where tenant_id=$1 and not voided and not internal_transaction
              and business_date>=current_date-interval '13 months'
            group by 1
         ), seasonality as (
           select (select month from monthly_sales order by net_sales desc,month desc limit 1) as strongest_month,
                  (select month from monthly_sales order by net_sales asc,month desc limit 1) as quietest_month,
                  (select count(*) from monthly_sales)::integer as observed_months
         )
         select location_summary.names as location_names,
                location_summary.observed_at as locations_observed_at,
                channel_summary.names as channel_names,
                channel_summary.observed_at as channels_observed_at,
                entity_summary.name as legal_entity_name,
                entity_summary.base_currency,
                entity_summary.observed_at as entity_observed_at,
                sales_summary.sale_count,sales_summary.observed_at as sales_observed_at,
                product_summary.product_count,product_summary.observed_at as products_observed_at,
                trading_hours.hours,seasonality.strongest_month,seasonality.quietest_month,
                seasonality.observed_months
           from location_summary cross join channel_summary cross join entity_summary
           cross join sales_summary cross join product_summary cross join trading_hours
           cross join seasonality`,
        [tenantId,timezone],
      );
      const row=canonical.rows[0];
      const contributions:CanonicalDossierFactContribution[]=[];
      if(row){
        for(const connection of controlEvidence.connections.rows){
          const generation=Number(connection.connection_generation);
          if(!Number.isSafeInteger(generation)||generation<1){
            throw new Error("dossier_connection_generation_invalid");
          }
          for(const contributor of contributors.filter((candidate)=>
            candidate.connectorId===connection.connector_key)){
            const collected=await contributor.collect({
              database:connectorHookDatabase(contributor.databaseRegistrationId,client,{
                tenantId,connectionId:connection.connection_id,
                connectionGeneration:generation,
              }),tenantId,
              connection:Object.freeze({
                connectionId:connection.connection_id,
                connectionGeneration:generation,
              }),
              context:{
                legalEntityName:row.legal_entity_name,
                baseCurrency:row.base_currency,
                entityObservedAt:row.entity_observed_at,
              },
            });
            for(const contribution of collected){
              contributions.push(normalizedDossierContribution(
                contribution,
                contributor.ownedKeys,
              ));
            }
          }
        }
      }
      return{row,contributions:Object.freeze(contributions)};
    }));
    const draft=buildDossierDraft(source.row,source.contributions);
    if(!draft)return false;
    const published=await this.control.transaction(async(client)=>{
      await establishControlTransformScope(client,tenantId);
      return client.query<{created:boolean}>(
        `select created from control_plane.publish_transform_dossier(
           $1::text,$2::jsonb,$3::jsonb,$4::text
         )`,
        [tenantId,JSON.stringify(draft.content),JSON.stringify(draft.provenance),draft.sourceBundleHash],
      );
    });
    return published.rows[0]?.created===true;
  }
}

function config(rank:number,fact:boolean,columns:readonly string[]):TableConfig{return{rank,fact,columns:new Set(columns)};}

type TransformCommitRow={staged_rows:string|number;quarantined_rows:string|number;command_count:string|number;canonical_rows:string|number;metadata_rows:string|number;quality_status:CanonicalTransformResult["qualityStatus"];partial_quality_status:CanonicalTransformResult["qualityStatus"];complete_quality_status:CanonicalTransformResult["qualityStatus"];data_ready_through:string|Date|null};
type ReadinessProjectionRow={projection_id:string;tenant_id:string;batch_id:string;connection_id:string;domain:string;state:string;progress:string|number;data_ready_through:string|Date|null;backfill_complete:boolean;partial_quality_status:string;complete_quality_status:string;reason_code:string|null;reason_detail:string|null;evaluated_at:string|Date};
type IdentityReviewProjectionRow={projection_id:string;tenant_id:string;task_id:string;entity_type:string;confidence_band:string;candidate_links:unknown;evidence:unknown};
type IdentityDecisionProjectionRow={
  tenant_id:string;projection_id:string;decision_id:string;identity_review_task_id:string;
  decision_version:string|number;decision:"accepted"|"rejected"|"proposed";
  entity_type:CanonicalEntityType;candidate_links:unknown;decided_by:string;
  decided_at:string|Date;attempt_count:string|number;lease_token:string;lease_expires_at:string|Date;
};
type IdentityDecisionProjectionMetricRow={status:string;job_count:string|number;oldest_age_seconds:string|number};
export type IdentityDecisionProjectionMetric=Readonly<{status:string;jobCount:number;oldestAgeSeconds:number}>;
type TransformMaintenanceClaimRow={
  authorization_id:string;tenant_id:string;lease_token:string;
  expires_at:string|Date;source_watermarks:Record<string,string|null>;
};
type PipelineStatProjectionRow={projection_id:string;tenant_id:string;snapshot_at:string|Date;schema_name:string;table_name:string;row_count:string|number;max_event_at:string|Date|null;max_ingested_at:string|Date|null;invariant_status:unknown;quality_run_id:string|null;quality_checked_at:string|Date|null;snapshot_table_count:number|null;snapshot_inventory_hash:string|null};
type DossierSourceRow={
  location_names:string[]|null;locations_observed_at:string|Date|null;
  channel_names:string[]|null;channels_observed_at:string|Date|null;
  legal_entity_name:string|null;base_currency:string|null;entity_observed_at:string|Date|null;
  sale_count:string|number; sales_observed_at:string|Date|null;
  product_count:string|number;products_observed_at:string|Date|null;
  hours:unknown;strongest_month:string|Date|null;quietest_month:string|Date|null;observed_months:string|number;
};
type DossierFactProvenance=Readonly<{
  source:string;observed_at:string;confidence:number;confirmation_state:"source_reported"|"inferred";
}>;
type DossierDraft=Readonly<{
  content:Readonly<Record<string,string|readonly string[]>>;
  provenance:Readonly<Record<string,DossierFactProvenance>>;
  sourceBundleHash:string;
}>;

const weekdayNames=["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"] as const;

export function assertDossierContribution(
  contribution:CanonicalDossierFactContribution,
  ownedKeys?:readonly string[],
):void{
  if(!/^[a-z][a-z0-9_]{0,63}$/u.test(contribution.key)||
      (ownedKeys&&(!ownedKeys.length||new Set(ownedKeys).size!==ownedKeys.length||
        !ownedKeys.includes(contribution.key)))||
      !contribution.source.trim()||contribution.source.length>200||
      !Number.isFinite(contribution.confidence)||contribution.confidence<0||
      contribution.confidence>1||
      !["source_reported","inferred"].includes(contribution.confirmationState)||
      !["replace","fill"].includes(contribution.merge)){
    throw new Error("dossier_contribution_invalid");
  }
  const value=contribution.value;
  if(typeof value==="string"&&value.length>500)throw new Error("dossier_contribution_invalid");
  if(Array.isArray(value)&&(value.length>50||value.some((item)=>
    typeof item!=="string"||!item.trim()||item.length>160))){
    throw new Error("dossier_contribution_invalid");
  }
  if(contribution.observedAt!==null&&!isoOrNull(contribution.observedAt)){
    throw new Error("dossier_contribution_invalid");
  }
}

function normalizedDossierContribution(
  contribution:CanonicalDossierFactContribution,
  ownedKeys:readonly string[],
):CanonicalDossierFactContribution{
  const value=contribution.value;
  const observedAt=contribution.observedAt;
  const captured:CanonicalDossierFactContribution={
    key:contribution.key,
    value:Array.isArray(value)?Object.freeze([...value]):value,
    source:contribution.source,
    observedAt,
    confidence:contribution.confidence,
    confirmationState:contribution.confirmationState,
    merge:contribution.merge,
  };
  assertDossierContribution(captured,ownedKeys);
  return Object.freeze({
    ...captured,
    observedAt:isoOrNull(captured.observedAt),
  });
}

export function buildDossierDraft(
  row:DossierSourceRow|undefined,
  contributions:readonly CanonicalDossierFactContribution[]=[],
):DossierDraft|null{
  if(!row)return null;
  const content:Record<string,string|readonly string[]>={};
  const provenance:Record<string,DossierFactProvenance>={};
  const add=(
    key:string,
    value:string|readonly string[]|null,
    source:string,
    observedAt:string|Date|null,
    confidence:number,
    confirmationState:DossierFactProvenance["confirmation_state"],
  )=>{
    const timestamp=isoOrNull(observedAt);
    if(value===null||!timestamp)return;
    if(typeof value==="string"&&!value.trim())return;
    if(Array.isArray(value)&&value.length===0)return;
    content[key]=value;
    provenance[key]={source,observed_at:timestamp,confidence,confirmation_state:confirmationState};
  };

  const locations=boundedDossierLabels(row.location_names);
  add("locations",locations,"Canonical locations from connected operational systems",row.locations_observed_at,1,"source_reported");
  const channels=boundedDossierLabels(row.channel_names);
  add("channels",channels,"Canonical sales channels",row.channels_observed_at,1,"source_reported");

  const baseCurrency=row.base_currency?.trim().toUpperCase();
  add(
    "base_currency",
    baseCurrency&&/^[A-Z]{3}$/.test(baseCurrency)?baseCurrency:null,
    "Canonical legal entity",
    row.entity_observed_at,
    1,
    "source_reported",
  );

  const salesCount=nonNegativeCount(row.sale_count);
  const productCount=nonNegativeCount(row.product_count);
  const retailObserved=latestDossierTimestamp(row.sales_observed_at,row.products_observed_at);
  if(salesCount>0||productCount>0){
    add(
      "industry",
      "Independent retail",
      "Canonical product catalogue and commerce activity",
      retailObserved,
      0.85,
      "inferred",
    );
  }

  for(const contribution of [...contributions].sort((left,right)=>
    left.key.localeCompare(right.key)||
    (isoOrNull(left.observedAt)??"").localeCompare(isoOrNull(right.observedAt)??"")||
    left.source.localeCompare(right.source)
  )){
    assertDossierContribution(contribution);
    if(contribution.merge==="fill"&&Object.hasOwn(content,contribution.key))continue;
    add(
      contribution.key,contribution.value,contribution.source,
      contribution.observedAt,contribution.confidence,contribution.confirmationState,
    );
  }

  const hours=formatTradingHours(row.hours);
  add(
    "trading_hours",
    hours,
    "90-day canonical completed-sales histogram (5th–95th percentile)",
    row.sales_observed_at,
    0.75,
    "inferred",
  );
  if(nonNegativeCount(row.observed_months)>=4){
    const strongest=monthName(row.strongest_month);
    const quietest=monthName(row.quietest_month);
    if(strongest&&quietest&&strongest!==quietest){
      add(
        "seasonality",
        `Strongest observed month: ${strongest}; quietest: ${quietest}`,
        "Trailing 13-month canonical net-sales histogram",
        row.sales_observed_at,
        0.7,
        "inferred",
      );
    }
  }
  if(Object.keys(content).length===0)return null;
  const sourceBundleHash=createHash("sha256")
    .update(JSON.stringify({content,provenance}))
    .digest("hex");
  return Object.freeze({
    content:Object.freeze(content),
    provenance:Object.freeze(provenance),
    sourceBundleHash,
  });
}

function boundedDossierLabels(values:readonly string[]|null):readonly string[]{
  const unique=new Set<string>();
  for(const value of values??[]){
    const clean=value.replace(/[\u0000-\u001f\u007f]/g," ").replace(/\s+/g," ").trim().slice(0,100);
    if(clean)unique.add(clean);
    if(unique.size>=50)break;
  }
  return Object.freeze([...unique]);
}

function nonNegativeCount(value:string|number):number{
  const count=Number(value);
  return Number.isSafeInteger(count)&&count>=0?count:0;
}

function latestDossierTimestamp(...values:readonly (string|Date|null)[]):string|null{
  return values.map(isoOrNull).filter((value):value is string=>Boolean(value))
    .sort((left,right)=>Date.parse(right)-Date.parse(left))[0]??null;
}

function formatTradingHours(value:unknown):string|null{
  let candidate=value;
  if(typeof candidate==="string"){
    try{candidate=JSON.parse(candidate) as unknown;}catch{return null;}
  }
  if(!Array.isArray(candidate))return null;
  const formatted=candidate.slice(0,7).flatMap((entry)=>{
    if(!entry||typeof entry!=="object"||Array.isArray(entry))return[];
    const row=entry as Record<string,unknown>;
    const day=Number(row.day),opens=Number(row.opens),closes=Number(row.closes),samples=Number(row.samples);
    if(!Number.isInteger(day)||day<1||day>7||!Number.isFinite(opens)||!Number.isFinite(closes)||samples<3)return[];
    return [`${weekdayNames[day-1]} ${formatClockSeconds(opens)}–${formatClockSeconds(closes)}`];
  });
  return formatted.length?formatted.join("; "):null;
}

function formatClockSeconds(value:number):string{
  const total=Math.min(86_399,Math.max(0,Math.round(value/60)*60));
  const hour24=Math.floor(total/3600),minute=Math.floor((total%3600)/60);
  const suffix=hour24>=12?"pm":"am";
  const hour=hour24%12||12;
  return `${hour}:${String(minute).padStart(2,"0")} ${suffix}`;
}

function monthName(value:string|Date|null):string|null{
  const iso=isoOrNull(value);
  if(!iso)return null;
  return new Intl.DateTimeFormat("en-AU",{month:"long",timeZone:"UTC"}).format(new Date(iso));
}

function transformResult(batchId:string,replayed:boolean,row:TransformCommitRow):CanonicalTransformResult{return{batchId,replayed,stagedRows:Number(row.staged_rows),quarantinedRows:Number(row.quarantined_rows),commandCount:Number(row.command_count),canonicalRows:Number(row.canonical_rows),metadataRows:Number(row.metadata_rows),qualityStatus:row.quality_status,partialQualityStatus:row.partial_quality_status,completeQualityStatus:row.complete_quality_status,dataReadyThrough:row.data_ready_through?new Date(row.data_ready_through).toISOString():null,compatibilityReplayPending:false,compatibilityReplayCandidates:0,compatibilityReplayCommands:0,compatibilityReplayProgressToken:null};}

async function establishTransformScope(
  client:PostgresQueryClient,
  tenantId:string,
  capability?:string,
):Promise<void>{
  await client.query("set local role transform_rw");
  if(capability){
    await client.query("select set_config('albert.tenant_capability',$1,true)",[capability]);
  }
  await client.query("select set_config('albert.tenant_id',$1,true)",[tenantId]);
  const role=await client.query<{role_name:string;tenant_scope:string|null}>(
    "select current_user as role_name,core.current_tenant_id() as tenant_scope",
  );
  if(role.rows[0]?.role_name!=="transform_rw"||role.rows[0]?.tenant_scope!==tenantId)throw new Error("transform_scope_not_established");
  // Serialize every analytical transform transaction against the exclusive
  // tenant lock used by purge. This also fences a still-valid capability that
  // was issued just before deletion began.
  await client.query(
    "select pg_advisory_xact_lock_shared(hashtextextended('deletion:'||$1,0))",
    [tenantId],
  );
}

async function establishControlTransformScope(client:PostgresQueryClient,tenantId:string):Promise<void>{
  await establishControlWorkerRole(client);
  await client.query("select set_config('albert.tenant_id',$1,true)",[tenantId]);
  const scope=await client.query<{tenant_scope:string|null}>(
    "select current_setting('albert.tenant_id',true) as tenant_scope",
  );
  if(scope.rows[0]?.tenant_scope!==tenantId){
    throw new Error("transform_control_scope_not_established");
  }
}

async function establishControlWorkerRole(client:PostgresQueryClient):Promise<void>{
  await client.query("set local role albert_transform_control");
  const role=await client.query<{role_name:string}>("select current_user as role_name");
  if(role.rows[0]?.role_name!=="albert_transform_control"){
    throw new Error("transform_control_database_role_not_ready");
  }
}

function requireManifest(connectorId:ConnectorId):ConnectorManifest{return connectorManifest(connectorId);}
function requireStagingContract(connectorId:ConnectorId,stream:string):StagingStreamContract{const contract=stagingByStream.get(`${connectorId}:${stream}`);if(!contract)throw new Error(`canonical_staging_contract_missing:${connectorId}:${stream}`);return contract;}
function requireStreamContract(manifest:ConnectorManifest,stream:string):StreamContract{
  const streamContract=manifest.streams.find((candidate)=>candidate.id===stream);
  if(!streamContract)throw new Error(`canonical_manifest_stream_missing:${manifest.id}:${stream}`);
  return streamContract;
}
async function loadMappingContext(
  control: TransactionalPostgres,
  job: CanonicalTransformBatch,
): Promise<CanonicalMappingContext> {
  const result = await control.transaction(async(client)=>{
    await establishControlTransformScope(client,job.tenantId);
    return client.query<{
      timezone:string|null;
      trading_day_cutoff:string|null;
      base_currency:string|null;
    }>(
      `select overlay.overlay->>'timezone' as timezone,
            coalesce(overlay.overlay->>'trading_day_cutoff','00:00') as trading_day_cutoff,
            upper(coalesce(
              connection.account_metadata->>'base_currency',
              connection.account_metadata->>'currency',
              overlay.overlay->>'base_currency',
              dossier.content->>'base_currency',
              dossier.content#>>'{organisation,base_currency}',
              'AUD'
            )) as base_currency
       from control_plane.connections as connection
       join lateral (
         select candidate.overlay
           from control_plane.tenant_overlays as candidate
          where candidate.tenant_id=connection.tenant_id and candidate.status='published'
          order by candidate.version desc limit 1
       ) as overlay on true
       left join lateral (
         select candidate.content
           from control_plane.dossiers as candidate
          where candidate.tenant_id=connection.tenant_id and candidate.status='published'
          order by candidate.version desc limit 1
       ) as dossier on true
      where connection.tenant_id=$1 and connection.connection_id=$2
        and connection.connector_key=$3
        and connection.status in ('connected','degraded')`,
      [job.tenantId,job.connectionId,job.connectorId],
    );
  });
  const row=result.rows[0];
  if(!row?.timezone)throw new Error("canonical_mapping_context_missing");
  try{
    new Intl.DateTimeFormat("en-AU",{timeZone:row.timezone}).format(new Date(0));
  }catch{
    throw new Error(`canonical_timezone_invalid:${row.timezone}`);
  }
  const cutoff=row.trading_day_cutoff??"00:00";
  const cutoffMatch=/^(\d{2}):(\d{2})$/.exec(cutoff);
  if(!cutoffMatch||Number(cutoffMatch[1])>23||Number(cutoffMatch[2])>59){
    throw new Error(`canonical_trading_day_cutoff_invalid:${cutoff}`);
  }
  const baseCurrency=row.base_currency?.trim().toUpperCase();
  if(!baseCurrency||!/^[A-Z]{3}$/.test(baseCurrency)){
    throw new Error("canonical_base_currency_invalid");
  }
  return Object.freeze({timezone:row.timezone,baseCurrency,tradingDayCutoff:cutoff});
}

function assertStagingLineage(
  row: CanonicalStagingRow,
  job: CanonicalTransformBatch,
  mappingVersion: string,
): void {
  if(
    row.tenant_id!==job.tenantId||row.connection_id!==job.connectionId||
    row.payload_batch_id!==job.batchId||row.sync_run_id!==job.syncRunId||
    row.mapping_version!==mappingVersion
  )throw new Error(`canonical_staging_lineage_mismatch:${row.namespaced_source_key}`);
}

function canonicalMappingFailure(error:unknown):Readonly<{
  errorCode:string;
  errorSummary:string;
}>{
  const message=error instanceof Error?error.message:"canonical_mapping_rejected";
  const sourceCode=(message.split(":",1)[0]??"canonical_mapping_rejected")
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g,"_")
    .replace(/^[^a-z]+/,"")
    .slice(0,100);
  const stableCode=sourceCode||"mapping_rejected";
  return Object.freeze({
    errorCode:`canonical.${stableCode}`,
    errorSummary:`Canonical mapper rejected this typed source record (${stableCode}).`,
  });
}

async function assertLandingCommit(client:PostgresQueryClient,job:CanonicalTransformBatch,stream:string,mappingVersion:string):Promise<void>{
  const landed=await client.query<{staged_record_count:string|number}>(
    `select landing.staged_record_count
       from ingestion.landing_commits AS landing
       join ingestion.batch_manifests AS manifest
         on manifest.tenant_id=landing.tenant_id and manifest.batch_id=landing.batch_id
      where landing.tenant_id=$1 and landing.batch_id=$2
        and landing.sync_run_id=$3 and landing.mapping_version=$4
        and landing.status='committed'
        and manifest.connection_id=$5 and manifest.connector_key=$6
        and manifest.stream=$7 and manifest.sync_run_id=$3`,
    [job.tenantId,job.batchId,job.syncRunId,mappingVersion,job.connectionId,job.connectorId,stream],
  );
  if(!landed.rows[0])throw new Error(`canonical_landing_not_committed:${stream}`);
}

async function loadStagingRows(client:PostgresQueryClient,contract:StagingStreamContract,job:CanonicalTransformBatch,mappingVersion:string):Promise<CanonicalStagingRow[]>{
  const table=`${quoteIdentifier(contract.schema)}.${quoteIdentifier(contract.table)}`;
  const result=await client.query<CanonicalStagingRow>(
    `select s.*,source.source_object_type
       from ${table} s
       join ingestion.source_records source
         on source.tenant_id=s.tenant_id
        and source.namespaced_source_key=s.namespaced_source_key
        and source.connection_id=s.connection_id
        and source.source_record_id=s.source_record_id
      where s.tenant_id=$1 and s.payload_batch_id=$2 and s.sync_run_id=$3
        and s.mapping_version=$4 and s.connection_id=$5
        and source.connector_key=$6 and source.stream=$7
      order by s.namespaced_source_key`,
    [job.tenantId,job.batchId,job.syncRunId,mappingVersion,job.connectionId,job.connectorId,contract.stream],
  );
  return [...result.rows];
}

async function recordCanonicalMappingQuarantine(
  client:PostgresQueryClient,
  job:CanonicalTransformBatch,
  stream:string,
  row:CanonicalStagingRow,
  errorCode:string,
  errorSummary:string,
):Promise<void>{
  await client.query(
    `select semantic_internal.record_canonical_mapping_quarantine(
       $1::text,$2::text,$3::text,$4::text,$5::text,$6::text,
       $7::text,$8::text,$9::text,$10::text,$11::text,$12::text
     )`,
    [
      job.tenantId,job.connectionId,job.syncRunId,job.batchId,stream,
      row.source_object_type,row.source_record_id,row.payload_hash,
      row.mapping_version,errorCode,"$mapper",errorSummary,
    ],
  );
}

async function resolveCanonicalMappingQuarantine(
  client:PostgresQueryClient,
  job:CanonicalTransformBatch,
  stream:string,
  row:CanonicalStagingRow,
):Promise<void>{
  await client.query(
    `select semantic_internal.resolve_canonical_mapping_quarantine(
       $1::text,$2::text,$3::text,$4::text,$5::text,$6::text,$7::text,$8::text
     )`,
    [
      job.tenantId,job.connectionId,job.syncRunId,job.batchId,stream,
      row.source_object_type,row.source_record_id,row.payload_hash,
    ],
  );
}

function commandRank(command:CanonicalProjectionCommand):number{
  if(command.kind==="dimension"||command.kind==="fact")return tableColumns[command.table].rank;
  if(command.kind==="category_assignment")return 60;
  if(command.kind==="identity_hint")return 200;
  if(command.kind==="event_link")return 210;
  return 220;
}

function deterministicCanonicalId(parts:readonly string[]):string{
  const bytes=createHash("sha256").update(parts.join("\u001f")).digest().subarray(0,16);
  const alphabet="0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let value=BigInt(`0x${bytes.toString("hex")}`);let output="";
  for(let index=0;index<26;index+=1){output=alphabet[Number(value&31n)]+output;value>>=5n;}
  return output;
}

function canonicalId(tenantId:string,table:CanonicalProjectionTable,connectionId:string,sourceObjectType:string,sourceRecordId:string):string{
  return deterministicCanonicalId(["canonical-v1",tenantId,table,connectionId,sourceObjectType,sourceRecordId]);
}

type CanonicalUpsertOutcome=Readonly<{applied:boolean;previousDates:readonly string[]}>;

/**
 * A fact mapper may not claim an authority concept different from the exact
 * stream contract that produced its source row. Keep this check pure and
 * exported so every connector fixture and the runtime exercise the same
 * fail-closed boundary.
 */
export function assertCanonicalCommandAuthority(
  command:CanonicalUpsertCommand,
  streamAuthority:SourceAuthorityConcept,
):void{
  if(command.kind==="fact"&&command.authorityConcept!==streamAuthority){
    throw new Error(`canonical_authority_manifest_mismatch:${command.table}`);
  }
}

/**
 * Bind every durable mapper output to the exact stream declaration before a
 * command-specific executor can perform a write. Special outputs intentionally
 * use explicit manifest targets instead of pretending to be canonical tables.
 */
export function assertCanonicalCommandAdmission(
  command:CanonicalProjectionCommand,
  stream:Pick<StreamContract,"canonicalTargets"|"authorityConcept">,
):void{
  const target=command.kind==="dimension"||command.kind==="fact"
    ?command.table
    :command.kind;
  if(!stream.canonicalTargets.some((declared)=>declared===target)){
    throw new Error(`canonical_target_manifest_mismatch:${target}`);
  }
  if(command.kind==="fact")assertCanonicalCommandAuthority(command,stream.authorityConcept);
}

async function executeUpsert(
  client:PostgresQueryClient,
  job:CanonicalTransformBatch,
  row:CanonicalStagingRow,
  command:CanonicalUpsertCommand,
  streamAuthority:SourceAuthorityConcept,
):Promise<CanonicalUpsertOutcome>{
  const table=tableColumns[command.table];
  if(!table||command.table==="calendar_day")throw new Error(`canonical_table_unsupported:${command.table}`);
  if((command.kind==="fact")!==table.fact)throw new Error(`canonical_command_kind_mismatch:${command.table}`);
  if(!command.sourceObjectType.trim()||!command.sourceRecordId.trim())throw new Error("canonical_source_identity_missing");
  const entries=Object.entries(command.values);
  if(!entries.length)throw new Error(`canonical_values_empty:${command.table}`);
  if(command.updateOnly&&!command.tombstone)throw new Error(`canonical_update_only_without_tombstone:${command.table}`);
  for(const [column] of entries)if(!table.columns.has(column))throw new Error(`canonical_field_unsupported:${command.table}.${column}`);
  if(command.tombstone&&table.fact&&!entries.some(([column])=>column==="voided"||column==="status"||column==="order_status")){
    throw new Error(`canonical_tombstone_unrepresented:${command.table}`);
  }
  assertCanonicalCommandAuthority(command,streamAuthority);
  const id=canonicalId(job.tenantId,command.table,job.connectionId,command.sourceObjectType,command.sourceRecordId);
  let persisted:Readonly<Record<string,unknown>>|undefined;
  if(command.updateOnly){
    const existing=await client.query<Record<string,unknown>>(
      `select * from core.${quoteIdentifier(command.table)} where tenant_id=$1 and id=$2`,
      [job.tenantId,id],
    );
    persisted=existing.rows[0];
    if(!persisted)return{applied:false,previousDates:[]};
  }
  const resolved:Record<string,unknown>={};
  for(const [column,value] of entries)resolved[column]=await resolveValue(client,job,value);
  if(table.fact)await assertAuthority(client,job,row,command,resolved,persisted);
  if(!await claimCanonicalRecordVersion(
    client,job,row,command.table,id,command.sourceObjectType,command.sourceRecordId,
  ))return{applied:false,previousDates:[]};
  const dateColumn=table.fact
    ? table.columns.has("business_date")?"business_date":table.columns.has("snapshot_date")?"snapshot_date":null
    : null;
  const previousDates:string[]=[];
  if(dateColumn){
    const previous=await client.query<{event_date:string|Date|null}>(
      `select ${quoteIdentifier(dateColumn)} as event_date from core.${quoteIdentifier(command.table)} where tenant_id=$1 and id=$2`,
      [job.tenantId,id],
    );
    const prior=dateOnlyOrNull(previous.rows[0]?.event_date);
    if(prior)previousDates.push(prior);
  }
  if(command.updateOnly){
    const mutable=Object.keys(resolved);
    const updated=await client.query<{id:string}>(
      `update core.${quoteIdentifier(command.table)} set
         ${mutable.map((column,index)=>`${quoteIdentifier(column)}=$${index+3}`).join(",")},
         sync_run_id=$${mutable.length+3},updated_at=now()
       where tenant_id=$1 and id=$2
       returning id`,
      [job.tenantId,id,...Object.values(resolved),row.sync_run_id],
    );
    if(!updated.rows[0])return{applied:false,previousDates};
    await publishCanonicalDimensionAuthorityDefaults(
      client,job,row.sync_run_id,command.table,id,
    );
    if(command.entityType)await upsertDirectEntityLink(client,job,row,command,id);
    return{applied:true,previousDates};
  }
  const values:Record<string,unknown>={tenant_id:job.tenantId,id,...resolved,sync_run_id:row.sync_run_id};
  if(table.fact){values.primary_connection_id=job.connectionId;values.primary_source_record_id=command.sourceRecordId;values.source_updated_at=isoOrNull(row.source_updated_at);}
  const columns=Object.keys(values);const parameters=Object.values(values);
  const mutable=columns.filter((column)=>!['tenant_id','id','primary_connection_id','primary_source_record_id','sync_run_id'].includes(column));
  const conflict=mutable.length?`do update set ${mutable.map((column)=>`${quoteIdentifier(column)}=excluded.${quoteIdentifier(column)}`).join(",")},updated_at=now()`:"do nothing";
  await client.query(`insert into core.${quoteIdentifier(command.table)} (${columns.map(quoteIdentifier).join(",")}) values (${columns.map((_,index)=>`$${index+1}`).join(",")}) on conflict (tenant_id,id) ${conflict}`,parameters);
  await publishCanonicalDimensionAuthorityDefaults(
    client,job,row.sync_run_id,command.table,id,
  );
  if(command.entityType)await upsertDirectEntityLink(client,job,row,command,id);
  if(command.table==="commerce_order")await upsertOrderObservation(client,job,row,command,id);
  if(command.table==="commerce_order_line")await upsertOrderLineObservation(client,job,row,command,id);
  return{applied:true,previousDates};
}

async function resolveValue(client:PostgresQueryClient,job:CanonicalTransformBatch,value:unknown):Promise<unknown>{
  if(!isCanonicalSourceReference(value))return value;
  const ref=value.sourceRef;const connectionId=ref.connectionId??job.connectionId;
  if(ref.lookup?.kind==="employment_episode_on"){
    if(ref.table!=="employment_episode")throw new Error("canonical_employment_episode_lookup_scope_invalid");
    const businessDate=dateOnlyOrNull(ref.lookup.businessDate);
    if(!businessDate)throw new Error("canonical_employment_episode_lookup_date_invalid");
    const workerId=canonicalId(
      job.tenantId,"worker",connectionId,
      ref.lookup.workerSourceObjectType,ref.lookup.workerSourceRecordId,
    );
    const matched=await client.query<{id:string}>(
      `select episode.id
         from core.employment_episode episode
        where episode.tenant_id=$1 and episode.worker_id=$2
          and episode.effective_from<=$3::date
          and (episode.effective_to is null or episode.effective_to>$3::date)
        order by episode.effective_from desc,episode.id
        limit 2`,
      [job.tenantId,workerId,businessDate],
    );
    if(matched.rows.length===1)return matched.rows[0]!.id;
    if(ref.nullable&&matched.rows.length===0)return null;
    throw new Error(matched.rows.length
      ? `canonical_employment_episode_ambiguous:${ref.lookup.workerSourceRecordId}:${businessDate}`
      : `canonical_employment_episode_missing:${ref.lookup.workerSourceRecordId}:${businessDate}`
    );
  }
  if(ref.lookup?.kind==="connector_natural_key"){
    const hook=connectorReferenceLookup(job.connectorId);
    if(!hook)throw new Error(`canonical_natural_key_lookup_unsupported:${job.connectorId}`);
    const resolution=await hook.resolve({
      database:connectorHookDatabase(hook.databaseRegistrationId,client,{
        tenantId:job.tenantId,connectionId:job.connectionId,
        batchId:job.batchId,syncRunId:job.syncRunId,
        mappingVersion:job.mappingVersion,
        connectionGeneration:job.connectionGeneration,
      }),
      job,reference:ref,lookup:ref.lookup,
    });
    if(resolution.status!=="matched"){
      if(ref.nullable&&resolution.status==="missing")return null;
      throw new Error(
        `canonical_natural_key_${resolution.status}:${ref.table}:${ref.lookup.value}`,
      );
    }
    if(!resolution.sourceObjectType.trim()||!resolution.sourceRecordId.trim()){
      throw new Error("canonical_natural_key_identity_invalid");
    }
    const target=tableColumns[ref.table];
    if(!target||ref.table==="calendar_day"){
      throw new Error(`canonical_reference_table_unsupported:${ref.table}`);
    }
    const id=canonicalId(
      job.tenantId,ref.table,connectionId,
      resolution.sourceObjectType,resolution.sourceRecordId,
    );
    const exists=await client.query<{present:number}>(
      `select 1 as present from core.${quoteIdentifier(ref.table)} where tenant_id=$1 and id=$2`,
      [job.tenantId,id],
    );
    if(exists.rows[0])return id;
    throw new Error(`canonical_reference_missing:${ref.table}:${ref.lookup.value}`);
  }
  if(!ref.sourceRecordId?.trim()){if(ref.nullable)return null;throw new Error("canonical_reference_id_missing");}
  // Facts always retain the source-owned canonical foreign key. Identity
  // decisions are an effective-dated query-time graph; materialising a merged
  // ID here would make an undo unable to separate facts written after merge.
  const id=canonicalId(job.tenantId,ref.table,connectionId,ref.sourceObjectType,ref.sourceRecordId);
  const target=tableColumns[ref.table];if(!target||ref.table==="calendar_day")throw new Error(`canonical_reference_table_unsupported:${ref.table}`);
  const exists=await client.query<{present:number}>(`select 1 as present from core.${quoteIdentifier(ref.table)} where tenant_id=$1 and id=$2`,[job.tenantId,id]);
  if(exists.rows[0])return id;
  throw new Error(`canonical_reference_missing:${ref.table}:${ref.sourceObjectType}:${ref.sourceRecordId}`);
}

async function executeCategoryAssignment(client:PostgresQueryClient,job:CanonicalTransformBatch,row:CanonicalStagingRow,command:CanonicalCategoryAssignmentCommand):Promise<boolean>{
  const productVariantId=await resolveValue(client,job,command.productVariant);
  const productCategoryId=await resolveValue(client,job,command.productCategory);
  if(typeof productVariantId!=="string"||typeof productCategoryId!=="string")throw new Error("canonical_category_assignment_reference_missing");
  const effectiveFrom=command.effectiveFrom??isoOrNull(row.source_updated_at)??"1970-01-01T00:00:00.000Z";
  const id=deterministicCanonicalId(["category-assignment-v1",job.tenantId,productVariantId,productCategoryId,effectiveFrom]);
  if(!await claimCanonicalRecordVersion(
    client,job,row,"product_category_assignment",id,command.sourceObjectType,command.sourceRecordId,
  ))return false;
  await client.query(
    `update core.product_category_assignment set effective_to=$4
      where tenant_id=$1 and product_variant_id=$2 and effective_to is null and product_category_id<>$3 and effective_from<$4`,
    [job.tenantId,productVariantId,productCategoryId,effectiveFrom],
  );
  if(command.tombstone){await client.query(`update core.product_category_assignment set effective_to=coalesce(effective_to,$3) where tenant_id=$1 and product_variant_id=$2 and effective_to is null`,[job.tenantId,productVariantId,effectiveFrom]);return true;}
  await client.query(
    `insert into core.product_category_assignment (tenant_id,id,product_variant_id,product_category_id,effective_from,sync_run_id)
     values ($1,$2,$3,$4,$5,$6) on conflict (tenant_id,id) do nothing`,
    [job.tenantId,id,productVariantId,productCategoryId,effectiveFrom,row.sync_run_id],
  );
  return true;
}

async function claimCanonicalRecordVersion(
  client:PostgresQueryClient,
  job:CanonicalTransformBatch,
  row:CanonicalStagingRow,
  table:CanonicalProjectionTable|"product_category_assignment",
  canonicalRecordId:string,
  sourceObjectType:string,
  sourceRecordId:string,
):Promise<boolean>{
  const sourceUpdatedAt=isoOrNull(row.source_updated_at)??isoOrNull(row.ingested_at)??new Date(0).toISOString();
  const claimed=await client.query<{canonical_id:string}>(
    `insert into semantic_internal.canonical_record_state (
       tenant_id,canonical_table,canonical_id,source_updated_at,source_version,payload_hash,
       batch_id,sync_run_id,connection_id,source_object_type,source_record_id,mapping_version
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     on conflict (tenant_id,canonical_table,canonical_id) do update set
       source_updated_at=excluded.source_updated_at,source_version=excluded.source_version,
       payload_hash=excluded.payload_hash,batch_id=excluded.batch_id,
       sync_run_id=excluded.sync_run_id,connection_id=excluded.connection_id,
       source_object_type=excluded.source_object_type,source_record_id=excluded.source_record_id,
       mapping_version=excluded.mapping_version,updated_at=now()
     where excluded.source_updated_at>=semantic_internal.canonical_record_state.source_updated_at
       and (
         excluded.payload_hash<>semantic_internal.canonical_record_state.payload_hash
         or excluded.source_version is distinct from semantic_internal.canonical_record_state.source_version
         or excluded.mapping_version is distinct from semantic_internal.canonical_record_state.mapping_version
       )
     returning canonical_id`,
    [
      job.tenantId,table,canonicalRecordId,sourceUpdatedAt,row.source_version,row.payload_hash,
      row.payload_batch_id,row.sync_run_id,job.connectionId,sourceObjectType,sourceRecordId,row.mapping_version,
    ],
  );
  return Boolean(claimed.rows[0]);
}

type ResolvedAuthorityScope=Readonly<{
  type:"account"|"location"|"legal_entity";
  id:string;
}>;

async function assertAuthority(
  client:PostgresQueryClient,
  job:CanonicalTransformBatch,
  row:CanonicalStagingRow,
  command:CanonicalUpsertCommand,
  resolved:Readonly<Record<string,unknown>>,
  persisted:Readonly<Record<string,unknown>>|undefined,
):Promise<void>{
  const concept=command.authorityConcept;
  if(!concept)throw new Error(`canonical_authority_undefined:${command.table}`);
  const scope=await resolvedAuthorityScope(client,job,command,resolved,persisted);
  const effectiveAt=authorityEffectiveAt(command,resolved,persisted,row);
  await client.query(
    `select core.install_default_source_authority(
       $1::text,$2::text,$3::text,$4::text,$5::text,$6::text,$7::timestamptz
     )`,
    [job.tenantId,concept,scope.type,scope.id,job.connectionId,row.sync_run_id,new Date(0).toISOString()],
  );
  await client.query(
    `select core.assert_source_authority(
       $1::text,$2::text,$3::text,$4::text,$5::text,$6::timestamptz
     )`,
    [job.tenantId,concept,scope.type,scope.id,job.connectionId,effectiveAt],
  );
}

function authorityEffectiveAt(
  command:CanonicalUpsertCommand,
  resolved:Readonly<Record<string,unknown>>,
  persisted:Readonly<Record<string,unknown>>|undefined,
  row:CanonicalStagingRow,
):string{
  const preferredColumns:Partial<Record<CanonicalProjectionTable,readonly string[]>>={
    commerce_order:["ordered_at"],commerce_order_line:["ordered_at"],
    commerce_payment:["paid_at"],commerce_refund_line:["refunded_at"],
    inventory_movement:["occurred_at"],inventory_balance_snapshot:["snapshot_at"],
    purchase_order_line:["ordered_at"],finance_journal_line:["posted_at"],
    finance_invoice_line:["issued_at"],finance_bank_transaction:["transaction_at"],
    workforce_shift:["starts_at"],workforce_time_entry:["starts_at"],
    workforce_leave:["starts_at"],
  };
  for(const column of preferredColumns[command.table]??[]){
    const value=Object.prototype.hasOwnProperty.call(resolved,column)
      ?resolved[column]
      :persisted?.[column];
    const timestamp=isoOrNull(value);
    if(timestamp)return timestamp;
  }
  return thisInstant(row);
}

async function resolvedAuthorityScope(
  client:PostgresQueryClient,
  job:CanonicalTransformBatch,
  command:CanonicalUpsertCommand,
  resolved:Readonly<Record<string,unknown>>,
  persisted:Readonly<Record<string,unknown>>|undefined,
):Promise<ResolvedAuthorityScope>{
  const value=(column:string):unknown=>Object.prototype.hasOwnProperty.call(resolved,column)
    ?resolved[column]
    :persisted?.[column];
  if(command.table==="finance_journal_line"||command.table==="finance_invoice_line"||
     command.table==="finance_bank_transaction"){
    return {type:"legal_entity",id:requiredResolvedScopeId(command.table,"legal_entity_id",value("legal_entity_id"))};
  }
  if(command.table==="commerce_order"||command.table==="commerce_order_line"||
     command.table==="commerce_payment"||command.table==="commerce_refund_line"||
     command.table==="workforce_shift"||command.table==="workforce_time_entry"){
    return {type:"location",id:requiredResolvedScopeId(command.table,"location_id",value("location_id"))};
  }
  if(command.table==="workforce_leave"){
    const locationId=value("location_id");
    return typeof locationId==="string"&&locationId
      ?{type:"location",id:locationId}
      :{type:"account",id:job.connectionId};
  }
  if(command.table==="inventory_movement"||command.table==="inventory_balance_snapshot"||
     command.table==="purchase_order_line"){
    const scopedStockLocationId=value("stock_location_id");
    if((scopedStockLocationId===null||scopedStockLocationId===undefined)&&command.table==="purchase_order_line"){
      return {type:"account",id:job.connectionId};
    }
    const stockLocationId=requiredResolvedScopeId(command.table,"stock_location_id",scopedStockLocationId);
    const location=await client.query<{location_id:string}>(
      `select location_id from core.stock_location where tenant_id=$1 and id=$2`,
      [job.tenantId,stockLocationId],
    );
    const locationId=location.rows[0]?.location_id;
    if(!locationId)throw new Error(`canonical_authority_scope_missing:${command.table}:location_id`);
    return {type:"location",id:locationId};
  }
  throw new Error(`canonical_authority_scope_undefined:${command.table}`);
}

function requiredResolvedScopeId(table:CanonicalProjectionTable,column:string,value:unknown):string{
  if(typeof value!=="string"||!value.trim())throw new Error(`canonical_authority_scope_missing:${table}:${column}`);
  return value;
}

async function publishAuthorityDefaults(client:PostgresQueryClient,job:CanonicalTransformBatch):Promise<void>{
  const policies=requireManifest(job.connectorId).sourceAuthority.defaults;
  for(const policy of policies){
    if(policy.scope.kind!=="connection_account")continue;
    for(const concept of policy.concepts){
      await client.query(
        `select core.install_default_source_authority(
           $1::text,$2::text,$3::text,$4::text,$5::text,$6::text,$7::timestamptz
         )`,
        [job.tenantId,concept,"account",job.connectionId,job.connectionId,
          job.syncRunId,new Date(0).toISOString()],
      );
    }
  }
}

async function publishCanonicalDimensionAuthorityDefaults(
  client:PostgresQueryClient,
  job:CanonicalTransformBatch,
  syncRunId:string,
  table:CanonicalProjectionTable,
  canonicalId:string,
):Promise<void>{
  const policies=requireManifest(job.connectorId).sourceAuthority.defaults;
  for(const policy of policies){
    if(policy.scope.kind!=="canonical_dimension"||policy.scope.table!==table)continue;
    for(const concept of policy.concepts){
      await client.query(
        `select core.install_default_source_authority(
           $1::text,$2::text,$3::text,$4::text,$5::text,$6::text,$7::timestamptz
         )`,
        [job.tenantId,concept,policy.scope.scopeType,canonicalId,
          job.connectionId,syncRunId,new Date(0).toISOString()],
      );
    }
  }
}

async function upsertDirectEntityLink(client:PostgresQueryClient,job:CanonicalTransformBatch,row:CanonicalStagingRow,command:CanonicalUpsertCommand,canonicalEntityId:string):Promise<void>{
  const entityType=command.entityType as CanonicalEntityType;
  const linkId=deterministicCanonicalId(["entity-link-v1",job.tenantId,entityType,job.connectionId,command.sourceObjectType,command.sourceRecordId]);
  const tombstonedAt=command.tombstone?thisInstant(row):null;
  const effectiveAt=thisInstant(row);
  // Source links are native anchors.  Retire any legacy projected/current link
  // before restoring the deterministic native row; graph resolution is the
  // only mechanism allowed to merge entities for analytical reads.
  await client.query(
    `update core.entity_source_link
        set valid_to=greatest($7::timestamptz,valid_from+interval '1 microsecond'),
            match_status='superseded',superseded_by=$8
      where tenant_id=$1 and entity_type=$2 and connection_id=$3
        and source_object_type=$4 and source_record_id=$5 and valid_to is null
        and (link_id<>$6 or $9::boolean)`,
    [job.tenantId,entityType,job.connectionId,command.sourceObjectType,command.sourceRecordId,linkId,effectiveAt,command.tombstone?null:linkId,command.tombstone],
  );
  await client.query(
    `insert into core.entity_source_link (tenant_id,link_id,entity_type,canonical_entity_id,connection_id,source_object_type,source_record_id,match_method,match_status,confidence_band,evidence,valid_from,valid_to,sync_run_id)
     values (
       $1,$2,$3,$4,$5,$6,$7,'external_id',
       case when $9::timestamptz is null then 'accepted' else 'superseded' end,
       'high',$8::jsonb,
       '1970-01-01T00:00:00Z',$9::timestamptz,$10
     )
     on conflict (tenant_id,link_id) do update set
       canonical_entity_id=excluded.canonical_entity_id,
       match_method='external_id',match_status=excluded.match_status,confidence_band='high',
       evidence=excluded.evidence,valid_to=excluded.valid_to,
       confirmed_by=null,superseded_by=null,sync_run_id=excluded.sync_run_id`,
    [job.tenantId,linkId,entityType,canonicalEntityId,job.connectionId,command.sourceObjectType,command.sourceRecordId,JSON.stringify({payload_hash:row.payload_hash,mapping_version:row.mapping_version}),tombstonedAt,row.sync_run_id],
  );
}

async function upsertOrderObservation(client:PostgresQueryClient,job:CanonicalTransformBatch,row:CanonicalStagingRow,command:CanonicalUpsertCommand,orderId:string):Promise<void>{
  await client.query(
    `insert into core.order_source_observation (tenant_id,order_id,connection_id,source_object_type,source_record_id,relationship,match_method,confidence_band,valid_from,valid_to,sync_run_id)
     values ($1,$2,$3,$4,$5,'authoritative','external_id','high','1970-01-01T00:00:00Z',$6,$7) on conflict do nothing`,
    [job.tenantId,orderId,job.connectionId,command.sourceObjectType,command.sourceRecordId,command.tombstone?thisInstant(row):null,row.sync_run_id],
  );
}
async function upsertOrderLineObservation(client:PostgresQueryClient,job:CanonicalTransformBatch,row:CanonicalStagingRow,command:CanonicalUpsertCommand,orderLineId:string):Promise<void>{
  await client.query(
    `insert into core.order_line_source_observation (tenant_id,order_line_id,connection_id,source_object_type,source_record_id,source_line_ref,relationship,allocation,match_method,confidence_band,sync_run_id)
     values ($1,$2,$3,$4,$5,$5,'authoritative',1,'external_id','high',$6) on conflict do nothing`,
    [job.tenantId,orderLineId,job.connectionId,command.sourceObjectType,command.sourceRecordId,row.sync_run_id],
  );
}

async function executeEventLink(client:PostgresQueryClient,job:CanonicalTransformBatch,row:CanonicalStagingRow,command:CanonicalEventLinkCommand,mappingVersion:string):Promise<void>{
  const fromConnection=command.from.connectionId??job.connectionId;const toConnection=command.to.connectionId??job.connectionId;
  const id=deterministicCanonicalId(["event-link-v1",job.tenantId,command.linkType,fromConnection,command.from.sourceObjectType,command.from.sourceRecordId,toConnection,command.to.sourceObjectType,command.to.sourceRecordId]);
  await client.query(
    `insert into core.event_link (tenant_id,id,link_type,from_connection_id,from_object_type,from_source_record_id,to_connection_id,to_object_type,to_source_record_id,evidence,rule_version,sync_run_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12) on conflict do nothing`,
    [job.tenantId,id,command.linkType,fromConnection,command.from.sourceObjectType,command.from.sourceRecordId,toConnection,command.to.sourceObjectType,command.to.sourceRecordId,JSON.stringify(command.evidence),`${mappingVersion}/${job.connectorId}`,row.sync_run_id],
  );
}

function thisInstant(row:CanonicalStagingRow):string{return isoOrNull(row.source_updated_at)??isoOrNull(row.ingested_at)??new Date(0).toISOString();}

async function persistIdentityHint(client:PostgresQueryClient,job:CanonicalTransformBatch,row:CanonicalStagingRow,command:CanonicalIdentityHintCommand):Promise<void>{
  const observationId=deterministicCanonicalId(["identity-observation-v1",job.tenantId,command.entityType,job.connectionId,command.sourceObjectType,command.sourceRecordId]);
  const keys=Object.fromEntries(Object.entries(command.deterministicKeys).filter((entry):entry is [string,string]=>Boolean(entry[1])).map(([key,value])=>[key,identityDigest(job.tenantId,value)]));
  const evidenceRefs=normalizedIdentityEvidenceRefs(command);
  const corroboratingScopeRef=normalizedCorroboratingScopeRef(command);
  await client.query(
    `insert into semantic_internal.identity_observation (tenant_id,observation_id,entity_type,connection_id,source_object_type,source_record_id,external_id_digest,deterministic_key_digests,normalized_name_digest,corroborating_scope_digest,corroborating_scope_ref,evidence_refs,linkable,sync_run_id,source_updated_at,active)
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15,$16)
     on conflict (tenant_id,observation_id) do update set external_id_digest=excluded.external_id_digest,deterministic_key_digests=excluded.deterministic_key_digests,normalized_name_digest=excluded.normalized_name_digest,corroborating_scope_digest=excluded.corroborating_scope_digest,corroborating_scope_ref=excluded.corroborating_scope_ref,evidence_refs=excluded.evidence_refs,linkable=excluded.linkable,sync_run_id=excluded.sync_run_id,source_updated_at=excluded.source_updated_at,active=excluded.active`,
    [job.tenantId,observationId,command.entityType,job.connectionId,command.sourceObjectType,command.sourceRecordId,command.externalId?identityDigest(job.tenantId,`${job.connectorId}:${command.sourceObjectType}:${command.externalId}`):null,JSON.stringify(keys),command.normalizedName?identityDigest(job.tenantId,command.normalizedName):null,corroboratingScopeRef?null:command.corroboratingScope?identityDigest(job.tenantId,`${job.connectorId}:${command.corroboratingScope}`):null,corroboratingScopeRef?JSON.stringify(corroboratingScopeRef):null,JSON.stringify(evidenceRefs),command.evidenceOnly!==true,row.sync_run_id,isoOrNull(row.source_updated_at),!row.tombstone],
  );
}

function normalizedCorroboratingScopeRef(command:CanonicalIdentityHintCommand):Readonly<{source_object_type:string;source_record_id:string}>|null{
  const ref=command.corroboratingScopeRef;if(!ref)return null;
  const sourceObjectType=ref.sourceObjectType.trim();const sourceRecordId=ref.sourceRecordId.trim();
  if(!sourceObjectType||sourceObjectType.length>160||!sourceRecordId||sourceRecordId.length>500){
    throw new Error("identity_corroborating_scope_reference_invalid");
  }
  return Object.freeze({source_object_type:sourceObjectType,source_record_id:sourceRecordId});
}

function normalizedIdentityEvidenceRefs(command:CanonicalIdentityHintCommand):readonly Readonly<{source_object_type:string;source_record_id:string}>[]{
  const refs=command.evidenceRefs??[];
  if(refs.length>16)throw new Error("identity_evidence_reference_limit_exceeded");
  const unique=new Map<string,Readonly<{source_object_type:string;source_record_id:string}>>();
  for(const ref of refs){
    const sourceObjectType=ref.sourceObjectType.trim();const sourceRecordId=ref.sourceRecordId.trim();
    if(!sourceObjectType||sourceObjectType.length>160||!sourceRecordId||sourceRecordId.length>500){
      throw new Error("identity_evidence_reference_invalid");
    }
    if(sourceObjectType===command.sourceObjectType&&sourceRecordId===command.sourceRecordId){
      throw new Error("identity_evidence_reference_self");
    }
    unique.set(`${sourceObjectType}\u001f${sourceRecordId}`,Object.freeze({
      source_object_type:sourceObjectType,source_record_id:sourceRecordId,
    }));
  }
  return Object.freeze([...unique.entries()].sort(([left],[right])=>left.localeCompare(right)).map(([,ref])=>ref));
}

function identityDigest(tenantId:string,value:string):string{return createHash("sha256").update(`${tenantId}\u001f${value.trim().toLowerCase()}`).digest("hex");}

async function generateIdentitySuggestions(client:PostgresQueryClient,tenantId:string):Promise<void>{
  await client.query("select semantic_internal.refresh_identity_scope_digests($1)",[tenantId]);
  await client.query("select semantic_internal.generate_identity_review_candidates($1)",[tenantId]);
}

async function publishCapabilities(client:PostgresQueryClient,job:CanonicalTransformBatch,manifest:ConnectorManifest,stream:string,rows:readonly CanonicalStagingRow[]):Promise<void>{
  const through=latestSourceTimestamp(rows);
  for(const [capability,declared] of Object.entries(manifest.capabilities)){
    if(!declared.streams.includes(stream))continue;
    const eligibleRows=rows.filter((row)=>!row.tombstone);
    const coverageFields=Object.fromEntries((declared.coverageFields??[]).map((sourceField)=>{
      const field=stagingColumnName(sourceField);
      const observedRecords=eligibleRows.filter((row)=>observedCapabilityValue(row[field],declared.nonZeroCoverage===true)).length;
      return [sourceField,Object.freeze({
        observedRecords,
        eligibleRecords:eligibleRows.length,
        ratio:eligibleRows.length===0?0:observedRecords/eligibleRows.length,
      })];
    }));
    const nonNullRecords=eligibleRows.filter((row)=>(declared.coverageFields??[]).some((sourceField)=>
      observedCapabilityValue(row[stagingColumnName(sourceField)],declared.nonZeroCoverage===true),
    )).length;
    const coverage={
      stream,
      observedRecords:eligibleRows.length,
      eligibleRecords:eligibleRows.length,
      nonNullRecords,
      ratio:eligibleRows.length===0?0:nonNullRecords/eligibleRows.length,
      fields:coverageFields,
    };
    const support=observedCapabilitySupport(declared.support,declared.requiresObservedCoverage===true,nonNullRecords);
    const available=support==="full"||support==="partial";
    const reasonCode=support==="unavailable"
      ? declared.support==="unavailable"?"connector_unavailable":"required_fields_not_observed"
      : support==="partial"?"partial_coverage":"canonical_stream_observed";
    await client.query(
      `insert into semantic_internal.tenant_capability (
         tenant_id,capability,source_key,connection_id,connector_id,available,
         support,reason_code,reason_detail,coverage,pack_version,source_watermark,evaluated_at
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,now())
       on conflict (tenant_id,capability,source_key) do update set
         available=excluded.available,support=excluded.support,
         reason_code=excluded.reason_code,reason_detail=excluded.reason_detail,
         coverage=excluded.coverage,
         source_watermark=greatest(semantic_internal.tenant_capability.source_watermark,excluded.source_watermark),
         evaluated_at=now()`,
      [job.tenantId,capability,`${job.connectorId}:${job.connectionId}:canonical:${stream}`,job.connectionId,job.connectorId,available,support,reasonCode,declared.reason,JSON.stringify(coverage),manifest.packVersion,through],
    );
  }
}

function observedCapabilitySupport(
  declared:"full"|"partial"|"unavailable"|"unknown",
  requiresObservedCoverage:boolean,
  observedRecords:number,
):"full"|"partial"|"unavailable"{
  if(declared==="unavailable")return"unavailable";
  if(requiresObservedCoverage&&observedRecords===0)return"unavailable";
  if(declared==="partial")return"partial";
  return"full";
}

function observedCapabilityValue(value:unknown,nonZero:boolean):boolean{
  if(value===null||value===undefined)return false;
  if(typeof value==="string"&&value.trim()==="")return false;
  if(!nonZero)return true;
  if(typeof value==="number")return value!==0;
  if(typeof value==="string")return !/^(?:0+(?:\.0+)?|false|null)$/iu.test(value.trim());
  return value!==false;
}

export async function publishSourceAllowlist(client:PostgresQueryClient,job:CanonicalTransformBatch,manifest:ConnectorManifest,contract:StagingStreamContract):Promise<void>{
  const coverage=new Map(manifest.fieldCoverage.filter((field)=>field.stream===contract.stream).map((field)=>[field.field,field]));
  // Each pack version is an exact, independently staged snapshot. Retire only
  // this version's prior stream set so a rolling candidate cannot mutate the
  // predecessor snapshot that remains user-visible until atomic activation.
  await client.query(
    `update semantic_internal.source_field_allowlist
        set active=false,deactivated_at=now(),
            deactivation_reason='pack_reclassified_or_removed'
      where tenant_id=$1 and connection_id=$2 and connector_id=$3
        and source_schema=$4 and source_table=$5 and pack_version=$6 and active`,
    [job.tenantId,job.connectionId,job.connectorId,contract.schema,contract.table,manifest.packVersion],
  );
  await client.query(
    `update semantic_internal.connector_pack_source_field_snapshot
        set active=false,deactivated_at=now(),
            deactivation_reason='pack_reclassified_or_removed'
      where tenant_id=$1 and connection_id=$2 and connector_id=$3
        and source_schema=$4 and source_table=$5 and pack_version=$6 and active`,
    [job.tenantId,job.connectionId,job.connectorId,contract.schema,contract.table,manifest.packVersion],
  );
  // Materialise explicit candidate tombstones for predecessor fields before
  // reactivating fields governed by this manifest. Activation can therefore
  // prove that every predecessor field was deliberately retained or retired,
  // while a reclassification to unsupported/PII remains safely invisible.
  await client.query(
    `insert into semantic_internal.source_field_allowlist (
       tenant_id,connection_id,connector_id,source_schema,source_table,
       source_field,field_type,disposition,pii_class,authority_concept,
       documented_definition,pack_version,active,deactivated_at,deactivation_reason
     )
     select predecessor.tenant_id,predecessor.connection_id,predecessor.connector_id,
            predecessor.source_schema,predecessor.source_table,predecessor.source_field,
            predecessor.field_type,predecessor.disposition,predecessor.pii_class,
            predecessor.authority_concept,predecessor.documented_definition,$6,
            false,now(),'candidate_pack_reclassified_or_removed'
       from semantic_internal.active_source_field_allowlist predecessor
      where predecessor.tenant_id=$1 and predecessor.connection_id=$2
        and predecessor.connector_id=$3 and predecessor.source_schema=$4
        and predecessor.source_table=$5 and predecessor.pack_version<>$6
     on conflict (tenant_id,connection_id,source_table,source_field)
     do nothing`,
    [job.tenantId,job.connectionId,job.connectorId,contract.schema,contract.table,manifest.packVersion],
  );
  for(const field of contract.fields){
    const declared=coverage.get(field.sourceField);
    if(!declared||declared.disposition!=="governed_extension"||field.type==="jsonb"||!explorationSafePii(declared.pii))continue;
    const target=declared.target??`${contract.schema}.${contract.table}.${field.column}`;
    await client.query(
      `insert into semantic_internal.source_field_allowlist (tenant_id,connection_id,connector_id,source_schema,source_table,source_field,field_type,disposition,pii_class,authority_concept,documented_definition,pack_version,active,deactivated_at,deactivation_reason)
       values ($1,$2,$3,$4,$5,$6,$7,'governed_source_extension',$8,$9,$10,$11,true,null,null)
       on conflict (tenant_id,connection_id,source_table,source_field) do update set connector_id=excluded.connector_id,source_schema=excluded.source_schema,field_type=excluded.field_type,pii_class=excluded.pii_class,authority_concept=excluded.authority_concept,documented_definition=excluded.documented_definition,active=true,deactivated_at=null,deactivation_reason=null`,
      [job.tenantId,job.connectionId,job.connectorId,contract.schema,contract.table,field.column,sourceFieldType(field),sourcePiiClass(field),sourceAuthorityForField(job.connectorId,contract.stream,target),`${manifest.displayName} ${contract.stream}.${field.sourceField}. ${target}.`,manifest.packVersion],
    );
  }
}

function sourceFieldType(field:StagingFieldContract):string{return field.type==="numeric"?"decimal":field.type==="timestamptz"?"timestamp":field.type;}
function explorationSafePii(value:FieldCoverage["pii"]):boolean{return value==="none"||value==="business_contact";}
function sourcePiiClass(field:StagingFieldContract):string{if(field.pii==="none")return"none";if(field.pii==="business_contact")return"business";if(field.pii==="payroll_sensitive")return"payroll";if(field.pii==="free_text_untrusted")return"sensitive_personal";return"customer_contact";}
export function sourceAuthorityForField(connectorId:ConnectorId,stream:string,target:string):SourceAuthorityConcept{
  const streamContract=requireManifest(connectorId).streams.find((candidate)=>candidate.id===stream);
  const authority=streamContract?.authorityConcept;
  if(!authority)throw new Error(`source_authority_unmapped:${connectorId}:${stream}`);
  const expectedSourcePrefix=`${stagingSchema(connectorId)}.${stream}.`;
  if(target.startsWith("source_")&&!target.startsWith(expectedSourcePrefix)){
    throw new Error(`source_authority_target_mismatch:${connectorId}:${stream}:${target}`);
  }
  return authority;
}

type DateBounds=Readonly<{from:string;to:string}>;

function canonicalDateBounds(commands:readonly CanonicalProjectionCommand[],historicalDates:readonly string[]=[]):DateBounds|null{
  const dates:string[]=[...historicalDates];
  for(const command of commands){
    if(command.kind!=="fact"&&command.kind!=="dimension")continue;
    for(const field of ["business_date","snapshot_date"]){
      const value=command.values[field];
      if(typeof value!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(value))continue;
      const parsed=new Date(`${value}T00:00:00.000Z`);
      if(Number.isNaN(parsed.valueOf())||parsed.toISOString().slice(0,10)!==value){
        throw new Error(`canonical_business_date_invalid:${value}`);
      }
      dates.push(value);
    }
  }
  if(!dates.length)return null;
  dates.sort();
  return{from:dates[0]!,to:dates.at(-1)!};
}

async function refreshMarts(client:PostgresQueryClient,tenantId:string,bounds:DateBounds):Promise<void>{
  const finalDay=new Date(`${bounds.to}T00:00:00.000Z`);
  let cursor=new Date(`${bounds.from}T00:00:00.000Z`);
  while(cursor<=finalDay){
    const candidate=new Date(cursor);
    candidate.setUTCDate(candidate.getUTCDate()+400);
    const chunkEnd=candidate<finalDay?candidate:finalDay;
    await client.query(
      "select mart.refresh_tenant_day_marts($1,$2::date,$3::date)",
      [tenantId,dateOnly(cursor),dateOnly(chunkEnd)],
    );
    cursor=new Date(chunkEnd);
    cursor.setUTCDate(cursor.getUTCDate()+1);
  }
}

async function ensureCalendarDays(client:PostgresQueryClient,bounds:DateBounds):Promise<void>{
  await client.query(
    `insert into core.calendar_day (
       calendar_date,calendar_year,calendar_quarter,calendar_month,iso_week,day_of_week,is_weekend
     )
     select day::date,extract(year from day)::smallint,extract(quarter from day)::smallint,
            extract(month from day)::smallint,extract(week from day)::smallint,
            extract(isodow from day)::smallint,extract(isodow from day) in (6,7)
       from generate_series($1::date,$2::date,interval '1 day') as day
     on conflict (calendar_date) do nothing`,
    [bounds.from,bounds.to],
  );
}

async function readinessQualityStatuses(client:PostgresQueryClient,tenantId:string,runId:string):Promise<Readonly<{
  partial:CanonicalTransformResult["qualityStatus"];
  complete:CanonicalTransformResult["qualityStatus"];
}>>{
  const result=await client.query<{
    check_id:string;status:string|null;blocks_partial_readiness:boolean;
  }>(
    `select expectation.check_id,result.status,
            expectation.blocks_partial_readiness
       from quality.check_expectation expectation
       left join quality.check_result result
         on result.tenant_id=$1
        and result.run_id=$2
        and result.check_id=expectation.check_id
        and result.domain=expectation.domain
      where expectation.required
        and expectation.blocks_readiness
      order by expectation.domain,expectation.check_id`,
    [tenantId,runId],
  );
  const evidence=result.rows.map((row):ReadinessQualityEvidence=>({
    checkId:row.check_id,
    status:row.status==="passed"||row.status==="warning"||row.status==="failed"||row.status==="blocked"
      ? row.status
      : null,
    blocksPartialReadiness:row.blocks_partial_readiness,
  }));
  return Object.freeze({
    partial:resolveReadinessQualityStatus(evidence,false),
    complete:resolveReadinessQualityStatus(evidence,true),
  });
}

async function enqueueReadinessProjection(client:PostgresQueryClient,job:CanonicalTransformBatch,domains:readonly string[],backfillComplete:boolean,qualityStatuses:Readonly<{partial:CanonicalTransformResult["qualityStatus"];complete:CanonicalTransformResult["qualityStatus"]}>,readyThrough:string|null,snapshotAt:string):Promise<void>{
  const qualityStatus=backfillComplete?qualityStatuses.complete:qualityStatuses.partial;
  for(const domain of [...new Set(domains)]){
    if(!/^[a-z][a-z0-9_]*$/.test(domain))throw new Error(`canonical_domain_invalid:${domain}`);
    const state=qualityStatus==="blocked"?"blocked":qualityStatus==="failed"?"degraded":backfillComplete?"ready_complete":"ready_partial";
    const progress=backfillComplete?1:0.8;const projectionId=deterministicCanonicalId(["readiness-v1",job.tenantId,job.batchId,domain]);
    await client.query(`insert into semantic_internal.readiness_projection_outbox (tenant_id,projection_id,batch_id,connection_id,domain,state,progress,data_ready_through,backfill_complete,partial_quality_status,complete_quality_status,reason_code,reason_detail,evaluated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) on conflict (tenant_id,projection_id) do nothing`,[job.tenantId,projectionId,job.batchId,job.connectionId,domain,state,progress,readyThrough,backfillComplete,qualityStatuses.partial,qualityStatuses.complete,qualityStatus==="passed"?null:`quality_${qualityStatus}`,qualityStatus==="passed"?null:`Canonical quality outcome: ${qualityStatus}.`,snapshotAt]);
  }
}

async function projectReadiness(client:PostgresQueryClient,row:ReadinessProjectionRow):Promise<void>{
  const connection=await client.query<{connector_key:ConnectorId}>("select connector_key from control_plane.connections where tenant_id=$1 and connection_id=$2",[row.tenant_id,row.connection_id]);
  const connectorId=connection.rows[0]?.connector_key;if(!connectorId)throw new Error("readiness_connection_missing");
  const domainStreams=requireManifest(connectorId).streams.filter((stream)=>stream.productDomains.includes(
    row.domain as (typeof stream.productDomains)[number],
  ));
  const requiredCandidates=domainStreams.filter((stream)=>stream.availability!=="optional").map((stream)=>stream.id);
  const required=requiredCandidates.length?requiredCandidates:domainStreams.map((stream)=>stream.id);
  if(!required.length)throw new Error(`readiness_domain_not_declared:${connectorId}:${row.domain}`);
  const partialQuality=qualityStatus(row.partial_quality_status);
  const completeQuality=qualityStatus(row.complete_quality_status);
  const snapshotResult=await client.query<{snapshot:unknown}>(
    "select control_plane.sync_readiness_inputs($1,$2,$3::text[],$4,$5,$6) snapshot",
    [row.tenant_id,row.connection_id,required,row.batch_id,partialQuality,completeQuality],
  );
  const snapshot=asJsonObject(snapshotResult.rows[0]?.snapshot);
  const streamInputs=Array.isArray(snapshot.streams)
    ? snapshot.streams.map((value)=>asJsonObject(value))
    : [];
  if(streamInputs.length!==required.length)throw new Error("readiness_stream_snapshot_incomplete");
  const generation=Number(snapshot.connectionGeneration);
  if(!Number.isSafeInteger(generation)||generation<1)throw new Error("readiness_generation_invalid");
  const progressiveResult=await client.query<{
    stream:string;status:string;covered_from:string|Date;covered_to:string|Date;
    qualification:string;
  }>(
    `select stream,status,covered_from,covered_to,qualification
       from control_plane.progressive_stream_coverage
      where tenant_id=$1 and connection_id=$2 and connection_generation=$3
        and phase='recent' and stream=any($4::text[])
      order by stream`,
    [row.tenant_id,row.connection_id,generation,required],
  );
  const progressiveActive=progressiveResult.rows.length>0;
  const progressiveQueryable=!progressiveActive||(
    progressiveResult.rows.length===required.length&&
    progressiveResult.rows.every((coverage)=>coverage.status==="queryable"||coverage.status==="superseded")
  );
  const complete=streamInputs.every((stream)=>stream.backfillComplete===true);
  const completedCount=streamInputs.filter((stream)=>stream.backfillComplete===true).length;
  const watermarks=streamInputs.map((stream)=>typeof stream.sourceWatermark==="string"?isoOrNull(stream.sourceWatermark):null).filter((value):value is string=>Boolean(value)).sort();
  const worst=typeof snapshot.worstState==="string"?snapshot.worstState:"blocked";
  if(!["blocked","degraded","incomplete","warning","passed"].includes(worst))throw new Error("readiness_worst_state_invalid");
  const anyQueryable=progressiveQueryable&&streamInputs.some((stream)=>stream.transformStatus==="succeeded");
  const state=worst==="blocked"?"blocked":worst==="degraded"?"degraded":
    worst==="incomplete"?(anyQueryable?"ready_partial":"transforming"):
      complete?"ready_complete":"ready_partial";
  const progress=worst==="blocked"||worst==="degraded"?Number(row.progress):complete?1:
    Math.min(0.95,Math.max(Number(row.progress),completedCount/required.length));
  const progressiveFrom=progressiveQueryable&&progressiveActive
    ? progressiveResult.rows.map((coverage)=>requiredTimestamp(coverage.covered_from,"progressive start")).sort().at(-1)??null:null;
  const progressiveTo=progressiveQueryable&&progressiveActive
    ? progressiveResult.rows.map((coverage)=>requiredTimestamp(coverage.covered_to,"progressive end")).sort()[0]??null:null;
  const dataReadyThrough=progressiveTo??(watermarks.length===required.length?watermarks[0]!:isoOrNull(row.data_ready_through));
  const reasonCode=!progressiveQueryable?"dependency_phase_incomplete":worst==="passed"&&progressiveActive?"covered_range_qualified":worst==="passed"?null:`sync_${worst}`;
  const reasonDetail=!progressiveQueryable
    ? "Recent data remains unavailable until every required page and declared master dependency is transformed."
    : progressiveActive
      ? "Recent data is queryable only inside the disclosed covered range while deeper history continues."
      : worst==="passed"?null:`Worst required-stream outcome for connection generation ${String(snapshot.connectionGeneration)}: ${worst}.`;
  await client.query(`insert into control_plane.readiness (tenant_id,connection_id,domain,state,progress,data_ready_through,backfill_complete,reason_code,reason_detail,evaluated_at,covered_from,covered_to,coverage_qualification,reconciliation_status) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) on conflict (tenant_id,connection_id,domain) do update set state=excluded.state,progress=excluded.progress,data_ready_through=excluded.data_ready_through,backfill_complete=excluded.backfill_complete,reason_code=excluded.reason_code,reason_detail=excluded.reason_detail,evaluated_at=excluded.evaluated_at,covered_from=excluded.covered_from,covered_to=excluded.covered_to,coverage_qualification=excluded.coverage_qualification,reconciliation_status=excluded.reconciliation_status`,[row.tenant_id,row.connection_id,row.domain,state,progress,dataReadyThrough,complete,reasonCode,reasonDetail,isoOrNull(row.evaluated_at),progressiveFrom,progressiveTo,progressiveActive?"Recent data is available only for the disclosed covered range while deeper history continues.":null,progressiveActive?"scheduled":null]);
}
async function projectIdentityReview(client:PostgresQueryClient,row:IdentityReviewProjectionRow):Promise<void>{await client.query(`insert into control_plane.identity_review_tasks (tenant_id,identity_review_task_id,entity_type,status,confidence_band,candidate_links,evidence) values ($1,$2,$3,'proposed',$4,$5::jsonb,$6::jsonb) on conflict (tenant_id,identity_review_task_id) do nothing`,[row.tenant_id,row.task_id,row.entity_type,row.confidence_band,JSON.stringify(row.candidate_links),JSON.stringify(row.evidence)]);}
async function projectPipelineStat(client:PostgresQueryClient,row:PipelineStatProjectionRow):Promise<void>{await client.query(`insert into control_plane.pipeline_stats (tenant_id,snapshot_at,schema_name,table_name,row_count,max_event_at,max_ingested_at,invariant_status,quality_run_id,quality_checked_at,snapshot_table_count,snapshot_inventory_hash) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12) on conflict (tenant_id,snapshot_at,schema_name,table_name) do nothing`,[row.tenant_id,isoOrNull(row.snapshot_at),row.schema_name,row.table_name,Number(row.row_count),isoOrNull(row.max_event_at),isoOrNull(row.max_ingested_at),JSON.stringify(row.invariant_status),row.quality_run_id,isoOrNull(row.quality_checked_at),row.snapshot_table_count,row.snapshot_inventory_hash]);}
async function markPublished(client:PostgresQueryClient,table:string,key:string,ids:readonly string[],publishedAt:string):Promise<void>{if(!new Set(["readiness_projection_outbox","identity_review_projection_outbox","pipeline_table_stats_projection_outbox"]).has(table))throw new Error("projection_table_invalid");if(key!=="projection_id")throw new Error("projection_key_invalid");await client.query(`update semantic_internal.${quoteIdentifier(table)} set published_at=$2 where tenant_id=current_setting('albert.tenant_id') and ${quoteIdentifier(key)}=any($1::text[]) and published_at is null`,[ids,publishedAt]);}

function latestSourceTimestamp(rows:readonly CanonicalStagingRow[]):string|null{const timestamps=rows.flatMap((row)=>{const value=isoOrNull(row.source_updated_at);return value?[value]:[];}).sort();return timestamps.at(-1)??null;}
function asJsonObject(value:unknown):Readonly<Record<string,unknown>>{
  if(value&&typeof value==="object"&&!Array.isArray(value))return value as Readonly<Record<string,unknown>>;
  throw new Error("identity_projection_result_invalid");
}
const identityProjectionDatabaseFailures:Readonly<
  Record<string,Readonly<{code:string;retryable:boolean}>>
>=Object.freeze({
  "22000":Object.freeze({code:"identity_projection_payload_conflict",retryable:false}),
  "22023":Object.freeze({code:"identity_projection_invalid",retryable:false}),
  "23503":Object.freeze({code:"identity_projection_integrity_violation",retryable:false}),
  "23505":Object.freeze({code:"identity_projection_integrity_violation",retryable:false}),
  "40001":Object.freeze({code:"identity_projection_database_conflict",retryable:true}),
  "40P01":Object.freeze({code:"identity_projection_database_conflict",retryable:true}),
  "42501":Object.freeze({code:"identity_projection_permission_denied",retryable:false}),
  "57P01":Object.freeze({code:"identity_projection_database_unavailable",retryable:true}),
  "08000":Object.freeze({code:"identity_projection_database_unavailable",retryable:true}),
  "08003":Object.freeze({code:"identity_projection_database_unavailable",retryable:true}),
  "08006":Object.freeze({code:"identity_projection_database_unavailable",retryable:true}),
  P0002:Object.freeze({code:"identity_projection_candidate_stale",retryable:false}),
});
const trustedIdentityProjectionFailures:Readonly<
  Record<string,Readonly<{retryable:boolean}>>
>=Object.freeze({
  identity_projection_result_invalid:Object.freeze({retryable:false}),
  transform_analytical_capability_invalid:Object.freeze({retryable:false}),
  transform_control_database_role_not_ready:Object.freeze({retryable:false}),
  transform_control_scope_not_established:Object.freeze({retryable:false}),
  transform_scope_not_established:Object.freeze({retryable:false}),
});

/** Persist only bounded operational codes; exception messages may contain source PII or credentials. */
export function identityProjectionFailure(error:unknown):Readonly<{
  code:string;retryable:boolean;retryDelaySeconds:number;
}>{
  const record=error&&typeof error==="object"?error as Readonly<Record<string,unknown>>:{};
  const pgCode=typeof record.code==="string"?record.code:"";
  const databaseFailure=identityProjectionDatabaseFailures[pgCode];
  if(databaseFailure){
    return Object.freeze({
      ...databaseFailure,
      retryDelaySeconds:databaseFailure.retryable?15:1,
    });
  }
  const name=typeof record.name==="string"?record.name:"";
  if(name==="AbortError"||name==="TimeoutError"){
    return Object.freeze({
      code:"identity_projection_timeout",retryable:true,retryDelaySeconds:15,
    });
  }
  if(name==="TypeError"||name==="SyntaxError"){
    return Object.freeze({
      code:"identity_projection_internal_error",retryable:false,retryDelaySeconds:1,
    });
  }
  const candidate=error instanceof Error
    ?error.message.split(":",1)[0]!.trim().toLowerCase()
    :"";
  const trusted=trustedIdentityProjectionFailures[candidate];
  if(trusted){
    return Object.freeze({
      code:candidate,retryable:trusted.retryable,
      retryDelaySeconds:trusted.retryable?15:1,
    });
  }
  return Object.freeze({
    code:"unexpected_identity_projection_failure",retryable:true,retryDelaySeconds:15,
  });
}
function isoOrNull(value:unknown):string|null{if(value===null||value===undefined)return null;const date=new Date(value as string|number|Date);return Number.isNaN(date.valueOf())?null:date.toISOString();}
function qualityStatus(value:unknown):CanonicalTransformResult["qualityStatus"]{if(value==="passed"||value==="warning"||value==="failed"||value==="blocked")return value;throw new Error("readiness_quality_status_invalid");}
function requiredTimestamp(value:unknown,label:string):string{const parsed=isoOrNull(value);if(!parsed)throw new Error(`${label} is invalid`);return parsed;}
function dateOnly(value:string|Date):string{return(value instanceof Date?value.toISOString():String(value)).slice(0,10);}
function dateOnlyOrNull(value:unknown):string|null{
  if(value===null||value===undefined)return null;
  const date=dateOnly(value as string|Date);
  return /^\d{4}-\d{2}-\d{2}$/.test(date)?date:null;
}
function quoteIdentifier(value:string):string{if(!/^[a-z_][a-z0-9_]*$/.test(value))throw new Error(`unsafe_identifier:${value}`);return`"${value}"`;}
