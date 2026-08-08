import { ulid } from "ulid";
import { isAllowlistedRememberedPreference } from "../../../packages/agent/src/semantic-tools.js";
import type { SemanticRegistry } from "../../../packages/semantic-registry/src/index.js";
import type {
  PgClientLike,
  PgPoolLike,
  SemanticAnalyticalCapabilityIssuer,
} from "./database.js";
import { serializePgVector,type EmbeddingProvider } from "./embeddings.js";
import {
  assertSourceFieldIsAccessible,
  sourceAuthorityConceptsForRole,
  sourceFieldIsAccessible,
} from "./source-access-policy.js";
import type {
  CatalogueSearchHit,
  CatalogueSearchProvider,
  DataHealthProvider,
  DataHealthSnapshot,
  SemanticAuditRecord,
  SemanticAuditSink,
  SemanticReadDatabase,
  SemanticResultCache,
  SemanticToolResponse,
  SourceCatalogueProvider,
  SourceField,
  SourceFieldCatalogueReference,
  TenantPreferenceStore,
  TenantSemanticContext,
  TenantSemanticContextProvider,
  TrustedToolContext,
} from "./types.js";
import type { PostgresSemanticPromotionRelay } from "./promotion-relay.js";

type Row=Readonly<Record<string,unknown>>;

export class PostgresTenantSemanticContextProvider implements TenantSemanticContextProvider {
  constructor(
    private readonly controlPlanePool:PgPoolLike,
    private readonly analyticalDatabase:SemanticReadDatabase,
  ){}

