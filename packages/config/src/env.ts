/**
 * Central, fail-fast runtime configuration. Secret values are never included
 * in thrown errors or readiness responses.
 */

import { ALBERT_BLOCKING_QUESTIONS_CONTRACT_DIGEST } from "./blocking-questions.js";
import { withWebReleaseIdentity } from "./vercel-runtime.js";

export type RuntimeMode =
  | "web"
  | "worker"
  | "transform-worker"
  | "deletion-worker"
  | "webhook-gateway"
  | "semantic-query"
  | "anthropic-analytics"
  | "operator-diagnostic"
  | "migration";

export type RuntimeReadiness = Readonly<{
  ready: boolean;
  mode: RuntimeMode;
  missing: readonly string[];
  invalid: readonly string[];
}>;

const requirements: Readonly<Record<RuntimeMode, readonly string[]>> = {
  web: [
    "NEXT_PUBLIC_SUPABASE_URL",
    "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
    "ALBERT_OAUTH_STATE_SECRET",
    "ALBERT_OAUTH_WORKER_SIGNING_SECRET",
    "ALBERT_SEMANTIC_SIGNING_SECRET",
    "ALBERT_SEMANTIC_PROFILE_SIGNING_SECRET",
    "ALBERT_ANTHROPIC_SIGNING_SECRET",
    "ALBERT_USER_HASH_SECRET",
    "ALBERT_PUBLIC_ORIGIN",
    "SYNC_WORKER_INTERNAL_URL",
    "SEMANTIC_QUERY_SERVICE_URL",
    "ANTHROPIC_ANALYTICS_SERVICE_URL",
    "OPERATOR_DIAGNOSTIC_SERVICE_URL",
    "ALBERT_OPERATOR_DIAGNOSTIC_SIGNING_SECRET",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "LIGHTSPEED_CLIENT_ID",
    "XERO_CLIENT_ID",
    "DEPUTY_CLIENT_ID",
    "ALBERT_ANALYTICAL_RUNTIME",
  ],
  worker: [
    "SUPABASE_STORAGE_S3_ENDPOINT",
    "SUPABASE_STORAGE_S3_REGION",
    "SUPABASE_STORAGE_S3_ACCESS_KEY_ID",
    "SUPABASE_STORAGE_S3_LEGACY_ANON_KEY",
    "ALBERT_RAW_STORAGE_SYNC_PASSWORD",
    "CONTROL_PLANE_DATABASE_URL",
    "ANALYTICAL_DATABASE_URL",
    "TOKEN_ENCRYPTION_KEY",
    "TOKEN_ENCRYPTION_KEY_ID",
    "ALBERT_OAUTH_WORKER_SIGNING_SECRET",
    "ALBERT_PUBLIC_ORIGIN",
    "LIGHTSPEED_CLIENT_ID",
    "LIGHTSPEED_CLIENT_SECRET",
    "XERO_CLIENT_ID",
    "XERO_DAILY_REQUEST_LIMIT",
    "DEPUTY_CLIENT_ID",
    "DEPUTY_CLIENT_SECRET",
    "ALBERT_WORKER_ID",
  ],
  "transform-worker": [
    "TRANSFORM_CONTROL_PLANE_DATABASE_URL",
    "TRANSFORM_DATABASE_URL",
    "ALBERT_TRANSFORM_WORKER_ID",
  ],
  "deletion-worker": [
    "SUPABASE_STORAGE_S3_ENDPOINT",
    "SUPABASE_STORAGE_S3_REGION",
    "SUPABASE_STORAGE_S3_ACCESS_KEY_ID",
    "SUPABASE_STORAGE_S3_LEGACY_ANON_KEY",
    "ALBERT_RAW_STORAGE_DELETION_PASSWORD",
    "CONTROL_PLANE_DATABASE_URL",
    "DELETION_ANALYTICAL_DATABASE_URL",
    "TOKEN_ENCRYPTION_KEY",
    "TOKEN_ENCRYPTION_KEY_ID",
    "LIGHTSPEED_CLIENT_ID",
    "LIGHTSPEED_CLIENT_SECRET",
    "XERO_CLIENT_ID",
    "DELETION_PROOF_HMAC_KEY",
    "ALBERT_DELETION_WORKER_ID",
  ],
  "webhook-gateway": [
    "SUPABASE_STORAGE_S3_ENDPOINT",
    "SUPABASE_STORAGE_S3_REGION",
    "SUPABASE_STORAGE_S3_ACCESS_KEY_ID",
    "SUPABASE_STORAGE_S3_LEGACY_ANON_KEY",
    "ALBERT_RAW_STORAGE_WEBHOOK_PASSWORD",
    "CONTROL_PLANE_DATABASE_URL",
    "XERO_WEBHOOK_SIGNING_KEY",
    "WEBHOOK_ATTESTATION_KEY_ID",
    "WEBHOOK_ATTESTATION_SECRET",
    "WEBHOOK_INBOX_ENCRYPTION_KEY",
    "WEBHOOK_INBOX_ENCRYPTION_KEY_ID",
    "ALBERT_WEBHOOK_WORKER_ID",
    "DEPUTY_WEBHOOK_ENCRYPTION_KEY",
    "DEPUTY_WEBHOOK_ENCRYPTION_KEY_ID",
  ],
  "semantic-query": [
    "CONTROL_PLANE_DATABASE_URL",
    "ANALYTICAL_DATABASE_URL",
    "ALBERT_SEMANTIC_METADATA_DATABASE_URL",
    "ALBERT_SEMANTIC_SIGNING_SECRET",
    "ALBERT_ANALYTICAL_RUNTIME",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
  ],
  "anthropic-analytics": [
    "ANTHROPIC_CONTROL_PLANE_DATABASE_URL",
    "ALBERT_ANTHROPIC_SIGNING_SECRET",
    "ALBERT_SEMANTIC_SIGNING_SECRET",
    "SEMANTIC_QUERY_SERVICE_URL",
  ],
  "operator-diagnostic": [
    "OPERATOR_DIAGNOSTIC_CONTROL_PLANE_DATABASE_URL",
    "OPERATOR_DIAGNOSTIC_ANALYTICAL_DATABASE_URL",
    "ALBERT_OPERATOR_DIAGNOSTIC_SIGNING_SECRET",
  ],
  migration: ["CONTROL_PLANE_DATABASE_URL", "ANALYTICAL_DATABASE_URL"],
};

