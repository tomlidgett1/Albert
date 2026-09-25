import type {
  CubeCatalogue,
  CubeCatalogueMember,
  CubeCatalogueView,
} from "../../albert-v3/src/cube/types.js";

/**
 * Omni-style semantic model rendering: the governed catalogue as one large,
 * human-readable YAML document of field definitions grouped by view. The
 * document is derived exclusively from the model-owned catalogue (names,
 * types, titles, descriptions) — never from row data, prompts or SQL — so it
 * is safe on the public trace exactly like `queryYaml`.
 */

export type OmniModelSearchResult = Readonly<{
  /** The rendered markdown body (heading, YAML fence, guidance). */
  document: string;
  /** Fields included in the YAML. */
  fieldCount: number;
  /** Views represented in the YAML. */
  viewCount: number;
  /** Right-aligned card outcome, e.g. `98 fields found matching "refund"`. */
  summary: string;
  /** Card headline, e.g. `Look up "refund" fields across the model`. */
  label: string;
  /** Views whose definitions the document contains (the topics now inspected). */
  viewNames: readonly string[];
}>;

const YAML_SAFE = /^[A-Za-z0-9][A-Za-z0-9 _.,'&()/%#+-]*$/u;

function yamlText(value: string): string {
  const collapsed = value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) return "''";
  if (YAML_SAFE.test(collapsed) && !/^(?:true|false|null|yes|no|on|off|~)$/iu.test(collapsed) && !/^[\d.+-]/u.test(collapsed)) {
    return collapsed;
  }
  return `'${collapsed.replaceAll("'", "''")}'`;
}

function memberDataType(member: CubeCatalogueMember): string {
  if (member.kind === "segment") return "SEGMENT";
  if (member.type === "time") return "TIMESTAMP";
  if (member.type === "boolean") return "BOOLEAN";
  if (member.type === "number" || member.kind === "measure") return "NUMBER";
  return "STRING";
}

function memberDescription(member: CubeCatalogueMember): string | undefined {
  const description = member.description?.trim() || member.aiContext?.trim();
  return description ? description.replace(/\s+/gu, " ").slice(0, 500) : undefined;
}

/**
 * Model-facing guidance (`meta.ai_context`) rendered beside the description.
 * The two used to be alternatives, so every member and view that carried both
 * silently lost its guidance; the description is the fact, the guidance is
 * how to use it.
 */
function memberGuidance(member: CubeCatalogueMember): string | undefined {
  const description = member.description?.trim();
  const guidance = member.aiContext?.trim();
  if (!description || !guidance || guidance === description) return undefined;
  return guidance.replace(/\s+/gu, " ").slice(0, 500);
}

const VIEW_GUIDANCE_MAX_CHARS = 4_000;

function viewGuidance(view: CubeCatalogueView): string | undefined {
  const description = view.description?.trim();
  const guidance = view.aiContext?.trim();
  if (!description || !guidance || guidance === description) return undefined;
  return guidance.replace(/\s+/gu, " ").slice(0, VIEW_GUIDANCE_MAX_CHARS);
}

function visibleMembers(view: CubeCatalogueView): readonly CubeCatalogueMember[] {
  return view.members.filter((member) => member.aiHidden !== true);
}

function renderMemberYaml(member: CubeCatalogueMember, indent: string): string {
  const lines = [
    `${indent}- name: ${yamlText(member.name)}`,
    `${indent}  data_type: ${memberDataType(member)}`,
  ];
  const description = memberDescription(member);
  if (description) lines.push(`${indent}  description: ${yamlText(description)}`);
  const guidance = memberGuidance(member);
  if (guidance) lines.push(`${indent}  guidance: ${yamlText(guidance)}`);
  const group = member.folder?.trim() || undefined;
  if (group) lines.push(`${indent}  group: ${yamlText(group)}`);
  if (member.title && member.title !== member.name) {
    lines.push(`${indent}  label: ${yamlText(member.shortTitle || member.title)}`);
  }
  return lines.join("\n");
}