  async load(context:TrustedToolContext):Promise<TenantSemanticContext>{
    const [overlayResult,progressiveCoverageResult,connectionInventoryResult]=await Promise.all([
      withControlPlaneRead(this.controlPlanePool,context.tenantId,(client)=>client.query(
      `SELECT overlay.version::text AS version,overlay.overlay,
              coalesce((
                SELECT dossier.content
                  FROM control_plane.dossiers AS dossier
                 WHERE dossier.tenant_id=overlay.tenant_id AND dossier.status='published'
                 ORDER BY dossier.version DESC LIMIT 1
              ),'{}'::jsonb) AS dossier
       FROM control_plane.tenant_overlays AS overlay
       WHERE overlay.tenant_id=$1 AND overlay.status='published'
       ORDER BY overlay.version DESC LIMIT 1`,[context.tenantId])),
      withControlPlaneRead(this.controlPlanePool,context.tenantId,(client)=>client.query(
        `SELECT connection_id,stream,status,covered_from,covered_to,qualification
           FROM control_plane.semantic_progressive_stream_coverage()`)),
      withControlPlaneRead(this.controlPlanePool,context.tenantId,(client)=>client.query(
        `SELECT connection_id,connector_id,display_name,connection_status,
                auth_health,authority_eligible
           FROM control_plane.semantic_connection_scopes()`)),
    ]);
    const overlayRow=overlayResult.rows[0];
    if(!overlayRow)throw new Error(`No published tenant overlay exists for ${context.tenantId}.`);
    const overlay=asRecord(overlayRow.overlay,"tenant overlay");

    const [capabilityResult,statsResult,authorityResult,identityGraphResult]=await Promise.all([
      this.analyticalDatabase.queryAsSemanticRole({tenantId:context.tenantId,capabilityEvidence:semanticCapabilityEvidence(context),statementTimeoutMs:5_000,parameters:[context.tenantId],sql:
        `SELECT capability,connection_id,connector_id,available,support,reason_code,
                reason_detail,coverage,pack_version,source_watermark
         FROM semantic_internal.active_tenant_capability
         WHERE tenant_id=$1`}),
      this.analyticalDatabase.queryAsSemanticRole({tenantId:context.tenantId,capabilityEvidence:semanticCapabilityEvidence(context),statementTimeoutMs:5_000,parameters:[context.tenantId],sql:
        `SELECT DISTINCT ON (domain) domain,source_watermarks
         FROM quality.pipeline_stats
         WHERE tenant_id=$1
         ORDER BY domain,snapshot_at DESC`}),
      this.analyticalDatabase.queryAsSemanticRole({tenantId:context.tenantId,capabilityEvidence:semanticCapabilityEvidence(context),statementTimeoutMs:5_000,parameters:[context.tenantId],sql:
        `SELECT concept,scope_type,scope_id,authoritative_connection_id,
                effective_from,effective_to
         FROM core.source_authority
         WHERE tenant_id=$1
         ORDER BY concept,scope_type,scope_id,effective_from`}),
      this.analyticalDatabase.queryAsSemanticRole({tenantId:context.tenantId,capabilityEvidence:semanticCapabilityEvidence(context),statementTimeoutMs:5_000,parameters:[context.tenantId],sql:
        `SELECT version::text AS version,graph_hash
         FROM semantic_internal.identity_graph_state
         WHERE tenant_id=$1`}),
    ]);

    if(process.env.ALBERT_DEBUG_ERRORS==="1"){
      console.error("tenant context capability rows",{tenantId:context.tenantId,rows:capabilityResult.rows.length,available:capabilityResult.rows.filter((row)=>row.available===true).length});
    }
    const capabilities=new Set<string>();const capabilityDetails:NonNullable<TenantSemanticContext["capabilityDetails"]>[number][]=[];const packVersions:Record<string,string>={};const sourceWatermarks:Record<string,string>={};
    const connectorByConnection=new Map<string,string>();
    const connectionInventory=new Map(connectionInventoryResult.rows.map((row)=>{
      const connectionId=requiredString(row.connection_id,"semantic connection id");
      const connectorId=requiredString(row.connector_id,"semantic connector id");
      connectorByConnection.set(connectionId,connectorId);
      return [connectionId,Object.freeze({
        connectorId,
        label:requiredString(row.display_name,"semantic connection display name"),
        connectionStatus:requiredString(row.connection_status,"semantic connection status"),
        authHealth:requiredString(row.auth_health,"semantic connection auth health"),
        authorityEligible:row.authority_eligible===true,
      })] as const;
    }));
    for(const row of capabilityResult.rows){
      const capability=requiredString(row.capability,"capability");const connector=requiredString(row.connector_id,"connector_id");const pack=requiredString(row.pack_version,"pack_version");
      if(row.available===true)capabilities.add(capability);
      capabilityDetails.push(Object.freeze({
        id:capability,connectorId:connector,
        ...(typeof row.connection_id==="string"?{connectionId:row.connection_id}:{}),
        available:row.available===true,
        support:capabilitySupport(row.support,row.available),
        ...(typeof row.reason_code==="string"&&row.reason_code?{reasonCode:row.reason_code}:{}),
        ...(typeof row.reason_detail==="string"&&row.reason_detail?{reason:row.reason_detail}:{}),
        coverage:Object.freeze(optionalRecord(row.coverage)),
      }));
      if(packVersions[connector]&&packVersions[connector]!==pack)throw new Error(`Conflicting active pack versions for ${connector}.`);
      packVersions[connector]=pack;
      if(typeof row.connection_id==="string")connectorByConnection.set(row.connection_id,connector);
      if(typeof row.connection_id==="string"&&row.source_watermark instanceof Date)recordSourceWatermark(sourceWatermarks,row.connection_id,row.source_watermark.toISOString());
      if(typeof row.connection_id==="string"&&typeof row.source_watermark==="string")recordSourceWatermark(sourceWatermarks,row.connection_id,row.source_watermark);
    }
    for(const row of statsResult.rows){
      const values=asRecord(row.source_watermarks,"source_watermarks");
      for(const [key,value] of Object.entries(values))if(typeof value==="string")recordSourceWatermark(sourceWatermarks,key,value);
    }
    const authoritySelections:NonNullable<TenantSemanticContext["authoritySelections"]>[number][]=[];
    const authorityByConcept:Record<string,string>={};
    const loadedAt=Date.now();
    for(const row of authorityResult.rows){
      const concept=requiredString(row.concept,"authority concept");
      const connectionId=requiredString(row.authoritative_connection_id,"authoritative connection");
      const effectiveFrom=requiredTimestamp(row.effective_from,"authority effective from");
      const effectiveTo=row.effective_to===null||row.effective_to===undefined
        ?undefined
        :requiredTimestamp(row.effective_to,"authority effective to");
      const scopeType=authorityScopeType(row.scope_type);
      const controlEligible=connectionInventory.get(connectionId)?.authorityEligible===true;
      authoritySelections.push(Object.freeze({
        concept,scopeType,scopeId:requiredString(row.scope_id,"authority scope id"),
        connectionId,effectiveFrom,...(effectiveTo?{effectiveTo}:{}),controlEligible,
      }));
      if(!(concept in authorityByConcept)&&controlEligible&&
         Date.parse(effectiveFrom)<=loadedAt&&(!effectiveTo||Date.parse(effectiveTo)>loadedAt)){
        authorityByConcept[concept]=connectionId;
      }
    }
    const identityGraphRow=identityGraphResult.rows[0];
    const identityGraphVersion=identityGraphRow
      ? boundedInteger(identityGraphRow.version,0,1,Number.MAX_SAFE_INTEGER,"identity graph version")
      : 0;
    const identityGraphHash=identityGraphRow
      ? graphHash(identityGraphRow.graph_hash)
      : "d41d8cd98f00b204e9800998ecf8427e";

    const fiscal=optionalRecord(overlay.fiscal_calendar);
    const customerWindows=optionalRecord(overlay.customer_windows);
    const rememberedPreferences=optionalRecord(overlay.remembered_preferences);
    const defaults:Record<string,string|number|boolean>={
      trading_day_cutoff:optionalString(overlay.trading_day_cutoff)??"00:00",
    };
    copyAllowlistedDefault(defaults,rememberedPreferences,"sales.default_metric",[
      "commerce.net_sales_ex_gst","commerce.gross_takings_inc_gst",
    ]);
    copyAllowlistedDefault(defaults,rememberedPreferences,"employee.performance_default",[
      "commerce.net_sales_ex_gst","commerce.gross_margin","composites.gross_profit_per_labour_hour",
    ]);
    copyAllowlistedDefault(defaults,rememberedPreferences,"reconciliation.pos_posting_topology",[
      "daily_summary_journals","individual_transactions","unknown",
    ]);
    copyAllowlistedDefault(defaults,rememberedPreferences,"finance.profit_default",[
      "commerce.gross_margin","finance.gross_profit_accounting","finance.net_profit",
    ]);
    copyAllowlistedDefault(defaults,rememberedPreferences,"calendar.year_basis",[
      "financial_year","calendar_year",
    ]);
    if(overlay.tax_display_default==="inclusive"||overlay.tax_display_default==="exclusive")defaults.tax_display_default=overlay.tax_display_default;
    return {
      timezone:requiredString(overlay.timezone,"overlay timezone"),
      tradingDayCutoff:optionalString(overlay.trading_day_cutoff)??"00:00",
      // A confirmed year basis outranks the fiscal calendar default. Without
      // one, "this year" resolved to 1 July from a code default nobody chose,
      // and reported five weeks of trade as the year to date.
      fiscalYearStartMonth:defaults["calendar.year_basis"]==="calendar_year"
        ?1
        :boundedInteger(fiscal.start_month??overlay.fiscal_year_start_month,7,1,12,"fiscal year start month"),
      fiscalYearStartDay:boundedInteger(fiscal.start_day??overlay.fiscal_year_start_day,1,1,31,"fiscal year start day"),
      weekStartsOn:boundedInteger(fiscal.week_starts_on??overlay.week_starts_on,1,1,7,"week start"),
      tenantParameters:Object.freeze({
        active_customer_days:boundedInteger(customerWindows.active_days??overlay.active_customer_days??overlay.active_customer_window_days,90,1,3660,"active customer window"),
        lapsed_customer_days:boundedInteger(customerWindows.lapsed_days??overlay.lapsed_customer_days??overlay.churn_window_days,90,1,3660,"lapsed customer window"),
        stock_velocity_days:boundedInteger(overlay.stock_velocity_days,30,1,3660,"stock velocity window"),
      }),
      capabilities,capabilityDetails:Object.freeze(capabilityDetails),
      overlayVersion:requiredString(overlayRow.version,"overlay version"),
      identityGraphVersion,identityGraphHash,
      defaults:Object.freeze(defaults),
      dossier:Object.freeze(parseDossier(overlayRow.dossier)),
      packVersions:Object.freeze(packVersions),sourceWatermarks:Object.freeze(sourceWatermarks),authorityByConcept:Object.freeze(authorityByConcept),
      authoritySelections:Object.freeze(authoritySelections),
      sourceDetails:Object.freeze([...connectorByConnection.entries()].map(([connectionId,connectorId])=>{
        const inventory=connectionInventory.get(connectionId);
        return Object.freeze({
          connectionId,connectorId,label:inventory?.label??connectorLabel(connectorId),
          dataThrough:sourceWatermarks[connectionId]??"",
          ...(inventory?{
            connectionStatus:inventory.connectionStatus,authHealth:inventory.authHealth,
            authorityEligible:inventory.authorityEligible,
          }:{}),
        });
      })),
      progressiveCoverage:Object.freeze(progressiveCoverageResult.rows.map((row)=>{
        const status=requiredString(row.status,"progressive coverage status");
        if(status!=="pending"&&status!=="queryable"&&status!=="degraded"&&status!=="superseded"){
          throw new Error("progressive coverage status is invalid");
        }
        return Object.freeze({
          connectionId:requiredString(row.connection_id,"progressive coverage connection"),
          stream:requiredString(row.stream,"progressive coverage stream"),status,
          coveredFrom:requiredTimestamp(row.covered_from,"progressive coverage start"),
          coveredTo:requiredTimestamp(row.covered_to,"progressive coverage end"),
          qualification:requiredString(row.qualification,"progressive coverage qualification"),
        });
      })),
    };
  }

