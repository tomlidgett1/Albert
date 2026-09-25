import assert from "node:assert/strict";
import test from "node:test";

import {
  SHOPIFY_DELETION_EVENTS_QUERY,
  SHOPIFY_QUERIES,
} from "../../connectors/shopify/queries.js";
import {
  loadShopifyAdminSchemaRegistry,
  shopifyGraphQLNamedType,
  type ShopifyAdminGraphQLSchemaRegistry,
  type ShopifyGraphQLField,
  type ShopifyGraphQLType,
} from "../../connectors/shopify/schema-registry.js";

type ValidationStats = Readonly<{
  fieldSelections: number;
  argumentUses: number;
  inlineFragments: number;
}>;

type ValidationResult = Readonly<{
  failures: readonly string[];
  stats: ValidationStats;
}>;

type MutableValidationStats = {
  fieldSelections: number;
  argumentUses: number;
  inlineFragments: number;
};

const COMPOSITE_KINDS = new Set<ShopifyGraphQLType["kind"]>([
  "OBJECT",
  "INTERFACE",
  "UNION",
]);

/**
 * This deliberately small lexer covers the executable GraphQL syntax used by
 * Shopify ingestion plans. Keeping the check offline makes schema drift a
 * deterministic contract failure instead of a network-dependent CI result.
 */
function lexGraphQL(source: string): readonly string[] {
  const tokens: string[] = [];

  for (let offset = 0; offset < source.length;) {
    const character = source[offset]!;

    if (/\s|,/u.test(character)) {
      offset += 1;
      continue;
    }

    if (character === "#") {
      while (offset < source.length && source[offset] !== "\n") offset += 1;
      continue;
    }

    if (source.startsWith("...", offset)) {
      tokens.push("...");
      offset += 3;
      continue;
    }

    if (character === '"') {
      if (source.startsWith('"""', offset)) {
        const end = source.indexOf('"""', offset + 3);
        if (end === -1) throw new Error("unterminated GraphQL block string");
        tokens.push(source.slice(offset, end + 3));
        offset = end + 3;
        continue;
      }

      let end = offset + 1;
      let terminated = false;
      while (end < source.length) {
        if (source[end] === "\\") {
          end += 2;
          continue;
        }
        if (source[end] === '"') {
          end += 1;
          terminated = true;
          break;
        }
        end += 1;
      }
      if (!terminated) throw new Error("unterminated GraphQL string");
      tokens.push(source.slice(offset, end));
      offset = end;
      continue;
    }

    if (/[_A-Za-z]/u.test(character)) {
      let end = offset + 1;
      while (end < source.length && /[_0-9A-Za-z]/u.test(source[end]!)) end += 1;
      tokens.push(source.slice(offset, end));
      offset = end;
      continue;
    }

    if (character === "-" || /[0-9]/u.test(character)) {
      let end = offset + 1;
      while (end < source.length && /[+.0-9Ee-]/u.test(source[end]!)) end += 1;
      tokens.push(source.slice(offset, end));
      offset = end;
      continue;
    }

    if ("!$():=@[]{|}&".includes(character)) {
      tokens.push(character);
      offset += 1;
      continue;
    }

    throw new Error(`unsupported GraphQL character ${JSON.stringify(character)} at ${offset}`);
  }

  return tokens;
}

class OfflineShopifyQueryValidator {
  private readonly failures: string[] = [];
  private readonly stats: MutableValidationStats = {
    fieldSelections: 0,
    argumentUses: 0,
    inlineFragments: 0,
  };
  private readonly typesByName: ReadonlyMap<string, ShopifyGraphQLType>;
  private readonly tokens: readonly string[];
  private offset = 0;

  constructor(
    private readonly label: string,
    source: string,
    private readonly registry: ShopifyAdminGraphQLSchemaRegistry,
  ) {
    this.tokens = lexGraphQL(source);
    this.typesByName = new Map(registry.types.map((type) => [type.name, type]));
  }

  validate(): ValidationResult {
    try {
      this.parseOperation();
      if (this.offset !== this.tokens.length) {
        this.fail(`document has ${this.tokens.length - this.offset} trailing token(s)`);
      }
    } catch (error) {
      this.fail(error instanceof Error ? error.message : String(error));
    }

    return {
      failures: this.failures,
      stats: this.stats,
    };
  }

  private peek(): string | undefined {
    return this.tokens[this.offset];
  }

  private take(expected?: string): string {
    const token = this.tokens[this.offset];
    if (token === undefined) {
      throw new Error(
        expected === undefined
          ? "unexpected end of GraphQL document"
          : `expected ${expected}, reached end of GraphQL document`,
      );
    }
    if (expected !== undefined && token !== expected) {
      throw new Error(`expected ${expected}, received ${token}`);
    }
    this.offset += 1;
    return token;
  }

  private fail(message: string): void {
    this.failures.push(`${this.label}: ${message}`);
  }

