/**
 * Central, fail-fast runtime configuration. Secret values are never included
 * in thrown errors or readiness responses.
 */

export type RuntimeMode =
  | "web"
  | "worker"
  | "transform-worker"
  | "deletion-worker"
  | "webhook-gateway"
  | "semantic-query"
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
    "ALBERT_USER_HASH_SECRET",
    "ALBERT_PUBLIC_ORIGIN",
    "SYNC_WORKER_INTERNAL_URL",
    "SEMANTIC_QUERY_SERVICE_URL",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "LIGHTSPEED_CLIENT_ID",
    "XERO_CLIENT_ID",
    "DEPUTY_CLIENT_ID",
  ],
  worker: [
    "SUPABASE_STORAGE_S3_ENDPOINT",
    "SUPABASE_STORAGE_S3_REGION",
    "SUPABASE_STORAGE_S3_ACCESS_KEY_ID",
    "SUPABASE_STORAGE_S3_SECRET_ACCESS_KEY",
    "CONTROL_PLANE_DATABASE_URL",
    "ANALYTICAL_DATABASE_URL",
    "TOKEN_ENCRYPTION_KEY",
    "TOKEN_ENCRYPTION_KEY_ID",
    "ALBERT_OAUTH_WORKER_SIGNING_SECRET",
    "ALBERT_PUBLIC_ORIGIN",
    "LIGHTSPEED_CLIENT_ID",
    "LIGHTSPEED_CLIENT_SECRET",
    "XERO_CLIENT_ID",
    "XERO_WEBHOOK_SIGNING_KEY",
    "XERO_DAILY_REQUEST_LIMIT",
    "DEPUTY_CLIENT_ID",
    "DEPUTY_CLIENT_SECRET",
    "DEPUTY_WEBHOOK_ENCRYPTION_KEY",
    "DEPUTY_WEBHOOK_ENCRYPTION_KEY_ID",
    "WEBHOOK_GATEWAY_PUBLIC_URL",
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
    "SUPABASE_STORAGE_S3_SECRET_ACCESS_KEY",
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
    "SUPABASE_STORAGE_S3_SECRET_ACCESS_KEY",
    "CONTROL_PLANE_DATABASE_URL",
    "XERO_WEBHOOK_SIGNING_KEY",
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
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
  ],
  migration: ["CONTROL_PLANE_DATABASE_URL", "ANALYTICAL_DATABASE_URL"],
};

function isHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (
      url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)
    );
  } catch {
    return false;
  }
}

function looksLikeBase64Key(value: string, byteLength: number): boolean {
  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    return atob(padded).length === byteLength;
  } catch {
    return false;
  }
}

function looksLikeCanonicalBase64UrlKey(value: string, byteLength: number): boolean {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return false;
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(
      Math.ceil(value.length / 4) * 4,
      "=",
    ));
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
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return Object.values(parsed as Record<string, unknown>)
      .filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

