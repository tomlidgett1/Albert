import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

const API_VERSION = "2026-07";
const REGISTRY_VERSION = 1;
const DOCS_ORIGIN = "https://shopify.dev";
const SHOPIFYQL_ROOT = `${DOCS_ORIGIN}/docs/api/shopifyql/${API_VERSION}`;
const ADMIN_ROOT = `${DOCS_ORIGIN}/docs/api/admin-graphql/${API_VERSION}`;
const projectRoot = resolve(import.meta.dirname, "..");
const outputPath = resolve(
  projectRoot,
  `connectors/shopify/generated/shopifyql-${API_VERSION}.json`,
);
const checkOnly = process.argv.includes("--check");
const unknownArguments = process.argv.slice(2).filter((argument) => argument !== "--check");

if (unknownArguments.length > 0) {
  throw new Error(`Unknown argument(s): ${unknownArguments.join(", ")}. Only --check is supported.`);
}

type PageMetadata = Readonly<{
  title: string;
  description: string;
  apiVersion: string;
  sourceHtml: string;
  sourceMarkdown: string;
  body: string;
}>;

type ParsedField = Readonly<{
  name: string;
  type: string;
  description: string;
  formula?: string;
  isDeprecated: boolean;
  deprecationReason?: string;
}>;

type ParsedMatchField = Readonly<{
  name: string;
  role: "filter" | "metric";
  description: string;
  type: string;
}>;

type ParsedMatchCondition = Readonly<{
  name: string;
  description: string;
  fields: readonly ParsedMatchField[];
}>;

type ParsedMatchExpression = Readonly<{
  name: string;
  type: string;
  description: string;
}>;

type ParsedSchema = Readonly<{
  name: string;
  domain: string;
  description: string;
  sourceUrl: string;
  sourceMarkdownUrl: string;
  metrics: readonly ParsedField[];
  dimensions: readonly ParsedField[];
  matches: readonly ParsedMatchExpression[];
  matchConditions: readonly ParsedMatchCondition[];
  queryableMetafieldPatterns: readonly string[];
  relatedSchemas: readonly string[];
}>;

type SyntaxOption = Readonly<{
  name: string;
  syntax: string;
  description: string;
}>;

type SyntaxTable = Readonly<{
  section: string;
  columns: readonly string[];
  rows: readonly (readonly string[])[];
}>;

type SyntaxDocument = Readonly<{
  slug: string;
  title: string;
  description: string;
  sourceUrl: string;
  sourceMarkdownUrl: string;
  grammar: readonly string[];
  options: readonly SyntaxOption[];
  tables: readonly SyntaxTable[];
}>;

const ZERO_WIDTH = /[\u200B-\u200D\u2060\uFEFF]/gu;

function normalizeIdentifier(value: string): string {
  return value
    .replace(ZERO_WIDTH, "")
    .replace(/\\_/gu, "_")
    .replace(/\\([<>|])/gu, "$1")
    .replaceAll("​", "")
    .trim();
}