  private parseOperation(): void {
    if (this.peek() === "{") {
      this.parseSelectionSet(this.registry.roots.query.type, this.registry.roots.query.type);
      return;
    }

    const operation = this.take();
    if (operation !== "query") {
      throw new Error(`ingestion document must be a query operation, received ${operation}`);
    }

    if (this.peek() !== "(" && this.peek() !== "{" && this.peek() !== "@") {
      this.take(); // Optional operation name.
    }
    if (this.peek() === "(") this.skipBalanced("(", ")");
    this.skipDirectives();
    this.parseSelectionSet(this.registry.roots.query.type, this.registry.roots.query.type);
  }

  private parseSelectionSet(parentName: string, path: string): void {
    const parent = this.typesByName.get(parentName);
    if (!parent) {
      this.fail(`${path} resolves to unknown type ${parentName}`);
      this.skipBalanced("{", "}");
      return;
    }
    if (!COMPOSITE_KINDS.has(parent.kind)) {
      this.fail(`${path} resolves to leaf type ${parentName}`);
      this.skipBalanced("{", "}");
      return;
    }

    const fieldsByName = new Map((parent.fields ?? []).map((field) => [field.name, field]));
    this.take("{");

    while (this.peek() !== "}") {
      if (this.peek() === undefined) {
        throw new Error(`unterminated selection set at ${path}`);
      }
      if (this.peek() === "...") {
        this.parseFragment(parent, path);
        continue;
      }
      this.parseField(parent, fieldsByName, path);
    }

    this.take("}");
  }

  private parseFragment(parent: ShopifyGraphQLType, path: string): void {
    this.take("...");

    if (this.peek() === "on") {
      this.take("on");
      const targetName = this.take();
      this.stats.inlineFragments += 1;
      this.validateFragmentTarget(parent, targetName, path);
      this.skipDirectives();
      this.parseSelectionSet(targetName, `${path}<${targetName}>`);
      return;
    }

    if (this.peek() === "@" || this.peek() === "{") {
      this.stats.inlineFragments += 1;
      this.skipDirectives();
      this.parseSelectionSet(parent.name, `${path}<inline>`);
      return;
    }

    const fragmentName = this.take();
    this.fail(`${path} uses unsupported named fragment spread ${fragmentName}`);
    this.skipDirectives();
  }

  private validateFragmentTarget(
    parent: ShopifyGraphQLType,
    targetName: string,
    path: string,
  ): void {
    const target = this.typesByName.get(targetName);
    if (!target) {
      this.fail(`${path} has inline fragment on unknown type ${targetName}`);
      return;
    }
    if (!COMPOSITE_KINDS.has(target.kind)) {
      this.fail(`${path} has inline fragment on non-composite type ${targetName}`);
      return;
    }

    const parentRuntimeTypes = this.runtimeTypes(parent);
    const targetRuntimeTypes = this.runtimeTypes(target);
    const overlaps = [...parentRuntimeTypes].some((name) => targetRuntimeTypes.has(name));
    if (!overlaps) {
      this.fail(`${path} cannot spread ${targetName} within ${parent.name}`);
    }
  }

  private runtimeTypes(type: ShopifyGraphQLType): ReadonlySet<string> {
    return type.kind === "OBJECT" ? new Set([type.name]) : new Set(type.possibleTypes ?? []);
  }

  private parseField(
    parent: ShopifyGraphQLType,
    fieldsByName: ReadonlyMap<string, ShopifyGraphQLField>,
    path: string,
  ): void {
    let fieldName = this.take();
    if (this.peek() === ":") {
      this.take(":");
      fieldName = this.take();
    }
    this.stats.fieldSelections += 1;

    const field = fieldName === "__typename"
      ? ({ name: "__typename", type: "String!", args: [] } as const)
      : fieldsByName.get(fieldName);
    const fieldPath = `${path}.${fieldName}`;
    if (!field) this.fail(`${fieldPath} does not exist on ${parent.name}`);

    const suppliedArguments = this.parseArguments(field, fieldPath);
    if (field) this.validateRequiredArguments(field, suppliedArguments, fieldPath);
    this.skipDirectives();

    const hasSelection = this.peek() === "{";
    if (!field) {
      if (hasSelection) this.skipBalanced("{", "}");
      return;
    }

    const childName = shopifyGraphQLNamedType(field.type);
    const child = this.typesByName.get(childName);
    const isComposite = child !== undefined && COMPOSITE_KINDS.has(child.kind);

    if (isComposite && !hasSelection) {
      this.fail(`${fieldPath} returns ${field.type} and requires a selection set`);
      return;
    }
    if (!isComposite && hasSelection) {
      this.fail(`${fieldPath} returns leaf type ${field.type} and cannot have a selection set`);
      this.skipBalanced("{", "}");
      return;
    }
    if (hasSelection) this.parseSelectionSet(childName, fieldPath);
  }

