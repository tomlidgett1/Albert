/**
 * Compiles cube-playground/agents/ (config.yml, rules, certified queries,
 * skills) into packages/albert-v3/src/agent-config/generated-agent-config.ts
 * so the Vercel bundle carries the agent configuration without runtime disk
 * reads. Run: npm run generate:albert-v3-agent-config [-- --check]
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentsDir = path.join(root, "cube-playground", "agents");
const outputFile = path.join(
  root, "packages", "albert-v3", "src", "agent-config", "generated-agent-config.ts",
);

type Frontmatter = Record<string, unknown>;

function parseFrontmatter(raw: string, file: string): { frontmatter: Frontmatter; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u);
  if (!match) throw new Error(`${file} is missing YAML frontmatter.`);
  const frontmatter = yaml.load(match[1]) as Frontmatter | null;
  if (!frontmatter || typeof frontmatter !== "object") {
    throw new Error(`${file} has invalid frontmatter.`);
  }
  return { frontmatter, body: match[2].trim() };
}

function markdownFiles(dir: string): readonly string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => path.join(dir, name));
}

const config = yaml.load(readFileSync(path.join(agentsDir, "config.yml"), "utf8")) as Record<string, unknown>;
if (!Array.isArray(config.accessible_views) || config.accessible_views.length === 0) {
  throw new Error("agents/config.yml must declare accessible_views.");
}
const supportedConnectors = new Set([
  "lightspeed", "lightspeed-x", "xero", "deputy", "square", "shopify", "stripe",
  "momence", "meta-ads", "google-ads",
]);
const viewNames = new Set<string>();
for (const [index, rawView] of config.accessible_views.entries()) {
  if (!rawView || typeof rawView !== "object" || Array.isArray(rawView)) {
    throw new Error(`accessible_views[${index}] must be an object.`);
  }
  const view = rawView as Record<string, unknown>;
  if (typeof view.name !== "string" || !/^[a-z][a-z0-9_]*$/u.test(view.name)) {
    throw new Error(`accessible_views[${index}] has an invalid name.`);
  }
  if (viewNames.has(view.name)) throw new Error(`Duplicate accessible view: ${view.name}`);
  viewNames.add(view.name);
  if (typeof view.connector !== "string" || !supportedConnectors.has(view.connector)) {
    throw new Error(`${view.name} has no supported connector mapping.`);
  }
  if (typeof view.guidance !== "string" || !view.guidance.trim()) {
    throw new Error(`${view.name} needs non-empty guidance.`);
  }
  if (view.purpose !== undefined && (
    typeof view.purpose !== "string" || !view.purpose.trim() || view.purpose.length > 180
  )) {
    throw new Error(`${view.name} purpose must be 1-180 characters.`);
  }
  if (view.routing_terms !== undefined && (
    !Array.isArray(view.routing_terms)
    || view.routing_terms.length > 12
    || view.routing_terms.some((term) => typeof term !== "string" || !term.trim() || term.length > 120)
  )) {
    throw new Error(`${view.name} routing_terms must contain at most 12 phrases of 1-120 characters.`);
  }
  if (view.key_metrics !== undefined && (
    !Array.isArray(view.key_metrics)
    || view.key_metrics.length < 1
    || view.key_metrics.length > 4
    || view.key_metrics.some((metric) =>
      typeof metric !== "string" || !/^(?:[a-z][a-z0-9_]*\.)?[a-z][a-z0-9_]*$/u.test(metric))
  )) {
    throw new Error(`${view.name} key_metrics must contain one to four measure identifiers.`);
  }
}

const alwaysRules: { name: string; body: string }[] = [];
const agentRequestedRules: { name: string; description: string; body: string }[] = [];
for (const file of markdownFiles(path.join(agentsDir, "rules"))) {
  const name = path.basename(file, ".md");
  const { frontmatter, body } = parseFrontmatter(readFileSync(file, "utf8"), file);
  if (frontmatter.type === "always") {
    alwaysRules.push({ name, body });
  } else if (frontmatter.type === "agent_requested") {
    const description = String(frontmatter.description ?? "").trim();
    if (!description) throw new Error(`${file} needs a description for agent_requested matching.`);
    agentRequestedRules.push({ name, description, body });
  } else {
    throw new Error(`${file} has unknown rule type ${String(frontmatter.type)}.`);
  }
}
if (alwaysRules.length === 0) throw new Error("At least one always rule is required.");

const RECIPE_ANSWER_FORMATS = ["integer", "number", "percent", "currency", "date", "text"] as const;
type Recipe = {
  presentation: "fact" | "list" | "table" | "line" | "bar";
  answerHint?: string;
  dateParameter?: string;
  matches?: readonly string[];
  emptyAnswer?: string;
  answerTemplate?: string;
  followUps?: readonly string[];
};
const RECIPE_PRESENTATIONS = new Set(["fact", "list", "table", "line", "bar"]);
const RECIPE_ANSWER_FORMAT_SET: ReadonlySet<string> = new Set(RECIPE_ANSWER_FORMATS);
const RECIPE_PLACEHOLDER = /^\{\{\s*([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,2})\s*\|\s*([a-z]+)\s*\}\}$/u;
const RECIPE_PLACEHOLDER_TOKEN = /\{\{[^{}]*\}\}/gu;
const ASSISTANT_OFFER = /^(?:i can|i'll|i will|i'd|i would|happy to|want me to|would you like(?: me)? to|shall i|let me|try:)\b/iu;

function selectedQueryMembers(query: unknown): ReadonlySet<string> {
  if (!query || typeof query !== "object" || Array.isArray(query)) return new Set();
  const record = query as Record<string, unknown>;
  const selected = new Set<string>();
  for (const field of ["measures", "dimensions"] as const) {
    if (!Array.isArray(record[field])) continue;
    for (const member of record[field]) {
      if (typeof member === "string") selected.add(member);
    }
  }
  if (Array.isArray(record.timeDimensions)) {
    for (const value of record.timeDimensions) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const timeDimension = value as Record<string, unknown>;
      if (typeof timeDimension.dimension === "string" && typeof timeDimension.granularity === "string") {
        selected.add(`${timeDimension.dimension}.${timeDimension.granularity}`);
      }
    }
  }
  return selected;
}

/** Validates the trusted deterministic-answer DSL before it reaches the bundle. */
export function validateRecipeAnswerTemplate(raw: unknown, query: unknown, file: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") throw new Error(`${file} answer_template must be a string.`);
  const template = raw.trim();
  if (template.length < 1 || template.length > 2_000) {
    throw new Error(`${file} answer_template must be 1-2000 characters.`);
  }
  const tokens = [...template.matchAll(RECIPE_PLACEHOLDER_TOKEN)].map(([token]) => token);
  if (tokens.length < 1 || tokens.length > 12) {
    throw new Error(`${file} answer_template must contain 1-12 member placeholders.`);
  }
  const withoutTokens = template.replace(RECIPE_PLACEHOLDER_TOKEN, "");
  if (withoutTokens.includes("{{") || withoutTokens.includes("}}")) {
    throw new Error(`${file} answer_template contains a malformed placeholder.`);
  }
  const selected = selectedQueryMembers(query);
  for (const token of tokens) {
    const match = token.match(RECIPE_PLACEHOLDER);
    if (!match || !RECIPE_ANSWER_FORMAT_SET.has(match[2]!)) {
      throw new Error(`${file} placeholder ${token} must be {{view.member|${RECIPE_ANSWER_FORMATS.join("|")}}}.`);
    }
    if (!selected.has(match[1]!)) {
      throw new Error(`${file} placeholder ${token} is not an exact member selected by its Cube query.`);
    }
  }
  return template;
}

