import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import ts from "typescript";

import { SQUARE_CONTRACT_LOCK } from "../connectors/square/spec-lock.js";
import {
  SQUARE_READ_STREAMS,
  squareReadRequestContractProbe,
} from "../connectors/square/streams.js";
import type {
  SquareCensusModel,
  SquareCensusShape,
  SquareSdkFieldCensus,
  SquareSdkRequestContract,
} from "../connectors/square/field-census-types.js";

const GENERATOR_VERSION = 2;
const outputPath = resolve("connectors/square/field-census.generated.ts");
const checkOnly = process.argv.includes("--check");
const suppliedPackageDir = process.env.SQUARE_SDK_PACKAGE_DIR;
const requireFromGenerator = createRequire(import.meta.url);
const UNKNOWN_BODY_KEY = "__albert_square_sdk_unknown_contract_key__";

type MutableShape =
  | { kind: "scalar"; type: string }
  | { kind: "unknown"; type: string }
  | { kind: "reference"; target: string }
  | { kind: "array"; item: MutableShape }
  | { kind: "map"; value: MutableShape }
  | { kind: "object"; fields: MutableField[] }
  | { kind: "union"; options: MutableShape[] }
  | { kind: "intersection"; parts: MutableShape[] };
type MutableField = { name: string; optional: boolean; shape: MutableShape };

type SdkOperation = Readonly<{
  method: "GET" | "POST";
  endpoint: string;
  clientSource: string;
  operation: string;
  section: string;
}>;

type SdkWireSerializer = Readonly<{
  parseOrThrow: (value: unknown, options: Record<string, unknown>) => unknown | Promise<unknown>;
  jsonOrThrow: (value: unknown, options: Record<string, unknown>) => unknown | Promise<unknown>;
}>;

function sdkPackageDirectory(): { packageDir: string; cleanup: () => void } {
  if (suppliedPackageDir) {
    return { packageDir: resolve(suppliedPackageDir), cleanup: () => undefined };
  }
  const work = mkdtempSync(join(tmpdir(), "albert-square-census-"));
  const packed = execFileSync("npm", ["pack", SQUARE_CONTRACT_LOCK.sdk.npmSpecifier, "--silent"], {
    cwd: work,
    encoding: "utf8",
  }).trim().split("\n").at(-1);
  if (!packed) throw new Error("npm pack did not return a Square SDK archive name.");
  const archive = join(work, packed);
  const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
  if (digest !== SQUARE_CONTRACT_LOCK.sdk.tarballSha256) {
    throw new Error(`Square SDK archive digest changed: expected ${SQUARE_CONTRACT_LOCK.sdk.tarballSha256}, got ${digest}.`);
  }
  execFileSync("tar", ["-xzf", archive], { cwd: work, stdio: "ignore" });
  return { packageDir: join(work, "package"), cleanup: () => rmSync(work, { recursive: true, force: true }) };
}

function moduleBlock(source: ts.SourceFile, modelName: string): ts.ModuleBlock {
  const declaration = source.statements.find((statement): statement is ts.ModuleDeclaration =>
    ts.isModuleDeclaration(statement) && statement.name.getText(source) === modelName,
  );
  if (!declaration?.body || !ts.isModuleBlock(declaration.body)) {
    throw new Error(`${source.fileName} has no ${modelName} namespace.`);
  }
  return declaration.body;
}

function propertyName(name: ts.PropertyName, source: ts.SourceFile): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return name.getText(source);
}

function compactUnion(options: MutableShape[]): MutableShape {
  const unique = new Map<string, MutableShape>();
  for (const option of options) unique.set(JSON.stringify(option), option);
  const values = [...unique.values()];
  return values.length === 1 ? values[0]! : { kind: "union", options: values };
}