  private parseArguments(
    field: Pick<ShopifyGraphQLField, "args"> | undefined,
    fieldPath: string,
  ): ReadonlySet<string> {
    const supplied = new Set<string>();
    if (this.peek() !== "(") return supplied;

    const available = new Set((field?.args ?? []).map((argument) => argument.name));
    this.take("(");
    while (this.peek() !== ")") {
      const argumentName = this.take();
      this.take(":");
      this.stats.argumentUses += 1;
      if (supplied.has(argumentName)) {
        this.fail(`${fieldPath} supplies argument ${argumentName} more than once`);
      }
      supplied.add(argumentName);
      if (field && !available.has(argumentName)) {
        this.fail(`${fieldPath} has no argument named ${argumentName}`);
      }
      this.skipValue();
    }
    this.take(")");
    return supplied;
  }

  private validateRequiredArguments(
    field: Pick<ShopifyGraphQLField, "args">,
    supplied: ReadonlySet<string>,
    fieldPath: string,
  ): void {
    for (const argument of field.args) {
      const isRequired = argument.type.endsWith("!") && argument.defaultValue === null;
      if (isRequired && !supplied.has(argument.name)) {
        this.fail(`${fieldPath} is missing required argument ${argument.name}: ${argument.type}`);
      }
    }
  }

  private skipValue(): void {
    if (this.peek() === "$") {
      this.take("$");
      this.take();
      return;
    }
    if (this.peek() === "[") {
      this.take("[");
      while (this.peek() !== "]") this.skipValue();
      this.take("]");
      return;
    }
    if (this.peek() === "{") {
      this.take("{");
      while (this.peek() !== "}") {
        this.take();
        this.take(":");
        this.skipValue();
      }
      this.take("}");
      return;
    }
    this.take();
  }

  private skipDirectives(): void {
    while (this.peek() === "@") {
      this.take("@");
      this.take();
      if (this.peek() === "(") this.skipBalanced("(", ")");
    }
  }

  private skipBalanced(open: string, close: string): void {
    this.take(open);
    let depth = 1;
    while (depth > 0) {
      const token = this.take();
      if (token === open) depth += 1;
      if (token === close) depth -= 1;
    }
  }
}

function validateQuery(
  label: string,
  source: string,
  registry = loadShopifyAdminSchemaRegistry(),
): ValidationResult {
  return new OfflineShopifyQueryValidator(label, source, registry).validate();
}

test("every committed Shopify ingestion query resolves against the offline Admin GraphQL registry", () => {
  const registry = loadShopifyAdminSchemaRegistry();
  const failures: string[] = [];
  const totals: MutableValidationStats = {
    fieldSelections: 0,
    argumentUses: 0,
    inlineFragments: 0,
  };

  for (const [stream, plan] of Object.entries(SHOPIFY_QUERIES)) {
    const result = validateQuery(stream, plan.query, registry);
    failures.push(...result.failures);
    totals.fieldSelections += result.stats.fieldSelections;
    totals.argumentUses += result.stats.argumentUses;
    totals.inlineFragments += result.stats.inlineFragments;
  }
  const deletionEvents = validateQuery(
    "shopify_deletion_events",
    SHOPIFY_DELETION_EVENTS_QUERY,
    registry,
  );
  failures.push(...deletionEvents.failures);
  totals.fieldSelections += deletionEvents.stats.fieldSelections;
  totals.argumentUses += deletionEvents.stats.argumentUses;
  totals.inlineFragments += deletionEvents.stats.inlineFragments;

  assert.deepEqual(failures, []);
  assert.equal(registry.apiVersion, "2026-07");
  assert.equal(registry.counts.types, 3_544);
  assert.equal(registry.counts.fields, 9_291);
  assert.equal(Object.keys(SHOPIFY_QUERIES).length, 15);
  assert.deepEqual(totals, {
    fieldSelections: 728,
    argumentUses: 76,
    inlineFragments: 10,
  });
});

const NEGATIVE_FIXTURES = [
  {
    name: "unknown field",
    query: "query UnknownField { shop { albertMissingField } }",
    expected: /QueryRoot\.shop\.albertMissingField does not exist on Shop/u,
  },
  {
    name: "unknown argument",
    query: "query UnknownArgument { shop(first: 1) { id } }",
    expected: /QueryRoot\.shop has no argument named first/u,
  },
  {
    name: "leaf subselection",
    query: "query LeafSubselection { shop { id { __typename } } }",
    expected: /QueryRoot\.shop\.id returns leaf type ID! and cannot have a selection set/u,
  },
  {
    name: "missing composite subselection",
    query: "query MissingSubselection { shop }",
    expected: /QueryRoot\.shop returns Shop! and requires a selection set/u,
  },
  {
    name: "impossible union fragment",
    query: `query ImpossibleUnionFragment {
      discountNodes(first: 1) {
        nodes { discount { ... on Product { id } } }
      }
    }`,
    expected: /cannot spread Product within Discount/u,
  },
] as const;

test("the offline walker rejects each protected schema-drift failure class", async (context) => {
  for (const fixture of NEGATIVE_FIXTURES) {
    await context.test(fixture.name, () => {
      const result = validateQuery(fixture.name, fixture.query);
      assert.equal(result.failures.length, 1, result.failures.join("\n"));
      assert.match(result.failures[0]!, fixture.expected);
    });
  }
});