function normalizeText(value: string): string {
  return value
    .replace(/\r\n?/gu, "\n")
    .replace(ZERO_WIDTH, "")
    .replace(/\\_/gu, "_")
    .replace(/\\([<>|*`\[\]()])/gu, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(/\s+/gu, " ")
    .trim();
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function compareNames(left: Readonly<{ name: string }>, right: Readonly<{ name: string }>): number {
  return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function frontmatterValue(frontmatter: string, key: string): string {
  const lines = frontmatter.split("\n");
  const index = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (index < 0) throw new Error(`Official Markdown is missing ${key} frontmatter.`);
  const first = lines[index]!.slice(key.length + 1).trim();
  if (first && first !== ">-" && first !== "|-" && first !== ">" && first !== "|") {
    return unquote(first);
  }
  const continuation: string[] = [];
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor]!;
    if (!/^\s+/u.test(line)) break;
    continuation.push(line.trim());
  }
  return normalizeText(continuation.join(" "));
}

function frontmatterSource(frontmatter: string, key: "html" | "md"): string {
  const lines = frontmatter.split("\n");
  const sourceIndex = lines.findIndex((line) => line.startsWith("source_url:"));
  if (sourceIndex < 0) throw new Error("Official Markdown is missing source_url frontmatter.");
  for (let cursor = sourceIndex + 1; cursor < lines.length; cursor += 1) {
    const line = lines[cursor]!;
    if (line.length > 0 && !/^\s+/u.test(line)) break;
    const match = new RegExp(`^\\s*${key}:\\s*(.*)$`, "u").exec(line);
    if (!match) continue;
    const first = match[1]!.trim();
    if (first && first !== ">-" && first !== "|-" && first !== ">" && first !== "|") {
      return unquote(first);
    }
    const continuation: string[] = [];
    for (let nested = cursor + 1; nested < lines.length; nested += 1) {
      const candidate = lines[nested]!;
      if (!/^\s{4,}/u.test(candidate)) break;
      continuation.push(candidate.trim());
    }
    return normalizeText(continuation.join(" "));
  }
  throw new Error(`Official Markdown is missing source_url.${key} frontmatter.`);
}

function parsePage(markdown: string, requestedUrl: string): PageMetadata {
  const normalized = markdown.replace(/\r\n?/gu, "\n");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u.exec(normalized);
  if (!match) throw new Error(`${requestedUrl} has no valid YAML frontmatter.`);
  const frontmatter = match[1]!;
  const apiVersion = frontmatterValue(frontmatter, "api_version");
  if (apiVersion !== API_VERSION) {
    throw new Error(`${requestedUrl} resolved to ShopifyQL ${apiVersion}, expected ${API_VERSION}.`);
  }
  const apiName = frontmatterValue(frontmatter, "api_name");
  if (apiName !== "shopifyql" && apiName !== "admin") {
    throw new Error(`${requestedUrl} belongs to unexpected API ${apiName}.`);
  }
  return {
    title: frontmatterValue(frontmatter, "title"),
    description: frontmatterValue(frontmatter, "description"),
    apiVersion,
    sourceHtml: frontmatterSource(frontmatter, "html"),
    sourceMarkdown: frontmatterSource(frontmatter, "md"),
    body: match[2]!.trim(),
  };
}

function headingSection(body: string, heading: string, nextHeadings: readonly string[]): string | null {
  const startMarker = `## ${heading}`;
  const start = body.indexOf(startMarker);
  if (start < 0) return null;
  const contentStart = body.indexOf("\n", start + startMarker.length);
  if (contentStart < 0) return "";
  let end = body.length;
  for (const candidate of nextHeadings) {
    const candidateIndex = body.indexOf(`\n## ${candidate}`, contentStart);
    if (candidateIndex >= 0 && candidateIndex < end) end = candidateIndex;
  }
  return body.slice(contentStart + 1, end).trim();
}

function firstParagraphAfterHeading(body: string, heading: string): string {
  const match = /^# ([^\n]+)$/mu.exec(body);
  if (!match || normalizeIdentifier(match[1]!) !== normalizeIdentifier(heading)) return "";
  const remainder = body.slice((match.index ?? 0) + match[0].length).trim();
  const paragraphs = remainder.split(/\n\s*\n/gu);
  for (const paragraph of paragraphs) {
    if (
      !paragraph.startsWith("#") &&
      !paragraph.startsWith("Examples") &&
      !paragraph.startsWith("```") &&
      !paragraph.startsWith("**Note:")
    ) {
      return normalizeText(paragraph);
    }
  }
  return "";
}

function listBlocks(section: string): readonly Readonly<{ name: string; body: string }>[] {
  const regex = /^\* \*\*([^\n]+)\*\*\n([\s\S]*?)(?=^\* \*\*|^### |^## |(?![\s\S]))/gmu;
  const blocks: { name: string; body: string }[] = [];
  for (const match of section.matchAll(regex)) {
    blocks.push({ name: normalizeIdentifier(match[1]!), body: match[2]!.trim() });
  }
  return blocks;
}

function cleanContentLines(body: string): string[] {
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 &&
        line !== "**deprecated**" &&
        !line.startsWith("```"),
    );
}

function parseFields(section: string, context: string): ParsedField[] {
  return listBlocks(section)
    .map(({ name, body }) => {
      const lines = cleanContentLines(body);
      const typeIndex = lines.findIndex((line) =>
        /^\*\*[A-Z][A-Z0-9_<>]*\*\*$/u.test(normalizeIdentifier(line)),
      );
      if (typeIndex < 0) throw new Error(`${context}.${name} has no documented ShopifyQL type.`);
      const type = normalizeIdentifier(lines[typeIndex]!.slice(2, -2));
      const deprecated = body.includes("**deprecated**");
      const deprecatedMarker = lines.findIndex((line) => line === "**Deprecated:**");
      const formulaIndex = lines.findIndex(
        (line, index) => index > typeIndex && line.startsWith("`") && line.endsWith("`"),
      );
      const contentEndCandidates = [
        formulaIndex >= 0 ? formulaIndex : lines.length,
        deprecatedMarker >= 0 ? deprecatedMarker : lines.length,
      ];
      const contentEnd = Math.min(...contentEndCandidates);
      const description = normalizeText(
        lines
          .slice(typeIndex + 1, contentEnd)
          .filter((line) => !line.startsWith("**"))
          .join(" "),
      );
      const deprecationReason = deprecated
        ? normalizeText(
            lines
              .slice(deprecatedMarker >= 0 ? deprecatedMarker + 1 : contentEnd)
              .filter((line) => !line.startsWith("**"))
              .join(" "),
          )
        : undefined;
      if (!description) throw new Error(`${context}.${name} has no documented description.`);
      if (deprecated && !deprecationReason) {
        throw new Error(`${context}.${name} is deprecated without a documented reason.`);
      }
      return {
        name,
        type,
        description,
        ...(formulaIndex >= 0
          ? { formula: normalizeText(lines[formulaIndex]!.slice(1, -1)) }
          : {}),
        isDeprecated: deprecated,
        ...(deprecationReason ? { deprecationReason } : {}),
      };
    })
    .sort(compareNames);
}

function parseConditions(section: string, schemaName: string): ParsedMatchCondition[] {
  const conditionHeading = /^### ([A-Za-z][A-Za-z0-9]*Conditions)$/gmu;
  const matches = [...section.matchAll(conditionHeading)];
  return matches
    .map((match, index) => {
      const name = match[1]!;
      const start = (match.index ?? 0) + match[0].length;
      const end = index + 1 < matches.length ? matches[index + 1]!.index! : section.length;
      const conditionBody = section.slice(start, end).trim();
      const descriptionParagraph = conditionBody.split(/\n\s*\n/gu)[0] ?? "";
      const fields: ParsedMatchField[] = [];
      // Shopify's generated Markdown escapes underscores in some condition
      // names (for example `distance\_km`). Capture the raw Markdown token and
      // normalize it before persisting the registry; otherwise those fields
      // silently disappear while their unescaped siblings still parse.
      const fieldRegex = /^\* ([a-z](?:[a-z0-9]|\\?_)*)\n\n\s{2}(Filter|Metric)\. ([^\n]+)\n\n\s{2}```ts\n\s{2}([^\n]+)\n\s{2}```/gmu;
      for (const fieldMatch of conditionBody.matchAll(fieldRegex)) {
        fields.push({
          name: normalizeIdentifier(fieldMatch[1]!),
          role: fieldMatch[2] === "Metric" ? "metric" : "filter",
          description: normalizeText(fieldMatch[3]!),
          type: normalizeIdentifier(fieldMatch[4]!),
        });
      }
      if (fields.length === 0) {
        throw new Error(`${schemaName}.${name} has no parsed condition fields.`);
      }
      return {
        name,
        description: normalizeText(descriptionParagraph),
        fields: fields.sort(compareNames),
      };
    })
    .sort(compareNames);
}

function parseMatchExpressions(
  section: string | null,
  conditions: readonly ParsedMatchCondition[],
  schemaName: string,
): ParsedMatchExpression[] {
  if (!section) return [];
  const conditionNames = new Set(conditions.map(({ name }) => name));
  const beforeConditions = section.split(/^### [A-Za-z][A-Za-z0-9]*Conditions$/mu)[0] ?? "";
  const parsed = listBlocks(beforeConditions)
    .map(({ name, body }) => {
      const lines = cleanContentLines(body);
      const typeIndex = lines.findIndex((line) => /^\*\*[A-Za-z][A-Za-z0-9]*Conditions\*\*$/u.test(line));
      if (typeIndex < 0) throw new Error(`${schemaName}.${name} MATCHES expression has no condition type.`);
      const type = normalizeIdentifier(lines[typeIndex]!.slice(2, -2));
      const description = normalizeText(lines.slice(typeIndex + 1).join(" "));
      if (!conditionNames.has(type)) {
        throw new Error(`${schemaName}.${name} points to missing condition type ${type}.`);
      }
      return { name, type, description };
    })
    .sort(compareNames);
  return parsed;
}

function parseRelatedSchemas(section: string | null): string[] {
  if (!section) return [];
  const values: string[] = [];
  const regex = /^\* \[`([^`]+)`\]\([^)]+\):/gmu;
  for (const match of section.matchAll(regex)) values.push(normalizeIdentifier(match[1]!));
  return sortedUnique(values);
}

function queryableMetafields(body: string): string[] {
  if (!body.includes("analyticsQueryable")) return [];
  const patterns = new Set<string>();
  for (const match of body.matchAll(/`([a-z_]+\.metafields\.<namespace>\.<key>)`/gu)) {
    patterns.add(match[1]!);
  }
  if (body.includes("`<owner>.metafields.<namespace>.<key>`")) {
    for (const owner of ["customer", "order", "product", "product_variant"]) {
      patterns.add(`${owner}.metafields.<namespace>.<key>`);
    }
  }
  return sortedUnique([...patterns]);
}

function parseSchema(page: PageMetadata, path: string): ParsedSchema {
  const parts = path.split("/");
  if (parts.length !== 2) throw new Error(`Unexpected ShopifyQL schema path ${path}.`);
  const [domain, expectedName] = parts;
  const name = normalizeIdentifier(page.title);
  if (name !== expectedName) {
    throw new Error(`${path} declares schema ${name}, expected ${expectedName}.`);
  }
  const metricsSection = headingSection(page.body, "Metrics", [
    "Dimensions",
    "MATCHES expressions",
    "Related schemas",
  ]);
  const dimensionsSection = headingSection(page.body, "Dimensions", [
    "MATCHES expressions",
    "Related schemas",
  ]);
  if (!metricsSection || !dimensionsSection) {
    throw new Error(`${name} does not document both Metrics and Dimensions.`);
  }
  const matchesSection = headingSection(page.body, "MATCHES expressions", ["Related schemas"]);
  const conditions = matchesSection ? parseConditions(matchesSection, name) : [];
  const description = firstParagraphAfterHeading(page.body, name);
  if (!description) throw new Error(`${name} has no schema description.`);
  return {
    name,
    domain: domain!,
    description,
    sourceUrl: `${SHOPIFYQL_ROOT}/schemas/${path}`,
    sourceMarkdownUrl: `${SHOPIFYQL_ROOT}/schemas/${path}.md`,
    metrics: parseFields(metricsSection, `${name}.metrics`),
    dimensions: parseFields(dimensionsSection, `${name}.dimensions`),
    matches: parseMatchExpressions(matchesSection, conditions, name),
    matchConditions: conditions,
    queryableMetafieldPatterns: queryableMetafields(page.body),
    relatedSchemas: parseRelatedSchemas(
      headingSection(page.body, "Related schemas", []),
    ),
  };
}

function markdownTables(body: string): SyntaxTable[] {
  const lines = body.split("\n");
  const tables: SyntaxTable[] = [];
  let section = "";
  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^##+\s+(.+)$/u.exec(lines[index]!);
    if (heading) section = normalizeText(heading[1]!);
    if (!lines[index]!.startsWith("|") || !/^\|(?:\s*-+\s*\|)+\s*$/u.test(lines[index + 1] ?? "")) {
      continue;
    }
    const rows: string[][] = [];
    const tableStart = index;
    let cursor = tableStart;
    for (; cursor < lines.length && lines[cursor]!.startsWith("|"); cursor += 1) {
      if (cursor === tableStart + 1) continue;
      rows.push(
        lines[cursor]!
          .slice(1, -1)
          .split(/(?<!\\)\|/gu)
          .map((cell) => normalizeText(cell.replaceAll("`", ""))),
      );
    }
    index = cursor - 1;
    if (rows.length === 0) continue;
    const columns = rows.shift()!;
    tables.push({ section, columns, rows });
  }
  return tables;
}

