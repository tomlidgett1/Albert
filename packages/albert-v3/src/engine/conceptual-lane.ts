/**
 * The conceptual lane explains governed business definitions without querying
 * tenant rows or asking a model to paraphrase them. Exact published definitions
 * are selected from the connector-scoped catalogue and rendered by trusted code.
 */
import { sanitizeTraceText, type TraceConnector } from "../../../shared/src/index.js";
import { hydrateViewSchemas, searchSemanticCatalogue } from "../cube/catalogue.js";
import type { CubeCatalogue } from "../cube/types.js";
import type { AlbertV3AgentConfig } from "../agent-config/loader.js";
import type { V3ToolRoute } from "./connector-routing.js";
import { normalizeV3Connector } from "./connector-routing.js";
import type { SemanticDefinitionEvidence } from "./context.js";
import type { FinalAnswer, LaneRunInput } from "./lanes.js";

export type ConceptualDefinitionCard = SemanticDefinitionEvidence & Readonly<{
  id: string;
  viewTitle: string;
}>;

const UNAVAILABLE_DEFINITION: FinalAnswer = Object.freeze({
  answer: "I don’t have a governed definition for that concept yet, so I can’t explain it reliably.",
  state: "Unavailable",
  followUps: [],
  assumptionsDisclosed: [],
});

const CONCEPT_STOP_WORDS = new Set([
  "a", "an", "and", "are", "can", "concept", "define", "definition", "do", "does",
  "explain", "for", "how", "is", "it", "mean", "meaning", "of", "the", "what", "work",
]);

const CONCEPT_ALIASES: readonly (readonly string[])[] = [
  ["sale", "sales", "revenue", "takings", "turnover"],
  ["cogs", "cost", "goods"],
  ["customer", "customers", "client", "clients"],
  ["employee", "employees", "staff", "worker", "workers"],
  ["stock", "inventory"],
  ["refund", "refunds", "return", "returns"],
] as const;

function exactConceptTokens(value: string): Set<string> {
  const tokens = new Set(value.toLowerCase().split(/[^a-z0-9]+/u).filter((token) => token.length > 1 && !CONCEPT_STOP_WORDS.has(token)));
  for (const group of CONCEPT_ALIASES) {
    if (group.some((token) => tokens.has(token))) for (const token of group) tokens.add(token);
  }
  return tokens;
}

/** Connector-scoped, model-visible definitions only; never SQL or alias targets. */
export function conceptualDefinitionCards(input: Readonly<{
  catalogue: CubeCatalogue;
  config: AlbertV3AgentConfig;
  route: V3ToolRoute;
  question: string;
}>): readonly ConceptualDefinitionCard[] {
  const allowed = new Set(input.route.activeCubeConnectors);
  const matches = searchSemanticCatalogue(
    input.catalogue,
    input.question,
    input.config.accessibleViews,
    {
      allowedConnectors: input.route.activeCubeConnectors,
      preferredConnectors: input.route.preferredCubeConnectors,
      limit: 3,
      memberLimit: 6,
    },
  ).filter(({ connector, score }) => score > 0 && allowed.has(connector));
  if (matches.length === 0) return [];

  const hydrated = hydrateViewSchemas(
    input.catalogue,
    matches.map(({ name }) => name),
    input.config.accessibleViews,
  );
  const schemaByName = new Map(hydrated.views.map((view) => [view.name, view]));
  const cards: ConceptualDefinitionCard[] = [];
  const seen = new Set<string>();
  const questionTokens = exactConceptTokens(input.question);

  for (const match of matches) {
    const schema = schemaByName.get(match.name);
    if (!schema || !allowed.has(schema.connector)) continue;
    const connector = normalizeV3Connector(schema.connector) as TraceConnector | undefined;
    if (!connector) continue;
    const members = new Map(schema.members.map((member) => [member.name, member]));
    for (const memberMatch of match.relevantMembers) {
      const member = members.get(memberMatch.name);
      if (!member || seen.has(member.name) || !member.description?.trim()) continue;
      const memberTokens = exactConceptTokens(`${member.name} ${member.title} ${member.description}`);
      if (![...questionTokens].some((token) => memberTokens.has(token))) continue;
      seen.add(member.name);
      cards.push(Object.freeze({
        id: `member:${member.name}`,
        connector,
        view: schema.name,
        viewTitle: sanitizeTraceText(schema.title, 120),
        member: member.name,
        label: sanitizeTraceText(member.title || member.shortTitle, 120),
        definition: sanitizeTraceText(member.description, 420),
        kind: member.kind,
      }));
      if (cards.length >= 8) return Object.freeze(cards);
    }
  }
  return Object.freeze(cards);
}

function endSentence(value: string): string {
  const text = value.trim();
  if (!text) return text;
  return /[.!?]$/u.test(text) ? text : `${text}.`;
}

/** Exact deterministic presentation: no paraphrase can outrun its definition. */
export function renderConceptualDefinitions(cards: readonly ConceptualDefinitionCard[]): string {
  const selected = cards.slice(0, 4);
  if (selected.length === 0) return UNAVAILABLE_DEFINITION.answer;
  if (selected.length === 1) {
    return `**${selected[0]!.label}** — ${endSentence(selected[0]!.definition)}`;
  }
  const labelCounts = new Map<string, number>();
  for (const card of selected) labelCounts.set(card.label, (labelCounts.get(card.label) ?? 0) + 1);
  return [
    "The published definitions Albert uses are:",
    "",
    ...selected.map((card) => {
      const scope = (labelCounts.get(card.label) ?? 0) > 1 ? ` (${card.viewTitle})` : "";
      return `- **${card.label}${scope}** — ${endSentence(card.definition)}`;
    }),
  ].join("\n");
}

export async function runConceptualLane(input: LaneRunInput): Promise<FinalAnswer> {
  const cards = conceptualDefinitionCards({
    catalogue: input.catalogue,
    config: input.config,
    route: input.context.toolRoute,
    question: input.intent.resolvedQuestion,
  });
  if (cards.length === 0) return UNAVAILABLE_DEFINITION;

  const used = cards.slice(0, 4);
  await input.context.emit({
    type: "progress",
    status: "complete",
    stage: "definition",
    label: `Read ${used.length} governed ${used.length === 1 ? "definition" : "definitions"}`,
    detail: sanitizeTraceText(input.intent.resolvedQuestion, 240),
    findings: used.map(({ label, viewTitle }) => sanitizeTraceText(`${label} · ${viewTitle}`, 160)),
    progress: 0.8,
  });
  input.context.definitionEvidence = used.map(({ connector, view, member, label, definition, kind }) => ({
    connector,
    view,
    member,
    label,
    definition,
    kind,
  }));
  return {
    answer: renderConceptualDefinitions(used),
    state: "Verified",
    followUps: [],
    assumptionsDisclosed: [],
  };
}