export function inspectRuntimeEnvironment(
  mode: RuntimeMode,
  source: Readonly<Record<string, string | undefined>> = process.env,
): RuntimeReadiness {
  const missing = requirements[mode].filter((name) => !source[name]?.trim());
  const invalid: string[] = [];

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
  if(source.ALBERT_TURN_TIMEOUT_MS!==undefined){
    const timeout=Number(source.ALBERT_TURN_TIMEOUT_MS);
    if(!Number.isInteger(timeout)||timeout<30_000||timeout>300_000)invalid.push("ALBERT_TURN_TIMEOUT_MS");
  }

  for (const name of [
    "NEXT_PUBLIC_SUPABASE_URL",
    "SYNC_WORKER_INTERNAL_URL",
    "SEMANTIC_QUERY_SERVICE_URL",
    "OPENAI_BASE_URL",
    "ALBERT_PUBLIC_ORIGIN",
    "WEBHOOK_GATEWAY_PUBLIC_URL",
    "SUPABASE_STORAGE_S3_ENDPOINT",
  ]) {
    const value = source[name]?.trim();
    if (value && !isHttpsUrl(value)) invalid.push(name);
  }

  if (
    source.TOKEN_ENCRYPTION_KEY?.trim() &&
    !looksLikeBase64Key(source.TOKEN_ENCRYPTION_KEY.trim(), 32)
  ) {
    invalid.push("TOKEN_ENCRYPTION_KEY");
  }
  if (
    source.DEPUTY_WEBHOOK_ENCRYPTION_KEY?.trim() &&
    !looksLikeCanonicalBase64UrlKey(source.DEPUTY_WEBHOOK_ENCRYPTION_KEY.trim(), 32)
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
    !looksLikeCanonicalBase64UrlKey(source.WEBHOOK_INBOX_ENCRYPTION_KEY.trim(), 32)
  ) {
    invalid.push("WEBHOOK_INBOX_ENCRYPTION_KEY");
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
    "ALBERT_USER_HASH_SECRET",
    "DELETION_PROOF_HMAC_KEY",
  ]) {
    const value = source[name]?.trim();
    if (value && new TextEncoder().encode(value).byteLength < 32) invalid.push(name);
  }

  const deputyWebhookKeyId = source.DEPUTY_WEBHOOK_ENCRYPTION_KEY_ID?.trim();
  if (deputyWebhookKeyId && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/u.test(deputyWebhookKeyId)) {
    invalid.push("DEPUTY_WEBHOOK_ENCRYPTION_KEY_ID");
  }
  const deputyPreviousKeys = source.DEPUTY_WEBHOOK_PREVIOUS_ENCRYPTION_KEYS?.trim();
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
            keyId === deputyWebhookKeyId || typeof key !== "string" ||
            !looksLikeCanonicalBase64UrlKey(key, 32) || key === source.DEPUTY_WEBHOOK_ENCRYPTION_KEY?.trim() ||
            key === source.TOKEN_ENCRYPTION_KEY || key === source.WEBHOOK_INBOX_ENCRYPTION_KEY ||
            key === source.XERO_WEBHOOK_SIGNING_KEY ||
            seenValues.has(key)
          ) previousKeysInvalid = true;
          if (typeof key === "string") seenValues.add(key);
        }
      }
    } catch {
      previousKeysInvalid = true;
    }
    if (previousKeysInvalid) invalid.push("DEPUTY_WEBHOOK_PREVIOUS_ENCRYPTION_KEYS");
  }

  const xeroInboxKeyId = source.WEBHOOK_INBOX_ENCRYPTION_KEY_ID?.trim();
  if (xeroInboxKeyId && !/^[a-z][a-z0-9._-]{0,63}$/u.test(xeroInboxKeyId)) {
    invalid.push("WEBHOOK_INBOX_ENCRYPTION_KEY_ID");
  }
  const xeroPreviousKeys = source.WEBHOOK_INBOX_PREVIOUS_ENCRYPTION_KEYS?.trim();
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
            keyId === xeroInboxKeyId || typeof key !== "string" ||
            !looksLikeCanonicalBase64UrlKey(key, 32) ||
            key === source.WEBHOOK_INBOX_ENCRYPTION_KEY?.trim() ||
            seenValues.has(key)
          ) previousKeysInvalid = true;
          if (typeof key === "string") seenValues.add(key);
        }
      }
    } catch {
      previousKeysInvalid = true;
    }
    if (previousKeysInvalid) invalid.push("WEBHOOK_INBOX_PREVIOUS_ENCRYPTION_KEYS");
  }

  const deputyKeyValues = new Set([
    source.DEPUTY_WEBHOOK_ENCRYPTION_KEY?.trim(),
    ...encodedJsonKeyValues(source.DEPUTY_WEBHOOK_PREVIOUS_ENCRYPTION_KEYS),
  ].filter((value): value is string => Boolean(value)));
  const xeroInboxKeyValues = new Set([
    source.WEBHOOK_INBOX_ENCRYPTION_KEY?.trim(),
    ...encodedJsonKeyValues(source.WEBHOOK_INBOX_PREVIOUS_ENCRYPTION_KEYS),
  ].filter((value): value is string => Boolean(value)));
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
      if (protocol !== "postgres:" && protocol !== "postgresql:") invalid.push(name);
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
  throw new Error(`Albert ${mode} configuration is not ready (${parts.join("; ")}).`);
}
