import type { CubeCatalogue, CubeCatalogueMember, CubeCatalogueView } from "./types.js";

export type CatalogueViewDescriptor = Readonly<{
  name: string;
  connector: string;
  guidance: string;
  purpose?: string;
  routingTerms?: readonly string[];
  keyMetrics?: readonly string[];
}>;

export type SemanticCatalogueMemberMatch = Readonly<{
  name: string;
  kind: CubeCatalogueMember["kind"];
  title: string;
  description?: string;
}>;

export type SemanticCatalogueViewMatch = Readonly<{
  name: string;
  connector: string;
  title: string;
  purpose: string;
  keyMetrics: readonly string[];
  relevantMembers: readonly SemanticCatalogueMemberMatch[];
  score: number;
}>;

export type SemanticCatalogueMemberSchema = Readonly<{
  name: string;
  kind: CubeCatalogueMember["kind"];
  title: string;
  shortTitle: string;
  description?: string;
  type?: CubeCatalogueMember["type"];
  aiContext?: string;
  folder?: string;
}>;

export type SemanticCatalogueViewSchema = Readonly<{
  name: string;
  connector: string;
  title: string;
  purpose: string;
  guidance: string;
  description?: string;
  aiContext?: string;
  queryPolicy?: CubeCatalogueView["queryPolicy"];
  minimumTimeGranularity?: CubeCatalogueView["minimumTimeGranularity"];
  minimumGroupSize?: number;
  populationMeasure?: string;
  members: readonly SemanticCatalogueMemberSchema[];
}>;

const SEARCH_STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "did", "do", "does",
  "for", "from", "give", "had", "has", "have", "how", "i", "in", "is", "it",
  "me", "my", "of", "on", "or", "our", "show", "the", "their", "them", "this",
  "to", "us", "was", "we", "were", "what", "when", "which", "who", "with",
]);

/** Generic business-language aliases. Connector-specific routing stays outside this module. */
const SEARCH_SYNONYM_GROUPS = [
  ["sale", "sales", "revenue", "taking", "takings", "turnover"],
  ["product", "products", "item", "items", "sku", "skus", "variant", "variants"],
  ["employee", "employees", "staff", "worker", "workers", "team"],
  ["inventory", "stock", "stocktake", "stocktakes"],
  ["refund", "refunds", "return", "returns"],
  ["profit", "profits", "profitability", "margin", "margins"],
  ["purchase", "purchasing", "supplier", "suppliers", "vendor", "vendors"],
  ["customer", "customers", "client", "clients", "member", "members"],
  ["payroll", "wage", "wages", "salary", "salaries"],
  ["roster", "rosters", "rostered", "shift", "shifts", "scheduled"],
  ["payment", "payments", "tender", "tenders", "collection", "collections"],
  ["bank", "banking", "settlement", "settlements", "payout", "payouts"],
  ["invoice", "invoices", "bill", "bills", "receivable", "payable"],
  ["workshop", "workorder", "workorders", "service", "services", "repair", "repairs"],
  ["catalog", "catalogue"],
  ["fulfillment", "fulfilment", "delivery", "deliveries"],
  ["discount", "discounts", "promotion", "promotions"],
  ["traffic", "session", "sessions", "visitor", "visitors"],
] as const;

const synonymsByToken = new Map<string, readonly string[]>();
for (const group of SEARCH_SYNONYM_GROUPS) {
  for (const token of group) synonymsByToken.set(token, group);
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function truncateAtWord(value: string, maxLength: number): string {
  const compact = compactWhitespace(value);
  if (compact.length <= maxLength) return compact;
  const clipped = compact.slice(0, maxLength + 1);
  const lastSpace = clipped.lastIndexOf(" ");
  return `${clipped.slice(0, lastSpace > maxLength * 0.65 ? lastSpace : maxLength).trimEnd()}…`;
}

function singularToken(token: string): string {
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith("ses")) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

function lexicalTokens(value: string): readonly string[] {
  return [...new Set(
    value
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[’']/gu, "")
      .split(/[^a-z0-9]+/u)
      .map(singularToken)
      .filter((token) => token.length > 1 && !SEARCH_STOP_WORDS.has(token)),
  )];
}

function expandedQuestionTokens(question: string): ReadonlyMap<string, number> {
  const weighted = new Map<string, number>();
  for (const token of lexicalTokens(question)) {
    weighted.set(token, 1);
    for (const synonym of synonymsByToken.get(token) ?? []) {
      const normalized = singularToken(synonym);
      if (!weighted.has(normalized)) weighted.set(normalized, 0.42);
    }
  }
  return weighted;
}

function tokenSet(value: string): ReadonlySet<string> {
  return new Set(lexicalTokens(value));
}

function descriptorMap(descriptors: readonly CatalogueViewDescriptor[]): ReadonlyMap<string, CatalogueViewDescriptor> {
  return new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));
}

