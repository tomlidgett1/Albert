import { SHOPIFY_API_VERSION } from "../connectors/shopify/manifest.js";
import {
  SHOPIFY_DELETION_EVENTS_QUERY,
  SHOPIFY_QUERIES,
} from "../connectors/shopify/queries.js";

const OFFICIAL_SCHEMA_PROXY = `https://shopify.dev/admin-graphql-direct-proxy/${SHOPIFY_API_VERSION}`;
const MAX_ATTEMPTS = 3;

type GraphQLError = Readonly<{
  message?: unknown;
  locations?: unknown;
  path?: unknown;
  extensions?: unknown;
}>;

type GraphQLEnvelope = Readonly<{
  errors?: unknown;
}>;

function errorsFrom(value: unknown): readonly GraphQLError[] {
  // Shopify's official public schema proxy returns execution errors as a
  // top-level array, while successful responses and some GraphQL errors use
  // the standard envelope. Access denial proves validation reached execution;
  // structural drift still carries a schema-validation error code and fails.
  if (Array.isArray(value)) return value as readonly GraphQLError[];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Shopify's schema proxy returned a non-object GraphQL envelope.");
  }
  const errors = (value as GraphQLEnvelope).errors;
  if (errors === undefined) return [];
  if (!Array.isArray(errors)) {
    throw new Error("Shopify's schema proxy returned a malformed GraphQL errors member.");
  }
  return errors as readonly GraphQLError[];
}

function errorCode(error: GraphQLError): string | null {
  if (!error.extensions || typeof error.extensions !== "object" || Array.isArray(error.extensions)) {
    return null;
  }
  const code = (error.extensions as Readonly<Record<string, unknown>>).code;
  return typeof code === "string" ? code : null;
}

function errorMessage(error: GraphQLError): string {
  const message = typeof error.message === "string" ? error.message : "Unknown GraphQL validation error";
  const path = Array.isArray(error.path) ? ` at ${error.path.join(".")}` : "";
  return `${message}${path}`;
}

async function validateQuery(name: string, query: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(OFFICIAL_SCHEMA_PROXY, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "user-agent": "Albert-Shopify-Schema-Check/1.0",
        },
        body: JSON.stringify({
          query,
          variables: {
            first: 1,
            after: null,
            parentAfter: null,
            childAfter: null,
            query: "action:destroy comments:false subject_type:PRODUCT created_at:>='2026-08-11T00:00:00.000Z' created_at:<='2026-08-12T00:00:00.000Z'",
            ownerType: "PRODUCT",
            definitionAfter: null,
            valueAfter: null,
          },
        }),
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        throw new Error(`official schema proxy returned HTTP ${response.status}`);
      }
      const errors = errorsFrom(await response.json());
      if (errors.length > 0 && !errors.every((error) => errorCode(error) === "ACCESS_DENIED")) {
        throw new Error(errors.map(errorMessage).join("; "));
      }
      return;
    } catch (error) {
      lastError = error;
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      }
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${name} is invalid against Shopify Admin GraphQL ${SHOPIFY_API_VERSION}: ${detail}`);
}

async function main(): Promise<void> {
  const queries = [
    ...Object.entries(SHOPIFY_QUERIES).map(([name, plan]) => [name, plan.query] as const),
    ["shopify_deletion_events", SHOPIFY_DELETION_EVENTS_QUERY] as const,
  ];
  for (const [name, query] of queries) {
    await validateQuery(name, query);
  }
  console.log(
    `All ${queries.length} Shopify ingestion queries are valid against the official Admin GraphQL ${SHOPIFY_API_VERSION} schema proxy.`,
  );
}

await main();
