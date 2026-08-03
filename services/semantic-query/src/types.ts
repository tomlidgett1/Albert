import type { SemanticRole, SemanticRegistry } from "../../../packages/semantic-registry/src/index.js";
import {
  REMOTE_SEMANTIC_AGENT_TOOL_NAMES,
  type RemoteSemanticAgentToolName,
  type SemanticToolResponse as AgentSemanticToolResponse,
} from "../../../packages/agent/src/semantic-tools.js";

export const SEMANTIC_TOOL_NAMES = REMOTE_SEMANTIC_AGENT_TOOL_NAMES;
export type SemanticToolName = RemoteSemanticAgentToolName;

export type TrustedToolContext = Readonly<{
  tenantId: string;
  role: SemanticRole;
  conversationId: string;
  turnId: string;
  confirmedPreference?: string;
  confirmedValue?: string;
}>;

export type TenantSemanticContext = Readonly<{
  timezone: string;
  tradingDayCutoff: string;
  fiscalYearStartMonth: number;
  fiscalYearStartDay: number;
  weekStartsOn: number;
  tenantParameters: Readonly<Record<string, string | number | boolean>>;
  capabilities: ReadonlySet<string>;
  capabilityDetails?: readonly Readonly<{
    id: string;
    connectorId: string;
    connectionId?: string;
    available?: boolean;
    support: "full" | "partial" | "unavailable" | "unknown";
    reasonCode?: string;
    reason?: string;
    coverage: Readonly<Record<string, unknown>>;
  }>[];
  overlayVersion: string;
  identityGraphVersion: number;
  identityGraphHash: string;
  defaults: Readonly<Record<string, string | number | boolean>>;
  dossier: Readonly<Record<string, string | number | boolean | readonly string[]>>;
  packVersions: Readonly<Record<string, string>>;
  sourceWatermarks: Readonly<Record<string, string>>;
  authorityByConcept: Readonly<Record<string, string>>;
  authoritySelections?: readonly Readonly<{
    concept: string;
    scopeType: "tenant" | "account" | "location" | "legal_entity";
    scopeId: string;
    connectionId: string;
    effectiveFrom: string;
    effectiveTo?: string;
    controlEligible?: boolean;
  }>[];
  sourceDetails?: readonly Readonly<{
    connectorId: string;
    connectionId: string;
    label: string;
    dataThrough: string;
    connectionStatus?: string;
    authHealth?: string;
    authorityEligible?: boolean;
  }>[];
  progressiveCoverage?: readonly Readonly<{
    connectionId: string;
    stream: string;
    status: "pending" | "queryable" | "degraded" | "superseded";
    coveredFrom: string;
    coveredTo: string;
    qualification: string;
  }>[];
}>;

export interface TenantSemanticContextProvider {
  load(context: TrustedToolContext): Promise<TenantSemanticContext>;
}

export type DatabaseRow = Readonly<Record<string, unknown>>;
export type DatabaseResult = Readonly<{ rows: readonly DatabaseRow[]; durationMs: number }>;

export type SemanticCapabilityEvidence = Readonly<{
  conversationId: string;
  turnId: string;
}>;

/** Implementations must use a read-only transaction, SET LOCAL ROLE semantic_ro,
 * and set trusted `albert.tenant_id` before executing the statement. */
export interface SemanticReadDatabase {
  queryAsSemanticRole(request: Readonly<{
    tenantId: string;
    sql: string;
    parameters: readonly unknown[];
    statementTimeoutMs: number;
    expectedIdentityGraph?: Readonly<{ version: number; hash: string }>;
    capabilityEvidence?: SemanticCapabilityEvidence;
  }>): Promise<DatabaseResult>;
}

export interface SemanticResultCache {
  get(key: string, context?: TrustedToolContext): Promise<SemanticToolResponse | undefined>;
  set(key: string, value: SemanticToolResponse, ttlSeconds: number, context?: TrustedToolContext): Promise<void>;
}

export type SourceField = Readonly<{
  connectionId: string;
  connectorId: string;
  sourceSchema: string;
  sourceTable: string;
  sourceField: string;
  fieldType: "text" | "integer" | "decimal" | "boolean" | "date" | "timestamp";
  piiClass: "none" | "business" | "customer_contact" | "payroll" | "sensitive_personal";
  authorityConcept?: string;
  definition: string;
  packVersion: string;
}>;

export type SourceFieldCatalogueReference = Readonly<{
  connectorId: string;
  sourceTable: string;
  sourceField: string;
}>;