function codeBlocks(body: string, language: string): string[] {
  const blocks: string[] = [];
  const lines = body.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const opening = /^(\s*)```([^\s`]*)\s*$/u.exec(lines[index]!);
    if (!opening || opening[2] !== language) continue;
    const indentation = opening[1]!;
    const content: string[] = [];
    let cursor = index + 1;
    for (; cursor < lines.length; cursor += 1) {
      if (lines[cursor] === `${indentation}\`\`\``) break;
      const line = lines[cursor]!;
      content.push(line.startsWith(indentation) ? line.slice(indentation.length) : line);
    }
    if (cursor >= lines.length) throw new Error(`Unclosed ${language} Markdown code fence.`);
    blocks.push(content.join("\n").trim());
    index = cursor;
  }
  return blocks;
}

function parseSyntaxOptions(body: string): SyntaxOption[] {
  const values: SyntaxOption[] = [];
  for (const { name, body: optionBody } of listBlocks(body)) {
    const lines = cleanContentLines(optionBody);
    if (lines.length < 2) continue;
    if (!/^\*\*.+\*\*$/u.test(lines[0]!)) continue;
    const syntax = normalizeText(lines[0]!.slice(2, -2));
    const description = normalizeText(
      lines
        .slice(1)
        .filter((line) => !line.startsWith("#") && line !== "Examples")
        .join(" "),
    );
    if (!description) continue;
    values.push({ name, syntax, description });
  }
  return values.sort(compareNames);
}