function parserFor(source: ts.SourceFile, block: ts.ModuleBlock) {
  const nested = new Map<string, ts.InterfaceDeclaration | ts.TypeAliasDeclaration>();
  for (const statement of block.statements) {
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
      nested.set(statement.name.text, statement);
    }
  }
  const resolving = new Set<string>();

  const parseMembers = (members: ts.NodeArray<ts.TypeElement>): MutableShape => {
    const fields: MutableField[] = [];
    for (const member of members) {
      if (ts.isPropertySignature(member) && member.name) {
        fields.push({
          name: propertyName(member.name, source),
          optional: Boolean(member.questionToken),
          shape: member.type ? parseType(member.type) : { kind: "unknown", type: "unspecified" },
        });
      } else if (ts.isIndexSignatureDeclaration(member)) {
        fields.push({
          name: "{*}",
          optional: false,
          shape: member.type ? parseType(member.type) : { kind: "unknown", type: "index_signature" },
        });
      }
    }
    return { kind: "object", fields };
  };

  const parseInterface = (node: ts.InterfaceDeclaration): MutableShape => {
    const own = parseMembers(node.members);
    const parents = (node.heritageClauses ?? []).flatMap((clause) => clause.types.map((type) => parseType(type.expression)));
    return parents.length === 0 ? own : { kind: "intersection", parts: [...parents, own] };
  };

  const parseNested = (name: string): MutableShape => {
    if (resolving.has(name)) return { kind: "unknown", type: `recursive_local:${name}` };
    const node = nested.get(name);
    if (!node) return { kind: "unknown", type: `unresolved_local:${name}` };
    resolving.add(name);
    const parsed = ts.isInterfaceDeclaration(node) ? parseInterface(node) : parseType(node.type);
    resolving.delete(name);
    return parsed;
  };

  const parseType = (node: ts.TypeNode | ts.ExpressionWithTypeArguments | ts.Expression): MutableShape => {
    if (ts.isParenthesizedTypeNode(node)) return parseType(node.type);
    if (ts.isUnionTypeNode(node)) {
      const options = node.types
        .filter((part) => part.kind !== ts.SyntaxKind.UndefinedKeyword
          && !(ts.isLiteralTypeNode(part) && part.literal.kind === ts.SyntaxKind.NullKeyword))
        .map(parseType);
      return options.length > 0 ? compactUnion(options) : { kind: "scalar", type: "null" };
    }
    if (ts.isIntersectionTypeNode(node)) return { kind: "intersection", parts: node.types.map(parseType) };
    if (ts.isArrayTypeNode(node)) return { kind: "array", item: parseType(node.elementType) };
    if (ts.isTupleTypeNode(node)) return { kind: "array", item: compactUnion(node.elements.map(parseType)) };
    if (ts.isTypeLiteralNode(node)) return parseMembers(node.members);
    if (ts.isLiteralTypeNode(node)) return { kind: "scalar", type: node.literal.getText(source) };
    if (node.kind === ts.SyntaxKind.StringKeyword) return { kind: "scalar", type: "string" };
    if (node.kind === ts.SyntaxKind.NumberKeyword) return { kind: "scalar", type: "number" };
    if (node.kind === ts.SyntaxKind.BigIntKeyword) return { kind: "scalar", type: "bigint" };
    if (node.kind === ts.SyntaxKind.BooleanKeyword) return { kind: "scalar", type: "boolean" };
    if (node.kind === ts.SyntaxKind.UnknownKeyword || node.kind === ts.SyntaxKind.AnyKeyword) {
      return { kind: "unknown", type: node.kind === ts.SyntaxKind.AnyKeyword ? "any" : "unknown" };
    }
    if (ts.isExpressionWithTypeArguments(node)) return parseType(node.expression);
    if (ts.isTypeReferenceNode(node)) {
      const text = node.typeName.getText(source);
      if ((text === "Array" || text === "ReadonlyArray") && node.typeArguments?.[0]) {
        return { kind: "array", item: parseType(node.typeArguments[0]) };
      }
      if ((text === "Record" || text === "Readonly<Record") && node.typeArguments?.[1]) {
        return { kind: "map", value: parseType(node.typeArguments[1]) };
      }
      const raw = text.match(/(?:^|\.)([A-Za-z0-9_]+)\.Raw$/);
      if (raw?.[1]) return { kind: "reference", target: raw[1] };
      const local = text.match(/^[A-Za-z0-9_]+\.([A-Za-z0-9_]+)$/);
      if (local?.[1] && nested.has(local[1])) return parseNested(local[1]);
      return { kind: "unknown", type: text };
    }
    if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) {
      const text = node.getText(source);
      const raw = text.match(/(?:^|\.)([A-Za-z0-9_]+)\.Raw$/);
      if (raw?.[1]) return { kind: "reference", target: raw[1] };
      const local = text.match(/^[A-Za-z0-9_]+\.([A-Za-z0-9_]+)$/);
      if (local?.[1] && nested.has(local[1])) return parseNested(local[1]);
      return { kind: "unknown", type: text };
    }
    return { kind: "unknown", type: node.getText(source) };
  };

  return { parseInterface, parseType };
}

