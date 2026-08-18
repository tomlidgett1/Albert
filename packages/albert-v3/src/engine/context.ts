import type {
  DashboardReplayRef,
  TraceCell,
  TraceConnector,
  TraceEvent,
  TraceProvenance,
  TraceTableColumn,
} from "../../../shared/src/index.js";
import type { CubeClient } from "../cube/client.js";
import type { ShopifyQLClient } from "../shopifyql/client.js";
import type { XeroMcpClient } from "../../../xero-mcp/src/client.js";
import type { ShopifyAdminClient } from "../shopify-admin/client.js";
import type { AlbertV3AgentConfig } from "../agent-config/loader.js";
import type { V3CommentaryState } from "./commentary.js";
import type { V3ToolRoute } from "./connector-routing.js";
import type { PriorTurnResult } from "./prior-results.js";
import type { BusinessContextForTurn } from "../context-layer/schema.js";

type TraceEventInput = TraceEvent extends infer Event
  ? Event extends TraceEvent
    ? Omit<Event, "id" | "sequence" | "occurredAt">
    : never
  : never;

export type EmitV3Trace = (event: TraceEventInput) => Promise<TraceEvent>;

/**
 * One connector domain's ingestion watermark from control-plane readiness.
 * Absence of data beyond `dataThrough` means "not synced yet", never zero.
 */
export type ConnectorDomainFreshness = Readonly<{
  connector: string;
  domain: string;
  /** ISO timestamp the domain's data is ready through; null when unknown. */
  dataThrough: string | null;
  /** Earliest date the domain holds data for, when a probe derived it (see freshness.ts). */
  dataFrom?: string;
}>;

/**
 * A durable, tenant-scoped fact about how this business's data sources fit
 * together, recorded by an earlier investigation: source elections, verified
 * reconciliations, data-quality traits. Injected into every turn so the
 * agent stops re-deriving (and sometimes fumbling) the same topology.
 */
export type TenantSourceFinding = Readonly<{
  concept: string;
  finding: string;
  recordedAt: string;
}>;

/** A governed query executed this turn, recorded for provenance and the UI. */
export type ExecutedCubeQuery = Readonly<{
  topic: string;
  view: string;
  /** The tool the view's data comes from (lightspeed, deputy, ...). */
  connector: TraceConnector;
  cubes: readonly string[];
  queryYaml: string;
  members: readonly string[];
  rowCount: number;
  executionMs: number;
  timeRangeLabel: string;
}>;

export type StoredTableResult = Readonly<{
  tableEventId: string;
  resultId: string;
  caption: string;
  columns: readonly TraceTableColumn[];
  rows: readonly Readonly<Record<string, TraceCell>>[];
  columnKeys: readonly string[];
  numericColumnKeys: readonly string[];
  rowCount: number;
  provenance: TraceProvenance;
  /** Absent for protected live queries that must never be silently replayed. */
  dashboardReplay?: DashboardReplayRef;
  presentation: "evidence" | "answer";
  /** True when this result was carried over from an earlier turn (see prior-results.ts). */
  reusedFromPriorTurn?: boolean;
  /**
   * Every row the query returned (bounded), for engine-side transforms such as
   * aggregate_result. `rows` is the client-facing slice; this is never emitted.
   */
  allRows?: readonly Readonly<Record<string, TraceCell>>[];
}>;

/**
 * Mutable per-turn state shared by every lane and tool. Deep-lane branches
 * share the same context so the query budget and provenance are global to
 * the turn.
 */
export type V3TurnContext = {
  readonly cube: CubeClient;
  /** Credential-free signed client for the governed ShopifyQL worker plane. */
  readonly shopifyQL?: ShopifyQLClient;
  /** Live Xero reports (P&L) through the credential-owning worker; owner/manager only. */
  readonly xeroMcp?: XeroMcpClient;
  /** Credential-free signed client for registry-governed Admin lookups. */
  readonly shopifyAdmin?: ShopifyAdminClient;
  readonly config: AlbertV3AgentConfig;
  /** Pseudonymous, stable tenant shard used only for provider prompt-cache routing. */
  readonly promptCachePartition: string;
  /** Deterministic execution planes resolved before model tool exposure. */
  readonly toolRoute: V3ToolRoute;
  readonly emit: EmitV3Trace;
  readonly signal?: AbortSignal;
  readonly budget: { maxQueries: number; executed: number };
  /** Per-connector-domain sync watermarks resolved at turn start; empty when unavailable. */
  readonly connectorFreshness: readonly ConnectorDomainFreshness[];
  /** Durable source-topology facts for this tenant; empty when none recorded. */
  /** Mutable so a lane can append a turn-scoped fact (e.g. a native report being unavailable). */
  sourceFindings: readonly TenantSourceFinding[];
  /** Persists a new source finding; absent when the runtime has no store. */
  readonly recordSourceFinding?: (concept: string, finding: string) => Promise<void>;
  /** record_source_finding calls this turn; capped so a turn cannot flood the ledger. */
  sourceFindingsRecorded?: number;
  /**
   * Set when a query window reached past a connector's sync watermark, so a
   * "Verified" claim about that window would overstate certainty.
   */
  freshnessQualified?: boolean;
  /**
   * The business context document for this tenant (see context-layer/):
   * what the business is, how it makes money, its vocabulary and what each
   * tool is the source of truth for. Rendered into the cached prompt prefix.
   */
  readonly businessContext?: BusinessContextForTurn;
  /** Bounded owner-facing commentary for analytical and deep turns. */
  readonly commentary: V3CommentaryState;
  /**
   * Entity-grounding lookups (explore_entities) run outside the main query
   * budget so exploration never starves analysis; capped separately per turn.
   */
  entityLookups?: number;
  /**
   * Free zero-row autopsies (date constraints relaxed to show where the data
   * actually falls) run outside the query budget; capped per turn.
   */
  emptyResultDiagnostics?: number;
  /**
   * Cubes (per connector) that returned zero rows this turn with NO constraint
   * at all — the whole table is empty for this tenant. Once two distinct cubes
   * of one connector are in here, that connector's governed surface is treated
   * as unpopulated: re-querying a proven-empty cube is refused without a Cube
   * round-trip, and the model is told to say the data has not been ingested
   * rather than to keep probing.
   */
  unpopulatedCubes?: Map<string, Set<string>>;
  /** update_plan calls (visible tick-off plan) run outside the query budget; capped per turn. */
  planUpdates?: number;
  /** Latest owner-facing plan already shown; the model ticks this list rather than replacing it. */
  visiblePlan?: readonly Readonly<{ label: string; status: "pending" | "active" | "done" }>[];
  catalogueSearches?: number;
  catalogueSchemaLoads?: number;
  shopifyQLCatalogueSearches?: number;
  shopifyAdminCatalogueSearches?: number;
  readonly executedQueries: ExecutedCubeQuery[];
  readonly tableResults: Map<string, StoredTableResult>;
  /**
   * Governed results from earlier turns of this conversation, addressable by
   * their original resultId. Materialised into `tableResults` on first use so
   * follow-ups re-present already-retrieved data without a new query.
   */
  readonly priorResults: Map<string, PriorTurnResult>;
  readonly chartedResultIds: Set<string>;
  /** Prefix applied to progress labels emitted from a deep-lane branch. */
  branchLabel?: string;
};