function purposeForView(view: CubeCatalogueView, descriptor?: CatalogueViewDescriptor): string {
  return compactWhitespace(descriptor?.purpose || descriptor?.guidance || view.description || view.aiContext || view.title || view.name);
}

function shortMemberName(member: CubeCatalogueMember): string {
  return member.name.slice(member.name.indexOf(".") + 1);
}

function modelVisibleMembers(view: CubeCatalogueView): readonly CubeCatalogueMember[] {
  return view.members.filter((member) => !member.aiHidden);
}

function keyMetricPenalty(member: CubeCatalogueMember): number {
  const name = shortMemberName(member).toLowerCase();
  if (/tenant|protected_subject|row_count|source_record|population/u.test(name)) return 100;
  if (/^count$/u.test(name)) return 20;
  return 0;
}

/**
 * Picks a stable, terse set of representative measures for the always-visible
 * view index. This is navigational context only; exact names and definitions
 * still come from get_view_schema before execution.
 */
export function catalogueKeyMetrics(view: CubeCatalogueView, limit = 3): readonly string[] {
  return modelVisibleMembers(view)
    .map((member, index) => ({ member, index }))
    .filter(({ member }) => member.kind === "measure")
    .sort((left, right) => {
      const penalty = keyMetricPenalty(left.member) - keyMetricPenalty(right.member);
      return penalty || left.index - right.index || left.member.name.localeCompare(right.member.name);
    })
    .slice(0, limit)
    .map(({ member }) => shortMemberName(member));
}

function descriptorKeyMetrics(
  view: CubeCatalogueView,
  descriptor: CatalogueViewDescriptor | undefined,
): readonly string[] {
  const measures = new Set(
    modelVisibleMembers(view).filter(({ kind }) => kind === "measure").map(({ name }) => name),
  );
  const configured = (descriptor?.keyMetrics ?? [])
    .map((name) => name.includes(".") ? name : `${view.name}.${name}`)
    .filter((name) => measures.has(name))
    .map((name) => name.slice(name.indexOf(".") + 1));
  return configured.length > 0 ? configured.slice(0, 4) : catalogueKeyMetrics(view);
}

function scopedViews(
  catalogue: CubeCatalogue,
  descriptors: readonly CatalogueViewDescriptor[],
  allowedConnectors?: readonly string[],
): readonly CubeCatalogueView[] {
  const byName = descriptorMap(descriptors);
  // Server-owned configuration is the model-disclosure allowlist. Cube meta
  // may also contain implementation cubes or unpublished views.
  const authorised = catalogue.views.filter((view) => byName.has(view.name));
  if (!allowedConnectors?.length) return authorised;
  const allowed = new Set(allowedConnectors);
  const filtered = authorised.filter((view) => {
    const connector = byName.get(view.name)?.connector;
    return connector !== undefined && allowed.has(connector);
  });
  // Connection metadata is an optimisation boundary, never an authority to
  // erase a live semantic view. Stale/empty metadata therefore widens safely.
  return filtered.length > 0 ? filtered : authorised;
}

/**
 * Compact always-visible index: every eligible view, its connector, purpose,
 * privacy policy and a few representative measures. Full member definitions
 * are deliberately excluded and are disclosed losslessly on demand.
 */
