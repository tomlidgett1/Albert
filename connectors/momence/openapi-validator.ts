import type { RawSourceRecord } from "../../packages/connector-sdk/src/index.js";
import { MOMENCE_ENTITY_VALIDATION_CONTRACTS } from "./openapi-coverage.generated.js";
import type {
  MomenceEntitySchema,
  MomenceEntityValidationContract,
  MomenceJsonPrimitive,
} from "./openapi-coverage-types.js";
import type { MomenceStreamId } from "./streams.js";

export type MomenceEntityValidationIssue = NonNullable<RawSourceRecord["validationIssues"]>[number];

const CONTRACT_BY_STREAM = new Map(
  MOMENCE_ENTITY_VALIDATION_CONTRACTS.map((contract) => [contract.streamId, contract]),
);

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function propertyPath(path: string, property: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(property)
    ? `${path}.${property}`
    : `${path}[${JSON.stringify(property)}]`;
}

function issue(
  code: MomenceEntityValidationIssue["code"],
  path: string,
  message: string,
): MomenceEntityValidationIssue {
  return { code, path, message };
}

function primitiveDescription(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && !Number.isFinite(value)) return "non-finite number";
  return typeof value;
}

function enumLabel(values: readonly MomenceJsonPrimitive[]): string {
  return values.map((value) => JSON.stringify(value)).join(", ");
}

function validateAgainstSchema(
  schema: MomenceEntitySchema,
  value: unknown,
  path: string,
): MomenceEntityValidationIssue[] {
  if (value === null) {
    if (schema.nullable) return [];
    return [issue(
      "schema_invalid",
      path,
      `Expected ${schema.kind} from ${schema.sourcePointer}, received null.`,
    )];
  }

  if (schema.kind === "union") {
    const results = schema.variants.map((variant) => validateAgainstSchema(variant, value, path));
    const matching = results.filter((result) => result.length === 0).length;
    if (schema.mode === "anyOf" ? matching > 0 : matching === 1) return [];
    if (schema.mode === "oneOf" && matching > 1) {
      return [issue(
        "schema_invalid",
        path,
        `Value matches more than one oneOf variant from ${schema.sourcePointer}.`,
      )];
    }
    return results
      .map((result) => [...result].sort(compareIssues))
      .sort((left, right) => left.length - right.length ||
        JSON.stringify(left).localeCompare(JSON.stringify(right), "en"))[0] ?? [issue(
          "schema_invalid",
          path,
          `Value does not match ${schema.mode} from ${schema.sourcePointer}.`,
        )];
  }

  if (schema.kind === "array") {
    if (!Array.isArray(value)) {
      return [issue(
        "schema_invalid",
        path,
        `Expected array from ${schema.sourcePointer}, received ${primitiveDescription(value)}.`,
      )];
    }
    return value.flatMap((item, index) => validateAgainstSchema(schema.items, item, `${path}[${index}]`));
  }

  if (schema.kind === "object") {
    if (!isObject(value)) {
      return [issue(
        "schema_invalid",
        path,
        `Expected object from ${schema.sourcePointer}, received ${primitiveDescription(value)}.`,
      )];
    }
    const issues: MomenceEntityValidationIssue[] = [];
    const required = new Set(schema.required);
    for (const name of schema.required) {
      if (!Object.hasOwn(value, name)) {
        issues.push(issue(
          "schema_invalid",
          propertyPath(path, name),
          `Missing required Momence field declared at ${schema.sourcePointer}.`,
        ));
      }
    }
    for (const [name, child] of Object.entries(schema.properties)) {
      if (Object.hasOwn(value, name)) {
        issues.push(...validateAgainstSchema(child, value[name], propertyPath(path, name)));
      } else if (!required.has(name)) {
        continue;
      }
    }
    for (const name of Object.keys(value).sort()) {
      if (Object.hasOwn(schema.properties, name)) continue;
      const childPath = propertyPath(path, name);
      if (schema.additionalProperties === false) {
        issues.push(issue(
          "schema_drift",
          childPath,
          `Undocumented Momence field is absent from the pinned schema at ${schema.sourcePointer}.`,
        ));
      } else if (schema.additionalProperties !== true) {
        issues.push(...validateAgainstSchema(schema.additionalProperties, value[name], childPath));
      }
    }
    return issues;
  }

  if (schema.kind !== "unknown") {
    const validType = schema.kind === "integer"
      ? typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)
      : schema.kind === "number"
        ? typeof value === "number" && Number.isFinite(value)
        : typeof value === schema.kind;
    if (!validType) {
      return [issue(
        "schema_invalid",
        path,
        `Expected ${schema.kind} from ${schema.sourcePointer}, received ${primitiveDescription(value)}.`,
      )];
    }
  }
  if (schema.enumValues && !schema.enumValues.some((candidate) => Object.is(candidate, value))) {
    return [issue(
      "schema_invalid",
      path,
      `Value is outside the Momence enum [${enumLabel(schema.enumValues)}] declared at ${schema.sourcePointer}.`,
    )];
  }
  return [];
}

function compareIssues(left: MomenceEntityValidationIssue, right: MomenceEntityValidationIssue): number {
  return left.path.localeCompare(right.path, "en") ||
    left.code.localeCompare(right.code, "en") ||
    left.message.localeCompare(right.message, "en");
}

export function momenceEntityValidationContract(
  streamId: MomenceStreamId,
): MomenceEntityValidationContract {
  const contract = CONTRACT_BY_STREAM.get(streamId);
  if (!contract) throw new Error(`Momence stream ${streamId} has no generated entity validation contract.`);
  return contract;
}

/**
 * Validates one extracted entity, not its paginated response envelope. Any
 * issue is fail-visible to staging, while the caller continues to retain the
 * exact raw provider payload for drift diagnosis and replay.
 */
export function validateMomenceEntity(
  streamId: MomenceStreamId,
  value: unknown,
): readonly MomenceEntityValidationIssue[] {
  const { schema } = momenceEntityValidationContract(streamId);
  const unique = new Map<string, MomenceEntityValidationIssue>();
  for (const validationIssue of validateAgainstSchema(schema, value, "$")) {
    unique.set(
      `${validationIssue.code}\u0000${validationIssue.path}\u0000${validationIssue.message}`,
      validationIssue,
    );
  }
  return [...unique.values()].sort(compareIssues);
}