const productionRequirements: Readonly<Record<RuntimeMode, readonly string[]>> =
  {
    web: [
      "ALBERT_CONTROL_PLANE_PROJECT_REF",
      "ALBERT_CONTROL_PLANE_REGION",
      "ALBERT_MODEL_DATA_RESIDENCY_REGION",
      "ALBERT_MODEL_DATA_CONTROL_APPROVED",
      "ALBERT_LIGHTSPEED_PRODUCT",
      "ALBERT_CONVERSATION_RUNTIME",
      "ALBERT_ALLOW_FIXTURE_RUNTIME",
      "ALBERT_BLOCKING_QUESTIONS_APPROVED_DIGEST",
      "ALBERT_SERVICE_VERSION",
      "ALBERT_DEPLOYMENT_ID",
    ],
    worker: [
      "ALBERT_CONTROL_PLANE_PROJECT_REF",
      "ALBERT_CONTROL_PLANE_REGION",
      "ALBERT_ANALYTICAL_REGION",
      "ALBERT_LIGHTSPEED_PRODUCT",
      "ALBERT_SERVICE_VERSION",
      "ALBERT_DEPLOYMENT_ID",
    ],
    "transform-worker": [
      "ALBERT_CONTROL_PLANE_PROJECT_REF",
      "ALBERT_CONTROL_PLANE_REGION",
      "ALBERT_ANALYTICAL_REGION",
      "ALBERT_SERVICE_VERSION",
      "ALBERT_DEPLOYMENT_ID",
    ],
    "deletion-worker": [
      "ALBERT_CONTROL_PLANE_PROJECT_REF",
      "ALBERT_CONTROL_PLANE_REGION",
      "ALBERT_ANALYTICAL_REGION",
      "ALBERT_SERVICE_VERSION",
      "ALBERT_DEPLOYMENT_ID",
    ],
    "webhook-gateway": [
      "ALBERT_CONTROL_PLANE_PROJECT_REF",
      "ALBERT_CONTROL_PLANE_REGION",
      "ALBERT_SERVICE_VERSION",
      "ALBERT_DEPLOYMENT_ID",
    ],
    "semantic-query": [
      "ALBERT_CONTROL_PLANE_PROJECT_REF",
      "ALBERT_CONTROL_PLANE_REGION",
      "ALBERT_ANALYTICAL_REGION",
      "ALBERT_MODEL_DATA_RESIDENCY_REGION",
      "ALBERT_MODEL_DATA_CONTROL_APPROVED",
      "ALBERT_SERVICE_VERSION",
      "ALBERT_DEPLOYMENT_ID",
    ],
    "anthropic-analytics": [
      "ALBERT_CONTROL_PLANE_PROJECT_REF",
      "ALBERT_CONTROL_PLANE_REGION",
      "ALBERT_MODEL_DATA_RESIDENCY_REGION",
      "ALBERT_MODEL_DATA_CONTROL_APPROVED",
      "ALBERT_ANTHROPIC_APP8_APPROVED",
      "ALBERT_ANTHROPIC_ZDR_APPROVED",
      "ALBERT_ANTHROPIC_LOAD_TEST_APPROVED",
      "ALBERT_ANTHROPIC_PROVIDER",
      "ALBERT_ANTHROPIC_BEDROCK_MODEL",
      "ALBERT_ANTHROPIC_BEDROCK_FALLBACK_MODEL",
      "AWS_REGION",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "ALBERT_SERVICE_VERSION",
      "ALBERT_DEPLOYMENT_ID",
    ],
    "operator-diagnostic": [
      "ALBERT_CONTROL_PLANE_PROJECT_REF",
      "ALBERT_CONTROL_PLANE_REGION",
      "ALBERT_ANALYTICAL_REGION",
      "ALBERT_SERVICE_VERSION",
      "ALBERT_DEPLOYMENT_ID",
    ],
    migration: [
      "ALBERT_CONTROL_PLANE_PROJECT_REF",
      "ALBERT_CONTROL_PLANE_REGION",
      "ALBERT_ANALYTICAL_REGION",
    ],
  };

const databaseLoginByMode: Readonly<
  Record<RuntimeMode, Readonly<Record<string, string>>>