export function renderCompactCatalogueIndex(
  catalogue: CubeCatalogue,
  descriptors: readonly CatalogueViewDescriptor[],
  options: Readonly<{ allowedConnectors?: readonly string[]; purposeLength?: number }> = {},
): string {
  const byName = descriptorMap(descriptors);
  return [...scopedViews(catalogue, descriptors, options.allowedConnectors)]
    .sort((left, right) => {
      const connectorOrder = (byName.get(left.name)?.connector ?? "")
        .localeCompare(byName.get(right.name)?.connector ?? "");
      return connectorOrder || left.name.localeCompare(right.name);
    })
    .map((view) => {
      const descriptor = byName.get(view.name);
      const connector = descriptor?.connector ?? "unmapped";
      const purpose = truncateAtWord(purposeForView(view, descriptor), options.purposeLength ?? 70);
      const keyMetrics = descriptorKeyMetrics(view, descriptor);
      const policy = view.queryPolicy === "aggregate_only" ? "; aggregate-only" : "";
      return `- ${view.name} [${connector}${policy}]: ${purpose} Key metrics: ${keyMetrics.join(", ") || "none"}.`;
    })
    .join("\n");
}

function memberLine(member: CubeCatalogueMember): string {
  const parts = [`- ${member.name}`];
  if (member.type) parts.push(`(${member.kind}, ${member.type})`);
  else parts.push(`(${member.kind})`);
  const doc = member.description ?? member.title;
  if (doc) parts.push(`— ${doc}`);
  if (member.aiContext) parts.push(`[note: ${member.aiContext}]`);
  return parts.join(" ");
}

function renderView(view: CubeCatalogueView, options: Readonly<{ full: boolean }>): string {
  const lines: string[] = [`## View: ${view.name}`];
  if (view.description) lines.push(view.description);
  if (view.aiContext) lines.push(`Guidance: ${view.aiContext}`);
  if (view.queryPolicy === "aggregate_only") {
    lines.push(
      `Query policy: aggregate-only. Select at least one measure${view.populationMeasure ? `, including ${view.populationMeasure}` : ""}. Time members may only be used through timeDimensions at ${view.minimumTimeGranularity ?? "day"}-or-coarser granularity; exact timestamps, measure filters and individual source rows are unavailable.${view.minimumGroupSize ? ` The full result is rejected if any returned group has fewer than ${view.minimumGroupSize} protected subjects.` : ""}`,
    );
  }

  const byFolder = new Map<string, CubeCatalogueMember[]>();
  for (const member of modelVisibleMembers(view)) {
    const folder = member.folder ?? "Other";
    const bucket = byFolder.get(folder) ?? [];
    bucket.push(member);
    byFolder.set(folder, bucket);
  }

  for (const [folder, members] of byFolder) {
    lines.push(`### ${folder}`);
    for (const member of members) {
      lines.push(options.full
        ? memberLine(member)
        : `- ${member.name} (${member.kind}${member.type ? `, ${member.type}` : ""})`);
    }
  }
  return lines.join("\n");
}

/**
 * Legacy full renderer retained for diagnostics and rollback comparisons. It
 * must not be inserted into a production agent's always-visible instructions.
 */
export function renderCatalogueForPrompt(catalogue: CubeCatalogue): string {
  return catalogue.views.map((view) => renderView(view, { full: true })).join("\n\n");
}

/** Backward-compatible compact count summary for non-agent diagnostics. */
export function renderCatalogueSummary(catalogue: CubeCatalogue): string {
  return catalogue.views
    .map((view) => {
      const visible = modelVisibleMembers(view);
      const measures = visible.filter((m) => m.kind === "measure").length;
      const dimensions = visible.filter((m) => m.kind === "dimension").length;
      const segments = visible.filter((m) => m.kind === "segment").length;
      return `- ${view.name}: ${view.description ?? view.title} (${measures} measures, ${dimensions} dimensions, ${segments} segments)`;
    })
    .join("\n");
}

