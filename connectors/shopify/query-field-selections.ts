import { SHOPIFY_QUERIES } from "./queries.js";
import {
  loadShopifyAdminSchemaRegistry,
  shopifyGraphQLNamedType,
  type ShopifyGraphQLType,
} from "./schema-registry.js";

type SelectionSurface = "curated" | "metafield";

function tokens(source: string): readonly string[] {
  const result: string[] = [];
  for (let offset = 0; offset < source.length;) {
    const character = source[offset]!;
    if (/\s|,/u.test(character)) { offset += 1; continue; }
    if (character === "#") {
      while (offset < source.length && source[offset] !== "\n") offset += 1;
      continue;
    }
    if (source.startsWith("...", offset)) { result.push("..."); offset += 3; continue; }
    if (character === '"') {
      let end = offset + 1;
      while (end < source.length) {
        if (source[end] === "\\") { end += 2; continue; }
        if (source[end] === '"') { end += 1; break; }
        end += 1;
      }
      result.push(source.slice(offset, end));
      offset = end;
      continue;
    }
    if (/[_A-Za-z]/u.test(character)) {
      let end = offset + 1;
      while (end < source.length && /[_0-9A-Za-z]/u.test(source[end]!)) end += 1;
      result.push(source.slice(offset, end));
      offset = end;
      continue;
    }
    if (character === "-" || /[0-9]/u.test(character)) {
      let end = offset + 1;
      while (end < source.length && /[+.0-9Ee-]/u.test(source[end]!)) end += 1;
      result.push(source.slice(offset, end));
      offset = end;
      continue;
    }
    if ("!$():=@[]{|}&".includes(character)) { result.push(character); offset += 1; continue; }
    throw new Error(`Unsupported GraphQL token at ${offset}.`);
  }
  return result;
}

function selectedFields(query: string): ReadonlySet<string> {
  const registry = loadShopifyAdminSchemaRegistry();
  const types = new Map(registry.types.map((type) => [type.name, type]));
  const source = tokens(query);
  let offset = 0;
  const selected = new Set<string>();
  const peek = () => source[offset];
  const take = () => {
    const value = source[offset];
    if (value === undefined) throw new Error("Unexpected end of Shopify GraphQL document.");
    offset += 1;
    return value;
  };
  const skipBalanced = (open: string, close: string) => {
    if (take() !== open) throw new Error(`Expected ${open}.`);
    let depth = 1;
    while (depth > 0) {
      const value = take();
      if (value === open) depth += 1;
      if (value === close) depth -= 1;
    }
  };
  const skipDirectives = () => {
    while (peek() === "@") {
      take(); take();
      if (peek() === "(") skipBalanced("(", ")");
    }
  };
  const walk = (parentName: string): void => {
    const parent = types.get(parentName);
    if (!parent) throw new Error(`Unknown Shopify query parent ${parentName}.`);
    if (take() !== "{") throw new Error(`Expected selection set for ${parentName}.`);
    while (peek() !== "}") {
      if (peek() === "...") {
        take();
        if (take() !== "on") throw new Error("Named Shopify query fragments are not supported.");
        const target = take();
        skipDirectives();
        walk(target);
        continue;
      }
      let fieldName = take();
      if (peek() === ":") { take(); fieldName = take(); }
      if (fieldName !== "__typename") selected.add(`${parentName}.${fieldName}`);
      if (peek() === "(") skipBalanced("(", ")");
      skipDirectives();
      if (peek() === "{") {
        const field = parent.fields?.find(({ name }) => name === fieldName);
        if (!field) throw new Error(`Unknown Shopify field ${parentName}.${fieldName}.`);
        walk(shopifyGraphQLNamedType(field.type));
      }
    }
    take();
  };

  if (take() !== "query") throw new Error("Shopify ingestion documents must be query operations.");
  if (peek() !== "(" && peek() !== "{") take();
  if (peek() === "(") skipBalanced("(", ")");
  skipDirectives();
  walk(registry.roots.query.type);
  return selected;
}

function build(surface: SelectionSurface): ReadonlySet<string> {
  const selected = new Set<string>();
  for (const [stream, plan] of Object.entries(SHOPIFY_QUERIES)) {
    const isMetafield = stream === "shopify_metafield_definitions" || stream === "shopify_metafield_values";
    if ((surface === "metafield") !== isMetafield) continue;
    for (const field of selectedFields(plan.query)) selected.add(field);
  }
  return selected;
}

export const SHOPIFY_CURATED_QUERY_FIELDS = build("curated");
export const SHOPIFY_METAFIELD_QUERY_FIELDS = build("metafield");

export function shopifySelectionValueForm(
  type: ShopifyGraphQLType | undefined,
): "literal_leaf" | "structural_composite" {
  return type && ["OBJECT", "INTERFACE", "UNION"].includes(type.kind)
    ? "structural_composite"
    : "literal_leaf";
}