  async ready():Promise<boolean>{
    try{await withControlPlaneRead(this.controlPlanePool,"readiness",(client)=>client.query("SELECT 1 AS ready"));return true;}catch{return false;}
  }
}

export class PostgresDataHealthProvider implements DataHealthProvider {
  constructor(private readonly database:SemanticReadDatabase,private readonly registry:SemanticRegistry){}
  async getForTopic(context:TrustedToolContext,topicId:string):Promise<DataHealthSnapshot>{
    const topic=this.registry.topics.get(topicId);if(!topic)throw new Error(`Unknown Topic ${topicId}.`);
    const domains=topicQualityDomains(topic.baseFacts,topic.id);
    const result=await this.database.queryAsSemanticRole({tenantId:context.tenantId,capabilityEvidence:semanticCapabilityEvidence(context),statementTimeoutMs:5_000,parameters:[context.tenantId,[...domains],topic.requiredCapabilities],sql:
      `SELECT check_id,domain,status,details,checked_at
       FROM quality.current_scoped_health($1,$2::text[],$3::text[])`});
    if(!result.rows.length)return{status:"blocked",checks:[{checkId:"data_health_available",status:"blocked",details:{reason:"No quality snapshot exists for this Topic."}}]};
    const checks=result.rows.map((row)=>({checkId:requiredString(row.check_id,"check id"),status:healthStatus(row.status),details:{...optionalRecord(row.details),domain:requiredString(row.domain,"quality domain")}}));
    return{status:worstHealth(checks.map((check)=>check.status)),checks};
  }
  async getForDomain(context:TrustedToolContext,domain:string):Promise<DataHealthSnapshot>{
    if(!/^[a-z][a-z0-9_.-]{0,99}$/.test(domain))throw new Error(`Invalid data-health domain ${domain}.`);
    const domains=domain==="canonical"||domain==="connector"?[domain]:["connector","canonical",domain];
    const result=await this.database.queryAsSemanticRole({tenantId:context.tenantId,capabilityEvidence:semanticCapabilityEvidence(context),statementTimeoutMs:5_000,parameters:[context.tenantId,domains],sql:
      `SELECT check_id,domain,status,details,checked_at
       FROM quality.current_health($1,$2::text[])`});
    if(!result.rows.length)return{status:"blocked",checks:[{checkId:"data_health_available",status:"blocked",details:{reason:`No quality snapshot exists for ${domain}.`}}]};
    const checks=result.rows.map((row)=>({checkId:requiredString(row.check_id,"check id"),status:healthStatus(row.status),details:{...optionalRecord(row.details),domain:requiredString(row.domain,"quality domain")}}));
    return{status:worstHealth(checks.map((check)=>check.status)),checks};
  }
}