function renderViewYaml(
  view: CubeCatalogueView,
  members: readonly CubeCatalogueMember[],
): string {
  const dimensions = members.filter((member) => member.kind === "dimension");
  const measures = members.filter((member) => member.kind === "measure");
  const segments = members.filter((member) => member.kind === "segment");
  const lines = [
    `- view_name: ${yamlText(view.name)}`,
    `  label: ${yamlText(view.title || view.name)}`,
  ];
  const description = view.description?.trim() || view.aiContext?.trim();
  if (description) lines.push(`  description: ${yamlText(description.replace(/\s+/gu, " ").slice(0, 700))}`);
  const guidance = viewGuidance(view);
  if (guidance) lines.push(`  guidance: ${yamlText(guidance)}`);
  if (dimensions.length > 0) {
    lines.push("  dimensions:");
    lines.push(...dimensions.map((member) => renderMemberYaml(member, "    ")));
  }
  if (measures.length > 0) {
    lines.push("  measures:");
    lines.push(...measures.map((member) => renderMemberYaml(member, "    ")));
  }
  if (segments.length > 0) {
    lines.push("  segments:");
    lines.push(...segments.map((member) => renderMemberYaml(member, "    ")));
  }
  return lines.join("\n");
}

function normalizeTopicToken(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
}

/** Resolves a topic reference ("Sales analytics", "sales_analytics") to a view. */
export function resolveTopic(
  catalogue: CubeCatalogue,
  topicName: string,
): CubeCatalogueView | undefined {
  const wanted = normalizeTopicToken(topicName);
  if (!wanted) return undefined;
  return catalogue.views.find((view) => normalizeTopicToken(view.name) === wanted)
    ?? catalogue.views.find((view) => normalizeTopicToken(view.title) === wanted)
    ?? catalogue.views.find((view) => (
      normalizeTopicToken(view.name).includes(wanted) || normalizeTopicToken(view.title).includes(wanted)
    ));
}

