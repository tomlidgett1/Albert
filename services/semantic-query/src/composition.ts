import { readFileSync } from "node:fs";
import { deputyManifest } from "../../../connectors/deputy/manifest.js";
import { lightspeedRManifest } from "../../../connectors/lightspeed-r/manifest.js";
import { xeroManifest } from "../../../connectors/xero/manifest.js";
import { buildGovernedSourceCatalogueFields } from "../../../packages/connector-sdk/src/index.js";
import {
  buildRegistry,
  combineCatalogueDocuments,
  createRegistryCatalogueDocuments,
  createSourceFieldCatalogueDocuments,
  parseRegistryDocument,
  registryDigest,
} from "../../../packages/semantic-registry/src/index.js";
import { DefaultSemanticToolExecutor } from "./service.js";
import { PostgresAnswerArtifactFinalizer, type AnswerArtifactFinalizer } from "./answer-artifact-finalizer.js";
import { PostgresModelUsageRecorder, type ModelUsageRecorder } from "./model-usage-recorder.js";
import {
  PostgresSemanticAnalyticalCapabilityIssuer,
  PostgresSemanticReadDatabase,
  probeAnalyticalCapabilityVerifier,
  type PgPoolLike,
} from "./database.js";
import type { EmbeddingProvider } from "./embeddings.js";
import {
  PostgresCatalogueSearchProvider,
  PostgresDataHealthProvider,
  PostgresSemanticAuditSink,
  PostgresSemanticPublicationVerifier,
  PostgresSemanticResultCache,
  PostgresSourceCatalogueProvider,
  PostgresTenantPreferenceStore,
  PostgresTenantSemanticContextProvider,
  probePostgresPool,
} from "./postgres-adapters.js";
import type { SemanticToolExecutor } from "./types.js";
import { PostgresSemanticPromotionRelay } from "./promotion-relay.js";

export type ClosablePgPool=PgPoolLike&Readonly<{end?:()=>Promise<void>}>;
export type SemanticServiceComposition=Readonly<{
  executor:SemanticToolExecutor;
  answerArtifactFinalizer?:AnswerArtifactFinalizer;
  modelUsageRecorder?:ModelUsageRecorder;
  readiness:()=>Promise<Readonly<{ready:boolean;checks:Readonly<Record<string,boolean>>}>>;
  close:()=>Promise<void>;
}>;