> = Object.freeze({
  web: Object.freeze({}),
  worker: Object.freeze({
    CONTROL_PLANE_DATABASE_URL: "albert_sync_control_runtime",
    ANALYTICAL_DATABASE_URL: "albert_ingest_runtime",
  }),
  "transform-worker": Object.freeze({
    TRANSFORM_CONTROL_PLANE_DATABASE_URL: "albert_transform_control_runtime",
    TRANSFORM_DATABASE_URL: "albert_transform_analytical_runtime",
  }),
  "deletion-worker": Object.freeze({
    CONTROL_PLANE_DATABASE_URL: "albert_deletion_control_runtime",
    DELETION_ANALYTICAL_DATABASE_URL: "albert_deletion_analytical_runtime",
  }),
  "webhook-gateway": Object.freeze({
    CONTROL_PLANE_DATABASE_URL: "albert_webhook_control_runtime",
  }),
  "semantic-query": Object.freeze({
    CONTROL_PLANE_DATABASE_URL: "albert_semantic_control_runtime",
    ANALYTICAL_DATABASE_URL: "albert_semantic_read_runtime",
    ALBERT_SEMANTIC_METADATA_DATABASE_URL: "albert_semantic_metadata_runtime",
  }),
  "anthropic-analytics": Object.freeze({
    ANTHROPIC_CONTROL_PLANE_DATABASE_URL: "albert_anthropic_control_runtime",
  }),
  "operator-diagnostic": Object.freeze({
    OPERATOR_DIAGNOSTIC_CONTROL_PLANE_DATABASE_URL:
      "albert_operator_diagnostic_control_runtime",
    OPERATOR_DIAGNOSTIC_ANALYTICAL_DATABASE_URL:
      "albert_operator_diagnostic_analytical_runtime",
  }),
  migration: Object.freeze({
    CONTROL_PLANE_DATABASE_URL: "albert_control_deployer",
    ANALYTICAL_DATABASE_URL: "albert_analytical_deployer",
  }),
});

const SYDNEY_REGION = "ap-southeast-2";
const AU_OPENAI_BASE_URL = "https://au.api.openai.com/v1";

const webForbiddenProductionValues = Object.freeze([
  "CONTROL_PLANE_DATABASE_URL",
  "ANALYTICAL_DATABASE_URL",
  "TRANSFORM_CONTROL_PLANE_DATABASE_URL",
  "TRANSFORM_DATABASE_URL",
  "DELETION_ANALYTICAL_DATABASE_URL",
  "ALBERT_SEMANTIC_METADATA_DATABASE_URL",
  "OPERATOR_DIAGNOSTIC_CONTROL_PLANE_DATABASE_URL",
  "OPERATOR_DIAGNOSTIC_ANALYTICAL_DATABASE_URL",
  "ANTHROPIC_CONTROL_PLANE_DATABASE_URL",
  "ANTHROPIC_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_AUTH_ADMIN_SERVICE_ROLE_KEY",
  "SUPABASE_STORAGE_S3_ACCESS_KEY_ID",
  "SUPABASE_STORAGE_S3_LEGACY_ANON_KEY",
  "SUPABASE_STORAGE_S3_SECRET_ACCESS_KEY",
  "ALBERT_RAW_STORAGE_SYNC_PASSWORD",
  "ALBERT_RAW_STORAGE_WEBHOOK_PASSWORD",
  "ALBERT_RAW_STORAGE_DELETION_PASSWORD",
  "TOKEN_ENCRYPTION_KEY",
  "TOKEN_ENCRYPTION_KEY_ID",
  "TOKEN_PREVIOUS_ENCRYPTION_KEYS",
  "LIGHTSPEED_CLIENT_SECRET",
  "DEPUTY_CLIENT_SECRET",
  "XERO_WEBHOOK_SIGNING_KEY",
  "WEBHOOK_ATTESTATION_KEY_ID",
  "WEBHOOK_ATTESTATION_SECRET",
  "WEBHOOK_INBOX_ENCRYPTION_KEY",
  "DEPUTY_WEBHOOK_ENCRYPTION_KEY",
  "DELETION_PROOF_HMAC_KEY",
  "CONTROL_PLANE_ADMIN_DATABASE_URL",
  "ANALYTICAL_ADMIN_DATABASE_URL",
]);

export function runtimeEnvironmentRequirementNames(
  mode: RuntimeMode,
  production = false,
): readonly string[] {
  return Object.freeze([
    ...new Set([
      ...requirements[mode],
      ...(production ? productionRequirements[mode] : []),
    ]),
  ]);
}

function isAllowedServiceUrl(value: string, allowLocalHttp: boolean): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    return (
      url.protocol === "https:" ||
      (allowLocalHttp &&
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(url.hostname))
    );
  } catch {
    return false;
  }
}

function isCleanOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function parsedPostgresUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "postgres:" || url.protocol === "postgresql:"
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

function databaseLoginMatches(url: URL, expectedLogin: string): boolean {
  let login: string;
  try {
    login = decodeURIComponent(url.username);
  } catch {
    return false;
  }
  if (login === expectedLogin) return true;
  // Supabase transaction/session poolers suffix custom PostgreSQL role names
  // with a project ref. Keep the role exact while permitting that transport
  // form for either the control or an analytical Supabase project.
  return new RegExp(`^${expectedLogin}\\.[a-z0-9]{20}$`, "u").test(login);
}

function databaseMatchesControlProject(url: URL, projectRef: string): boolean {
  let login: string;
  try {
    login = decodeURIComponent(url.username);
  } catch {
    return false;
  }
  return (
    url.hostname === `db.${projectRef}.supabase.co` ||
    login.endsWith(`.${projectRef}`)
  );
}

function databaseRequiresTls(url: URL): boolean {
  if (["localhost", "127.0.0.1", "::1"].includes(url.hostname)) return false;
  const sslMode = url.searchParams.get("sslmode")?.toLowerCase();
  return (
    sslMode === "require" ||
    sslMode === "verify-ca" ||
    sslMode === "verify-full"
  );
}

