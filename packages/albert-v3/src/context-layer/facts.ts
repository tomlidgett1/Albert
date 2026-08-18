/**
 * Business facts: the evidence the context generator reads.
 *
 * Every fact comes from a config-declared probe (`context_probes` in the agent
 * config) — one small governed Cube query on one view, scoped to the tenant's
 * active connectors. The collector runs them in parallel (bounded, because
 * the semantic layer's per-turn pool is small), keeps a bounded number of rows
 * per probe, and records failures instead of throwing: a probe that times out
 * simply leaves that fact unknown.
 *
 * Nothing here knows a connector. A new connector adds probes to the config.
 */
import type { CubeClient } from "../cube/client.js";
import type { CubeQuery } from "../cube/types.js";
import type { AlbertV3AgentConfig, ContextProbe } from "../agent-config/loader.js";
import { normalizeV3Connector } from "../engine/connector-routing.js";
import type { ConnectorDomainFreshness } from "../engine/context.js";

export type ProbeFact = Readonly<{
  key: string;
  connector: string;
  purpose: string;
  view: string;
  ok: boolean;
  /** Rows as returned by the semantic layer (member keys), bounded. */
  rows: readonly Readonly<Record<string, string | number | boolean | null>>[];
  rowCount: number;
  error?: string;
  executionMs: number;
}>;

export type BusinessFacts = Readonly<{
  collectedAt: string;
  /** Normalised view-connector keys the probes ran for (lightspeed, xero, deputy…). */
  connectors: readonly string[];
  /** Control-plane connector keys as supplied (lightspeed-r, xero, deputy…). */
  connectorKeys: readonly string[];
  probes: readonly ProbeFact[];
  freshness: readonly ConnectorDomainFreshness[];
  timezone: string;
  currency: string;
}>;

const PROBE_TIMEOUT_MS = 60_000;
/** Failed probes get one sequential retry after the first pass (contention eases). */
const RETRY_TIMEOUT_MS = 90_000;
const PARALLELISM = 2;

function toCell(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    // Cube returns numerics as strings; keep numbers as numbers for the generator.
    if (/^-?\d+(?:\.\d+)?$/u.test(trimmed) && trimmed.length < 18) return Number(trimmed);
    return trimmed.slice(0, 200);
  }
  return String(value).slice(0, 200);
}

function viewOf(query: Readonly<Record<string, unknown>>): string {
  const members = [
    ...(Array.isArray(query.measures) ? query.measures : []),
    ...(Array.isArray(query.dimensions) ? query.dimensions : []),
    ...(Array.isArray(query.timeDimensions) ? (query.timeDimensions as Array<Record<string, unknown>>).map((td) => td.dimension) : []),
  ];
  const first = members.find((m): m is string => typeof m === "string" && m.includes("."));
  return first ? first.split(".")[0]! : "unknown";
}

/** Probes for the tenant's connectors, in config order. */
export function probesForConnectors(config: AlbertV3AgentConfig, connectorKeys: readonly string[]): readonly ContextProbe[] {
  const active = new Set(connectorKeys.map((key) => normalizeV3Connector(key) ?? key.toLowerCase()));
  return config.contextProbes.filter((probe) => active.has(probe.connector));
}

