/**
 * Refreshing the business context under a governed lease.
 *
 * Cube queries need a running turn (or dashboard refresh) lease, so the
 * context is (re)generated *inside* a turn: opportunistically by the engine
 * when the stored document is missing or stale (the probes run beside the
 * turn's own queries and the result is saved before the lease closes), or
 * explicitly by the "Regenerate" action, which begins a short turn for it.
 *
 * `runBusinessContextRefresh` is the shared unit of work: collect facts →
 * generate → hand back the document for the caller to persist.
 */
import type { Runner } from "@openai/agents";
import type { AgentRunPreferences } from "../../../shared/src/index.js";
import type { AlbertV3AgentConfig } from "../agent-config/loader.js";
import type { CubeClient } from "../cube/client.js";
import type { ConnectorDomainFreshness, TenantSourceFinding } from "../engine/context.js";
import { collectBusinessFacts, type BusinessFacts } from "./facts.js";
import { generateBusinessContext } from "./generate.js";
import type { BusinessContextDocument, BusinessContextSection } from "./schema.js";

/** A document older than this (or generated for a different connector set) is refreshed on the next turn. */
export const BUSINESS_CONTEXT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export type BusinessContextRefreshResult = Readonly<{
  document: BusinessContextDocument;
  rendered: string;
  facts: BusinessFacts;
  generatorVersion: string;
  model: string;
  /** Latest watermark across the facts' freshness entries, if any. */
  dataThrough: string | null;
  connectors: readonly string[];
  words: number;
  durationMs: number;
}>;

export type SaveBusinessContext = (result: BusinessContextRefreshResult) => Promise<void>;

/** Whether the stored context (if any) is due for regeneration. Pure, so the route and tests can share it. */
export function businessContextRefreshDue(input: Readonly<{
  generatedAt: string | null;
  connectors: readonly string[];
  activeConnectors: readonly string[];
  now?: number;
}>): boolean {
  if (!input.generatedAt) return true;
  const age = (input.now ?? Date.now()) - Date.parse(input.generatedAt);
  if (!Number.isFinite(age) || age > BUSINESS_CONTEXT_MAX_AGE_MS) return true;
  const stored = new Set(input.connectors.map((key) => key.toLowerCase()));
  return input.activeConnectors.some((key) => !stored.has(key.toLowerCase()));
}

export async function runBusinessContextRefresh(input: Readonly<{
  cube: CubeClient;
  config: AlbertV3AgentConfig;
  connectorKeys: readonly string[];
  freshness?: readonly ConnectorDomainFreshness[];
  preferences: AgentRunPreferences;
  runner: Runner;
  cachePartition: string;
  existing?: Readonly<{ document: BusinessContextDocument; ownerLocked: readonly BusinessContextSection[] }>;
  sourceFindings?: readonly TenantSourceFinding[];
  signal?: AbortSignal;
}>): Promise<BusinessContextRefreshResult> {
  const started = Date.now();
  const facts = await collectBusinessFacts({
    cube: input.cube,
    config: input.config,
    connectorKeys: input.connectorKeys,
    freshness: input.freshness,
    signal: input.signal,
  });
  const generated = await generateBusinessContext({
    facts,
    config: input.config,
    preferences: input.preferences,
    runner: input.runner,
    cachePartition: input.cachePartition,
    existing: input.existing,
    sourceFindings: input.sourceFindings,
    signal: input.signal,
  });
  const dataThrough = (input.freshness ?? [])
    .map((entry) => entry.dataThrough)
    .filter((value): value is string => Boolean(value))
    .sort()
    .at(-1) ?? null;
  return {
    document: generated.document,
    rendered: generated.rendered,
    facts,
    generatorVersion: generated.generatorVersion,
    model: generated.model,
    dataThrough,
    connectors: [...input.connectorKeys],
    words: generated.words,
    durationMs: Date.now() - started,
  };
}