export class PostgresSourceCatalogueProvider implements SourceCatalogueProvider {
  constructor(private readonly database:SemanticReadDatabase){}
  async listFields(context:TrustedToolContext,connectionId:string,sourceTable:string):Promise<readonly SourceField[]>{
    const authorityConcepts=sourceAuthorityConceptsForRole(context.role);
    const piiPredicate=context.role==="bookkeeper"
      ? "pii_class='none'"
      : "pii_class NOT IN ('customer_contact','payroll','sensitive_personal')";
    const result=await this.database.queryAsSemanticRole({tenantId:context.tenantId,capabilityEvidence:semanticCapabilityEvidence(context),statementTimeoutMs:5_000,parameters:[context.tenantId,connectionId,sourceTable,authorityConcepts],sql:
      `SELECT connection_id,connector_id,source_schema,source_table,source_field,field_type,pii_class,authority_concept,documented_definition,pack_version
       FROM semantic_internal.active_source_field_allowlist
       WHERE tenant_id=$1 AND connection_id=$2 AND source_table=$3
         AND authority_concept=ANY($4::text[]) AND ${piiPredicate}
       ORDER BY source_field`});
    return sourceFieldsFromRows(result.rows).filter((field)=>sourceFieldIsAccessible(field,context.role));
  }
  async searchFields(context:TrustedToolContext,query:string,limit:number):Promise<readonly SourceField[]>{
    const boundedLimit=Math.min(Math.max(limit,1),50);const pattern=`%${escapeLike(query)}%`;const authorityConcepts=sourceAuthorityConceptsForRole(context.role);
    const piiPredicate=context.role==="bookkeeper"
      ? "pii_class='none'"
      : "pii_class NOT IN ('customer_contact','payroll','sensitive_personal')";
    const result=await this.database.queryAsSemanticRole({tenantId:context.tenantId,capabilityEvidence:semanticCapabilityEvidence(context),statementTimeoutMs:5_000,parameters:[context.tenantId,pattern,boundedLimit,authorityConcepts],sql:
      `SELECT connection_id,connector_id,source_schema,source_table,source_field,field_type,pii_class,authority_concept,documented_definition,pack_version
       FROM semantic_internal.active_source_field_allowlist
       WHERE tenant_id=$1
         AND authority_concept=ANY($4::text[]) AND ${piiPredicate}
         AND (source_field ILIKE $2 ESCAPE '\\' OR documented_definition ILIKE $2 ESCAPE '\\' OR source_table ILIKE $2 ESCAPE '\\')
       ORDER BY source_field,connection_id
       LIMIT $3`});
    return sourceFieldsFromRows(result.rows).filter((field)=>sourceFieldIsAccessible(field,context.role));
  }
  async resolveRankedFields(context:TrustedToolContext,references:readonly SourceFieldCatalogueReference[],limit:number):Promise<readonly SourceField[]>{
    const boundedLimit=Math.min(Math.max(Math.trunc(limit),1),50);
    const unique=new Map<string,SourceFieldCatalogueReference>();
    for(const reference of references){
      if(!/^[a-z0-9-]+$/u.test(reference.connectorId)||!isSafeIdentifier(reference.sourceTable)||!isSafeIdentifier(reference.sourceField))throw new Error("Invalid governed catalogue field reference.");
      const key=`${reference.connectorId}:${reference.sourceTable}:${reference.sourceField}`;
      if(!unique.has(key))unique.set(key,Object.freeze({...reference}));
    }
    if(!unique.size)return[];
    const ranked=[...unique.values()].slice(0,200).map((reference,index)=>({connector_id:reference.connectorId,source_table:reference.sourceTable,source_field:reference.sourceField,rank:index+1}));
    const authorityConcepts=sourceAuthorityConceptsForRole(context.role);
    const piiPredicate=context.role==="bookkeeper"
      ? "field.pii_class='none'"
      : "field.pii_class NOT IN ('customer_contact','payroll','sensitive_personal')";
    const result=await this.database.queryAsSemanticRole({tenantId:context.tenantId,capabilityEvidence:semanticCapabilityEvidence(context),statementTimeoutMs:5_000,parameters:[context.tenantId,JSON.stringify(ranked),boundedLimit,authorityConcepts],sql:
      `WITH ranked AS (
         SELECT connector_id,source_table,source_field,rank
         FROM jsonb_to_recordset($2::jsonb) AS item(
           connector_id text,source_table text,source_field text,rank integer
         )
       )
       SELECT field.connection_id,field.connector_id,field.source_schema,field.source_table,
              field.source_field,field.field_type,field.pii_class,field.authority_concept,
              field.documented_definition,field.pack_version
       FROM ranked
       JOIN semantic_internal.active_source_field_allowlist field
         ON field.connector_id=ranked.connector_id
        AND field.source_table=ranked.source_table
        AND field.source_field=ranked.source_field
       WHERE field.tenant_id=$1
         AND field.authority_concept=ANY($4::text[]) AND ${piiPredicate}
       ORDER BY ranked.rank,field.connection_id
       LIMIT $3`});
    return sourceFieldsFromRows(result.rows).filter((field)=>sourceFieldIsAccessible(field,context.role));
  }
  async listFieldValues(context:TrustedToolContext,fieldId:string,query:string|undefined,limit:number):Promise<readonly Readonly<{value:string;count?:number}>[]>{
    const authorityConcepts=sourceAuthorityConceptsForRole(context.role);
    const metadata=await this.database.queryAsSemanticRole({tenantId:context.tenantId,capabilityEvidence:semanticCapabilityEvidence(context),statementTimeoutMs:5_000,parameters:[context.tenantId,fieldId,authorityConcepts],sql:
      `SELECT connection_id,connector_id,source_schema,source_table,source_field,field_type,pii_class,authority_concept,documented_definition,pack_version
       FROM semantic_internal.active_source_field_allowlist
       WHERE tenant_id=$1
         AND authority_concept=ANY($3::text[])
         AND ('source:'||connection_id||':'||source_table||':'||source_field)=$2`});
    const fields=sourceFieldsFromRows(metadata.rows);if(fields.length!==1)throw new Error(`Source field ${fieldId} is unknown or ambiguous.`);
    const field=fields[0] as SourceField;
    assertSourceFieldIsAccessible(field,context.role);
    const parameters:unknown[]=[context.tenantId,field.connectionId];let predicate="";
    if(query){parameters.push(`%${escapeLike(query)}%`);predicate=` AND s.${quoteIdentifier(field.sourceField)}::text ILIKE $3 ESCAPE '\\'`;}
    parameters.push(Math.min(Math.max(limit,1),50));const limitParameter=`$${parameters.length}`;
    const values=await this.database.queryAsSemanticRole({tenantId:context.tenantId,capabilityEvidence:semanticCapabilityEvidence(context),statementTimeoutMs:5_000,parameters,sql:
      `SELECT s.${quoteIdentifier(field.sourceField)}::text AS value,count(*)::int AS count
       FROM ${quoteIdentifier(field.sourceSchema)}.${quoteIdentifier(field.sourceTable)} s
       WHERE s.tenant_id=$1 AND s.connection_id=$2${predicate}
       GROUP BY s.${quoteIdentifier(field.sourceField)}
       ORDER BY count(*) DESC,s.${quoteIdentifier(field.sourceField)}
       LIMIT ${limitParameter}`});
    return values.rows.flatMap((row)=>typeof row.value==="string"?[{value:row.value,count:boundedCount(row.count)}]:[]);
  }
}