function parseSyntax(page: PageMetadata, slug: string): SyntaxDocument {
  return {
    slug,
    title: normalizeText(page.title),
    description: page.description,
    sourceUrl: `${SHOPIFYQL_ROOT}/syntax/${slug}`,
    sourceMarkdownUrl: `${SHOPIFYQL_ROOT}/syntax/${slug}.md`,
    grammar: codeBlocks(page.body, "shopifyql").filter((block) =>
      /^(?:FROM \[ORGANIZATION\]|WHERE condition|WHERE match_expression|GROUP BY item|TIMESERIES time_dimension|WITH modifier|HAVING condition|SINCE date_parameter|date_range_clause:|COMPARE TO comparison|ORDER BY column|LIMIT count|VISUALIZE metric_or_alias|ANNOTATE |-- |\/\*)/u.test(
        block,
      ),
    ),
    options: parseSyntaxOptions(page.body),
    tables: markdownTables(page.body),
  };
}

function parseSchemaIndex(page: PageMetadata): readonly Readonly<{
  path: string;
  name: string;
  domain: string;
  description: string;
}>[] {
  const entries: { path: string; name: string; domain: string; description: string }[] = [];
  const regex = /^\| \[`([a-z_]+)`\]\(https:\/\/shopify\.dev\/docs\/api\/shopifyql\/latest\/schemas\/([a-z_]+\/[a-z_]+)\) \| ([^\n]+) \|$/gmu;
  for (const match of page.body.matchAll(regex)) {
    const path = match[2]!;
    entries.push({
      name: match[1]!,
      path,
      domain: path.split("/")[0]!,
      description: normalizeText(match[3]!),
    });
  }
  if (entries.length === 0) throw new Error("ShopifyQL schema index yielded no schemas.");
  return entries.sort(compareNames);
}

function parseFromSchemas(page: PageMetadata): readonly Readonly<{
  name: string;
  description: string;
  documentedReference: boolean;
}>[] {
  const section = headingSection(page.body, "FROM", ["SHOW"]);
  if (!section) throw new Error("FROM documentation has no FROM section.");
  const schemasHeading = section.indexOf("### Schemas");
  const examplesHeading = section.indexOf("### Examples", schemasHeading);
  const schemaSection = section.slice(schemasHeading, examplesHeading >= 0 ? examplesHeading : undefined);
  return listBlocks(schemaSection)
    .map(({ name, body }) => ({
      name,
      description: normalizeText(body.replace(/\[Learn more\]\([^)]+\)/gu, "")),
      documentedReference: body.includes("[Learn more]"),
    }))
    .sort(compareNames);
}

