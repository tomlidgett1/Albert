/**
 * The business-context generator: one bounded model call that turns the
 * collected facts into the structured document, preserving whatever the owner
 * has locked. It never queries anything itself; the facts are collected first
 * (facts.ts) under a governed lease, so this call is replayable and cheap.
 */
import { Agent, Runner, system, user } from "@openai/agents";
import { sanitizeTraceText, type AgentRunPreferences } from "../../../shared/src/index.js";
import type { AlbertV3AgentConfig } from "../agent-config/loader.js";
import { CONNECTOR_LABELS } from "../engine/orchestrator.js";
import { laneModelSettings, v3PromptCacheKey, withV3PromptCacheBoundary } from "../engine/lanes.js";
import type { TenantSourceFinding } from "../engine/context.js";
import { normalizeV3Connector } from "../engine/connector-routing.js";
import { renderFactsForGenerator, type BusinessFacts } from "./facts.js";
import { businessContextDocumentSchema, GENERATOR_VERSION, type BusinessContextDocument, type BusinessContextSection } from "./schema.js";
import { businessContextWordCount, renderBusinessContext } from "./render.js";

const GENERATOR_INSTRUCTIONS = `You write Albert's business context document: a dense, factual description of ONE
small business, read by an analyst (Albert) before every question about that business. Every
line must change how an analysis is scoped, interpreted or presented; no filler, no marketing.

Work only from the facts below (governed query results from the business's connected tools),
the tool catalogue notes, and any existing document. Never invent figures. Where a fact is
missing, leave the field null / the list short rather than guessing.

Field guidance:
- identity.summary: two sentences — what it is, where, how it operates (retail floor, workshop,
  online, wholesale). name = the trading name (Xero business name if present, else the POS shop).
- revenue.streams: the business's real revenue streams grouped the way an owner thinks
  (e.g. "Bikes", "Workshop labour & servicing", "Parts & accessories", "Clothing"), NOT raw
  category rows — group and sum categories into 3–7 streams; share = fraction of the basis;
  note = a short qualifier ("includes e-bikes"; "labour lines only, parts sold separately").
  basis names the tool, view, window and tax basis the shares came from.
- revenue.annualBand: a rounded band from the monthly series (e.g. "roughly $500k–$560k a year,
  GST-inclusive takings"). seasonality: peaks/troughs from the monthly series in plain words.
- scale: headcount from the workforce tool ("7 staff on the books, ~5 active; ~600 rostered
  hours a month"), customers, catalogue/stock — one clause each, with the source tool named.
- goals.ownerStated: keep EXACTLY what the existing document has (owner-authored); if none,
  return an empty list. goals.suggestedFocus: up to 4 watch-points the data itself suggests
  (e.g. "payables outstanding $22k vs receivables $x", "wages 25% of takings, rising"), each a
  neutral fact the owner can accept or delete — never advice.
- vocabulary: 6–12 entries an owner of THIS kind of business uses and what they map to in the
  data ("workshop" = service jobs/labour in Lightspeed workorders, mapsTo workshop_analytics;
  "the floor" = retail sales staff; "takings" = gross_takings incl. GST; "wages" = Deputy
  timesheet wage cost). Prefer terms grounded in the tools' area/category/position names.
- tools: one entry per connected tool (use the control-plane connector keys given), role = what
  it is the source of truth for HERE in one line, sourceOfTruthFor = short nouns (sales,
  products, workshop, rosters, wages, invoices, bills, bank, GST), dataFrom/dataThrough as
  YYYY-MM-DD when known: dataFrom is the EARLIEST date the tool's history holds (the first
  year in a per-year probe, or a watermark's "from"), never the start of a 12- or 24-month
  window; dataThrough is the latest watermark.
- cautions: data quirks that change interpretation, drawn from the facts and established
  source findings (e.g. "workshop status fields all read as open — do not report open-job
  counts as fact"; "Xero payroll is empty — wages come from Deputy"). Only about tools that
  are connected here; never mention tools that are not. Max 6, one line each.
- Keep the whole document to about 400 words when rendered: identity.summary ≤ 40 words,
  revenue.basis ≤ 20 words, each note/clause ≤ 12 words, no repetition between sections.
- State figures plainly, as an owner would read them ("7 staff, 5 active"). Never describe the
  collection mechanics: no "records", "rows", "views", "probes", "displayed months",
  "indicated by". A fact marked "not collected this time" is simply unknown — leave the field
  null or the list short and never mention that it was unavailable.
- Locked sections: if the existing document marks a section as owner-locked, copy it VERBATIM.`;