/** Follow-ups are static owner messages, never assistant offers. */
export function validateRecipeFollowUps(raw: unknown, file: string): readonly string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length > 3) {
    throw new Error(`${file} follow_ups must contain at most three strings.`);
  }
  const followUps = raw.map((value, index) => {
    if (typeof value !== "string") throw new Error(`${file} follow_ups[${index}] must be a string.`);
    const followUp = value.trim();
    if (followUp.length < 4 || followUp.length > 160 || ASSISTANT_OFFER.test(followUp)) {
      throw new Error(`${file} follow_ups[${index}] must be a 4-160 character owner-voice prompt.`);
    }
    return followUp;
  });
  if (new Set(followUps.map((value) => value.toLowerCase())).size !== followUps.length) {
    throw new Error(`${file} follow_ups must be unique.`);
  }
  return followUps;
}

const certifiedQueries: { name: string; userRequest: string; notes: string; query: unknown; recipe?: Recipe }[] = [];
for (const file of markdownFiles(path.join(agentsDir, "certified_queries"))) {
  const name = path.basename(file, ".md");
  const { frontmatter, body } = parseFrontmatter(readFileSync(file, "utf8"), file);
  const userRequest = String(frontmatter.user_request ?? "").trim();
  if (!userRequest) throw new Error(`${file} needs a user_request frontmatter field.`);
  const jsonMatch = body.match(/```json\r?\n([\s\S]*?)```/u);
  if (!jsonMatch) throw new Error(`${file} needs a \`\`\`json Cube query block.`);
  const query = JSON.parse(jsonMatch[1]);
  const notes = body.replace(jsonMatch[0], "").trim();
  // A certified query flagged as a recipe is a complete fast-path answer: the
  // intent orchestrator may route straight to it (see recipe-lane.ts).
  let recipe: Recipe | undefined;
  if (frontmatter.recipe !== true && (frontmatter.answer_template !== undefined || frontmatter.follow_ups !== undefined)) {
    throw new Error(`${file} answer_template and follow_ups are only valid on recipe: true queries.`);
  }
  if (frontmatter.recipe === true) {
    const presentation = String(frontmatter.presentation ?? "").trim();
    if (!RECIPE_PRESENTATIONS.has(presentation)) {
      throw new Error(`${file} is a recipe and needs presentation: fact|list|table|line|bar.`);
    }
    const dateParameter = frontmatter.date_parameter ? String(frontmatter.date_parameter).trim() : undefined;
    if (dateParameter && !/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/u.test(dateParameter)) {
      throw new Error(`${file} date_parameter must be a fully qualified member.`);
    }
    const matches = Array.isArray(frontmatter.matches)
      ? frontmatter.matches.map((m) => String(m).trim()).filter(Boolean).slice(0, 12)
      : undefined;
    const answerTemplate = validateRecipeAnswerTemplate(frontmatter.answer_template, query, file);
    const followUps = validateRecipeFollowUps(frontmatter.follow_ups, file);
    if (followUps && !answerTemplate) {
      throw new Error(`${file} follow_ups require answer_template so they stay on the deterministic path.`);
    }
    recipe = {
      presentation: presentation as Recipe["presentation"],
      ...(frontmatter.answer_hint ? { answerHint: String(frontmatter.answer_hint).trim() } : {}),
      ...(dateParameter ? { dateParameter } : {}),
      ...(matches?.length ? { matches } : {}),
      // empty_answer: when set, zero rows IS the answer (no open shifts, no
      // leave, nothing overdue) and the recipe lane answers directly instead
      // of handing an "empty period" to the diagnostic lanes.
      ...(frontmatter.empty_answer ? { emptyAnswer: String(frontmatter.empty_answer).trim() } : {}),
      ...(answerTemplate ? { answerTemplate } : {}),
      ...(followUps ? { followUps } : {}),
    };
  }
  certifiedQueries.push({ name, userRequest, notes, query, ...(recipe ? { recipe } : {}) });
}

