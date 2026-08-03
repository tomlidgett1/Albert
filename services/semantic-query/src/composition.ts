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
import { PostgresSemanticReadDatabase,type PgPoolLike } from "./database.js";
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

export type ClosablePgPool=PgPoolLike&Readonly<{end?:()=>Promise<void>}>;
export type SemanticServiceComposition=Readonly<{
  executor:SemanticToolExecutor;
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
}>):SemanticServiceComposition{
  const registryDocument=parseRegistryDocument(readFileSync(options.registryPath,"utf8"));
  const registry=buildRegistry(registryDocument);
  const catalogueDocuments=combineCatalogueDocuments(
    createRegistryCatalogueDocuments(registryDocument),
    createSourceFieldCatalogueDocuments(buildGovernedSourceCatalogueFields([
      deputyManifest,lightspeedRManifest,xeroManifest,
    ])),
  );
  const publicationVerifier=new PostgresSemanticPublicationVerifier(options.controlPlanePool,registry.version,registryDigest(registryDocument));
  const database=new PostgresSemanticReadDatabase(options.analyticalReadPool);
  const contextProvider=new PostgresTenantSemanticContextProvider(options.controlPlanePool,database);
  const catalogueSearch=new PostgresCatalogueSearchProvider(
    options.controlPlanePool,
    options.embeddingProvider,
    registry.version,
    registryDigest(registryDocument),
    catalogueDocuments.length,
  );
  const defaultExecutor=new DefaultSemanticToolExecutor({
    registry,contextProvider,database,
    cache:new PostgresSemanticResultCache(options.semanticMetadataPool),
    sourceCatalogue:new PostgresSourceCatalogueProvider(database),
    catalogueSearch,
    dataHealth:new PostgresDataHealthProvider(database,registry),
    audit:new PostgresSemanticAuditSink(options.semanticMetadataPool),
    preferenceStore:new PostgresTenantPreferenceStore(options.controlPlanePool),
    ...(options.clock?{clock:options.clock}:{}),
    ...(options.cacheTtlSeconds?{cacheTtlSeconds:options.cacheTtlSeconds}:{}),
    ...(options.statementTimeoutMs?{statementTimeoutMs:options.statementTimeoutMs}:{}),
  });
  const executor:SemanticToolExecutor={async execute(name,input,context){
    await publicationVerifier.assertActivePublication();
    return defaultExecutor.execute(name,input,context);
  }};
  const pools=[options.controlPlanePool,options.analyticalReadPool,options.semanticMetadataPool];
  return{
    executor,
    async readiness(){
      const [controlPlane,analyticalRead,semanticMetadata,semanticPublication,catalogueIndex]=await Promise.all([...pools.map(probePostgresPool),publicationVerifier.matchesActivePublication(),catalogueSearch.ready()]);
      const checks={controlPlane,analyticalRead,semanticMetadata,semanticPublication,catalogueIndex};
      return{ready:Object.values(checks).every(Boolean),checks};
    },
    async close(){
      const unique=[...new Set(pools)];
      await Promise.all(unique.map(async(pool)=>{if(pool.end)await pool.end();}));
    },
  };
}