export class PostgresCatalogueSearchProvider implements CatalogueSearchProvider {
  constructor(
    private readonly controlPlanePool:PgPoolLike,
    private readonly embeddings:EmbeddingProvider,
    private readonly registryVersion:string,
    private readonly registryHash:string,
    private readonly expectedDocumentCount:number,
  ){
    if(!Number.isInteger(expectedDocumentCount)||expectedDocumentCount<1)throw new Error("Expected catalogue document count must be positive.");
  }

  async search(query:string,limit:number):Promise<readonly CatalogueSearchHit[]>{
    const normalized=query.replaceAll(/\s+/gu," ").trim();
    if(!normalized)throw new Error("Catalogue search query cannot be empty.");
    const boundedLimit=Math.min(Math.max(Math.trunc(limit),1),50);
    const candidateLimit=Math.min(Math.max(boundedLimit*4,32),200);
    const vector=serializePgVector(await this.embeddings.embedQuery(normalized));
    const result=await withControlPlaneGlobalRead(this.controlPlanePool,(client)=>client.query(
      `WITH active_publication AS (
         SELECT publication_id
         FROM control_plane.semantic_publications
         WHERE status='published' AND registry_version=$3 AND registry_hash=$4
       ), parameters AS (
         SELECT $1::extensions.vector(1536) AS query_embedding,
                websearch_to_tsquery('english'::regconfig,$2) AS query_terms
       ), semantic_ranked AS (
         SELECT document_id,kind,title,metadata,
                row_number() OVER (
                  ORDER BY embedding OPERATOR(extensions.<=>) parameters.query_embedding,document_id
                ) AS semantic_rank
         FROM control_plane.catalogue_documents
         JOIN active_publication USING (publication_id)
         CROSS JOIN parameters
         ORDER BY embedding OPERATOR(extensions.<=>) parameters.query_embedding,document_id
         LIMIT $5
       ), keyword_ranked AS (
         SELECT document_id,kind,title,metadata,
                row_number() OVER (
                  ORDER BY ts_rank_cd(search_document,parameters.query_terms) DESC,document_id
                ) AS keyword_rank
         FROM control_plane.catalogue_documents
         JOIN active_publication USING (publication_id)
         CROSS JOIN parameters
         WHERE search_document @@ parameters.query_terms
         ORDER BY ts_rank_cd(search_document,parameters.query_terms) DESC,document_id
         LIMIT $5
       ), candidates AS (
         SELECT document_id,kind,title,metadata,semantic_rank,NULL::bigint AS keyword_rank
         FROM semantic_ranked
         UNION ALL
         SELECT document_id,kind,title,metadata,NULL::bigint,keyword_rank
         FROM keyword_ranked
       )
       SELECT document_id,min(kind) AS kind,min(title) AS title,
              min(metadata->>'semanticId') AS semantic_id,
              min(metadata->>'connectorId') AS connector_id,
              min(metadata->>'sourceTable') AS source_table,
              min(metadata->>'sourceField') AS source_field,
              (coalesce(sum(1.0/(60+semantic_rank)) FILTER (WHERE semantic_rank IS NOT NULL),0)+
               coalesce(sum(1.0/(60+keyword_rank)) FILTER (WHERE keyword_rank IS NOT NULL),0))::float8 AS score
       FROM candidates
       GROUP BY document_id
       ORDER BY score DESC,document_id
       LIMIT $6`,
      [vector,normalized,this.registryVersion,this.registryHash,candidateLimit,boundedLimit],
    ));
    return Object.freeze(result.rows.map(catalogueHitFromRow));
  }

  async ready():Promise<boolean>{
    try{
      const result=await withControlPlaneGlobalRead(this.controlPlanePool,(client)=>client.query(
        `SELECT count(*)::int AS document_count,
                count(*) FILTER (
                  WHERE catalogue_documents.embedding_model=$3
                    AND catalogue_documents.embedding_dimensions=$4
                    AND extensions.vector_dims(catalogue_documents.embedding)=$4
                )::int AS compatible_count
         FROM control_plane.catalogue_documents
         JOIN control_plane.semantic_publications
           USING (publication_id)
         WHERE semantic_publications.status='published'
           AND semantic_publications.registry_version=$1
           AND semantic_publications.registry_hash=$2`,
        [this.registryVersion,this.registryHash,this.embeddings.model,this.embeddings.dimensions],
      ));
      const row=result.rows[0];
      return Number(row?.document_count)===this.expectedDocumentCount&&Number(row?.compatible_count)===this.expectedDocumentCount;
    }catch{return false;}
  }
}

export class PostgresTenantPreferenceStore implements TenantPreferenceStore {
  constructor(private readonly controlPlanePool:PgPoolLike){}
  async remember(context:TrustedToolContext,preference:string,value:string|number|boolean):Promise<number>{
    if(!isAllowlistedRememberedPreference(preference,value))throw new Error(`Invalid tenant preference ${preference}.`);
    return withControlPlaneWrite(this.controlPlanePool,context.tenantId,async(client)=>{
      const currentResult=await client.query(
        `SELECT overlay_id,version,overlay
         FROM control_plane.tenant_overlays
         WHERE tenant_id=$1 AND status='published'
         FOR UPDATE`,[context.tenantId]);
      const current=currentResult.rows[0];if(!current)throw new Error(`No published tenant overlay exists for ${context.tenantId}.`);
      const version=boundedInteger(current.version,0,1,2_147_483_647,"overlay version");
      const overlay=asRecord(current.overlay,"tenant overlay");
      const preferences=optionalRecord(overlay.remembered_preferences);
      if(Object.hasOwn(preferences,preference)&&preferences[preference]===value)return version;
      preferences[preference]=value;
      const nextOverlay={...overlay,remembered_preferences:preferences};const nextVersion=version+1;const overlayId=ulid();
      await client.query(
        `UPDATE control_plane.tenant_overlays
         SET status='superseded',superseded_at=now()
         WHERE tenant_id=$1 AND overlay_id=$2`,[context.tenantId,requiredString(current.overlay_id,"overlay id")]);
      await client.query(
        `INSERT INTO control_plane.tenant_overlays
           (tenant_id,overlay_id,version,status,overlay,change_reason,published_at)
         VALUES ($1,$2,$3,'published',$4::jsonb,$5,now())`,
        [context.tenantId,overlayId,nextVersion,JSON.stringify(nextOverlay),`Explicit preference remembered: ${preference}`]);
      await client.query(
        `INSERT INTO control_plane.audit_log
           (tenant_id,audit_id,actor_type,action,resource_type,resource_id,request_id,audit_metadata)
         VALUES ($1,$2,'service','tenant.preference_remembered','tenant_overlay',$3,$4,$5::jsonb)`,
        [context.tenantId,ulid(),overlayId,context.turnId,JSON.stringify({preference,overlay_version:nextVersion,conversation_id:context.conversationId})]);
      return nextVersion;
    });
  }
}