export type GenerateBusinessContextInput = Readonly<{
  facts: BusinessFacts;
  config: AlbertV3AgentConfig;
  preferences: AgentRunPreferences;
  runner?: Runner;
  cachePartition: string;
  existing?: Readonly<{ document: BusinessContextDocument; ownerLocked: readonly BusinessContextSection[] }>;
  sourceFindings?: readonly TenantSourceFinding[];
  signal?: AbortSignal;
}>;

export type GeneratedBusinessContext = Readonly<{
  document: BusinessContextDocument;
  rendered: string;
  words: number;
  generatorVersion: string;
  model: string;
}>;

function toolNotes(config: AlbertV3AgentConfig, connectorKeys: readonly string[]): string {
  const active = new Set(connectorKeys.map((key) => normalizeV3Connector(key) ?? key));
  const byConnector = new Map<string, string[]>();
  for (const view of config.accessibleViews) {
    if (!active.has(view.connector)) continue;
    const list = byConnector.get(view.connector) ?? [];
    list.push(`${view.name}: ${(view.purpose ?? view.guidance).replace(/\s+/gu, " ").slice(0, 140)}`);
    byConnector.set(view.connector, list);
  }
  return [...byConnector.entries()].map(([connector, views]) => `- ${connector} (${CONNECTOR_LABELS[connector] ?? connector}):\n  ${views.slice(0, 10).join("\n  ")}`).join("\n");
}

/** Owner-locked sections are copied from the existing document regardless of what the model returned. */
export function applyOwnerLocks(generated: BusinessContextDocument, existing: GenerateBusinessContextInput["existing"]): BusinessContextDocument {
  if (!existing || existing.ownerLocked.length === 0) return generated;
  const merged: BusinessContextDocument = { ...generated };
  for (const section of existing.ownerLocked) {
    (merged as Record<string, unknown>)[section] = existing.document[section];
  }
  // Owner-stated goals are always owner-authored: never overwritten by generation.
  if (!existing.ownerLocked.includes("goals")) {
    merged.goals = { ...merged.goals, ownerStated: existing.document.goals.ownerStated };
  }
  return merged;
}

export async function generateBusinessContext(input: GenerateBusinessContextInput): Promise<GeneratedBusinessContext> {
  const runner = input.runner ?? new Runner();
  const agent = new Agent<unknown, typeof businessContextDocumentSchema>({
    name: "Albert business context generator",
    instructions: GENERATOR_INSTRUCTIONS,
    model: input.preferences.model,
    modelSettings: laneModelSettings(input.preferences, "medium", {
      maxEffort: "medium",
      promptCacheKey: v3PromptCacheKey({ partition: input.cachePartition, profile: "business-context-generator" }),
    }),
    outputType: businessContextDocumentSchema,
  });
  const existingBlock = input.existing
    ? `# Existing document (owner-locked sections: ${input.existing.ownerLocked.join(", ") || "none"} — copy locked sections verbatim; keep goals.ownerStated verbatim)\n${JSON.stringify(input.existing.document)}`
    : "# Existing document\nnone — this is the first generation.";
  const findings = (input.sourceFindings ?? []).slice(0, 12).map((f) => `- [${sanitizeTraceText(f.concept, 60)}] ${sanitizeTraceText(f.finding, 300)}`).join("\n");
  const run = await runner.run(agent, withV3PromptCacheBoundary(input.preferences.model, [
    system(`# Connected tools and their views\n${toolNotes(input.config, input.facts.connectorKeys)}\n\n${existingBlock}\n\n${findings ? `# Established source facts about this business (verified earlier)\n${findings}\n\n` : ""}# Facts from the connected tools\n${renderFactsForGenerator(input.facts)}`),
    user("Write the business context document."),
  ]), { maxTurns: 2, signal: input.signal });
  const output = run.finalOutput;
  if (!output) throw new Error("The business context generator returned no document.");
  const document = applyOwnerLocks(businessContextDocumentSchema.parse(output), input.existing);
  return {
    document,
    rendered: renderBusinessContext(document),
    words: businessContextWordCount(document),
    generatorVersion: GENERATOR_VERSION,
    model: input.preferences.model,
  };
}