function parseModel(filePath: string): SquareCensusModel {
  const modelName = basename(filePath, ".d.ts");
  const source = ts.createSourceFile(filePath, readFileSync(filePath, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const block = moduleBlock(source, modelName);
  const raw = block.statements.find(
    (statement): statement is ts.InterfaceDeclaration | ts.TypeAliasDeclaration =>
      (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && statement.name.text === "Raw",
  );
  if (!raw) throw new Error(`${filePath} has no Raw declaration.`);
  const parser = parserFor(source, block);
  const shape = ts.isInterfaceDeclaration(raw) ? parser.parseInterface(raw) : parser.parseType(raw.type);
  return { name: modelName, source: `serialization/types/${basename(filePath)}`, shape: shape as SquareCensusShape };
}

function references(shape: SquareCensusShape, found = new Set<string>()): Set<string> {
  switch (shape.kind) {
    case "reference": found.add(shape.target); break;
    case "array": references(shape.item, found); break;
    case "map": references(shape.value, found); break;
    case "object": for (const field of shape.fields) references(field.shape, found); break;
    case "union": for (const option of shape.options) references(option, found); break;
    case "intersection": for (const part of shape.parts) references(part, found); break;
    default: break;
  }
  return found;
}

function allFiles(directory: string, suffix: string): string[] {
  return readdirSync(directory).map((entry) => join(directory, entry)).filter((entry) => statSync(entry).isFile() && entry.endsWith(suffix));
}

function allFilesRecursive(directory: string, suffix: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const child = join(directory, entry);
    return statSync(child).isDirectory()
      ? allFilesRecursive(child, suffix)
      : child.endsWith(suffix) ? [child] : [];
  });
}

function countPinnedHeaders(directory: string): number {
  let count = 0;
  const visit = (path: string): void => {
    for (const entry of readdirSync(path)) {
      const child = join(path, entry);
      if (statSync(child).isDirectory()) visit(child);
      else if (entry === "Client.js") {
        count += readFileSync(child, "utf8").split(`"${SQUARE_CONTRACT_LOCK.apiVersion}"`).length - 1;
      }
    }
  };
  visit(directory);
  return count;
}

function sdkOperations(packageDir: string): SdkOperation[] {
  const operations: SdkOperation[] = [];
  const clients = allFilesRecursive(join(packageDir, "api", "resources"), "Client.js").sort();
  const errorPattern = /handleNonStatusCodeError\)\(_response\.error,\s*_response\.rawResponse,\s*"(GET|POST)",\s*"([^"]+)"\)/g;
  const methodPattern = /^ {4}([A-Za-z_$][A-Za-z0-9_$]*)\([^)]*\) \{/gm;

  for (const client of clients) {
    const source = readFileSync(client, "utf8");
    const methodStarts = [...source.matchAll(methodPattern)].map((match) => ({
      index: match.index,
      name: match[1]!,
    }));
    for (const match of source.matchAll(errorPattern)) {
      const start = methodStarts.filter((candidate) => candidate.index < match.index).at(-1);
      if (!start) throw new Error(`${client} has an SDK operation without a containing client method.`);
      operations.push({
        method: match[1] as "GET" | "POST",
        endpoint: match[2]!,
        clientSource: relative(packageDir, client).replaceAll("\\", "/"),
        operation: start.name,
        section: source.slice(start.index, match.index + match[0].length),
      });
    }
  }
  if (operations.length === 0) throw new Error("Official SDK contains no generated API operations.");
  return operations;
}

function normalizedEndpoint(endpoint: string): string {
  return endpoint.replace(/\{[^}]+\}/g, "{}");
}