function parseClauses(page: PageMetadata): readonly Readonly<{
  name: string;
  requirement: "required" | "conditional" | "optional";
  description: string;
}>[] {
  const table = markdownTables(page.body).find(({ columns }) =>
    columns.some((column) => column === "Clause"),
  );
  if (!table) throw new Error("ShopifyQL syntax index contains no clause table.");
  return table.rows.map((row) => {
    const requirement = row[1];
    if (requirement !== "required" && requirement !== "conditional" && requirement !== "optional") {
      throw new Error(`Unknown ShopifyQL clause requirement ${requirement}.`);
    }
    return { name: row[0]!, requirement, description: row[2]! };
  });
}

function parseExpressionOperators(page: PageMetadata): SyntaxOption[] {
  const section = headingSection(page.body, "SHOW", []);
  if (!section) return [];
  const expressionsStart = section.indexOf("### Expressions");
  if (expressionsStart < 0) return [];
  const asStart = section.indexOf("### AS", expressionsStart);
  const expressions = section.slice(expressionsStart, asStart < 0 ? undefined : asStart);
  return parseSyntaxOptions(expressions);
}

function parseAnnotationTypes(page: PageMetadata) {
  const table = markdownTables(page.body).find(({ columns }) =>
    columns.includes("Category") && columns.includes("Type"),
  );
  if (!table) throw new Error("ANNOTATE documentation has no annotation type table.");
  let currentCategory = "";
  return table.rows.map((row) => {
    // Shopify's Markdown uses a visually merged first column: the category is
    // present on the first row, while subsequent rows shift type/description/
    // operations left and leave the fourth cell empty.
    const continuation = row[3] === "";
    if (!continuation && row[0]) currentCategory = row[0]!;
    const type = continuation ? row[0] : row[1];
    const description = continuation ? row[1] : row[2];
    const operationsCell = continuation ? row[2] : row[3];
    if (!currentCategory || !type || !description || operationsCell === undefined) {
      throw new Error("Malformed ShopifyQL annotation row.");
    }
    const operations = operationsCell === "Not available"
      ? []
      : operationsCell.split(",").map((value) => value.trim().toLowerCase());
    return {
      category: currentCategory,
      type,
      description,
      graphqlAdminOperations: operations,
    };
  });
}

function requiredTable(page: PageMetadata, columns: readonly string[], context: string): SyntaxTable {
  const table = markdownTables(page.body).find((candidate) =>
    columns.every((column) => candidate.columns.includes(column)),
  );
  if (!table) throw new Error(`${context} documentation is missing its expected table.`);
  return table;
}

function tableOptions(table: SyntaxTable): SyntaxOption[] {
  return table.rows.map((row) => ({ name: row[0]!, syntax: row[1]!, description: row[2]! }));
}

function allOptionTables(page: PageMetadata, context: string): SyntaxOption[] {
  const tables = markdownTables(page.body).filter(({ columns }) =>
    ["Option", "Syntax", "Description"].every((column) => columns.includes(column)),
  );
  if (tables.length === 0) throw new Error(`${context} documentation is missing operator tables.`);
  return tables.flatMap(tableOptions);
}

function sectionLead(section: string, context: string): string {
  const paragraph = section.split(/\n\s*\n/gu).find((candidate) => candidate.trim().length > 0);
  if (!paragraph) throw new Error(`${context} documentation has no description.`);
  return normalizeText(paragraph);
}

function parseWhereFunctions(page: PageMetadata) {
  const section = headingSection(page.body, "Anniversary filters", ["MATCHES"]);
  if (!section) throw new Error("WHERE documentation has no anniversary filter section.");
  const description = sectionLead(section, "anniversary filter");
  const functionName = /`([a-z_]+)\(\)`/u.exec(description)?.[1];
  if (!functionName) throw new Error("WHERE anniversary filter has no documented function name.");
  const supportedOperators = [...description.matchAll(/`(=|!=|BETWEEN)`/gu)].map((match) => match[1]!);
  if (supportedOperators.length === 0) {
    throw new Error("WHERE anniversary filter has no documented supported operators.");
  }
  return [{
    name: functionName,
    syntax: `${functionName}()`,
    description,
    supportedOperators,
  }];
}

function parseMatchOperators(page: PageMetadata): SyntaxOption[] {
  const section = headingSection(page.body, "MATCHES", []);
  if (!section) throw new Error("WHERE documentation has no MATCHES section.");
  const description = sectionLead(section, "MATCHES");
  const grammar = codeBlocks(section, "shopifyql").find((block) => block.includes("match_expression"));
  if (!grammar) throw new Error("WHERE MATCHES documentation has no grammar block.");
  const operators: SyntaxOption[] = [];
  for (const syntax of grammar.split("\n").map((line) => line.trim()).filter(Boolean)) {
    const name = /\b(NOT MATCHES|MATCHES)\b/u.exec(syntax)?.[1];
    if (!name) throw new Error(`Unrecognized MATCHES grammar: ${syntax}.`);
    operators.push({ name, syntax, description });
  }
  return operators.sort(compareNames);
}

