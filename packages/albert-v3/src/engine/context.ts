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
import type { ShopifyAdminClient } from "../shopify-admin/client.js";
import type { AlbertV3AgentConfig } from "../agent-config/loader.js";
import type { V3CommentaryState } from "./commentary.js";
import type { V3ToolRoute } from "./connector-routing.js";

type TraceEventInput = TraceEvent extends infer Event
  ? Event extends TraceEvent
    ? Omit<Event, "id" | "sequence" | "occurredAt">
    : never
  : never;

export type EmitV3Trace = (event: TraceEventInput) => Promise<TraceEvent>;

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
  /** Bounded owner-facing commentary for analytical and deep turns. */
  readonly commentary: V3CommentaryState;
  /**
   * Entity-grounding lookups (explore_entities) run outside the main query
   * budget so exploration never starves analysis; capped separately per turn.
   */
  entityLookups?: number;
  catalogueSearches?: number;
  catalogueSchemaLoads?: number;
  shopifyQLCatalogueSearches?: number;
  shopifyAdminCatalogueSearches?: number;
  readonly executedQueries: ExecutedCubeQuery[];
  readonly tableResults: Map<string, StoredTableResult>;
  readonly chartedResultIds: Set<string>;
  /** Prefix applied to progress labels emitted from a deep-lane branch. */
  branchLabel?: string;
};