export function selectCatalogueViews(
  catalogue: CubeCatalogue,
  viewNames: readonly string[],
): Readonly<{ views: readonly CubeCatalogueView[]; unknownViewNames: readonly string[] }> {
  const byName = new Map(catalogue.views.map((view) => [view.name, view]));
  const uniqueNames = [...new Set(viewNames)];
  return Object.freeze({
    views: Object.freeze(uniqueNames.flatMap((name) => {
      const view = byName.get(name);
      return view ? [view] : [];
    })),
    unknownViewNames: Object.freeze(uniqueNames.filter((name) => !byName.has(name))),
  });
}

/** Lossless model-visible schema for one to three exact governed views. */
export function renderViewSchemasForPrompt(
  catalogue: CubeCatalogue,
  viewNames: readonly string[],
): Readonly<{ schemas: string; unknownViewNames: readonly string[] }> {
  const selected = selectCatalogueViews(catalogue, viewNames);
  return Object.freeze({
    schemas: selected.views.map((view) => renderView(view, { full: true })).join("\n\n"),
    unknownViewNames: selected.unknownViewNames,
  });
}

/**
 * Hydrates exact authorised views without exposing Cube's internal alias
 * targets. All fields that were visible in the legacy full prompt, plus titles
 * and policy metadata, are preserved verbatim.
 */
export function hydrateViewSchemas(
  catalogue: CubeCatalogue,
  viewNames: readonly string[],
  descriptors: readonly CatalogueViewDescriptor[],
): Readonly<{
  views: readonly SemanticCatalogueViewSchema[];
  unknownViewNames: readonly string[];
}> {
  const descriptorByName = descriptorMap(descriptors);
  const selected = selectCatalogueViews({
    ...catalogue,
    views: scopedViews(catalogue, descriptors),
  }, viewNames);
  return Object.freeze({
    views: Object.freeze(selected.views.map((view) => {
      const descriptor = descriptorByName.get(view.name)!;
      return Object.freeze({
        name: view.name,
        connector: descriptor.connector,
        title: view.title,
        purpose: truncateAtWord(purposeForView(view, descriptor), 320),
        guidance: descriptor.guidance,
        ...(view.description ? { description: view.description } : {}),
        ...(view.aiContext ? { aiContext: view.aiContext } : {}),
        ...(view.queryPolicy ? { queryPolicy: view.queryPolicy } : {}),
        ...(view.minimumTimeGranularity
          ? { minimumTimeGranularity: view.minimumTimeGranularity }
          : {}),
        ...(view.minimumGroupSize !== undefined
          ? { minimumGroupSize: view.minimumGroupSize }
          : {}),
        ...(view.populationMeasure ? { populationMeasure: view.populationMeasure } : {}),
        members: Object.freeze(modelVisibleMembers(view).map((member) => Object.freeze({
          name: member.name,
          kind: member.kind,
          title: member.title,
          shortTitle: member.shortTitle,
          ...(member.description ? { description: member.description } : {}),
          ...(member.type ? { type: member.type } : {}),
          ...(member.aiContext ? { aiContext: member.aiContext } : {}),
          ...(member.folder ? { folder: member.folder } : {}),
        }))),
      });
    })),
    unknownViewNames: selected.unknownViewNames,
  });
}

function fuzzyTokenMatch(queryToken: string, candidate: string): boolean {
  if (queryToken.length < 4 || candidate.length < 4) return false;
  if (candidate.startsWith(queryToken) || queryToken.startsWith(candidate)) return true;
  const queryTrigrams = new Set<string>();
  for (let index = 0; index <= queryToken.length - 3; index += 1) {
    queryTrigrams.add(queryToken.slice(index, index + 3));
  }
  let hits = 0;
  for (let index = 0; index <= candidate.length - 3; index += 1) {
    if (queryTrigrams.has(candidate.slice(index, index + 3))) hits += 1;
  }
  return hits / Math.max(queryTrigrams.size, candidate.length - 2) >= 0.58;
}

function fieldScore(
  query: ReadonlyMap<string, number>,
  tokens: ReadonlySet<string>,
  exactWeight: number,
  fuzzyWeight: number,
): number {
  let score = 0;
  for (const [queryToken, queryWeight] of query) {
    if (tokens.has(queryToken)) {
      score += exactWeight * queryWeight;
      continue;
    }
    if ([...tokens].some((candidate) => fuzzyTokenMatch(queryToken, candidate))) {
      score += fuzzyWeight * queryWeight;
    }
  }
  return score;
}