function retryDelayMilliseconds(response: Response | null, attempt: number): number {
  const retryAfter = response?.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 10_000);
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return Math.min(Math.max(at - Date.now(), 0), 10_000);
  }
  return Math.min(500 * 2 ** (attempt - 1), 4_000);
}

async function wait(milliseconds: number): Promise<void> {
  await new Promise((resolveWait) => setTimeout(resolveWait, milliseconds));
}

async function fetchMarkdown(url: string): Promise<PageMetadata> {
  const maximumAttempts = 4;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    let response: Response | null = null;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60_000);
    try {
      response = await fetch(url, {
        headers: {
          accept: "text/markdown",
          "user-agent": `Albert-ShopifyQL-Registry/${REGISTRY_VERSION}`,
        },
        redirect: "follow",
        signal: controller.signal,
      });
      const body = await response.text();
      if (!response.ok) {
        throw new Error(
          `${url} returned HTTP ${response.status}: ${body.slice(0, 500).replace(/\s+/gu, " ")}`,
        );
      }
      return parsePage(body, url);
    } catch (error) {
      lastError = error;
      const retryable = response === null || response.status === 429 || response.status >= 500;
      if (!retryable || attempt === maximumAttempts) break;
      await wait(retryDelayMilliseconds(response, attempt));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error(`Unable to fetch official Shopify documentation ${url}.`, { cause: lastError });
}