function sdkQueryKeys(operation: SdkOperation): string[] {
  const wrapped = `class SquareSdkContractProbe {\n${operation.section}\n}`;
  const source = ts.createSourceFile(
    operation.clientSource,
    wrapped,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const objects: ts.ObjectLiteralExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === "_queryParams"
      && node.initializer
      && ts.isObjectLiteralExpression(node.initializer)) {
      objects.push(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (objects.length > 1) {
    throw new Error(`${operation.clientSource}#${operation.operation} has multiple SDK query objects.`);
  }
  if (objects.length === 0) return [];

  const keys = objects[0]!.properties.map((property) => {
    if (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) {
      return propertyName(property.name, source);
    }
    throw new Error(
      `${operation.clientSource}#${operation.operation} has an unsupported SDK query property: ${property.getText(source)}.`,
    );
  });
  return [...new Set(keys)].sort();
}

function sdkRequestSerializer(operation: SdkOperation): string | null {
  const matches = [...operation.section.matchAll(
    /body:\s*(serializers(?:\.[A-Za-z_$][A-Za-z0-9_$]*)+)\.jsonOrThrow\(/g,
  )];
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    throw new Error(`${operation.clientSource}#${operation.operation} invokes multiple SDK body serializers.`);
  }
  return matches[0]![1]!.split(".").at(-1)!;
}

function serializerFiles(packageDir: string): ReadonlyMap<string, readonly string[]> {
  const byName = new Map<string, string[]>();
  for (const file of allFilesRecursive(join(packageDir, "serialization"), ".js")) {
    if (basename(file) === "index.js") continue;
    const name = basename(file, ".js");
    const existing = byName.get(name) ?? [];
    existing.push(file);
    byName.set(name, existing);
  }
  return byName;
}

function loadSerializer(
  serializerName: string,
  files: ReadonlyMap<string, readonly string[]>,
): SdkWireSerializer {
  const candidates = files.get(serializerName) ?? [];
  if (candidates.length !== 1) {
    throw new Error(
      `Expected one SDK serializer file for ${serializerName}, found ${candidates.length}: ${candidates.join(", ")}.`,
    );
  }
  const loadedModule = requireFromGenerator(candidates[0]!) as Record<string, unknown>;
  const serializer = loadedModule[serializerName] as Partial<SdkWireSerializer> | undefined;
  if (typeof serializer?.parseOrThrow !== "function" || typeof serializer.jsonOrThrow !== "function") {
    throw new Error(`${candidates[0]} does not export the expected ${serializerName} wire serializer.`);
  }
  return serializer as SdkWireSerializer;
}

async function validateBodyRoundTrip(
  streamId: string,
  body: Readonly<Record<string, unknown>>,
  serializer: SdkWireSerializer,
): Promise<void> {
  const parsed = await serializer.parseOrThrow(body, {
    unrecognizedObjectKeys: "strip",
    allowUnrecognizedUnionMembers: false,
    allowUnrecognizedEnumValues: false,
    skipValidation: false,
    breadcrumbsPrefix: ["request"],
  });
  const serialized = await serializer.jsonOrThrow(parsed, {
    unrecognizedObjectKeys: "strip",
    omitUndefined: true,
  });
  if (!isDeepStrictEqual(serialized, body)) {
    throw new Error(
      `${streamId} body is not lossless through the pinned SDK serializer.\n`
      + `Built: ${JSON.stringify(body)}\nSDK: ${JSON.stringify(serialized)}`,
    );
  }

  const bodyWithUnknown = { ...body, [UNKNOWN_BODY_KEY]: "must-be-stripped" };
  const parsedWithUnknown = await serializer.parseOrThrow(bodyWithUnknown, {
    unrecognizedObjectKeys: "strip",
    allowUnrecognizedUnionMembers: false,
    allowUnrecognizedEnumValues: false,
    skipValidation: false,
    breadcrumbsPrefix: ["request"],
  });
  const serializedWithUnknown = await serializer.jsonOrThrow(parsedWithUnknown, {
    unrecognizedObjectKeys: "strip",
    omitUndefined: true,
  });
  if (serializedWithUnknown !== null
    && typeof serializedWithUnknown === "object"
    && Object.hasOwn(serializedWithUnknown, UNKNOWN_BODY_KEY)) {
    throw new Error(`${streamId} pinned SDK serializer did not strip the unknown-key sentinel.`);
  }
}

async function buildRequestContracts(packageDir: string): Promise<SquareSdkRequestContract[]> {
  const operations = sdkOperations(packageDir);
  const files = serializerFiles(packageDir);
  const contracts: SquareSdkRequestContract[] = [];

  for (const stream of SQUARE_READ_STREAMS) {
    const matches = operations.filter((operation) =>
      operation.method === stream.method
      && normalizedEndpoint(operation.endpoint) === normalizedEndpoint(stream.endpoint));
    if (matches.length !== 1) {
      throw new Error(
        `${stream.id} expected one official SDK ${stream.method} ${stream.endpoint} operation, found ${matches.length}.`,
      );
    }
    const operation = matches[0]!;
    const queryKeys = sdkQueryKeys(operation);
    const probe = squareReadRequestContractProbe(stream);
    const rejectedQueryKeys = Object.keys(probe.query).filter((key) => !queryKeys.includes(key));
    if (rejectedQueryKeys.length > 0) {
      throw new Error(
        `${stream.id} sends query keys absent from the pinned SDK operation: ${rejectedQueryKeys.join(", ")}.`,
      );
    }

    const serializerName = sdkRequestSerializer(operation);
    if (stream.method === "POST") {
      if (!serializerName || probe.body === null) {
        throw new Error(`${stream.id} POST operation has no pinned SDK request serializer/body.`);
      }
      await validateBodyRoundTrip(stream.id, probe.body, loadSerializer(serializerName, files));
    } else if (serializerName !== null || probe.body !== null) {
      throw new Error(`${stream.id} GET operation unexpectedly declares an SDK request body.`);
    }

    contracts.push({
      streamId: stream.id,
      method: stream.method,
      endpoint: operation.endpoint,
      sdkClientSource: operation.clientSource,
      sdkOperation: operation.operation,
      sdkQueryKeys: queryKeys,
      sdkRequestSerializer: serializerName,
      probe,
      validation: {
        exactOperationMatch: true,
        queryKeysAccepted: true,
        bodyWireRoundTrip: stream.method === "POST" ? true : null,
        unknownBodyKeyStripped: stream.method === "POST" ? true : null,
      },
    });
  }
  return contracts;
}

async function buildCensus(packageDir: string): Promise<SquareSdkFieldCensus> {
  const pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as { name: string; version: string };
  if (pkg.name !== SQUARE_CONTRACT_LOCK.sdk.package || pkg.version !== SQUARE_CONTRACT_LOCK.sdk.version) {
    throw new Error(`Expected ${SQUARE_CONTRACT_LOCK.sdk.npmSpecifier}, received ${pkg.name}@${pkg.version}.`);
  }
  const declarations = allFiles(join(packageDir, "serialization", "types"), ".d.ts")
    .filter((file) => basename(file) !== "index.d.ts")
    .sort();
  const available = new Map(declarations.map((file) => {
    const model = parseModel(file);
    return [model.name, model] as const;
  }));
  const roots = [...new Set(SQUARE_READ_STREAMS.map((stream) => stream.rootEntity))].sort();
  const wanted = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (wanted.has(name)) continue;
    const model = available.get(name);
    if (!model) throw new Error(`Square stream census root/reference ${name} is absent from SDK ${pkg.version}.`);
    wanted.add(name);
    for (const reference of references(model.shape)) {
      if (!wanted.has(reference)) queue.push(reference);
    }
  }
  const models = Object.fromEntries(
    [...wanted].sort().map((name) => [name, available.get(name)!]),
  ) as Record<string, SquareCensusModel>;
  const pinnedHeaderOccurrenceCount = countPinnedHeaders(join(packageDir, "api", "resources"));
  if (pinnedHeaderOccurrenceCount === 0) throw new Error("Official SDK contains no pinned Square-Version request headers.");
  const requestContracts = await buildRequestContracts(packageDir);
  return {
    apiVersion: SQUARE_CONTRACT_LOCK.apiVersion,
    sdkPackage: pkg.name,
    sdkVersion: pkg.version,
    sdkTarballSha256: SQUARE_CONTRACT_LOCK.sdk.tarballSha256,
    generatorVersion: GENERATOR_VERSION,
    rawDeclarationCount: declarations.length,
    pinnedHeaderOccurrenceCount,
    rootEntities: roots,
    models,
    requestContracts,
  };
}

function render(census: SquareSdkFieldCensus): string {
  return `/**\n * GENERATED by scripts/generate-square-api-census.mts. DO NOT EDIT.\n * Source: official ${census.sdkPackage}@${census.sdkVersion} wire-format Raw declarations, generated client request contracts, and serializers; Square API ${census.apiVersion}.\n */\nimport type { SquareSdkFieldCensus } from "./field-census-types.js";\n\nexport const SQUARE_SDK_FIELD_CENSUS = ${JSON.stringify(census, null, 2)} as const satisfies SquareSdkFieldCensus;\n`;
}

const acquired = sdkPackageDirectory();
try {
  const generated = render(await buildCensus(acquired.packageDir));
  if (checkOnly) {
    const current = readFileSync(outputPath, "utf8");
    if (current !== generated) throw new Error(`${outputPath} is stale. Run: node --import tsx scripts/generate-square-api-census.mts`);
  } else {
    writeFileSync(outputPath, generated);
  }
} finally {
  acquired.cleanup();
}