export function createPostgresSemanticComposition(options:Readonly<{
  registryPath:string;
  controlPlanePool:ClosablePgPool;
  analyticalReadPool:ClosablePgPool;
  semanticMetadataPool:ClosablePgPool;
  embeddingProvider:EmbeddingProvider;
  clock?:()=>Date;
  cacheTtlSeconds?:number;
  statementTimeoutMs?:number;
  promotionRelayWorkerId:string;
  promotionRelayPollIntervalMs?:number;
  promotionRelayTenantBatchSize?:number;
  promotionRelayCandidateBatchSize?:number;
  promotionRelayLeaseSeconds?:number;
}>):SemanticServiceComposition{
  const registryDocument=parseRegistryDocument(readFileSync(options.registryPath,"utf8"));
  const registry=buildRegistry(registryDocument);
  const registryHash=registryDigest(registryDocument);
  const catalogueDocuments=combineCatalogueDocuments(
    createRegistryCatalogueDocuments(registryDocument),
    createSourceFieldCatalogueDocuments(buildGovernedSourceCatalogueFields([
      deputyManifest,lightspeedRManifest,xeroManifest,
    ])),
  );
  const publicationVerifier=new PostgresSemanticPublicationVerifier(options.controlPlanePool,registry.version,registryHash);
  const capabilityIssuer=new PostgresSemanticAnalyticalCapabilityIssuer(options.controlPlanePool);
  const promotionRelay=new PostgresSemanticPromotionRelay({
    controlPlanePool:options.controlPlanePool,
    semanticMetadataPool:options.semanticMetadataPool,
    capabilityIssuer,
    workerId:options.promotionRelayWorkerId,
    ...(options.promotionRelayPollIntervalMs?{pollIntervalMs:options.promotionRelayPollIntervalMs}:{}),
    ...(options.promotionRelayTenantBatchSize?{tenantBatchSize:options.promotionRelayTenantBatchSize}:{}),
    ...(options.promotionRelayCandidateBatchSize?{candidateBatchSize:options.promotionRelayCandidateBatchSize}:{}),
    ...(options.promotionRelayLeaseSeconds?{leaseSeconds:options.promotionRelayLeaseSeconds}:{}),
  });
  const database=new PostgresSemanticReadDatabase(options.analyticalReadPool,Date.now,capabilityIssuer);
  const contextProvider=new PostgresTenantSemanticContextProvider(options.controlPlanePool,database);
  const catalogueSearch=new PostgresCatalogueSearchProvider(
    options.controlPlanePool,
    options.embeddingProvider,
    registry.version,
    registryHash,
    catalogueDocuments.length,
  );
  const defaultExecutor=new DefaultSemanticToolExecutor({
    registry,contextProvider,database,
    cache:new PostgresSemanticResultCache(options.semanticMetadataPool,capabilityIssuer),
    sourceCatalogue:new PostgresSourceCatalogueProvider(database),
    catalogueSearch,
    dataHealth:new PostgresDataHealthProvider(database,registry),
    audit:new PostgresSemanticAuditSink(options.semanticMetadataPool,capabilityIssuer,promotionRelay),
    publicationEvidence:{async inspect(){return{
      registryVersion:registry.version,
      registryHash,
      activePublicationMatches:await publicationVerifier.matchesActivePublication(),
    };}},
    preferenceStore:new PostgresTenantPreferenceStore(options.controlPlanePool),
    ...(options.clock?{clock:options.clock}:{}),
    ...(options.cacheTtlSeconds?{cacheTtlSeconds:options.cacheTtlSeconds}:{}),
    ...(options.statementTimeoutMs?{statementTimeoutMs:options.statementTimeoutMs}:{}),
  });
  promotionRelay.start();
  const executor:SemanticToolExecutor={async execute(name,input,context){
    // Governed semantic queries persist an explicit blocked validation/audit
    // when the exact publication proof is unavailable. Other tool routes have
    // no per-query audit envelope, so retain the hard publication preflight.
    if(name!=="run_semantic_query")await publicationVerifier.assertActivePublication();
    return defaultExecutor.execute(name,input,context);
  }};
  const pools=[options.controlPlanePool,options.analyticalReadPool,options.semanticMetadataPool];
  return{
    executor,
    answerArtifactFinalizer:new PostgresAnswerArtifactFinalizer(options.controlPlanePool,options.semanticMetadataPool,capabilityIssuer),
    modelUsageRecorder:new PostgresModelUsageRecorder(options.controlPlanePool),
    async readiness(){
      const [controlPlane,analyticalRead,semanticMetadata,semanticPublication,catalogueIndex,capabilityIssuerReady,semanticVerifier,metadataVerifier,promotionRelayReady]=await Promise.all([
        ...pools.map(probePostgresPool),publicationVerifier.matchesActivePublication(),catalogueSearch.ready(),
        capabilityIssuer.ready(),probeAnalyticalCapabilityVerifier(options.analyticalReadPool,"semantic_ro"),
        probeAnalyticalCapabilityVerifier(options.semanticMetadataPool,"semantic_meta_rw"),promotionRelay.ready(),
      ]);
      const checks={controlPlane,analyticalRead,semanticMetadata,semanticPublication,catalogueIndex,capabilityIssuerReady,semanticVerifier,metadataVerifier,promotionRelayReady};
      return{ready:Object.values(checks).every(Boolean),checks};
    },
    async close(){
      await promotionRelay.stop();
      const unique=[...new Set(pools)];
      await Promise.all(unique.map(async(pool)=>{if(pool.end)await pool.end();}));
    },
  };
}
