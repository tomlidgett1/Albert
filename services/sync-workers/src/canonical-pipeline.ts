import { createHash } from "node:crypto";
import { deputyManifest } from "../../../connectors/deputy/manifest.js";
import { lightspeedRManifest } from "../../../connectors/lightspeed-r/manifest.js";
import { xeroManifest } from "../../../connectors/xero/manifest.js";
import {
  type SourceAuthorityConcept,
} from "../../../packages/canonical-schema/src/index.js";
import {
  buildStagingContracts,
  type ConnectorId,
  type ConnectorManifest,
  type StagingFieldContract,
  type StagingStreamContract,
} from "../../../packages/connector-sdk/src/index.js";
import type { PostgresQueryClient } from "../../../packages/queue/src/index.js";
import type { TransactionalPostgres } from "./database.js";
import {
  isCanonicalSourceReference,
  type CanonicalEntityType,
  type CanonicalCategoryAssignmentCommand,
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

const manifests = [lightspeedRManifest, xeroManifest, deputyManifest] as const;
const manifestsByConnector = new Map(manifests.map((manifest) => [manifest.id, manifest]));
const stagingContracts = buildStagingContracts(manifests);
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

const defaultAuthority: Readonly<Record<ConnectorId, readonly SourceAuthorityConcept[]>> = {
  "lightspeed-r": ["operational_sales","stock","product_master","customer_master"],
  xero: ["statutory_finance","cash_settlement"],
  deputy: ["planned_shifts","worked_hours"],
};

const defaultFactAuthority: Partial<Record<CanonicalProjectionTable, SourceAuthorityConcept>> = {
  commerce_order: "operational_sales",
  commerce_order_line: "operational_sales",
  commerce_payment: "operational_sales",
  commerce_refund_line: "operational_sales",
  inventory_movement: "stock",
  inventory_balance_snapshot: "stock",
  purchase_order_line: "product_master",
  finance_journal_line: "statutory_finance",
  finance_invoice_line: "statutory_finance",
  finance_bank_transaction: "cash_settlement",
  workforce_shift: "planned_shifts",
  workforce_time_entry: "worked_hours",
  workforce_leave: "worked_hours",
};

export type CanonicalTransformResult = Readonly<{
  batchId: string;
  replayed: boolean;
  stagedRows: number;
  commandCount: number;
  canonicalRows: number;
  metadataRows: number;
  qualityStatus: "passed" | "warning" | "failed" | "blocked";
  dataReadyThrough: string | null;
}>;

export type CanonicalMapperRegistry = Readonly<Record<ConnectorId, CanonicalStreamMapper>>;

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

  async transformBatch(
    job: CanonicalTransformBatch,
    stream: string,
    domains: readonly string[],
    backfillComplete: boolean,
    publishControl = true,
  ): Promise<CanonicalTransformResult> {
    if(job.mappingVersion!==this.mappingVersion){
      throw new Error(`canonical_mapping_version_mismatch:${job.mappingVersion}`);
    }
    const contract = requireStagingContract(job.connectorId, stream);
    const manifest = requireManifest(job.connectorId);
    const mapper = this.mappers[job.connectorId];
    if (!mapper) throw new Error(`canonical_mapper_missing:${job.connectorId}`);
    const mappingContext = await loadMappingContext(this.control, job);

    const result = await this.analytical.transaction(async (client) => {
      await establishTransformScope(client, job.tenantId);
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`canonical:${job.tenantId}`]);
      const existing = await client.query<TransformCommitRow>(
        `select staged_rows, command_count, canonical_rows, metadata_rows, quality_status, data_ready_through
           from semantic_internal.canonical_transform_commits
          where tenant_id=$1 and batch_id=$2 and mapping_version=$3
          for update`,
        [job.tenantId, job.batchId, this.mappingVersion],
      );
      if (existing.rows[0]) return transformResult(job.batchId, true, existing.rows[0]);

      await assertLandingCommit(client, job, stream, this.mappingVersion);
      await publishAuthorityDefaults(client, job, this.clock().toISOString());
      const rows = await loadStagingRows(client, contract, job, this.mappingVersion);
      const commands = rows.flatMap((row) => {
        assertStagingLineage(row, job, this.mappingVersion);
        const mapped = mapper(stream, row, mappingContext);
        if (!Array.isArray(mapped) || mapped.length === 0) {
          throw new Error(`canonical_mapper_empty:${job.connectorId}:${stream}:${row.source_record_id}`);
        }
        return mapped.map((command) => ({ command, row }));
      });
      commands.sort((left, right) => commandRank(left.command) - commandRank(right.command));

      let canonicalRows = 0;
      let metadataRows = 0;
      const appliedCommands: CanonicalProjectionCommand[] = [];
      const previouslyMaterializedDates:string[]=[];
      for (const item of commands) {
        if (item.command.kind === "dimension" || item.command.kind === "fact") {
          const outcome=await executeUpsert(client, job, item.row, item.command);
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

      await publishCapabilities(client, job, manifest, stream, rows);
      await publishSourceAllowlist(client, job, manifest, contract);
      await generateIdentitySuggestions(client, job.tenantId);
      const readyThrough = latestSourceTimestamp(rows);
      const snapshotAt = this.clock().toISOString();
      await client.query("select quality.run_all_invariants($1,$2)", [job.tenantId, job.syncRunId]);
      const dateBounds = canonicalDateBounds(appliedCommands,previouslyMaterializedDates);
      if (dateBounds) {
        await ensureCalendarDays(client,dateBounds);
        await refreshMarts(client, job.tenantId, dateBounds);
      }
      await client.query(
        "select quality.snapshot_all_pipeline_stats($1,$2::timestamptz,$3::text[],$4::jsonb)",
        [job.tenantId, snapshotAt, [...new Set(domains)], JSON.stringify({ [job.connectionId]: readyThrough })],
      );
      const qualityStatus = await overallQualityStatus(client, job.tenantId, job.syncRunId);
      await enqueueReadinessProjection(client, job, domains, backfillComplete, qualityStatus, readyThrough, snapshotAt);
      await client.query(
        `insert into semantic_internal.canonical_transform_commits (
           tenant_id,batch_id,sync_run_id,connection_id,connector_id,stream,mapping_version,
           staged_rows,command_count,canonical_rows,metadata_rows,quality_status,data_ready_through,completed_at
         ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now())`,
        [job.tenantId,job.batchId,job.syncRunId,job.connectionId,job.connectorId,stream,this.mappingVersion,rows.length,commands.length,canonicalRows,metadataRows,qualityStatus,readyThrough],
      );
      return {
        batchId:job.batchId,replayed:false,stagedRows:rows.length,commandCount:commands.length,
        canonicalRows,metadataRows,qualityStatus,dataReadyThrough:readyThrough,
      } satisfies CanonicalTransformResult;
    });

    if(publishControl){
      await this.publishPendingControlProjections(job.tenantId, job.batchId);
      await this.refreshDossier(job.tenantId);
    }
    return result;
  }

  async publishPendingControlProjections(tenantId: string, batchId?: string): Promise<void> {
    const pending = await this.analytical.transaction(async (client) => {
      await establishTransformScope(client, tenantId);
      const filter = batchId ? " and batch_id=$2" : "";
      const parameters = batchId ? [tenantId,batchId] : [tenantId];
      const readiness = await client.query<ReadinessProjectionRow>(
        `select * from semantic_internal.readiness_projection_outbox where tenant_id=$1 and published_at is null${filter} order by created_at`,
        parameters,
      );
      const reviews = await client.query<IdentityReviewProjectionRow>(
        "select * from semantic_internal.identity_review_projection_outbox where tenant_id=$1 and published_at is null order by created_at",
        [tenantId],
      );
      const stats = await client.query<PipelineStatProjectionRow>(
        "select * from semantic_internal.pipeline_table_stats_projection_outbox where tenant_id=$1 and published_at is null order by snapshot_at,schema_name,table_name",
        [tenantId],
      );
      return { readiness: readiness.rows, reviews: reviews.rows, stats: stats.rows };
    });
    if (!pending.readiness.length && !pending.reviews.length && !pending.stats.length) return;

    await this.control.transaction(async (client) => {
      await establishControlTransformScope(client,tenantId);
      for (const row of pending.readiness) await projectReadiness(client, row);
      for (const row of pending.reviews) await projectIdentityReview(client, row);
      for (const row of pending.stats) await projectPipelineStat(client, row);
    });
    await this.analytical.transaction(async (client) => {
      await establishTransformScope(client, tenantId);
      const publishedAt = this.clock().toISOString();
      if (pending.readiness.length) await markPublished(client,"readiness_projection_outbox","projection_id",pending.readiness.map((row)=>row.projection_id),publishedAt);
      if (pending.reviews.length) await markPublished(client,"identity_review_projection_outbox","projection_id",pending.reviews.map((row)=>row.projection_id),publishedAt);
      if (pending.stats.length) await markPublished(client,"pipeline_table_stats_projection_outbox","projection_id",pending.stats.map((row)=>row.projection_id),publishedAt);
    });
  }

  async snapshotAllTenants():Promise<number>{
    const tenants=await this.control.transaction(async(client)=>{
      await establishControlWorkerRole(client);
      return client.query<{tenant_id:string;source_watermarks:Record<string,string|null>}>(
        "select tenant_id,source_watermarks from control_plane.canonical_transform_tenant_watermarks()",
      );
    });
    const snapshotAt=this.clock().toISOString();
    for(const tenant of tenants.rows){
      await this.analytical.transaction(async(client)=>{
        await establishTransformScope(client,tenant.tenant_id);
        await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))",[`canonical:${tenant.tenant_id}`]);
        await client.query("select quality.snapshot_all_pipeline_stats($1,$2::timestamptz,$3::text[],$4::jsonb)",[tenant.tenant_id,snapshotAt,[],JSON.stringify(tenant.source_watermarks)]);
      });
      await this.publishPendingControlProjections(tenant.tenant_id);
      await this.refreshDossier(tenant.tenant_id);
    }
    return tenants.rows.length;
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
        const applied=await this.analytical.transaction(async(client)=>{
          await establishTransformScope(client,claim.tenant_id);
          return client.query<{result:unknown}>(
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
        });
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

  async refreshDossier(tenantId:string):Promise<boolean>{
    const timezoneResult=await this.control.transaction(async(client)=>{
      await establishControlTransformScope(client,tenantId);
      return client.query<{timezone:string|null}>(
        `select overlay->>'timezone' as timezone
           from control_plane.tenant_overlays
          where tenant_id=$1 and status='published'
          order by version desc limit 1`,
        [tenantId],
      );
    });
    const timezone=timezoneResult.rows[0]?.timezone;
    if(!timezone)throw new Error("dossier_timezone_missing");
    try{new Intl.DateTimeFormat("en-AU",{timeZone:timezone}).format(new Date(0));}
    catch{throw new Error("dossier_timezone_invalid");}

    const source=await this.analytical.transaction(async(client)=>{
      await establishTransformScope(client,tenantId);
      return client.query<DossierSourceRow>(
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
         ), xero_summary as (
           select name,base_currency,sales_tax_basis,tax_number,
                  coalesce(updated_date_utc,source_updated_at,ingested_at) as observed_at
             from source_xero.organisation
            where tenant_id=$1 and not tombstone
            order by coalesce(updated_date_utc,source_updated_at,ingested_at) desc,namespaced_source_key
            limit 1
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
                coalesce(xero_summary.base_currency,entity_summary.base_currency) as base_currency,
                greatest(entity_summary.observed_at,xero_summary.observed_at) as entity_observed_at,
                xero_summary.sales_tax_basis,xero_summary.tax_number,
                xero_summary.observed_at as xero_observed_at,
                sales_summary.sale_count,sales_summary.observed_at as sales_observed_at,
                product_summary.product_count,product_summary.observed_at as products_observed_at,
                trading_hours.hours,seasonality.strongest_month,seasonality.quietest_month,
                seasonality.observed_months
           from location_summary cross join channel_summary cross join entity_summary
           cross join sales_summary cross join product_summary cross join trading_hours
           cross join seasonality left join xero_summary on true`,
        [tenantId,timezone],
      );
    });
    const draft=buildDossierDraft(source.rows[0]);
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

type TransformCommitRow={staged_rows:string|number;command_count:string|number;canonical_rows:string|number;metadata_rows:string|number;quality_status:CanonicalTransformResult["qualityStatus"];data_ready_through:string|Date|null};
type ReadinessProjectionRow={projection_id:string;tenant_id:string;batch_id:string;connection_id:string;domain:string;state:string;progress:string|number;data_ready_through:string|Date|null;backfill_complete:boolean;reason_code:string|null;reason_detail:string|null;evaluated_at:string|Date};
type IdentityReviewProjectionRow={projection_id:string;tenant_id:string;task_id:string;entity_type:string;confidence_band:string;candidate_links:unknown;evidence:unknown};
type IdentityDecisionProjectionRow={
  tenant_id:string;projection_id:string;decision_id:string;identity_review_task_id:string;
  decision_version:string|number;decision:"accepted"|"rejected"|"proposed";
  entity_type:CanonicalEntityType;candidate_links:unknown;decided_by:string;
  decided_at:string|Date;attempt_count:string|number;lease_token:string;lease_expires_at:string|Date;
};
type IdentityDecisionProjectionMetricRow={status:string;job_count:string|number;oldest_age_seconds:string|number};
export type IdentityDecisionProjectionMetric=Readonly<{status:string;jobCount:number;oldestAgeSeconds:number}>;
type PipelineStatProjectionRow={projection_id:string;tenant_id:string;snapshot_at:string|Date;schema_name:string;table_name:string;row_count:string|number;max_event_at:string|Date|null;max_ingested_at:string|Date|null;invariant_status:unknown};
type DossierSourceRow={
  location_names:string[]|null;locations_observed_at:string|Date|null;
  channel_names:string[]|null;channels_observed_at:string|Date|null;
  legal_entity_name:string|null;base_currency:string|null;entity_observed_at:string|Date|null;
  sales_tax_basis:string|null;tax_number:string|null;xero_observed_at:string|Date|null;
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

export function buildDossierDraft(row:DossierSourceRow|undefined):DossierDraft|null{
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
    "Xero Organisation settings and canonical legal entity",
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

  const salesTaxBasis=row.sales_tax_basis?.trim().toUpperCase()??"";
  const accountingBasis=salesTaxBasis.includes("CASH")
    ? "Cash"
    : salesTaxBasis.includes("ACCRUAL")?"Accrual":null;
  add("accounting_basis",accountingBasis,"Xero Organisation settings",row.xero_observed_at,1,"source_reported");
  const gstRegistration=salesTaxBasis==="NONE"
    ? "Not registered"
    : salesTaxBasis||row.tax_number?.trim()?"Registered":null;
  add(
    "gst_registration",
    gstRegistration,
    "Xero Organisation tax settings",
    row.xero_observed_at,
    salesTaxBasis?0.98:0.85,
    salesTaxBasis?"source_reported":"inferred",
  );

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

function transformResult(batchId:string,replayed:boolean,row:TransformCommitRow):CanonicalTransformResult{return{batchId,replayed,stagedRows:Number(row.staged_rows),commandCount:Number(row.command_count),canonicalRows:Number(row.canonical_rows),metadataRows:Number(row.metadata_rows),qualityStatus:row.quality_status,dataReadyThrough:row.data_ready_through?new Date(row.data_ready_through).toISOString():null};}

async function establishTransformScope(client:PostgresQueryClient,tenantId:string):Promise<void>{
  await client.query("set local role transform_rw");
  await client.query("select set_config('albert.tenant_id',$1,true)",[tenantId]);
  const role=await client.query<{role_name:string;tenant_scope:string|null}>("select current_user as role_name,current_setting('albert.tenant_id',true) as tenant_scope");
  if(role.rows[0]?.role_name!=="transform_rw"||role.rows[0]?.tenant_scope!==tenantId)throw new Error("transform_scope_not_established");
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

function requireManifest(connectorId:ConnectorId):ConnectorManifest{const manifest=manifestsByConnector.get(connectorId);if(!manifest)throw new Error(`canonical_manifest_missing:${connectorId}`);return manifest;}
function requireStagingContract(connectorId:ConnectorId,stream:string):StagingStreamContract{const contract=stagingByStream.get(`${connectorId}:${stream}`);if(!contract)throw new Error(`canonical_staging_contract_missing:${connectorId}:${stream}`);return contract;}

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

async function executeUpsert(client:PostgresQueryClient,job:CanonicalTransformBatch,row:CanonicalStagingRow,command:CanonicalUpsertCommand):Promise<CanonicalUpsertOutcome>{
  const table=tableColumns[command.table];
  if(!table||command.table==="calendar_day")throw new Error(`canonical_table_unsupported:${command.table}`);
  if((command.kind==="fact")!==table.fact)throw new Error(`canonical_command_kind_mismatch:${command.table}`);
  if(!command.sourceObjectType.trim()||!command.sourceRecordId.trim())throw new Error("canonical_source_identity_missing");
  const entries=Object.entries(command.values);
  if(!entries.length)throw new Error(`canonical_values_empty:${command.table}`);
  for(const [column] of entries)if(!table.columns.has(column))throw new Error(`canonical_field_unsupported:${command.table}.${column}`);
  if(command.tombstone&&table.fact&&!entries.some(([column])=>column==="voided"||column==="status"||column==="order_status")){
    throw new Error(`canonical_tombstone_unrepresented:${command.table}`);
  }
  if(table.fact)await assertAuthority(client,job,command);
  const id=canonicalId(job.tenantId,command.table,job.connectionId,command.sourceObjectType,command.sourceRecordId);
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
  const resolved:Record<string,unknown>={};
  for(const [column,value] of entries)resolved[column]=await resolveValue(client,job,value);
  const values:Record<string,unknown>={tenant_id:job.tenantId,id,...resolved,sync_run_id:row.sync_run_id};
  if(table.fact){values.primary_connection_id=job.connectionId;values.primary_source_record_id=command.sourceRecordId;values.source_updated_at=isoOrNull(row.source_updated_at);}
  const columns=Object.keys(values);const parameters=Object.values(values);
  const mutable=columns.filter((column)=>!['tenant_id','id','primary_connection_id','primary_source_record_id','sync_run_id'].includes(column));
  const conflict=mutable.length?`do update set ${mutable.map((column)=>`${quoteIdentifier(column)}=excluded.${quoteIdentifier(column)}`).join(",")},updated_at=now()`:"do nothing";
  await client.query(`insert into core.${quoteIdentifier(command.table)} (${columns.map(quoteIdentifier).join(",")}) values (${columns.map((_,index)=>`$${index+1}`).join(",")}) on conflict (tenant_id,id) ${conflict}`,parameters);
  if(command.entityType)await upsertDirectEntityLink(client,job,row,command,id);
  if(command.table==="commerce_order")await upsertOrderObservation(client,job,row,command,id);
  if(command.table==="commerce_order_line")await upsertOrderLineObservation(client,job,row,command,id);
  return{applied:true,previousDates};
}

async function resolveValue(client:PostgresQueryClient,job:CanonicalTransformBatch,value:unknown):Promise<unknown>{
  if(!isCanonicalSourceReference(value))return value;
  const ref=value.sourceRef;const connectionId=ref.connectionId??job.connectionId;
  if(ref.lookup?.kind==="xero_gl_account_code"){
    if(ref.table!=="gl_account"||connectionId!==job.connectionId)throw new Error("canonical_natural_key_scope_invalid");
    const matched=await client.query<{source_record_id:string;source_object_type:string}>(
      `select account.source_record_id,source.source_object_type
         from source_xero.accounts account
         join ingestion.source_records source on source.tenant_id=account.tenant_id and source.namespaced_source_key=account.namespaced_source_key
        where account.tenant_id=$1 and account.connection_id=$2 and account.code=$3 and not account.tombstone
        order by account.source_updated_at desc nulls last limit 2`,
      [job.tenantId,connectionId,ref.lookup.value],
    );
    if(matched.rows.length===1){
      const row=matched.rows[0]!;const id=canonicalId(job.tenantId,"gl_account",connectionId,row.source_object_type,row.source_record_id);
      const exists=await client.query<{present:number}>("select 1 as present from core.gl_account where tenant_id=$1 and id=$2",[job.tenantId,id]);
      if(exists.rows[0])return id;
      if(ref.nullable)return null;
      throw new Error(`canonical_reference_missing:gl_account:${ref.lookup.value}`);
    }
    if(ref.nullable&&matched.rows.length===0)return null;
    throw new Error(matched.rows.length?`canonical_natural_key_ambiguous:gl_account:${ref.lookup.value}`:`canonical_natural_key_missing:gl_account:${ref.lookup.value}`);
  }
  if(!ref.sourceRecordId?.trim()){if(ref.nullable)return null;throw new Error("canonical_reference_id_missing");}
  // Facts always retain the source-owned canonical foreign key. Identity
  // decisions are an effective-dated query-time graph; materialising a merged
  // ID here would make an undo unable to separate facts written after merge.
  const id=canonicalId(job.tenantId,ref.table,connectionId,ref.sourceObjectType,ref.sourceRecordId);
  const target=tableColumns[ref.table];if(!target||ref.table==="calendar_day")throw new Error(`canonical_reference_table_unsupported:${ref.table}`);
  const exists=await client.query<{present:number}>(`select 1 as present from core.${quoteIdentifier(ref.table)} where tenant_id=$1 and id=$2`,[job.tenantId,id]);
  if(exists.rows[0])return id;
  if(ref.nullable)return null;
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
      job.batchId,row.sync_run_id,job.connectionId,sourceObjectType,sourceRecordId,row.mapping_version,
    ],
  );
  return Boolean(claimed.rows[0]);
}

async function assertAuthority(client:PostgresQueryClient,job:CanonicalTransformBatch,command:CanonicalUpsertCommand):Promise<void>{
  const concept=command.authorityConcept??defaultFactAuthority[command.table];
  if(!concept)throw new Error(`canonical_authority_undefined:${command.table}`);
  const result=await client.query<{authoritative_connection_id:string}>(
    `select authoritative_connection_id from core.source_authority
      where tenant_id=$1 and concept=$2 and scope_type='tenant' and scope_id=$1 and effective_to is null`,
    [job.tenantId,concept],
  );
  if(result.rows.length!==1||result.rows[0]?.authoritative_connection_id!==job.connectionId)throw new Error(`canonical_non_authoritative:${concept}:${job.connectionId}`);
}

async function publishAuthorityDefaults(client:PostgresQueryClient,job:CanonicalTransformBatch,effectiveFrom:string):Promise<void>{
  for(const concept of defaultAuthority[job.connectorId]){
    const id=deterministicCanonicalId(["authority-v1",job.tenantId,concept,"tenant",job.tenantId]);
    await client.query(
      `insert into core.source_authority (tenant_id,id,concept,scope_type,scope_id,authoritative_connection_id,effective_from,sync_run_id)
       values ($1,$2,$3,'tenant',$1,$4,$5,$6) on conflict do nothing`,
      [job.tenantId,id,concept,job.connectionId,effectiveFrom,job.syncRunId],
    );
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
  await client.query(
    `insert into semantic_internal.identity_observation (tenant_id,observation_id,entity_type,connection_id,source_object_type,source_record_id,external_id_digest,deterministic_key_digests,normalized_name_digest,corroborating_scope_digest,evidence_refs,linkable,sync_run_id,source_updated_at,active)
     values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11::jsonb,$12,$13,$14,$15)
     on conflict (tenant_id,observation_id) do update set external_id_digest=excluded.external_id_digest,deterministic_key_digests=excluded.deterministic_key_digests,normalized_name_digest=excluded.normalized_name_digest,corroborating_scope_digest=excluded.corroborating_scope_digest,evidence_refs=excluded.evidence_refs,linkable=excluded.linkable,sync_run_id=excluded.sync_run_id,source_updated_at=excluded.source_updated_at,active=excluded.active`,
    [job.tenantId,observationId,command.entityType,job.connectionId,command.sourceObjectType,command.sourceRecordId,command.externalId?identityDigest(job.tenantId,`${job.connectorId}:${command.sourceObjectType}:${command.externalId}`):null,JSON.stringify(keys),command.normalizedName?identityDigest(job.tenantId,command.normalizedName):null,command.corroboratingScope?identityDigest(job.tenantId,`${job.connectorId}:${command.corroboratingScope}`):null,JSON.stringify(evidenceRefs),command.evidenceOnly!==true,row.sync_run_id,isoOrNull(row.source_updated_at),!row.tombstone],
  );
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
  await client.query("select semantic_internal.generate_identity_review_candidates($1)",[tenantId]);
}

async function publishCapabilities(client:PostgresQueryClient,job:CanonicalTransformBatch,manifest:ConnectorManifest,stream:string,rows:readonly CanonicalStagingRow[]):Promise<void>{
  const through=latestSourceTimestamp(rows);
  for(const [capability,declared] of Object.entries(manifest.capabilities)){
    const relevant=capabilityRelevantToStream(job.connectorId,capability,stream);
    if(!relevant)continue;
    const available=declared==="full"||declared==="partial";
    await client.query(
      `insert into semantic_internal.tenant_capability (tenant_id,capability,source_key,connection_id,connector_id,available,reason_code,pack_version,source_watermark,evaluated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
       on conflict (tenant_id,capability,source_key) do update set available=excluded.available,reason_code=excluded.reason_code,pack_version=excluded.pack_version,source_watermark=greatest(semantic_internal.tenant_capability.source_watermark,excluded.source_watermark),evaluated_at=now()`,
      [job.tenantId,capability,`${job.connectorId}:${job.connectionId}`,job.connectionId,job.connectorId,available,available?(declared==="partial"?"partial_coverage":null):declared==="unknown"?"live_probe_required":"connector_unavailable",manifest.packVersion,through],
    );
  }
}

function capabilityRelevantToStream(connectorId:ConnectorId,capability:string,stream:string):boolean{
  const exact:Record<string,readonly string[]>={
    "lightspeed-r:commerce.order_lines":["sales"],"lightspeed-r:commerce.order_lines.worker_attribution":["sales","employees"],"lightspeed-r:commerce.order_lines.unit_cost":["sales","items"],"lightspeed-r:inventory.current_stock":["item_shops"],"lightspeed-r:inventory.historical_movements":["inventory_logs"],
    "xero:finance.settings":["organisation","accounts","tax_rates"],"xero:finance.invoices":["invoices","credit_notes"],"xero:finance.payments":["payments"],"xero:finance.bank_transactions":["bank_transactions"],"xero:finance.general_ledger":["journals","manual_journals"],
    "deputy:workforce.rosters":["rosters"],"deputy:workforce.timesheets":["timesheets"],"deputy:workforce.timesheets.cost":["timesheets"],"deputy:workforce.leave":["leave"],
  };
  const streams=exact[`${connectorId}:${capability}`];return streams?streams.includes(stream):capability.startsWith("source.webhooks")&&stream===requireManifest(connectorId).streams[0]?.id;
}

async function publishSourceAllowlist(client:PostgresQueryClient,job:CanonicalTransformBatch,manifest:ConnectorManifest,contract:StagingStreamContract):Promise<void>{
  const coverage=new Map(manifest.fieldCoverage.filter((field)=>field.stream===contract.stream).map((field)=>[field.field,field]));
  for(const field of contract.fields){
    const declared=coverage.get(field.sourceField);
    if(!declared||declared.disposition!=="governed_extension"||field.type==="jsonb")continue;
    const target=declared.target??`${contract.schema}.${contract.table}.${field.column}`;
    await client.query(
      `insert into semantic_internal.source_field_allowlist (tenant_id,connection_id,connector_id,source_schema,source_table,source_field,field_type,disposition,pii_class,authority_concept,documented_definition,pack_version,active)
       values ($1,$2,$3,$4,$5,$6,$7,'governed_source_extension',$8,$9,$10,$11,true)
       on conflict (tenant_id,connection_id,source_table,source_field) do update set field_type=excluded.field_type,pii_class=excluded.pii_class,authority_concept=excluded.authority_concept,documented_definition=excluded.documented_definition,pack_version=excluded.pack_version,active=true`,
      [job.tenantId,job.connectionId,job.connectorId,contract.schema,contract.table,field.column,sourceFieldType(field),sourcePiiClass(field),sourceAuthorityForField(job.connectorId,target),`${manifest.displayName} ${contract.stream}.${field.sourceField}. ${target}.`,manifest.packVersion],
    );
  }
}

function sourceFieldType(field:StagingFieldContract):string{return field.type==="numeric"?"decimal":field.type==="timestamptz"?"timestamp":field.type;}
function sourcePiiClass(field:StagingFieldContract):string{if(field.pii==="none")return"none";if(field.pii==="business_contact")return"business";if(field.pii==="payroll_sensitive")return"payroll";if(field.pii==="free_text_untrusted")return"sensitive_personal";return"customer_contact";}
function sourceAuthorityForField(connectorId:ConnectorId,target:string):SourceAuthorityConcept|undefined{if(target.includes("inventory"))return"stock";if(target.includes("workforce_shift"))return"planned_shifts";if(target.includes("workforce_"))return"worked_hours";if(target.includes("finance_")||connectorId==="xero")return"statutory_finance";if(target.includes("product"))return"product_master";if(target.includes("customer"))return"customer_master";if(target.includes("commerce"))return"operational_sales";return undefined;}

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

async function overallQualityStatus(client:PostgresQueryClient,tenantId:string,runId:string):Promise<CanonicalTransformResult["qualityStatus"]>{
  const result=await client.query<{status:string}>(`select case when bool_or(status='blocked') then 'blocked' when bool_or(status='failed') then 'failed' when bool_or(status='warning') then 'warning' else 'passed' end status from quality.check_result where tenant_id=$1 and run_id=$2`,[tenantId,runId]);
  const status=result.rows[0]?.status;if(status==="passed"||status==="warning"||status==="failed"||status==="blocked")return status;return"blocked";
}

async function enqueueReadinessProjection(client:PostgresQueryClient,job:CanonicalTransformBatch,domains:readonly string[],backfillComplete:boolean,qualityStatus:CanonicalTransformResult["qualityStatus"],readyThrough:string|null,snapshotAt:string):Promise<void>{
  for(const domain of [...new Set(domains)]){
    if(!/^[a-z][a-z0-9_]*$/.test(domain))throw new Error(`canonical_domain_invalid:${domain}`);
    const state=qualityStatus==="blocked"?"blocked":qualityStatus==="failed"?"degraded":backfillComplete?"ready_complete":"ready_partial";
    const progress=backfillComplete?1:0.8;const projectionId=deterministicCanonicalId(["readiness-v1",job.tenantId,job.batchId,domain]);
    await client.query(`insert into semantic_internal.readiness_projection_outbox (tenant_id,projection_id,batch_id,connection_id,domain,state,progress,data_ready_through,backfill_complete,reason_code,reason_detail,evaluated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict (tenant_id,projection_id) do nothing`,[job.tenantId,projectionId,job.batchId,job.connectionId,domain,state,progress,readyThrough,backfillComplete,qualityStatus==="passed"?null:`quality_${qualityStatus}`,qualityStatus==="passed"?null:`Canonical quality outcome: ${qualityStatus}.`,snapshotAt]);
  }
}

async function projectReadiness(client:PostgresQueryClient,row:ReadinessProjectionRow):Promise<void>{
  const connection=await client.query<{connector_key:ConnectorId}>("select connector_key from control_plane.connections where tenant_id=$1 and connection_id=$2",[row.tenant_id,row.connection_id]);
  const connectorId=connection.rows[0]?.connector_key;if(!connectorId)throw new Error("readiness_connection_missing");
  const required=requireManifest(connectorId).streams.filter((stream)=>stream.canonicalTargets.includes(row.domain)).map((stream)=>stream.id);
  if(!required.length)throw new Error(`readiness_domain_not_declared:${connectorId}:${row.domain}`);
  const cursors=await client.query<{stream:string;backfill_complete:boolean;source_watermark:string|Date|null}>(
    "select stream,backfill_complete,source_watermark from control_plane.stream_cursors where tenant_id=$1 and connection_id=$2 and stream=any($3::text[])",
    [row.tenant_id,row.connection_id,required],
  );
  const byStream=new Map(cursors.rows.map((cursor)=>[cursor.stream,cursor]));
  const complete=required.every((stream)=>byStream.get(stream)?.backfill_complete===true);
  const completedCount=required.filter((stream)=>byStream.get(stream)?.backfill_complete===true).length;
  const watermarks=required.map((stream)=>isoOrNull(byStream.get(stream)?.source_watermark)).filter((value):value is string=>Boolean(value)).sort();
  const failed=row.state==="blocked"||row.state==="degraded";
  const state=failed?row.state:complete?"ready_complete":"ready_partial";
  const progress=failed?Number(row.progress):complete?1:Math.min(0.95,Math.max(Number(row.progress),completedCount/required.length));
  const dataReadyThrough=watermarks.length===required.length?watermarks[0]!:isoOrNull(row.data_ready_through);
  await client.query(`insert into control_plane.readiness (tenant_id,connection_id,domain,state,progress,data_ready_through,backfill_complete,reason_code,reason_detail,evaluated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (tenant_id,connection_id,domain) do update set state=excluded.state,progress=excluded.progress,data_ready_through=excluded.data_ready_through,backfill_complete=excluded.backfill_complete,reason_code=excluded.reason_code,reason_detail=excluded.reason_detail,evaluated_at=excluded.evaluated_at`,[row.tenant_id,row.connection_id,row.domain,state,progress,dataReadyThrough,complete,row.reason_code,row.reason_detail,isoOrNull(row.evaluated_at)]);
}
async function projectIdentityReview(client:PostgresQueryClient,row:IdentityReviewProjectionRow):Promise<void>{await client.query(`insert into control_plane.identity_review_tasks (tenant_id,identity_review_task_id,entity_type,status,confidence_band,candidate_links,evidence) values ($1,$2,$3,'proposed',$4,$5::jsonb,$6::jsonb) on conflict (tenant_id,identity_review_task_id) do nothing`,[row.tenant_id,row.task_id,row.entity_type,row.confidence_band,JSON.stringify(row.candidate_links),JSON.stringify(row.evidence)]);}
async function projectPipelineStat(client:PostgresQueryClient,row:PipelineStatProjectionRow):Promise<void>{await client.query(`insert into control_plane.pipeline_stats (tenant_id,snapshot_at,schema_name,table_name,row_count,max_event_at,max_ingested_at,invariant_status) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) on conflict (tenant_id,snapshot_at,schema_name,table_name) do nothing`,[row.tenant_id,isoOrNull(row.snapshot_at),row.schema_name,row.table_name,Number(row.row_count),isoOrNull(row.max_event_at),isoOrNull(row.max_ingested_at),JSON.stringify(row.invariant_status)]);}
async function markPublished(client:PostgresQueryClient,table:string,key:string,ids:readonly string[],publishedAt:string):Promise<void>{if(!new Set(["readiness_projection_outbox","identity_review_projection_outbox","pipeline_table_stats_projection_outbox"]).has(table))throw new Error("projection_table_invalid");if(key!=="projection_id")throw new Error("projection_key_invalid");await client.query(`update semantic_internal.${quoteIdentifier(table)} set published_at=$2 where tenant_id=current_setting('albert.tenant_id') and ${quoteIdentifier(key)}=any($1::text[]) and published_at is null`,[ids,publishedAt]);}

function latestSourceTimestamp(rows:readonly CanonicalStagingRow[]):string|null{const timestamps=rows.flatMap((row)=>{const value=isoOrNull(row.source_updated_at);return value?[value]:[];}).sort();return timestamps.at(-1)??null;}
function asJsonObject(value:unknown):Readonly<Record<string,unknown>>{
  if(value&&typeof value==="object"&&!Array.isArray(value))return value as Readonly<Record<string,unknown>>;
  throw new Error("identity_projection_result_invalid");
}
function identityProjectionFailure(error:unknown):Readonly<{
  code:string;detail:string;retryable:boolean;retryDelaySeconds:number;
}>{
  const record=error&&typeof error==="object"?error as Readonly<Record<string,unknown>>:{};
  const pgCode=typeof record.code==="string"?record.code:"";
  const message=(error instanceof Error?error.message:"identity projection failed")
    .replace(/[\u0000-\u001f\u007f]/g," ").slice(0,500);
  const permanent=new Set(["22000","22023","P0002"]).has(pgCode)
    || /(invalid|payload changed|candidate .*missing|no longer active|baseline is missing|review card is stale|source-owned link)/iu.test(message);
  const normalized=(message.split(":",1)[0]||"identity_projection_failed")
    .replace(/[^a-z0-9_.-]/giu,"_").toLowerCase().slice(0,120);
  return Object.freeze({
    code:normalized||"identity_projection_failed",
    detail:message,
    retryable:!permanent,
    retryDelaySeconds:15,
  });
}
function isoOrNull(value:unknown):string|null{if(value===null||value===undefined)return null;const date=new Date(value as string|number|Date);return Number.isNaN(date.valueOf())?null:date.toISOString();}
function dateOnly(value:string|Date):string{return(value instanceof Date?value.toISOString():String(value)).slice(0,10);}
function dateOnlyOrNull(value:unknown):string|null{
  if(value===null||value===undefined)return null;
  const date=dateOnly(value as string|Date);
  return /^\d{4}-\d{2}-\d{2}$/.test(date)?date:null;
}
function quoteIdentifier(value:string):string{if(!/^[a-z_][a-z0-9_]*$/.test(value))throw new Error(`unsafe_identifier:${value}`);return`"${value}"`;}
