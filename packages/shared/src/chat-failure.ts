import { sanitizeTraceText } from "./agent-runtime.js";

export type ChatFailureRuntime = "fixture" | "openai" | "anthropic" | "cubecore" | "v3" | "xero_mcp" | "codex" | "compare";

export type ChatFailureContext = Readonly<{
  runtime?: ChatFailureRuntime;
  httpStatus?: number;
  missingConfig?: readonly string[];
  invalidConfig?: readonly string[];
  phase?: "start" | "stream" | "empty_trace" | "config";
  detail?: string;
}>;

const CONFIG_DIAGNOSIS: Readonly<Record<string, string>> = Object.freeze({
  semanticServiceUrl: "Fly is not connected (SEMANTIC_QUERY_SERVICE_URL is missing).",
  SEMANTIC_QUERY_SERVICE_URL: "Fly is not connected (SEMANTIC_QUERY_SERVICE_URL is missing).",
  semanticSigningSecret: "Fly is not connected (ALBERT_SEMANTIC_SIGNING_SECRET is missing).",
  ALBERT_SEMANTIC_SIGNING_SECRET: "Fly is not connected (ALBERT_SEMANTIC_SIGNING_SECRET is missing).",
  cubeApiUrl: "Cubecore is not configured (CUBE_API_URL is missing).",
  CUBE_API_URL: "Cubecore is not configured (CUBE_API_URL is missing).",
  cubeApiSecret: "Cubecore is not configured (CUBEJS_API_SECRET is missing).",
  CUBEJS_API_SECRET: "Cubecore is not configured (CUBEJS_API_SECRET is missing).",
  shopifyQLServiceUrl: "Fly is not connected (sync worker URL is missing).",
  shopifyAdminServiceUrl: "Fly is not connected (sync worker URL is missing).",
  SYNC_WORKER_INTERNAL_URL: "Fly is not connected (SYNC_WORKER_INTERNAL_URL is missing).",
  shopifyQLSigningSecret: "Fly is not connected (ALBERT_SHOPIFYQL_SIGNING_SECRET is missing).",
  ALBERT_SHOPIFYQL_SIGNING_SECRET: "Fly is not connected (ALBERT_SHOPIFYQL_SIGNING_SECRET is missing).",
  shopifyAdminSigningSecret: "Fly is not connected (ALBERT_SHOPIFY_ADMIN_SIGNING_SECRET is missing).",
  ALBERT_SHOPIFY_ADMIN_SIGNING_SECRET: "Fly is not connected (ALBERT_SHOPIFY_ADMIN_SIGNING_SECRET is missing).",
  xeroMcpServiceUrl: "The Xero MCP test service is not connected.",
  xeroMcpSigningSecret: "The Xero MCP test service is not connected.",
  openaiApiKey: "OpenAI is not configured (OPENAI_API_KEY is missing).",
  OPENAI_API_KEY: "OpenAI is not configured (OPENAI_API_KEY is missing).",
  openaiBaseUrl: "OpenAI is not configured (OPENAI_BASE_URL is missing).",
  OPENAI_BASE_URL: "OpenAI is not configured (OPENAI_BASE_URL is missing).",
  xaiApiKey: "Grok is not configured (XAI_API_KEY is missing).",
  XAI_API_KEY: "Grok is not configured (XAI_API_KEY is missing).",
  userHashSecret: "Live analytics is not configured (ALBERT_USER_HASH_SECRET is missing).",
  ALBERT_USER_HASH_SECRET: "Live analytics is not configured (ALBERT_USER_HASH_SECRET is missing).",
  ANTHROPIC_ANALYTICS_SERVICE_URL: "Fly is not connected (ANTHROPIC_ANALYTICS_SERVICE_URL is missing).",
  ALBERT_ANTHROPIC_SIGNING_SECRET: "Fly is not connected (ALBERT_ANTHROPIC_SIGNING_SECRET is missing).",
});

function uniqueSentences(items: readonly string[]): string {
  return [...new Set(items.filter(Boolean))].join(" ");
}

