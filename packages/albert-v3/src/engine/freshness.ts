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
import type { CubeClient } from "../cube/client.js";
import type { FreshnessProbe } from "../agent-config/loader.js";
import type { ConnectorDomainFreshness } from "./context.js";

const CACHE_TTL_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 12_000;
/** The critical path never waits longer than this; slower probes still fill the cache for later turns. */
const CRITICAL_PATH_BUDGET_MS = 5_000;

type CacheEntry = { at: number; freshness: readonly ConnectorDomainFreshness[] };
const cache = new Map<string, CacheEntry>();

async function edgeDate(cube: CubeClient, member: string, direction: "asc" | "desc", signal: AbortSignal): Promise<string | undefined> {
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

async function probeOne(cube: CubeClient, probe: FreshnessProbe, signal: AbortSignal | undefined): Promise<ConnectorDomainFreshness | undefined> {
  const [view] = probe.member.split(".");
  if (!view) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("freshness probe timeout")), PROBE_TIMEOUT_MS);
  const onAbort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const [latest, earliest] = await Promise.all([
      edgeDate(cube, probe.member, "desc", controller.signal),
      edgeDate(cube, probe.member, "asc", controller.signal).catch(() => undefined),
    ]);
    if (!latest) return undefined;
    return { connector: probe.connector, domain: probe.domain, dataThrough: latest, ...(earliest ? { dataFrom: earliest } : {}) };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Watermarks for the connectors that lack a control-plane watermark. `known`
 * entries win; derived entries fill the gaps. Cached per tenant.
 */
export async function deriveConnectorFreshness(input: Readonly<{
  cube: CubeClient;
  tenantId: string;
  probes: readonly FreshnessProbe[];
  activeConnectors: readonly string[];
  known: readonly ConnectorDomainFreshness[];
  signal?: AbortSignal;
}>): Promise<readonly ConnectorDomainFreshness[]> {
  const knownConnectors = new Set(input.known.filter((entry) => entry.dataThrough !== null).map((entry) => entry.connector));
  const wanted = input.probes.filter((probe) => input.activeConnectors.includes(probe.connector) && !knownConnectors.has(probe.connector));
  if (wanted.length === 0) return input.known;
  const key = `${input.tenantId}:${wanted.map((probe) => probe.member).join(",")}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return [...input.known, ...cached.freshness];
  const derivation = Promise.all(wanted.map((probe) => probeOne(input.cube, probe, input.signal)))
    .then((entries) => {
      const derived = entries.filter((entry): entry is ConnectorDomainFreshness => Boolean(entry));
      if (derived.length > 0) cache.set(key, { at: Date.now(), freshness: derived });
      return derived;
    });
  const derived = await Promise.race([
    derivation,
    new Promise<readonly ConnectorDomainFreshness[]>((resolve) => setTimeout(() => resolve([]), CRITICAL_PATH_BUDGET_MS)),
  ]);
  return [...input.known, ...derived];
}