async function mapLimited<T, U>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<U>,
): Promise<U[]> {
  const results = new Array<U>(values.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await mapper(values[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}

function count<T>(values: readonly T[], predicate: (value: T) => boolean): number {
  return values.reduce((total, value) => total + (predicate(value) ? 1 : 0), 0);
}

async function buildRegistry() {
  const [schemaIndexPage, syntaxIndexPage, adminQueryPage] = await Promise.all([
    fetchMarkdown(`${SHOPIFYQL_ROOT}/schemas.md`),
    fetchMarkdown(`${SHOPIFYQL_ROOT}/syntax.md`),
    fetchMarkdown(`${ADMIN_ROOT}/queries/shopifyqlQuery.md`),
  ]);
  const schemaIndex = parseSchemaIndex(schemaIndexPage);
  const syntaxSlugs = sortedUnique(
    [...syntaxIndexPage.body.matchAll(/https:\/\/shopify\.dev\/docs\/api\/shopifyql\/latest\/syntax\/([a-z0-9-]+)/gu)]
      .map((match) => match[1]!),
  );
  const schemaPages = await mapLimited(schemaIndex, 8, async (entry) => ({
    entry,
    page: await fetchMarkdown(`${SHOPIFYQL_ROOT}/schemas/${entry.path}.md`),
  }));
  const syntaxPages = await mapLimited(syntaxSlugs, 8, async (slug) => ({
    slug,
    page: await fetchMarkdown(`${SHOPIFYQL_ROOT}/syntax/${slug}.md`),
  }));
  const schemas = schemaPages.map(({ page, entry }) => {
    const schema = parseSchema(page, entry.path);
    if (schema.description !== entry.description) {
      // Schema pages provide a richer grain description; the index remains a
      // discovery denominator rather than replacing that source text.
    }
    return schema;
  }).sort(compareNames);
  const syntax = syntaxPages.map(({ page, slug }) => parseSyntax(page, slug)).sort((left, right) =>
    left.slug < right.slug ? -1 : left.slug > right.slug ? 1 : 0,
  );
  const syntaxBySlug = new Map(syntaxPages.map(({ slug, page }) => [slug, page] as const));
  const fromPage = syntaxBySlug.get("from-and-show");
  const annotatePage = syntaxBySlug.get("annotate");
  const wherePage = syntaxBySlug.get("where");
  const havingPage = syntaxBySlug.get("having");
  const timeseriesPage = syntaxBySlug.get("timeseries");
  const datePage = syntaxBySlug.get("since-until-during");
  const comparePage = syntaxBySlug.get("compare-to");
  const withPage = syntaxBySlug.get("with");
  const visualizePage = syntaxBySlug.get("visualize");
  if (!fromPage || !annotatePage || !wherePage || !havingPage || !timeseriesPage || !datePage || !comparePage || !withPage || !visualizePage) {
    throw new Error("Official ShopifyQL syntax index omitted a required planner document.");
  }
  const fromSchemas = parseFromSchemas(fromPage);
  const publicSchemaNames = new Set(schemas.map(({ name }) => name));
  const undocumentedSchemas = fromSchemas.filter(({ name }) => !publicSchemaNames.has(name));

  const allFields = schemas.flatMap((schema) => [...schema.metrics, ...schema.dimensions]);
  const metrics = schemas.flatMap((schema) => schema.metrics);
  const dimensions = schemas.flatMap((schema) => schema.dimensions);
  const matches = schemas.flatMap((schema) => schema.matches);
  const matchConditions = schemas.flatMap((schema) => schema.matchConditions);
  const matchConditionFields = matchConditions.flatMap(({ fields }) => fields);
  const dataTypes = new Map<string, string>();
  for (const page of schemaPages.map(({ page }) => page)) {
    for (const match of page.body.matchAll(/^### ([A-Z][A-Z0-9_\\<>]*)\n\n([^\n]+)/gmu)) {
      const name = normalizeIdentifier(match[1]!);
      if (name.endsWith("Conditions")) continue;
      const description = normalizeText(match[2]!);
      if (!description || description.startsWith("Fields you can use")) continue;
      const existing = dataTypes.get(name);
      if (existing && existing !== description) {
        throw new Error(`ShopifyQL type ${name} has conflicting descriptions.`);
      }
      dataTypes.set(name, description);
    }
  }
  for (const field of [...allFields, ...matchConditionFields]) {
    const base = field.type.replace(/^ARRAY<|>$/gu, "");
    if (!dataTypes.has(base)) {
      throw new Error(`ShopifyQL field type ${field.type} has no documented type definition.`);
    }
  }

  const clauses = parseClauses(syntaxIndexPage);
  const expressionOperators = parseExpressionOperators(fromPage);
  const whereOperators = allOptionTables(wherePage, "WHERE");
  const havingOperators = allOptionTables(havingPage, "HAVING");
  const whereFunctions = parseWhereFunctions(wherePage);
  const matchOperators = parseMatchOperators(wherePage);
  const operatorKey = (value: SyntaxOption) => `${value.name}\u0000${value.syntax}`;
  const uniqueOptions = (values: readonly SyntaxOption[]) =>
    [...new Map(values.map((value) => [operatorKey(value), value] as const)).values()].sort(compareNames);

  const timeseriesTable = requiredTable(timeseriesPage, ["Time dimension", "Default range"], "TIMESERIES");
  const timeseriesTypeSection = headingSection(timeseriesPage.body, "Time dimensions", ["Default date ranges"]);
  if (!timeseriesTypeSection) throw new Error("TIMESERIES documentation has no time dimensions.");
  const timeseriesFormats = new Map(
    parseSyntaxOptions(timeseriesTypeSection).map((entry) => [entry.name, entry] as const),
  );
  const timeseries = timeseriesTable.rows.map((row) => {
    const option = timeseriesFormats.get(row[0]!);
    if (!option) throw new Error(`TIMESERIES ${row[0]} has no format definition.`);
    return { name: row[0]!, format: option.syntax, description: option.description, defaultRange: row[1]! };
  });
  const namedRanges = requiredTable(datePage, ["Named range", "Description"], "named date ranges").rows.map(
    (row) => ({ name: row[0]!, description: row[1]! }),
  );
  const dateFunctions = requiredTable(datePage, ["Time unit", "Functions", "Description"], "date functions").rows.map(
    (row) => ({ unit: row[0]!, syntax: row[1]!, description: row[2]! }),
  );
  const comparisonSection = headingSection(comparePage.body, "Relative comparison periods", ["Generated comparison columns"]);
  if (!comparisonSection) throw new Error("COMPARE TO documentation has no relative periods.");
  const relativeComparisons = parseSyntaxOptions(comparisonSection);
  const modifierSection = headingSection(withPage.body, "Modifiers", ["Generated result columns"]);
  if (!modifierSection) throw new Error("WITH documentation has no modifiers.");
  const modifiers = parseSyntaxOptions(modifierSection);
  const attributionTable = requiredTable(withPage, ["Attribution model", "Credit assignment"], "attribution models");
  const attributionModels = attributionTable.rows
    .filter((row) => row[0] !== "multiple models")
    .map((row) => {
      const suffix = /Column suffix:\s*([^\.]+)\.?$/u.exec(row[1]!)?.[1];
      return { name: row[0]!, description: row[1]!, ...(suffix ? { columnSuffix: suffix } : {}) };
    });
  const visualizationTypes = [...visualizePage.body.matchAll(/^##### `([a-z_]+)`\n\n([^\n]+)/gmu)].map(
    (match) => ({ name: match[1]!, description: normalizeText(match[2]!) }),
  );
  const annotationTypes = parseAnnotationTypes(annotatePage);

  const accessLine = adminQueryPage.body.split("\n").find((line) => line.startsWith("Requires `read_reports`"));
  if (!accessLine) throw new Error("Admin GraphQL shopifyqlQuery docs omit access requirements.");

  const schemaContent = {
    access: {
      graphqlField: "QueryRoot.shopifyqlQuery",
      requiredScope: "read_reports",
      protectedCustomerDataLevel: 2,
      description: normalizeText(accessLine),
      executionDescription: adminQueryPage.description,
      sourceUrl: `${ADMIN_ROOT}/queries/shopifyqlQuery`,
      sourceMarkdownUrl: `${ADMIN_ROOT}/queries/shopifyqlQuery.md`,
    },
    schemaIndex: {
      sourceUrl: `${SHOPIFYQL_ROOT}/schemas`,
      sourceMarkdownUrl: `${SHOPIFYQL_ROOT}/schemas.md`,
      domains: sortedUnique(schemas.map(({ domain }) => domain)),
    },
    schemas,
    undocumentedSchemas: undocumentedSchemas.map(({ name, description }) => ({ name, description })),
    dataTypes: [...dataTypes.entries()]
      .map(([name, description]) => ({ name, description }))
      .sort(compareNames),
    syntax: {
      sourceUrl: `${SHOPIFYQL_ROOT}/syntax`,
      sourceMarkdownUrl: `${SHOPIFYQL_ROOT}/syntax.md`,
      clauses,
      documents: syntax,
      expressionOperators,
      whereOperators: uniqueOptions(whereOperators),
      havingOperators: uniqueOptions(havingOperators),
      whereFunctions,
      matchOperators,
      timeseries,
      namedDateRanges: namedRanges,
      dateFunctions,
      relativeComparisons,
      modifiers,
      attributionModels,
      visualizationTypes,
      annotationTypes,
    },
  };
  const registrySha256 = createHash("sha256")
    .update(JSON.stringify(schemaContent), "utf8")
    .digest("hex");
  const sourceDocuments = 3 + schemaPages.length + syntaxPages.length;
  return {
    registryVersion: REGISTRY_VERSION,
    apiVersion: API_VERSION,
    source: {
      provider: "Shopify",
      api: "ShopifyQL",
      apiVersion: API_VERSION,
      documentationRoot: SHOPIFYQL_ROOT,
      adminGraphqlDocumentationRoot: ADMIN_ROOT,
      sourceDocuments,
      registrySha256,
    },
    counts: {
      sourceDocuments,
      schemas: schemas.length,
      undocumentedSchemas: undocumentedSchemas.length,
      domains: schemaContent.schemaIndex.domains.length,
      metrics: metrics.length,
      dimensions: dimensions.length,
      fields: allFields.length,
      deprecatedMetrics: count(metrics, ({ isDeprecated }) => isDeprecated),
      deprecatedDimensions: count(dimensions, ({ isDeprecated }) => isDeprecated),
      formulas: count(allFields, ({ formula }) => Boolean(formula)),
      dataTypes: dataTypes.size,
      matchExpressions: matches.length,
      matchConditionTypes: matchConditions.length,
      matchConditionFields: matchConditionFields.length,
      queryableMetafieldPatterns: schemas.reduce(
        (total, schema) => total + schema.queryableMetafieldPatterns.length,
        0,
      ),
      relatedSchemaLinks: schemas.reduce((total, schema) => total + schema.relatedSchemas.length, 0),
      syntaxDocuments: syntax.length,
      clauses: clauses.length,
      expressionOperators: expressionOperators.length,
      whereOperators: schemaContent.syntax.whereOperators.length,
      havingOperators: schemaContent.syntax.havingOperators.length,
      whereFunctions: schemaContent.syntax.whereFunctions.length,
      matchOperators: schemaContent.syntax.matchOperators.length,
      timeseriesDimensions: timeseries.length,
      namedDateRanges: namedRanges.length,
      dateFunctions: dateFunctions.length,
      relativeComparisons: relativeComparisons.length,
      modifiers: modifiers.length,
      attributionModels: attributionModels.length,
      visualizationTypes: visualizationTypes.length,
      annotationTypes: annotationTypes.length,
    },
    ...schemaContent,
  };
}

function writeAtomically(path: string, content: string): void {
  const temporaryPath = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temporaryPath, content, { encoding: "utf8", mode: 0o644 });
    renameSync(temporaryPath, path);
  } finally {
    if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
  }
}

const registry = await buildRegistry();
const output = `${JSON.stringify(registry)}\n`;

if (checkOnly) {
  if (!existsSync(outputPath)) {
    throw new Error(`ShopifyQL registry is missing. Run npm run shopifyql:schema:generate.`);
  }
  const current = readFileSync(outputPath, "utf8");
  if (current !== output) {
    let committedHash = "unreadable";
    try {
      committedHash = String(
        (JSON.parse(current) as { source?: { registrySha256?: string } }).source?.registrySha256 ??
          "missing",
      );
    } catch {
      // Byte comparison is authoritative; this value is only diagnostic.
    }
    throw new Error(
      `ShopifyQL ${API_VERSION} registry is stale (committed ${committedHash}, official ${registry.source.registrySha256}). Run npm run shopifyql:schema:generate.`,
    );
  }
  process.stdout.write(
    `ShopifyQL ${API_VERSION} registry is fresh: ${registry.counts.schemas} field-documented + ${registry.counts.undocumentedSchemas} FROM-only schemas, ${registry.counts.metrics} metrics, ${registry.counts.dimensions} dimensions, ${registry.counts.matchConditionFields} MATCHES fields (${registry.source.registrySha256}).\n`,
  );
} else {
  mkdirSync(resolve(outputPath, ".."), { recursive: true });
  writeAtomically(outputPath, output);
  process.stdout.write(
    `Generated ShopifyQL ${API_VERSION} registry: ${registry.counts.schemas} field-documented + ${registry.counts.undocumentedSchemas} FROM-only schemas, ${registry.counts.metrics} metrics, ${registry.counts.dimensions} dimensions, ${registry.counts.matchConditionFields} MATCHES fields at ${outputPath} (${registry.source.registrySha256}).\n`,
  );
}