function memberMatches(member: CubeCatalogueMember, terms: readonly string[]): boolean {
  const haystack = [
    member.name,
    member.title,
    member.shortTitle,
    member.description ?? "",
    member.aiContext ?? "",
    member.folder ?? "",
  ].join(" ").toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

function memberNameMatches(member: CubeCatalogueMember, terms: readonly string[]): boolean {
  const haystack = [member.name, member.title, member.shortTitle].join(" ").toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

function searchTerms(pattern: string): readonly string[] {
  return pattern
    .toLowerCase()
    .split(/[^a-z0-9%]+/u)
    .map((term) => term.replaceAll("%", "").trim())
    .filter((term) => term.length > 0)
    .slice(0, 8);
}

const DOCUMENT_HEADER = "## Field Definitions\n\nYAML representation of all available fields, grouped by view:";
const DOCUMENT_FOOTER = "See instructions in system prompt around field selection in topics.";

function wrapDocument(yamlBody: string, trailer?: string): string {
  return [
    DOCUMENT_HEADER,
    "```yaml",
    yamlBody,
    "```",
    DOCUMENT_FOOTER,
    ...(trailer ? [trailer] : []),
  ].join("\n");
}

/**
 * Loads one whole topic as the big YAML document (Omni `topicName` lookup).
 */
export function lookupTopicModel(
  catalogue: CubeCatalogue,
  topicName: string,
): OmniModelSearchResult {
  const view = resolveTopic(catalogue, topicName);
  if (!view) {
    const known = catalogue.views.map((candidate) => candidate.title || candidate.name).slice(0, 40);
    return Object.freeze({
      document: wrapDocument("[]", `No topic named "${topicName}" exists. Available topics: ${known.join(", ")}.`),
      fieldCount: 0,
      viewCount: 0,
      summary: `No topic found matching "${topicName}"`,
      label: `Look up topic ${topicName}`,
      viewNames: Object.freeze([]),
    });
  }
  const members = visibleMembers(view);
  return Object.freeze({
    document: wrapDocument(renderViewYaml(view, members)),
    fieldCount: members.length,
    viewCount: 1,
    summary: `Looked up topic ${view.title || view.name}`,
    label: `Look up topic ${view.title || view.name}`,
    viewNames: Object.freeze([view.name]),
  });
}

/**
 * Searches fields across the model (Omni `searchPattern`), optionally scoped
 * to one topic, and renders every match grouped by view.
 */
export function searchModelFields(
  catalogue: CubeCatalogue,
  searchPattern: string,
  topicName?: string,
): OmniModelSearchResult {
  // Explicit alternatives are OR; words within each alternative remain AND.
  // Do not execute model-supplied regular expressions.
  const alternatives = searchPattern.split(/[|,]/u).slice(0, 12).map(searchTerms).filter((terms) => terms.length > 0);
  const scope = topicName ? resolveTopic(catalogue, topicName) : undefined;
  if (topicName && !scope) return lookupTopicModel(catalogue, topicName);
  const views = scope ? [scope] : catalogue.views;
  // Names first: "gross_takings|completed_at" should return those fields, not
  // every field whose description mentions takings (39 fields, 14.5k chars,
  // re-sent on every later step). Descriptions are searched only for an
  // alternative that names no field.
  const matchers = alternatives.map((terms) => (
    views.some((view) => visibleMembers(view).some((member) => memberNameMatches(member, terms))) ? memberNameMatches : memberMatches
  ));
  const sections: string[] = [];
  const viewNames: string[] = [];
  let fieldCount = 0;
  let viewCount = 0;
  for (const view of views) {
    const matches = alternatives.length === 0
      ? []
      : visibleMembers(view).filter((member) => alternatives.some((terms, index) => matchers[index]!(member, terms)));
    if (matches.length === 0) continue;
    sections.push(renderViewYaml(view, matches));
    viewNames.push(view.name);
    fieldCount += matches.length;
    viewCount += 1;
  }
  const scopeLabel = scope ? ` in the ${scope.title || scope.name} topic` : " across the model";
  if (fieldCount === 0) {
    return Object.freeze({
      document: wrapDocument("[]", "No matches found. Try different or related terms."),
      fieldCount: 0,
      viewCount: 0,
      summary: `No fields found matching "${searchPattern}"`,
      label: `Look up ${searchPattern} fields${scopeLabel}`,
      viewNames: Object.freeze([]),
    });
  }
  return Object.freeze({
    document: wrapDocument(sections.join("\n")),
    fieldCount,
    viewCount,
    summary: `${fieldCount} ${fieldCount === 1 ? "field" : "fields"} found matching "${searchPattern}"`,
    label: `Look up ${searchPattern} fields${scopeLabel}`,
    viewNames: Object.freeze(viewNames),
  });
}

/**
 * The compact topic index embedded in the system prompt: one line per topic so
 * the agent knows what exists before its first SearchSemanticModel call.
 */
export function renderTopicIndex(catalogue: CubeCatalogue): string {
  return catalogue.views.map((view) => {
    const members = visibleMembers(view);
    const measures = members.filter((member) => member.kind === "measure").length;
    const dimensions = members.filter((member) => member.kind === "dimension").length;
    const description = (view.description ?? view.aiContext ?? "").replace(/\s+/gu, " ").trim().slice(0, 220);
    // The opening of the guidance is the routing hint ("Use this view for…");
    // the full text arrives with the topic lookup.
    const guidance = viewGuidance(view)?.slice(0, 200);
    return `- ${view.name} ("${view.title || view.name}"): ${measures} measures, ${dimensions} dimensions.${description ? ` ${description}` : ""}${guidance ? ` Guidance: ${guidance}` : ""}`;
  }).join("\n");
}
