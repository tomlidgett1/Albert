/**
 * Data-derived freshness watermarks.
 *
 * The control plane's ingestion cursors are the primary source of "data
 * through" per connector, but they are not always populated (a connector fed
 * by an external pipeline has no Albert-side cursor). Without a watermark the
 * model cannot tell an empty yesterday from an unsynced yesterday and either
 * reports a false zero or spends queries probing. This module derives the
 * watermark from the data itself: for each configured probe (a connector's
 * primary time dimension), the latest date that holds a row. Probes are tiny
 * governed queries, run in parallel and cached per tenant for a few minutes, so
 * they cost nothing perceptible on the critical path.
 *
 * Connector-agnostic: probes are declared per view in the agent config; the
 * engine merges them under the same ConnectorDomainFreshness contract the
 * control plane uses.
 */
import type { CubeLoadResponse, CubeQuery } from "../cube/types.js";
import type { FreshnessProbe } from "../agent-config/loader.js";
import type { ConnectorDomainFreshness } from "./context.js";

const CACHE_TTL_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 12_000;
/** The critical path never waits longer than this; slower probes still fill the cache for later turns. */
const CRITICAL_PATH_BUDGET_MS = 5_000;

/** Any governed Cube client: the v3 secret-signed client or a bearer-scoped runtime client. */
export type FreshnessProbeCube = Readonly<{
  loadQuery: (
    query: CubeQuery,
    options: Readonly<{ signal?: AbortSignal }>,
  ) => Promise<Readonly<{ result: CubeLoadResponse }>>;
}>;

type CacheEntry = { at: number; freshness: readonly ConnectorDomainFreshness[] };
const cache = new Map<string, CacheEntry>();

/**
 * One probe run per tenant and probe set, shared by every turn that starts
 * while it is in flight. Turns that start together on a cold cache used to
 * fire a full set each (four concurrent turns: 56 queries), every set missed
 * the critical-path budget, and all four went without a data cutoff.
 */
type Derivation = {
  /** Each probe's entry as it lands, in probe order. */
  found: (ConnectorDomainFreshness | undefined)[];
  settled: Promise<void>;
};
const inflight = new Map<string, Derivation>();

async function edgeDate(cube: FreshnessProbeCube, member: string, direction: "asc" | "desc", signal: AbortSignal): Promise<string | undefined> {
  const { result } = await cube.loadQuery({
    timeDimensions: [{ dimension: member, granularity: "day", ...(direction === "desc" ? { dateRange: "from 400 days ago to now" } : {}) }],
    order: { [member]: direction },
    limit: 1,
  }, { signal });
  if (!result.ok || result.rows.length === 0) return undefined;
  const row = result.rows[0]!;
  const value = row[`${member}.day`] ?? row[member];
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/u.test(value) ? value.slice(0, 10) : undefined;
}

async function probeOne(cube: FreshnessProbeCube, probe: FreshnessProbe, edges: FreshnessEdges): Promise<ConnectorDomainFreshness | undefined> {
  const [view] = probe.member.split(".");
  if (!view) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("freshness probe timeout")), PROBE_TIMEOUT_MS);
  try {
    const [latest, earliest] = await Promise.all([
      edgeDate(cube, probe.member, "desc", controller.signal),
      edges === "both" ? edgeDate(cube, probe.member, "asc", controller.signal).catch(() => undefined) : undefined,
    ]);
    if (!latest) return undefined;
    return { connector: probe.connector, domain: probe.domain, dataThrough: latest, ...(earliest ? { dataFrom: earliest } : {}) };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** "latest" probes only each source's last day, for callers that never read dataFrom. */
export type FreshnessEdges = "both" | "latest";

/**
 * Watermarks for the connectors that lack a control-plane watermark. `known`
 * entries win; derived entries fill the gaps. Cached per tenant.
 *
 * The caller waits at most `budgetMs` and receives every probe that has
 * landed by then; the rest still land in the cache for later turns. The
 * probes run under their own timeout, not the caller's signal, because a run
 * may be shared with other turns; an aborted caller simply stops waiting.
 */
export async function deriveConnectorFreshness(input: Readonly<{
  cube: FreshnessProbeCube;
  tenantId: string;
  probes: readonly FreshnessProbe[];
  activeConnectors: readonly string[];
  known: readonly ConnectorDomainFreshness[];
  signal?: AbortSignal;
  edges?: FreshnessEdges;
  budgetMs?: number;
}>): Promise<readonly ConnectorDomainFreshness[]> {
  const knownConnectors = new Set(input.known.filter((entry) => entry.dataThrough !== null).map((entry) => entry.connector));
  const wanted = input.probes.filter((probe) => input.activeConnectors.includes(probe.connector) && !knownConnectors.has(probe.connector));
  if (wanted.length === 0) return input.known;
  const edges = input.edges ?? "both";
  const key = `${input.tenantId}:${edges}:${wanted.map((probe) => probe.member).join(",")}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return [...input.known, ...cached.freshness];
  let derivation = inflight.get(key);
  if (!derivation) {
    const found: Derivation["found"] = wanted.map(() => undefined);
    const settled = Promise.all(wanted.map((probe, index) => probeOne(input.cube, probe, edges).then((entry) => { found[index] = entry; })))
      .then(() => {
        const derived = found.filter((entry): entry is ConnectorDomainFreshness => Boolean(entry));
        if (derived.length > 0) cache.set(key, { at: Date.now(), freshness: derived });
      })
      .finally(() => inflight.delete(key));
    derivation = { found, settled };
    inflight.set(key, derivation);
  }
  const { found, settled } = derivation;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    await Promise.race([
      settled,
      new Promise<void>((resolve) => { timer = setTimeout(resolve, input.budgetMs ?? CRITICAL_PATH_BUDGET_MS); }),
      new Promise<void>((resolve) => {
        if (!input.signal) return;
        if (input.signal.aborted) return resolve();
        onAbort = resolve;
        input.signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) input.signal?.removeEventListener("abort", onAbort);
  }
  return [...input.known, ...found.filter((entry): entry is ConnectorDomainFreshness => Boolean(entry))];
}