export function describeMissingChatConfig(
  missing: readonly string[] = [],
  invalid: readonly string[] = [],
): string {
  const missingNotes = missing.map((key) => CONFIG_DIAGNOSIS[key] ?? `Missing configuration: ${key}.`);
  const invalidNotes = invalid.map((key) => `Invalid configuration: ${key}.`);
  return uniqueSentences([...missingNotes, ...invalidNotes]) || "Live analytics is not fully configured.";
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (
    error
    && typeof error === "object"
    && "message" in error
    && typeof (error as { message: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  return "";
}

function isTransportFailure(text: string): boolean {
  return /econnrefused|enotfound|econnreset|etimedout|ehostunreach|enetunreach|fetch failed|failed to fetch|load failed|networkerror|network error|socket hang up|undici|connect timeout|connect econnrefused/iu.test(text);
}

function looksLikeCube(text: string, runtime?: ChatFailureRuntime): boolean {
  return runtime === "cubecore"
    || runtime === "v3"
    || /cube(?:core|js)?|\bcube api\b|cube meta|cubejs-api/iu.test(text);
}

function looksLikeFly(text: string): boolean {
  return /semantic(?: query)? service|fly\b|governed query service|sync worker|anthropic analytics|SEMANTIC_QUERY|SYNC_WORKER/iu.test(text);
}

function looksLikeStructuredOutputSchema(text: string): boolean {
  return /unable to convert the provided zod schema|optional\(\) without \.nullable\(\)|structured outputs/iu.test(text);
}

function looksLikeOpenAI(text: string): boolean {
  return /openai|api\.openai|incorrect api key|insufficient_quota|rate limit reached|model_not_found/iu.test(text);
}

function looksLikeGrok(text: string): boolean {
  return /\bxai\b|grok|api\.x\.ai/iu.test(text);
}

function alreadyDiagnostic(text: string): boolean {
  return /^(Cubecore is down|Cubecore is not configured|Fly is not connected|OpenAI is not connected|OpenAI is not configured|Grok is not connected|Grok is not configured|Claude Haiku is not configured|Claude Haiku is not approved|Supabase is not connected|Anthropic analytics is not connected|The Albert chat API could not be reached|Live analytics is not configured)/iu.test(text)
    || / is not connected/iu.test(text)
    || / is not configured/iu.test(text);
}

function runtimeLabel(runtime: ChatFailureRuntime | undefined): string {
  if (runtime === "cubecore") return "Cubecore";
  if (runtime === "v3") return "Albert v3 (Cubecore)";
  if (runtime === "xero_mcp") return "Xero MCP";
  if (runtime === "codex") return "Codex";
  if (runtime === "compare") return "Compare";
  if (runtime === "anthropic") return "New Method (Anthropic)";
  if (runtime === "openai") return "OpenAI / Fly";
  if (runtime === "fixture") return "fixture";
  return "selected";
}

function withStatus(message: string, status?: number): string {
  if (!status) return message;
  if (message.includes(`HTTP ${status}`)) return message;
  return `${message.replace(/\.$/u, "")} (HTTP ${status}).`;
}

/** Owner-visible chat failure copy that names the broken dependency. */
export function describeChatFailure(error: unknown, context: ChatFailureContext = {}): string {
  if ((context.missingConfig?.length ?? 0) > 0 || (context.invalidConfig?.length ?? 0) > 0) {
    return sanitizeTraceText(
      describeMissingChatConfig(context.missingConfig ?? [], context.invalidConfig ?? []),
      400,
    );
  }

  const raw = sanitizeTraceText(errorText(error), 400);
  const haystack = `${raw} ${context.detail ?? ""}`.trim();
  const status = context.httpStatus;

  if (/abort(?:ed|error)|this operation was aborted/iu.test(haystack) && !/timeout/iu.test(haystack)) {
    return "The analysis was cancelled.";
  }

  if (context.phase === "empty_trace") {
    return `Albert returned an empty analysis trace from the ${runtimeLabel(context.runtime)} runtime. The service may have crashed before streaming any events.`;
  }

  if (alreadyDiagnostic(raw) && status === undefined) {
    return raw;
  }

  const transport = isTransportFailure(haystack);
  const cubeNamed = /cube(?:core|js)?|\bcube api\b|cube meta|cubejs-api/iu.test(haystack);
  const cubeish = looksLikeCube(haystack, context.runtime);
  const flyish = looksLikeFly(haystack);

  if (
    (cubeNamed || (cubeish && context.phase !== "start"))
    && (transport || /unreachable|not running|http \d{3}/iu.test(haystack) || (status !== undefined && status >= 500))
  ) {
    const where = context.detail?.trim();
    if (status !== undefined && status >= 500) {
      return sanitizeTraceText(
        `Cubecore is down (HTTP ${status}${where ? ` from ${where}` : ""}).`,
        400,
      );
    }
    if (where) {
      return sanitizeTraceText(`Cubecore is down. ${where} is not connected.`, 400);
    }
    return sanitizeTraceText(
      withStatus("Cubecore is down. The Cube API or Cubecore bridge could not be reached.", status),
      400,
    );
  }

  if (flyish && context.phase !== "start") {
    return sanitizeTraceText(
      withStatus("Fly is not connected. The semantic query service could not be reached.", status),
      400,
    );
  }

  if (context.runtime === "openai" && transport && context.phase !== "start" && !looksLikeOpenAI(haystack)) {
    return sanitizeTraceText(
      withStatus("Fly is not connected. The semantic query service could not be reached.", status),
      400,
    );
  }

  if (context.runtime === "anthropic" && (transport || (status !== undefined && status >= 500))) {
    return sanitizeTraceText(
      withStatus("Fly is not connected. The Anthropic analytics service (New Method) could not be reached.", status),
      400,
    );
  }

  if (looksLikeStructuredOutputSchema(haystack)) {
    return sanitizeTraceText(
      raw || "Albert could not start this analysis because a tool schema was rejected by the model API.",
      400,
    );
  }

  if (looksLikeGrok(haystack)) {
    return sanitizeTraceText(`Grok is not connected. ${raw || "The xAI API rejected the request."}`, 400);
  }

  if (looksLikeOpenAI(haystack)) {
    return sanitizeTraceText(`OpenAI is not connected. ${raw || "The OpenAI API rejected the request."}`, 400);
  }

  if (/supabase|\bjwt\b|auth session missing/iu.test(haystack)) {
    return sanitizeTraceText(
      withStatus("Supabase is not connected. Authentication could not be completed.", status),
      400,
    );
  }

  if (context.phase === "start" && (transport || (status !== undefined && status >= 500 && !raw))) {
    if (context.runtime === "cubecore") {
      return status
        ? `Cubecore is down. The Cubecore chat endpoint could not be reached (HTTP ${status}).`
        : "Cubecore is down. The Cubecore chat endpoint could not be reached (network error).";
    }
    if (context.runtime === "v3") {
      return status
        ? `Cubecore is down. The Albert v3 chat endpoint could not be reached (HTTP ${status}).`
        : "Cubecore is down. The Albert v3 chat endpoint could not be reached (network error).";
    }
    if (context.runtime === "anthropic") {
      return status
        ? `Fly is not connected. The New Method chat endpoint could not be reached (HTTP ${status}).`
        : "Fly is not connected. The New Method chat endpoint could not be reached (network error).";
    }
    return status
      ? `The Albert chat API could not be reached (HTTP ${status}). Check that the web app is running.`
      : "The Albert chat API could not be reached. Check that the web app is running.";
  }

  if (context.phase === "stream") {
    return `The conversation stream was unavailable from the ${runtimeLabel(context.runtime)} runtime.`;
  }

  if (status === 401 || status === 403) {
    return sanitizeTraceText(raw || "Authentication failed for this chat request.", 400);
  }

  if (status === 429) {
    return sanitizeTraceText(raw || "Too many chat requests. Wait a moment, then try again.", 400);
  }

  if (raw && !isTransportFailure(raw)) {
    return withStatus(raw.endsWith(".") ? raw : `${raw}.`, status);
  }

  if (transport) {
    if (context.runtime === "cubecore" || context.runtime === "v3") {
      return "Cubecore is down. Network error while contacting Cubecore.";
    }
    if (context.runtime === "anthropic" || context.runtime === "openai") {
      return "Fly is not connected. Network error while contacting the Fly-hosted analytics service.";
    }
    return "A required chat service is not connected (network error).";
  }

  const extras = [
    raw,
    status ? `HTTP ${status}` : "",
    context.runtime ? `runtime ${context.runtime}` : "",
  ].filter(Boolean);
  return sanitizeTraceText(
    extras.length > 0
      ? `Albert could not finish that answer (${extras.join(", ")}).`
      : "Albert could not finish that answer. The failed step was recorded and can be retried safely.",
    400,
  );
}

/** Cubecore answer copy: name an outage when the bridge is down, keep query errors intact. */
export function cubecoreOwnerFailure(error: string): string {
  const text = error.trim();
  if (!text) return "Cubecore is down. The Cubecore bridge did not return an error detail.";
  if (/^cubecore is down/iu.test(text)) return text;
  if (/fetch failed|econnrefused|failed to fetch|http [45]\d\d|is not connected/iu.test(text)) {
    return `Cubecore is down. ${text}`;
  }
  return `Cubecore could not run the query. ${text}`;
}
