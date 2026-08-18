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

type Recipe = { presentation: "fact" | "list" | "table" | "line" | "bar"; answerHint?: string; dateParameter?: string; matches?: readonly string[] };
const RECIPE_PRESENTATIONS = new Set(["fact", "list", "table", "line", "bar"]);
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
    recipe = {
      presentation: presentation as Recipe["presentation"],
      ...(frontmatter.answer_hint ? { answerHint: String(frontmatter.answer_hint).trim() } : {}),
      ...(dateParameter ? { dateParameter } : {}),
      ...(matches?.length ? { matches } : {}),
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