const skills: { name: string; title: string; description: string; body: string }[] = [];
for (const file of markdownFiles(path.join(agentsDir, "skills"))) {
  const name = path.basename(file, ".md");
  const { frontmatter, body } = parseFrontmatter(readFileSync(file, "utf8"), file);
  const title = String(frontmatter.title ?? "").trim();
  const description = String(frontmatter.description ?? "").trim();
  if (!title || !description) throw new Error(`${file} needs title and description frontmatter.`);
  skills.push({ name, title, description, body });
}

const generated = `/**
 * GENERATED FILE. Do not edit by hand.
 * Source: cube-playground/agents/ — regenerate with:
 *   npm run generate:albert-v3-agent-config
 */

export const ALBERT_V3_AGENT_CONFIG = ${JSON.stringify(
  {
    config,
    alwaysRules,
    agentRequestedRules,
    certifiedQueries,
    skills,
  },
  null,
  2,
)} as const;
`;

if (process.argv.includes("--check")) {
  const current = existsSync(outputFile) ? readFileSync(outputFile, "utf8") : "";
  if (current !== generated) {
    console.error("generated-agent-config.ts is stale. Run npm run generate:albert-v3-agent-config");
    process.exit(1);
  }
  console.log("albert-v3 agent config is up to date.");
} else {
  writeFileSync(outputFile, generated);
  console.log(`Wrote ${path.relative(root, outputFile)}`);
  console.log(`  always rules: ${alwaysRules.length}, agent_requested: ${agentRequestedRules.length}, certified queries: ${certifiedQueries.length}, skills: ${skills.length}`);
}