export class PostgresSemanticPublicationVerifier {
  constructor(private readonly controlPlanePool:PgPoolLike,private readonly registryVersion:string,private readonly registryHash:string){}
  async matchesActivePublication():Promise<boolean>{
    try{
      const result=await withControlPlaneGlobalRead(this.controlPlanePool,(client)=>client.query(
        `SELECT registry_version,registry_hash
         FROM control_plane.semantic_publications
         WHERE status='published'`));
      return result.rows.length===1&&result.rows[0]?.registry_version===this.registryVersion&&result.rows[0]?.registry_hash===this.registryHash;
    }catch{return false;}
  }
  async assertActivePublication():Promise<void>{
    if(!await this.matchesActivePublication())throw new Error(`Local semantic registry ${this.registryVersion}/${this.registryHash} does not match the single active control-plane publication.`);
  }
}

export class PostgresSemanticResultCache implements SemanticResultCache {
  constructor(
    private readonly metadataPool:PgPoolLike,
    private readonly capabilityIssuer?:SemanticAnalyticalCapabilityIssuer,
  ){}
  async get(key:string,context?:TrustedToolContext):Promise<SemanticToolResponse|undefined>{
    const {tenantId,bundleHash}=parseCacheKey(key);
    return withSemanticMetadata(this.metadataPool,this.capabilityIssuer,tenantId,context&&semanticCapabilityEvidence(context),async(client)=>{
      const result=await client.query(
        `SELECT response FROM semantic_internal.result_cache
         WHERE tenant_id=$1 AND bundle_hash=$2 AND expires_at>now()`,[tenantId,bundleHash]);
      const row=result.rows[0];return row?parseSemanticResponse(row.response):undefined;
    });
  }
  async set(key:string,value:SemanticToolResponse,ttlSeconds:number,context?:TrustedToolContext):Promise<void>{
    const {tenantId,bundleHash}=parseCacheKey(key);
    if(!Number.isInteger(ttlSeconds)||ttlSeconds<1||ttlSeconds>86_400)throw new Error("Semantic cache TTL must be between 1 and 86400 seconds.");
    await withSemanticMetadata(this.metadataPool,this.capabilityIssuer,tenantId,context&&semanticCapabilityEvidence(context),(client)=>client.query(
      `INSERT INTO semantic_internal.result_cache (tenant_id,bundle_hash,registry_version,response,expires_at)
       VALUES ($1,$2,$3,$4::jsonb,now()+($5::text||' seconds')::interval)
       ON CONFLICT (tenant_id,bundle_hash) DO UPDATE SET
         registry_version=EXCLUDED.registry_version,response=EXCLUDED.response,expires_at=EXCLUDED.expires_at,updated_at=now()`,
      [tenantId,bundleHash,value.provenance.registryVersion,JSON.stringify(value),ttlSeconds],
    ));
  }
}

export class PostgresSemanticAuditSink implements SemanticAuditSink {
  constructor(
    private readonly metadataPool:PgPoolLike,
    private readonly capabilityIssuer?:SemanticAnalyticalCapabilityIssuer,
    private readonly promotionRelay?:PostgresSemanticPromotionRelay,
  ){}
  async append(record:SemanticAuditRecord):Promise<void>{
    if(!/^[a-f0-9]{64}$/.test(record.resultDigest))throw new Error("Semantic audit result digest is invalid.");
    await withSemanticMetadata(this.metadataPool,this.capabilityIssuer,record.tenantId,{
      conversationId:record.conversationId,turnId:record.turnId,
    },(client)=>client.query(
      `INSERT INTO semantic_internal.query_audit (
         tenant_id,query_id,conversation_id,turn_id,actor_role,route,topic,bundle_hash,registry_version,ir,compiled_sql,
         parameter_count,result_digest,row_count,duration_ms,cache_hit,answer_state,validation
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13,$14,$15,$16,$17,$18::jsonb)`,
      [record.tenantId,record.queryId,record.conversationId,record.turnId,record.role,record.route,record.topic??null,record.bundleHash,record.registryVersion,
       JSON.stringify(record.input),record.compiledSql,record.parameterCount,record.resultDigest,
       record.rowCount,record.durationMs,record.cacheHit,record.state,JSON.stringify(record.validation)],
    ));
  }
  async promoteSourceField(candidate:Parameters<SemanticAuditSink["promoteSourceField"]>[0]):Promise<string>{
    if(!this.promotionRelay)throw new Error("The durable semantic promotion relay is unavailable.");
    return this.promotionRelay.fileAndDeliver(candidate);
  }
}

export async function probePostgresPool(pool:PgPoolLike):Promise<boolean>{
  const client=await pool.connect();try{const result=await client.query("SELECT 1 AS ready");return result.rows[0]?.ready===1;}catch{return false;}finally{client.release();}
}