function databaseTarget(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const url = parsedPostgresUrl(value.trim());
  if (!url) return undefined;
  const database = url.pathname.replace(/^\/+/, "") || "postgres";
  let login = "";
  try {
    login = decodeURIComponent(url.username);
  } catch {
    return undefined;
  }
  const poolerProjectRef = /\.([a-z0-9]{20})$/u.exec(login)?.[1];
  return (
    `${url.hostname.toLowerCase()}:${url.port || "5432"}/${database}` +
    (poolerProjectRef ? `#${poolerProjectRef}` : "")
  );
}

function projectRefMatchesSupabaseUrl(
  value: string,
  projectRef: string,
): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === `${projectRef}.supabase.co` &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function projectRefMatchesStorageEndpoint(
  value: string,
  projectRef: string,
): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === `${projectRef}.storage.supabase.co` &&
      url.pathname.replace(/\/+$/u, "") === "/storage/v1/s3" &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

function looksLikeCanonicalBase64UrlKey(
  value: string,
  byteLength: number,
): boolean {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return false;
  try {
    const binary = atob(
      value
        .replace(/-/g, "+")
        .replace(/_/g, "/")
        .padEnd(Math.ceil(value.length / 4) * 4, "="),
    );
    const canonical = btoa(binary)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/u, "");
    return binary.length === byteLength && canonical === value;
  } catch {
    return false;
  }
}

function encodedJsonKeyValues(value: string | undefined): readonly string[] {
  if (!value?.trim()) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return [];
    return Object.values(parsed as Record<string, unknown>).filter(
      (item): item is string => typeof item === "string",
    );
  } catch {
    return [];
  }
}