export interface SourceCatalogueProvider {
  listFields(context: TrustedToolContext, connectionId: string, sourceTable: string): Promise<readonly SourceField[]>;
  searchFields?(context: TrustedToolContext, query: string, limit: number): Promise<readonly SourceField[]>;
  resolveRankedFields?(context: TrustedToolContext, references: readonly SourceFieldCatalogueReference[], limit: number): Promise<readonly SourceField[]>;
  listFieldValues?(context: TrustedToolContext, fieldId: string, query: string | undefined, limit: number): Promise<readonly Readonly<{ value: string; count?: number }>[]>;
}

export type CatalogueSearchHit = Readonly<{
  documentId: string;
  semanticId: string;
  kind: "topic" | "metric" | "field" | "source_field";
  title: string;
  score: number;
  sourceFieldReference?: SourceFieldCatalogueReference;
}>;

/** Searches the immutable catalogue snapshot belonging to the active semantic
 * publication. Production implementations combine embedding similarity and
 * PostgreSQL full-text rank; the semantic service never accepts model-supplied
 * tenant or publication scope. */
export interface CatalogueSearchProvider {
  search(query: string, limit: number): Promise<readonly CatalogueSearchHit[]>;
  ready(): Promise<boolean>;
}

export type DataHealthSnapshot = Readonly<{
  status: "passed" | "warning" | "failed" | "blocked";
  checks: readonly Readonly<{ checkId: string; status: "passed" | "warning" | "failed" | "blocked"; details?: Readonly<Record<string, unknown>> }>[];
}>;

export interface DataHealthProvider {
  getForTopic(context: TrustedToolContext, topic: string): Promise<DataHealthSnapshot>;
  getForDomain?(context: TrustedToolContext, domain: string): Promise<DataHealthSnapshot>;
}

export interface TenantPreferenceStore {
  remember(context: TrustedToolContext, preference: string, value: string | number | boolean): Promise<number>;
}

/** Exact, content-addressed active-publication proof supplied by the trusted
 * service composition. Production derives this from the single published
 * control-plane registry row; fixture executors must provide their own proof. */
export type SemanticPublicationEvidence = Readonly<{
  registryVersion: string;
  registryHash: string;
  activePublicationMatches: boolean;
}>;

export interface SemanticPublicationEvidenceProvider {
  inspect(): Promise<SemanticPublicationEvidence>;
}

export type SemanticAuditRecord = Readonly<{
  queryId: string;
  tenantId: string;
  conversationId: string;
  turnId: string;
  role: SemanticRole;
  route: "semantic" | "source_exploration";
  topic?: string;
  bundleHash: string;
  registryVersion: string;
  input: unknown;
  compiledSql: string;
  parameterCount: number;
  resultDigest: string;
  rowCount: number;
  durationMs: number;
  cacheHit: boolean;
  state: AnswerState;
  validation: Readonly<Record<string, unknown>>;
}>;

export interface SemanticAuditSink {
  append(record: SemanticAuditRecord): Promise<void>;
  promoteSourceField(candidate: Readonly<{
    queryId: string;
    context: TrustedToolContext;
    connectionId: string;
    connectorId: string;
    sourceTable: string;
    sourceFields: readonly string[];
    questionDigest: string;
    requestedMetricConcept?: string;
  }>): Promise<string>;
}

export type AnswerState = "verified" | "qualified" | "exploratory" | "clarification" | "unavailable";

export type SemanticToolResponse = AgentSemanticToolResponse;

export interface SemanticToolExecutor {
  execute(name: SemanticToolName, input: unknown, context: TrustedToolContext): Promise<SemanticToolResponse>;
}

export type SemanticServiceDependencies = Readonly<{
  registry: SemanticRegistry;
  contextProvider: TenantSemanticContextProvider;
  database: SemanticReadDatabase;
  cache: SemanticResultCache;
  sourceCatalogue: SourceCatalogueProvider;
  /** Optional only for deterministic in-process fixtures. The production
   * PostgreSQL composition always supplies the governed hybrid index. */
  catalogueSearch?: CatalogueSearchProvider;
  dataHealth: DataHealthProvider;
  audit: SemanticAuditSink;
  publicationEvidence?: SemanticPublicationEvidenceProvider;
  preferenceStore?: TenantPreferenceStore;
  clock?: () => Date;
  cacheTtlSeconds?: number;
  statementTimeoutMs?: number;
  readiness?: () => Promise<Readonly<{ ready: boolean; checks: Readonly<Record<string, boolean>> }>>;
  close?: () => Promise<void>;
}>;