export async function collectBusinessFacts(input: Readonly<{
  cube: CubeClient;
  config: AlbertV3AgentConfig;
  /** Control-plane connector keys (lightspeed-r, xero, deputy…). */
  connectorKeys: readonly string[];
  freshness?: readonly ConnectorDomainFreshness[];
  signal?: AbortSignal;
  /** Test seam: run a probe query and return rows. */
  runQuery?: (query: CubeQuery, signal?: AbortSignal) => Promise<{ ok: boolean; rows: readonly Readonly<Record<string, unknown>>[]; error?: string; executionMs: number }>;
}>): Promise<BusinessFacts> {
  const probes = probesForConnectors(input.config, input.connectorKeys);
  const runQuery = input.runQuery ?? (async (query: CubeQuery, signal?: AbortSignal) => {
    const { result } = await input.cube.loadQuery({ ...query, timezone: input.config.timezone }, { signal });
    return result.ok
      ? { ok: true, rows: result.rows, executionMs: result.executionMs }
      : { ok: false, rows: [], error: result.error, executionMs: result.executionMs };
  });
  const facts: ProbeFact[] = new Array(probes.length);
  const runProbe = async (index: number, timeoutMs: number) => {
      const probe = probes[index]!;
      const started = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const onAbort = () => controller.abort();
      input.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const result = await runQuery(probe.query as CubeQuery, controller.signal);
        facts[index] = {
          key: probe.key,
          connector: probe.connector,
          purpose: probe.purpose,
          view: viewOf(probe.query),
          ok: result.ok,
          rows: result.rows.slice(0, probe.rows).map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, toCell(v)]))),
          rowCount: result.rows.length,
          ...(result.ok ? {} : { error: (result.error ?? "The probe failed.").slice(0, 300) }),
          executionMs: result.executionMs || Date.now() - started,
        };
      } catch (error) {
        facts[index] = {
          key: probe.key, connector: probe.connector, purpose: probe.purpose, view: viewOf(probe.query),
          ok: false, rows: [], rowCount: 0, error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
          executionMs: Date.now() - started,
        };
      } finally {
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", onAbort);
      }
  };
  let next = 0;
  const worker = async () => {
    while (next < probes.length) {
      const index = next;
      next += 1;
      await runProbe(index, PROBE_TIMEOUT_MS);
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLELISM, Math.max(1, probes.length)) }, worker));
  // One sequential retry for probes that failed on a busy source; a fact that
  // still fails is left unknown (never a document line).
  if (!input.signal?.aborted) {
    for (let index = 0; index < probes.length; index += 1) {
      if (facts[index]?.ok) continue;
      if (input.signal?.aborted) break;
      await runProbe(index, RETRY_TIMEOUT_MS);
    }
  }
  return {
    collectedAt: new Date().toISOString(),
    connectors: [...new Set(probes.map((probe) => probe.connector))],
    connectorKeys: [...input.connectorKeys],
    probes: facts.filter(Boolean),
    freshness: input.freshness ?? [],
    timezone: input.config.timezone,
    currency: input.config.currency,
  };
}

/** Compact, generator-facing rendering of the facts (bounded per probe). */
export function renderFactsForGenerator(facts: BusinessFacts): string {
  const lines: string[] = [
    `Collected ${facts.collectedAt.slice(0, 16)}Z; timezone ${facts.timezone}; currency ${facts.currency}.`,
    `Connected tools (control-plane keys): ${facts.connectorKeys.join(", ") || "none"}.`,
  ];
  if (facts.freshness.length) {
    lines.push(`Data watermarks: ${facts.freshness.map((f) => `${f.connector}/${f.domain}${f.dataFrom ? ` from ${f.dataFrom}` : ""}${f.dataThrough ? ` through ${f.dataThrough.slice(0, 10)}` : ""}`).join("; ")}.`);
  }
  for (const probe of facts.probes) {
    lines.push("", `## ${probe.key} [${probe.connector} · ${probe.view}] — ${probe.purpose}`);
    if (!probe.ok) { lines.push("(not collected this time — unknown; do not mention in the document)"); continue; }
    if (probe.rows.length === 0) { lines.push("(no rows)"); continue; }
    const keys = Object.keys(probe.rows[0]!);
    lines.push(keys.map((k) => k.split(".").slice(1).join(".") || k).join(" | "));
    for (const row of probe.rows) lines.push(keys.map((k) => { const v = row[k]; return v === null ? "" : typeof v === "number" ? (Number.isInteger(v) ? String(v) : v.toFixed(2)) : String(v); }).join(" | "));
    if (probe.rowCount > probe.rows.length) lines.push(`… ${probe.rowCount - probe.rows.length} more rows`);
  }
  return lines.join("\n");
}