export function inspectRuntimeEnvironment(
  mode: RuntimeMode,
  inputSource: Readonly<Record<string, string | undefined>> = process.env,
): RuntimeReadiness {
  const source =
    mode === "web" ? withWebReleaseIdentity(inputSource) : inputSource;
  const production = source.NODE_ENV === "production";
  const requiredNames = runtimeEnvironmentRequirementNames(mode, production);
  const missing = requiredNames.filter((name) => !source[name]?.trim());
  const invalid: string[] = [];
  const allowLocalHttp = !production;

  if (
    mode === "anthropic-analytics" &&
    !production &&
    !source.ANTHROPIC_API_KEY?.trim()
  ) {
    missing.push("ANTHROPIC_API_KEY");
  }

  if (
    source.XERO_ENABLE_ADVANCED_JOURNALS !== undefined &&
    !["true", "false"].includes(source.XERO_ENABLE_ADVANCED_JOURNALS)
  ) {
    invalid.push("XERO_ENABLE_ADVANCED_JOURNALS");
  }
  if (
    source.XERO_DAILY_REQUEST_LIMIT !== undefined &&
    !["1000", "5000"].includes(source.XERO_DAILY_REQUEST_LIMIT)
  ) {
    invalid.push("XERO_DAILY_REQUEST_LIMIT");
  }
  if (
    source.ALBERT_OPENAI_TRACING_ENABLED !== undefined &&
    !["true", "false"].includes(source.ALBERT_OPENAI_TRACING_ENABLED)
  ) {
    invalid.push("ALBERT_OPENAI_TRACING_ENABLED");
  }
  if (
    source.ALBERT_ANALYTICAL_RUNTIME !== undefined &&
    !["v1", "v2"].includes(source.ALBERT_ANALYTICAL_RUNTIME.trim())
  ) {
    invalid.push("ALBERT_ANALYTICAL_RUNTIME");
  }
  if (
    mode === "semantic-query" &&
    source.ALBERT_ANALYTICAL_RUNTIME?.trim() === "v2" &&
    !/^[a-f0-9]{64}$/u.test(
      source.ALBERT_SEMANTIC_V2_PUBLICATION_HASH?.trim() ?? "",
    )
  ) {
    invalid.push("ALBERT_SEMANTIC_V2_PUBLICATION_HASH");
  }
  if (source.ALBERT_TURN_TIMEOUT_MS !== undefined) {
    const timeout = Number(source.ALBERT_TURN_TIMEOUT_MS);
    if (!Number.isInteger(timeout) || timeout < 30_000 || timeout > 300_000)
      invalid.push("ALBERT_TURN_TIMEOUT_MS");
  }

  for (const name of [
    "NEXT_PUBLIC_SUPABASE_URL",
    "SYNC_WORKER_INTERNAL_URL",
    "SEMANTIC_QUERY_SERVICE_URL",
    "ANTHROPIC_ANALYTICS_SERVICE_URL",
    "OPERATOR_DIAGNOSTIC_SERVICE_URL",
    "OPENAI_BASE_URL",
    "ALBERT_PUBLIC_ORIGIN",
    "WEBHOOK_GATEWAY_PUBLIC_URL",
    "SUPABASE_STORAGE_S3_ENDPOINT",
  ]) {
    const value = source[name]?.trim();
    if (value && !isAllowedServiceUrl(value, allowLocalHttp))
      invalid.push(name);
  }

  if (production) {
    if (mode === "web") {
      for (const name of webForbiddenProductionValues) {
        if (source[name]?.trim()) invalid.push(name);
      }
    }
    if (source.ALBERT_CONTROL_PLANE_REGION?.trim() !== SYDNEY_REGION) {
      invalid.push("ALBERT_CONTROL_PLANE_REGION");
    }
    if (
      productionRequirements[mode].includes("ALBERT_ANALYTICAL_REGION") &&
      source.ALBERT_ANALYTICAL_REGION?.trim() !== SYDNEY_REGION
    ) {
      invalid.push("ALBERT_ANALYTICAL_REGION");
    }
    if (
      requirements[mode].includes("SUPABASE_STORAGE_S3_REGION") &&
      source.SUPABASE_STORAGE_S3_REGION?.trim() !== SYDNEY_REGION
    ) {
      invalid.push("SUPABASE_STORAGE_S3_REGION");
    }
    if (
      productionRequirements[mode].includes(
        "ALBERT_MODEL_DATA_RESIDENCY_REGION",
      ) &&
      source.ALBERT_MODEL_DATA_RESIDENCY_REGION?.trim() !== "au"
    ) {
      invalid.push("ALBERT_MODEL_DATA_RESIDENCY_REGION");
    }
    if (
      productionRequirements[mode].includes(
        "ALBERT_MODEL_DATA_CONTROL_APPROVED",
      ) &&
      source.ALBERT_MODEL_DATA_CONTROL_APPROVED?.trim() !== "true"
    ) {
      invalid.push("ALBERT_MODEL_DATA_CONTROL_APPROVED");
    }
    if (
      productionRequirements[mode].includes("ALBERT_LIGHTSPEED_PRODUCT") &&
      source.ALBERT_LIGHTSPEED_PRODUCT?.trim() !== "r-series"
    ) {
      invalid.push("ALBERT_LIGHTSPEED_PRODUCT");
    }
    if (mode === "web") {
      if (source.ALBERT_CONVERSATION_RUNTIME?.trim() !== "live") {
        invalid.push("ALBERT_CONVERSATION_RUNTIME");
      }
      if (source.ALBERT_ALLOW_FIXTURE_RUNTIME?.trim() !== "false") {
        invalid.push("ALBERT_ALLOW_FIXTURE_RUNTIME");
      }
      if (
        source.ALBERT_BLOCKING_QUESTIONS_APPROVED_DIGEST?.trim() !==
        ALBERT_BLOCKING_QUESTIONS_CONTRACT_DIGEST
      ) {
        invalid.push("ALBERT_BLOCKING_QUESTIONS_APPROVED_DIGEST");
      }
    }
    if (
      ["web", "semantic-query"].includes(mode) &&
      productionRequirements[mode].includes(
        "ALBERT_MODEL_DATA_RESIDENCY_REGION",
      ) &&
      source.OPENAI_BASE_URL?.trim().replace(/\/+$/u, "") !== AU_OPENAI_BASE_URL
    ) {
      invalid.push("OPENAI_BASE_URL");
    }
    if (mode === "anthropic-analytics") {
      for (const name of [
        "ALBERT_ANTHROPIC_APP8_APPROVED",
        "ALBERT_ANTHROPIC_ZDR_APPROVED",
        "ALBERT_ANTHROPIC_LOAD_TEST_APPROVED",
      ]) {
        if (source[name]?.trim() !== "true") invalid.push(name);
      }
      if (source.ALBERT_ANTHROPIC_PROVIDER?.trim() !== "bedrock")
        invalid.push("ALBERT_ANTHROPIC_PROVIDER");
      if (source.AWS_REGION?.trim() !== SYDNEY_REGION)
        invalid.push("AWS_REGION");
      const primaryProfile =
        source.ALBERT_ANTHROPIC_BEDROCK_MODEL?.trim() ?? "";
      const fallbackProfile =
        source.ALBERT_ANTHROPIC_BEDROCK_FALLBACK_MODEL?.trim() ?? "";
      const auProfile = (value: string, family: "opus" | "sonnet") =>
        (value.startsWith("au.") ||
          /^arn:aws:bedrock:ap-southeast-(?:2|4):[0-9]{12}:inference-profile\/au\./u.test(
            value,
          )) &&
        new RegExp(`anthropic\\.claude-${family}-5`, "iu").test(value);
      if (!auProfile(primaryProfile, "opus"))
        invalid.push("ALBERT_ANTHROPIC_BEDROCK_MODEL");
      if (!auProfile(fallbackProfile, "sonnet"))
        invalid.push("ALBERT_ANTHROPIC_BEDROCK_FALLBACK_MODEL");
      if (source.ANTHROPIC_API_KEY?.trim()) invalid.push("ANTHROPIC_API_KEY");
    }
    if (
      productionRequirements[mode].includes("ALBERT_SERVICE_VERSION") &&
      !/^[a-f0-9]{40}$/u.test(source.ALBERT_SERVICE_VERSION?.trim() ?? "")
    ) {
      invalid.push("ALBERT_SERVICE_VERSION");
    }
    if (
      productionRequirements[mode].includes("ALBERT_DEPLOYMENT_ID") &&
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(
        source.ALBERT_DEPLOYMENT_ID?.trim() ?? "",
      )
    ) {
      invalid.push("ALBERT_DEPLOYMENT_ID");
    }

    const projectRef = source.ALBERT_CONTROL_PLANE_PROJECT_REF?.trim();
    if (
      productionRequirements[mode].includes(
        "ALBERT_CONTROL_PLANE_PROJECT_REF",
      ) &&
      !/^[a-z0-9]{20}$/u.test(projectRef ?? "")
    ) {
      invalid.push("ALBERT_CONTROL_PLANE_PROJECT_REF");
    }
    if (
      projectRef &&
      source.NEXT_PUBLIC_SUPABASE_URL?.trim() &&
      !projectRefMatchesSupabaseUrl(
        source.NEXT_PUBLIC_SUPABASE_URL.trim(),
        projectRef,
      )
    ) {
      invalid.push("NEXT_PUBLIC_SUPABASE_URL");
    }
    if (
      projectRef &&
      source.SUPABASE_STORAGE_S3_ENDPOINT?.trim() &&
      !projectRefMatchesStorageEndpoint(
        source.SUPABASE_STORAGE_S3_ENDPOINT.trim(),
        projectRef,
      )
    ) {
      invalid.push("SUPABASE_STORAGE_S3_ENDPOINT");
    }

    for (const [name, expectedLogin] of Object.entries(
      databaseLoginByMode[mode],
    )) {
      const value = source[name]?.trim();
      if (!value) continue;
      const databaseUrl = parsedPostgresUrl(value);
      if (
        !databaseUrl ||
        !databaseLoginMatches(databaseUrl, expectedLogin) ||
        !databaseRequiresTls(databaseUrl)
      ) {
        invalid.push(name);
      }
      if (
        projectRef &&
        (name === "CONTROL_PLANE_DATABASE_URL" ||
          name === "ANTHROPIC_CONTROL_PLANE_DATABASE_URL" ||
          name === "TRANSFORM_CONTROL_PLANE_DATABASE_URL" ||
          name === "OPERATOR_DIAGNOSTIC_CONTROL_PLANE_DATABASE_URL") &&
        databaseUrl &&
        !databaseMatchesControlProject(databaseUrl, projectRef)
      ) {
        invalid.push(name);
      }
    }

    const controlTarget = databaseTarget(
      source.CONTROL_PLANE_DATABASE_URL ??
        source.TRANSFORM_CONTROL_PLANE_DATABASE_URL ??
        source.OPERATOR_DIAGNOSTIC_CONTROL_PLANE_DATABASE_URL ??
        source.ANTHROPIC_CONTROL_PLANE_DATABASE_URL,
    );
    const analyticalTarget = databaseTarget(
      source.ANALYTICAL_DATABASE_URL ??
        source.TRANSFORM_DATABASE_URL ??
        source.DELETION_ANALYTICAL_DATABASE_URL ??
        source.OPERATOR_DIAGNOSTIC_ANALYTICAL_DATABASE_URL,
    );
    if (
      controlTarget &&
      analyticalTarget &&
      controlTarget === analyticalTarget
    ) {
      invalid.push(
        mode === "transform-worker"
          ? "TRANSFORM_DATABASE_URL"
          : mode === "deletion-worker"
            ? "DELETION_ANALYTICAL_DATABASE_URL"
            : mode === "operator-diagnostic"
              ? "OPERATOR_DIAGNOSTIC_ANALYTICAL_DATABASE_URL"
              : "ANALYTICAL_DATABASE_URL",
      );
    }
  }
  if (
    source.ALBERT_PUBLIC_ORIGIN?.trim() &&
    !isCleanOrigin(source.ALBERT_PUBLIC_ORIGIN.trim())
  ) {
    invalid.push("ALBERT_PUBLIC_ORIGIN");
  }

  if (
    source.TOKEN_ENCRYPTION_KEY?.trim() &&
    !looksLikeCanonicalBase64UrlKey(source.TOKEN_ENCRYPTION_KEY.trim(), 32)
  ) {
    invalid.push("TOKEN_ENCRYPTION_KEY");
  }
  const tokenKeyId = source.TOKEN_ENCRYPTION_KEY_ID?.trim();
  if (tokenKeyId && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(tokenKeyId)) {
    invalid.push("TOKEN_ENCRYPTION_KEY_ID");
  }
  const tokenPreviousKeys = source.TOKEN_PREVIOUS_ENCRYPTION_KEYS?.trim();
  if (tokenPreviousKeys) {
    let previousKeysInvalid = false;
    try {
      const parsed = JSON.parse(tokenPreviousKeys) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        previousKeysInvalid = true;
      } else {
        const entries = Object.entries(parsed as Record<string, unknown>);
        const seenValues = new Set<string>();
        if (entries.length > 4) previousKeysInvalid = true;
        for (const [keyId, key] of entries) {
          if (
            !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(keyId) ||
            keyId === tokenKeyId ||
            typeof key !== "string" ||
            !looksLikeCanonicalBase64UrlKey(key, 32) ||
            key === source.TOKEN_ENCRYPTION_KEY?.trim() ||
            seenValues.has(key)
          )
            previousKeysInvalid = true;
          if (typeof key === "string") seenValues.add(key);
        }
      }
    } catch {
      previousKeysInvalid = true;
    }
    if (previousKeysInvalid) invalid.push("TOKEN_PREVIOUS_ENCRYPTION_KEYS");
  }
  if (
    source.DEPUTY_WEBHOOK_ENCRYPTION_KEY?.trim() &&
    !looksLikeCanonicalBase64UrlKey(
      source.DEPUTY_WEBHOOK_ENCRYPTION_KEY.trim(),
      32,
    )
  ) {
    invalid.push("DEPUTY_WEBHOOK_ENCRYPTION_KEY");
  }
  if (
    source.DEPUTY_WEBHOOK_ENCRYPTION_KEY?.trim() &&
    source.DEPUTY_WEBHOOK_ENCRYPTION_KEY === source.TOKEN_ENCRYPTION_KEY
  ) {
    invalid.push("DEPUTY_WEBHOOK_ENCRYPTION_KEY");
  }
  if (
    source.DEPUTY_WEBHOOK_ENCRYPTION_KEY?.trim() &&
    source.DEPUTY_WEBHOOK_ENCRYPTION_KEY === source.XERO_WEBHOOK_SIGNING_KEY
  ) {
    invalid.push("DEPUTY_WEBHOOK_ENCRYPTION_KEY");
  }
  if (
    source.WEBHOOK_INBOX_ENCRYPTION_KEY?.trim() &&
    !looksLikeCanonicalBase64UrlKey(
      source.WEBHOOK_INBOX_ENCRYPTION_KEY.trim(),
      32,
    )
  ) {
    invalid.push("WEBHOOK_INBOX_ENCRYPTION_KEY");
  }
  const webhookAttestationKeyId = source.WEBHOOK_ATTESTATION_KEY_ID?.trim();
  if (
    webhookAttestationKeyId &&
    !/^[a-z][a-z0-9._-]{0,63}$/u.test(webhookAttestationKeyId)
  ) {
    invalid.push("WEBHOOK_ATTESTATION_KEY_ID");
  }
  const webhookAttestationSecret = source.WEBHOOK_ATTESTATION_SECRET?.trim();
  if (
    webhookAttestationSecret &&
    !looksLikeCanonicalBase64UrlKey(webhookAttestationSecret, 32)
  ) {
    invalid.push("WEBHOOK_ATTESTATION_SECRET");
  }
  if (
    source.WEBHOOK_INBOX_ENCRYPTION_KEY?.trim() &&
    source.WEBHOOK_INBOX_ENCRYPTION_KEY === source.DEPUTY_WEBHOOK_ENCRYPTION_KEY
  ) {
    invalid.push("WEBHOOK_INBOX_ENCRYPTION_KEY");
  }

  for (const name of [
    "ALBERT_OAUTH_STATE_SECRET",
    "ALBERT_OAUTH_WORKER_SIGNING_SECRET",
    "ALBERT_SEMANTIC_SIGNING_SECRET",
    "ALBERT_SEMANTIC_PROFILE_SIGNING_SECRET",
    "ALBERT_ANTHROPIC_SIGNING_SECRET",
    "ALBERT_OPERATOR_DIAGNOSTIC_SIGNING_SECRET",
    "ALBERT_USER_HASH_SECRET",
    "DELETION_PROOF_HMAC_KEY",
  ]) {
    const value = source[name]?.trim();
    if (value && new TextEncoder().encode(value).byteLength < 32)
      invalid.push(name);
  }
  const operatorDiagnosticSecret =
    source.ALBERT_OPERATOR_DIAGNOSTIC_SIGNING_SECRET?.trim();
  if (
    operatorDiagnosticSecret &&
    [
      source.ALBERT_OAUTH_STATE_SECRET?.trim(),
      source.ALBERT_OAUTH_WORKER_SIGNING_SECRET?.trim(),
      source.ALBERT_SEMANTIC_SIGNING_SECRET?.trim(),
      source.ALBERT_USER_HASH_SECRET?.trim(),
    ].some((candidate) => candidate === operatorDiagnosticSecret)
  ) {
    invalid.push("ALBERT_OPERATOR_DIAGNOSTIC_SIGNING_SECRET");
  }
  const anthropicSigningSecret = source.ALBERT_ANTHROPIC_SIGNING_SECRET?.trim();
  if (
    anthropicSigningSecret &&
    [
      source.ALBERT_OAUTH_STATE_SECRET?.trim(),
      source.ALBERT_OAUTH_WORKER_SIGNING_SECRET?.trim(),
      source.ALBERT_SEMANTIC_SIGNING_SECRET?.trim(),
      source.ALBERT_OPERATOR_DIAGNOSTIC_SIGNING_SECRET?.trim(),
      source.ALBERT_USER_HASH_SECRET?.trim(),
    ].some((candidate) => candidate === anthropicSigningSecret)
  ) {
    invalid.push("ALBERT_ANTHROPIC_SIGNING_SECRET");
  }
  const semanticProfileSigningSecret =
    source.ALBERT_SEMANTIC_PROFILE_SIGNING_SECRET?.trim();
  if (
    semanticProfileSigningSecret &&
    [
      source.ALBERT_OAUTH_STATE_SECRET?.trim(),
      source.ALBERT_OAUTH_WORKER_SIGNING_SECRET?.trim(),
      source.ALBERT_SEMANTIC_SIGNING_SECRET?.trim(),
      source.ALBERT_ANTHROPIC_SIGNING_SECRET?.trim(),
      source.ALBERT_OPERATOR_DIAGNOSTIC_SIGNING_SECRET?.trim(),
      source.ALBERT_USER_HASH_SECRET?.trim(),
    ].some((candidate) => candidate === semanticProfileSigningSecret)
  ) {
    invalid.push("ALBERT_SEMANTIC_PROFILE_SIGNING_SECRET");
  }

  const deputyWebhookKeyId = source.DEPUTY_WEBHOOK_ENCRYPTION_KEY_ID?.trim();
  if (
    deputyWebhookKeyId &&
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(deputyWebhookKeyId)
  ) {
    invalid.push("DEPUTY_WEBHOOK_ENCRYPTION_KEY_ID");
  }
  const deputyPreviousKeys =
    source.DEPUTY_WEBHOOK_PREVIOUS_ENCRYPTION_KEYS?.trim();
  if (deputyPreviousKeys) {
    let previousKeysInvalid = false;
    try {
      const parsed = JSON.parse(deputyPreviousKeys) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        previousKeysInvalid = true;
      } else {
        const entries = Object.entries(parsed as Record<string, unknown>);
        const seenValues = new Set<string>();
        if (entries.length > 4) previousKeysInvalid = true;
        for (const [keyId, key] of entries) {
          if (
            !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(keyId) ||
            keyId === deputyWebhookKeyId ||
            typeof key !== "string" ||
            !looksLikeCanonicalBase64UrlKey(key, 32) ||
            key === source.DEPUTY_WEBHOOK_ENCRYPTION_KEY?.trim() ||
            key === source.TOKEN_ENCRYPTION_KEY ||
            key === source.WEBHOOK_INBOX_ENCRYPTION_KEY ||
            key === source.XERO_WEBHOOK_SIGNING_KEY ||
            seenValues.has(key)
          )
            previousKeysInvalid = true;
          if (typeof key === "string") seenValues.add(key);
        }
      }
    } catch {
      previousKeysInvalid = true;
    }
    if (previousKeysInvalid)
      invalid.push("DEPUTY_WEBHOOK_PREVIOUS_ENCRYPTION_KEYS");
  }

  const xeroInboxKeyId = source.WEBHOOK_INBOX_ENCRYPTION_KEY_ID?.trim();
  if (xeroInboxKeyId && !/^[a-z][a-z0-9._-]{0,63}$/u.test(xeroInboxKeyId)) {
    invalid.push("WEBHOOK_INBOX_ENCRYPTION_KEY_ID");
  }
  const xeroPreviousKeys =
    source.WEBHOOK_INBOX_PREVIOUS_ENCRYPTION_KEYS?.trim();
  if (xeroPreviousKeys) {
    let previousKeysInvalid = false;
    try {
      const parsed = JSON.parse(xeroPreviousKeys) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        previousKeysInvalid = true;
      } else {
        const entries = Object.entries(parsed as Record<string, unknown>);
        const seenValues = new Set<string>();
        if (entries.length > 4) previousKeysInvalid = true;
        for (const [keyId, key] of entries) {
          if (
            !/^[a-z][a-z0-9._-]{0,63}$/u.test(keyId) ||
            keyId === xeroInboxKeyId ||
            typeof key !== "string" ||
            !looksLikeCanonicalBase64UrlKey(key, 32) ||
            key === source.WEBHOOK_INBOX_ENCRYPTION_KEY?.trim() ||
            seenValues.has(key)
          )
            previousKeysInvalid = true;
          if (typeof key === "string") seenValues.add(key);
        }
      }
    } catch {
      previousKeysInvalid = true;
    }
    if (previousKeysInvalid)
      invalid.push("WEBHOOK_INBOX_PREVIOUS_ENCRYPTION_KEYS");
  }

  const deputyKeyValues = new Set(
    [
      source.DEPUTY_WEBHOOK_ENCRYPTION_KEY?.trim(),
      ...encodedJsonKeyValues(source.DEPUTY_WEBHOOK_PREVIOUS_ENCRYPTION_KEYS),
    ].filter((value): value is string => Boolean(value)),
  );
  const xeroInboxKeyValues = new Set(
    [
      source.WEBHOOK_INBOX_ENCRYPTION_KEY?.trim(),
      ...encodedJsonKeyValues(source.WEBHOOK_INBOX_PREVIOUS_ENCRYPTION_KEYS),
    ].filter((value): value is string => Boolean(value)),
  );
  const tokenKeyValues = new Set(
    [
      source.TOKEN_ENCRYPTION_KEY?.trim(),
      ...encodedJsonKeyValues(source.TOKEN_PREVIOUS_ENCRYPTION_KEYS),
    ].filter((value): value is string => Boolean(value)),
  );
  if ([...tokenKeyValues].some((key) => deputyKeyValues.has(key))) {
    invalid.push("TOKEN_PREVIOUS_ENCRYPTION_KEYS");
  }
  if ([...tokenKeyValues].some((key) => xeroInboxKeyValues.has(key))) {
    invalid.push("TOKEN_PREVIOUS_ENCRYPTION_KEYS");
  }
  if ([...xeroInboxKeyValues].some((key) => deputyKeyValues.has(key))) {
    invalid.push("WEBHOOK_INBOX_ENCRYPTION_KEY");
  }
  const xeroSigningKey = source.XERO_WEBHOOK_SIGNING_KEY?.trim();
  if (xeroSigningKey && xeroInboxKeyValues.has(xeroSigningKey)) {
    invalid.push("WEBHOOK_INBOX_ENCRYPTION_KEY");
  }
  if (xeroSigningKey && deputyKeyValues.has(xeroSigningKey)) {
    invalid.push("DEPUTY_WEBHOOK_ENCRYPTION_KEY");
  }
  if (
    webhookAttestationSecret &&
    (xeroSigningKey === webhookAttestationSecret ||
      xeroInboxKeyValues.has(webhookAttestationSecret) ||
      deputyKeyValues.has(webhookAttestationSecret) ||
      tokenKeyValues.has(webhookAttestationSecret))
  ) {
    invalid.push("WEBHOOK_ATTESTATION_SECRET");
  }

  for (const name of [
    "CONTROL_PLANE_DATABASE_URL",
    "ANALYTICAL_DATABASE_URL",
    "TRANSFORM_CONTROL_PLANE_DATABASE_URL",
    "TRANSFORM_DATABASE_URL",
    "DELETION_ANALYTICAL_DATABASE_URL",
    "ALBERT_SEMANTIC_METADATA_DATABASE_URL",
  ]) {
    const value = source[name]?.trim();
    if (!value) continue;
    try {
      const protocol = new URL(value).protocol;
      if (protocol !== "postgres:" && protocol !== "postgresql:")
        invalid.push(name);
    } catch {
      invalid.push(name);
    }
  }

  return Object.freeze({
    ready: missing.length === 0 && invalid.length === 0,
    mode,
    missing: Object.freeze([...missing]),
    invalid: Object.freeze([...new Set(invalid)]),
  });
}

export function assertRuntimeEnvironment(
  mode: RuntimeMode,
  source: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const result = inspectRuntimeEnvironment(mode, source);
  if (result.ready) return;

  const parts = [
    result.missing.length ? `missing: ${result.missing.join(", ")}` : "",
    result.invalid.length ? `invalid: ${result.invalid.join(", ")}` : "",
  ].filter(Boolean);
  throw new Error(
    `Albert ${mode} configuration is not ready (${parts.join("; ")}).`,
  );
}