function memberSearchScore(
  member: CubeCatalogueMember,
  query: ReadonlyMap<string, number>,
  normalizedQuestion: string,
): number {
  const identity = `${member.name} ${member.shortTitle} ${member.title} ${member.folder ?? ""}`;
  const docs = `${member.description ?? ""} ${member.aiContext ?? ""}`;
  let score = fieldScore(query, tokenSet(identity), 9, 2.2)
    + fieldScore(query, tokenSet(docs), 3.2, 0.8);
  const normalizedName = compactWhitespace(member.name.replaceAll("_", " ").replaceAll(".", " ").toLowerCase());
  if (normalizedQuestion.includes(normalizedName)) score += 160;
  return score;
}

/**
 * Deterministic in-memory semantic-catalogue retrieval. It searches the full
 * trusted live catalogue server-side while returning only bounded view/member
 * excerpts. Exact view/member names always dominate lexical/fuzzy matches.
 */
export function searchSemanticCatalogue(
  catalogue: CubeCatalogue,
  question: string,
  descriptors: readonly CatalogueViewDescriptor[],
  options: Readonly<{
    allowedConnectors?: readonly string[];
    preferredConnectors?: readonly string[];
    limit?: number;
    memberLimit?: number;
  }> = {},
): readonly SemanticCatalogueViewMatch[] {
  const byName = descriptorMap(descriptors);
  const query = expandedQuestionTokens(question);
  const normalizedQuestion = compactWhitespace(
    question.replaceAll("_", " ").replaceAll(".", " ").toLowerCase(),
  );
  const preferred = new Set(options.preferredConnectors ?? []);
  const limit = Math.min(8, Math.max(1, options.limit ?? 5));
  const memberLimit = Math.min(12, Math.max(1, options.memberLimit ?? 8));

  return scopedViews(catalogue, descriptors, options.allowedConnectors)
    .map((view) => {
      const descriptor = byName.get(view.name);
      const connector = descriptor?.connector ?? "unmapped";
      const normalizedViewName = compactWhitespace(view.name.replaceAll("_", " ").toLowerCase());
      const identity = `${view.name} ${view.title}`;
      const purpose = purposeForView(view, descriptor);
      const relevantMembers = modelVisibleMembers(view)
        .map((member) => ({ member, score: memberSearchScore(member, query, normalizedQuestion) }))
        .sort((left, right) => right.score - left.score || left.member.name.localeCompare(right.member.name));
      const positiveMembers = relevantMembers.filter(({ score }) => score > 0);
      let score = fieldScore(query, tokenSet(identity), 30, 8)
        + fieldScore(query, tokenSet((descriptor?.routingTerms ?? []).join(" ")), 24, 5)
        + fieldScore(query, tokenSet(`${purpose} ${view.description ?? ""} ${view.aiContext ?? ""}`), 10, 2.5)
        + relevantMembers.slice(0, 6).reduce((total, match, index) => total + match.score / (index + 1), 0);
      if (normalizedQuestion.includes(normalizedViewName)) score += 1_000;
      if (preferred.has(connector)) score += 18;
      return {
        view,
        connector,
        purpose,
        score,
        relevantMembers: (positiveMembers.length > 0 ? positiveMembers : relevantMembers).slice(0, memberLimit),
      };
    })
    .sort((left, right) => right.score - left.score || left.view.name.localeCompare(right.view.name))
    .slice(0, limit)
    .map(({ view, connector, purpose, score, relevantMembers }) => Object.freeze({
      name: view.name,
      connector,
      title: view.title,
      purpose: truncateAtWord(purpose, 320),
      keyMetrics: Object.freeze(descriptorKeyMetrics(view, byName.get(view.name))),
      relevantMembers: Object.freeze(relevantMembers.map(({ member }) => Object.freeze({
        name: member.name,
        kind: member.kind,
        title: member.title,
        ...(member.description ? { description: truncateAtWord(member.description, 240) } : {}),
      }))),
      score: Math.round(score * 100) / 100,
    }));
}