async function withControlPlaneRead<T>(pool:PgPoolLike,tenantId:string,operation:(client:PgClientLike)=>Promise<T>):Promise<T>{
  const client=await pool.connect();try{await client.query("BEGIN TRANSACTION READ ONLY");await client.query("SET LOCAL ROLE albert_semantic_control");await client.query("SELECT set_config('albert.tenant_id',$1,true)",[tenantId]);const result=await operation(client);await client.query("COMMIT");return result;}catch(error){try{await client.query("ROLLBACK");}catch{}throw error;}finally{client.release();}
}
async function withControlPlaneGlobalRead<T>(pool:PgPoolLike,operation:(client:PgClientLike)=>Promise<T>):Promise<T>{
  const client=await pool.connect();try{await client.query("BEGIN TRANSACTION READ ONLY");await client.query("SET LOCAL ROLE albert_semantic_control");const result=await operation(client);await client.query("COMMIT");return result;}catch(error){try{await client.query("ROLLBACK");}catch{}throw error;}finally{client.release();}
}
async function withControlPlaneWrite<T>(pool:PgPoolLike,tenantId:string,operation:(client:PgClientLike)=>Promise<T>):Promise<T>{
  const client=await pool.connect();try{await client.query("BEGIN");await client.query("SET LOCAL ROLE albert_semantic_control");await client.query("SELECT set_config('albert.tenant_id',$1,true)",[tenantId]);const result=await operation(client);await client.query("COMMIT");return result;}catch(error){try{await client.query("ROLLBACK");}catch{}throw error;}finally{client.release();}
}
async function withSemanticMetadata<T>(
  pool:PgPoolLike,
  capabilityIssuer:SemanticAnalyticalCapabilityIssuer|undefined,
  tenantId:string,
  evidence:Readonly<{conversationId:string;turnId:string}>|undefined,
  operation:(client:PgClientLike)=>Promise<T>,
):Promise<T>{
  const capability=capabilityIssuer
    ? await capabilityIssuer.issue({tenantId,scope:"semantic_metadata",evidence:requiredSemanticCapabilityEvidence(evidence)})
    : undefined;
  const client=await pool.connect();
  try{
    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE semantic_meta_rw");
    if(capability)await client.query("SELECT set_config('albert.tenant_capability',$1,true)",[capability]);
    else await client.query("SELECT set_config('albert.tenant_id',$1,true)",[tenantId]);
    // A capability proves that the control plane considered this tenant live at
    // issuance time. This transaction lock closes the remaining race: an
    // already-issued capability cannot write metadata after analytical erasure
    // has started, because deletion takes the matching exclusive lock.
    await client.query(
      "SELECT pg_advisory_xact_lock_shared(hashtextextended('deletion:'||$1,0))",
      [tenantId],
    );
    const result=await operation(client);
    await client.query("COMMIT");
    return result;
  }catch(error){
    try{await client.query("ROLLBACK");}catch{}
    throw error;
  }finally{
    client.release();
  }
}

function semanticCapabilityEvidence(context:TrustedToolContext):Readonly<{conversationId:string;turnId:string}>{
  return Object.freeze({conversationId:context.conversationId,turnId:context.turnId});
}

function requiredSemanticCapabilityEvidence(
  evidence:Readonly<{conversationId:string;turnId:string}>|undefined,
):Readonly<{conversationId:string;turnId:string}>{
  if(!evidence?.conversationId?.trim()||!evidence.turnId?.trim()){
    throw new Error("Semantic metadata access requires a durable conversation-turn lease.");
  }
  return evidence;
}

function parseCacheKey(key:string):{tenantId:string;bundleHash:string}{const separator=key.indexOf(":");if(separator<1)throw new Error("Semantic cache key is malformed.");const tenantId=key.slice(0,separator),bundleHash=key.slice(separator+1);if(!/^[a-f0-9]{64}$/.test(bundleHash))throw new Error("Semantic cache bundle hash is malformed.");return{tenantId,bundleHash};}
function parseSemanticResponse(value:unknown):SemanticToolResponse{const record=typeof value==="string"?JSON.parse(value) as unknown:value;if(!record||typeof record!=="object"||typeof (record as Row).state!=="string"||!("provenance" in record))throw new Error("Cached semantic response failed validation.");return record as SemanticToolResponse;}
/**
 * quality.pipeline_stats carries one watermark row per domain, and every domain
 * of a connector repeats the same connection id. Assigning each row in turn let
 * whichever domain sorted last overwrite the rest, so a connector whose product
 * catalogue had not resynced since 2021 reported the whole connection as five
 * years stale and the runtime refused current sales as unsafe. Watermarks are
 * only ever consumed as "how recent is this connection", so keep the latest.
 */
function recordSourceWatermark(watermarks:Record<string,string>,connectionId:string,candidate:string):void{
  const parsed=Date.parse(candidate);
  if(!Number.isFinite(parsed))return;
  const existing=watermarks[connectionId];
  if(existing!==undefined&&Date.parse(existing)>=parsed)return;
  watermarks[connectionId]=candidate;
}

function asRecord(value:unknown,label:string):Record<string,unknown>{if(!value||typeof value!=="object"||Array.isArray(value))throw new Error(`${label} must be an object.`);return value as Record<string,unknown>;}
function optionalRecord(value:unknown):Record<string,unknown>{return value&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:{};}
function requiredString(value:unknown,label:string):string{if(typeof value!=="string"||!value.trim())throw new Error(`${label} is missing.`);return value;}
function requiredTimestamp(value:unknown,label:string):string{const parsed=value instanceof Date?value:new Date(String(value??""));if(!Number.isFinite(parsed.valueOf()))throw new Error(`${label} is invalid.`);return parsed.toISOString();}
function optionalString(value:unknown):string|undefined{return typeof value==="string"&&value.trim()?value:undefined;}
function boundedInteger(value:unknown,fallback:number,min:number,max:number,label:string):number{const result=value===undefined?fallback:Number(value);if(!Number.isInteger(result)||result<min||result>max)throw new Error(`${label} must be an integer between ${min} and ${max}.`);return result;}
function capabilitySupport(value:unknown,available:unknown):"full"|"partial"|"unavailable"|"unknown"{if(value==="full"||value==="partial"||value==="unavailable"||value==="unknown")return value;return available===true?"full":"unknown";}
function authorityScopeType(value:unknown):"tenant"|"account"|"location"|"legal_entity"{if(value==="tenant"||value==="account"||value==="location"||value==="legal_entity")return value;throw new Error(`Invalid source authority scope ${String(value)}.`);}
function graphHash(value:unknown):string{const parsed=requiredString(value,"identity graph hash");if(!/^[a-f0-9]{32}$/.test(parsed))throw new Error("identity graph hash must be a lowercase MD5 digest.");return parsed;}
function copyAllowlistedDefault(target:Record<string,string|number|boolean>,source:Record<string,unknown>,key:string,allowed:readonly string[]):void{const value=source[key];if(typeof value==="string"&&allowed.includes(value))target[key]=value;}
function parseDossier(value:unknown):Record<string,string|number|boolean|readonly string[]>{const source=optionalRecord(value);const dossier:Record<string,string|number|boolean|readonly string[]>={};for(const [key,item] of Object.entries(source)){if(!/^[a-z][a-z0-9_]{0,79}$/.test(key))continue;if(typeof item==="string"&&item.length<=500){dossier[key]=item;continue;}if(typeof item==="number"&&Number.isFinite(item)){dossier[key]=item;continue;}if(typeof item==="boolean"){dossier[key]=item;continue;}if(Array.isArray(item)&&item.length<=50&&item.every((entry)=>typeof entry==="string"&&entry.length<=200))dossier[key]=Object.freeze([...item]);}return dossier;}
function healthStatus(value:unknown):"passed"|"warning"|"failed"|"blocked"{if(value==="passed"||value==="warning"||value==="failed"||value==="blocked")return value;throw new Error(`Invalid health status ${String(value)}.`);}
function worstHealth(values:readonly ReturnType<typeof healthStatus>[]):ReturnType<typeof healthStatus>{for(const status of ["blocked","failed","warning","passed"] as const)if(values.includes(status))return status;return"blocked";}
function topicQualityDomains(baseFacts:readonly string[],topicId:string):ReadonlySet<string>{
  const domains=new Set<string>(["connector","canonical"]);
  for(const fact of baseFacts){
    if(fact.startsWith("commerce_")||fact.startsWith("customer_"))domains.add("commerce");
    if(fact.startsWith("inventory_"))domains.add("inventory");
    if(fact.startsWith("workforce_"))domains.add("workforce");
    if(fact.startsWith("finance_"))domains.add("finance");
    if(fact==="workforce_sales_aligned"){domains.add("commerce");domains.add("workforce");}
    if(fact==="reconciliation_aligned"){domains.add("commerce");domains.add("finance");domains.add("reconciliation");}
  }
  if(topicId==="reconciliation")domains.add("reconciliation");
  return domains;
}
function sourceFieldType(value:unknown):SourceField["fieldType"]{if(value==="text"||value==="integer"||value==="decimal"||value==="boolean"||value==="date"||value==="timestamp")return value;throw new Error(`Invalid source field type ${String(value)}.`);}
function piiClass(value:unknown):SourceField["piiClass"]{if(value==="none"||value==="business"||value==="customer_contact"||value==="payroll"||value==="sensitive_personal")return value;throw new Error(`Invalid PII class ${String(value)}.`);}
function sourceFieldsFromRows(rows:readonly Row[]):SourceField[]{return rows.map((row)=>({connectionId:requiredString(row.connection_id,"connection id"),connectorId:requiredString(row.connector_id,"connector id"),sourceSchema:requiredString(row.source_schema,"source schema"),sourceTable:requiredString(row.source_table,"source table"),sourceField:requiredString(row.source_field,"source field"),fieldType:sourceFieldType(row.field_type),piiClass:piiClass(row.pii_class),...(typeof row.authority_concept==="string"?{authorityConcept:row.authority_concept}:{}),definition:requiredString(row.documented_definition,"source definition"),packVersion:requiredString(row.pack_version,"pack version")}));}
function catalogueHitFromRow(row:Row):CatalogueSearchHit{const kind=row.kind;if(kind!=="topic"&&kind!=="metric"&&kind!=="field"&&kind!=="source_field")throw new Error(`Invalid catalogue document kind ${String(kind)}.`);const score=Number(row.score);if(!Number.isFinite(score)||score<0)throw new Error(`Invalid catalogue search score ${String(row.score)}.`);const base:CatalogueSearchHit={documentId:requiredString(row.document_id,"catalogue document id"),semanticId:requiredString(row.semantic_id,"catalogue semantic id"),kind,title:requiredString(row.title,"catalogue title"),score};if(kind!=="source_field")return Object.freeze(base);return Object.freeze({...base,sourceFieldReference:Object.freeze({connectorId:requiredString(row.connector_id,"catalogue connector id"),sourceTable:safeIdentifier(row.source_table,"catalogue source table"),sourceField:safeIdentifier(row.source_field,"catalogue source field")})});}
function connectorLabel(value:string):string{const normalized=value.toLowerCase();if(normalized.startsWith("xero"))return"Xero";if(normalized.startsWith("deputy"))return"Deputy";if(normalized.startsWith("lightspeed"))return"Lightspeed";if(normalized.startsWith("square"))return"Square";if(normalized.startsWith("shopify"))return"Shopify";if(normalized.startsWith("stripe"))return"Stripe";if(normalized.startsWith("momence"))return"Momence";if(normalized.startsWith("meta"))return"Meta Ads";if(normalized.startsWith("google"))return"Google Ads";return value;}
function escapeLike(value:string):string{return value.replaceAll("\\","\\\\").replaceAll("%","\\%").replaceAll("_","\\_");}
function isSafeIdentifier(value:string):boolean{return/^[a-z_][a-z0-9_]*$/u.test(value);}
function safeIdentifier(value:unknown,label:string):string{const parsed=requiredString(value,label);if(!isSafeIdentifier(parsed))throw new Error(`Invalid ${label}.`);return parsed;}
function quoteIdentifier(value:string):string{if(!/^[a-z_][a-z0-9_]*$/.test(value))throw new Error(`Unsafe source identifier ${value}.`);return`"${value}"`;}
function boundedCount(value:unknown):number{const parsed=Number(value);if(!Number.isInteger(parsed)||parsed<0)throw new Error(`Invalid field-value count ${String(value)}.`);return parsed;}
