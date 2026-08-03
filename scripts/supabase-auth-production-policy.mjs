import assert from "node:assert/strict";

export const SUPABASE_AUTH_CONFIG_PATH = "/v1/projects/{ref}/config/auth";
export const ALBERT_AUTH_PASSWORD_MIN_LENGTH = 12;
export const ALBERT_AUTH_PASSWORD_REQUIRED_CHARACTERS =
  "abcdefghijklmnopqrstuvwxyz:ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789";

const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const PORT_PATTERN = /^(?:[1-9]|[1-9][0-9]{1,3}|[1-5][0-9]{4}|6[0-4][0-9]{3}|65[0-4][0-9]{2}|655[0-2][0-9]|6553[0-5])$/u;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const AUTH_CONFIG_FIELDS = Object.freeze([
  "disable_signup",
  "external_anonymous_users_enabled",
  "external_email_enabled",
  "mailer_autoconfirm",
  "mailer_allow_unverified_email_sign_ins",
  "site_url",
  "uri_allow_list",
  "smtp_admin_email",
  "smtp_host",
  "smtp_port",
  "smtp_user",
  "smtp_sender_name",
  "password_hibp_enabled",
  "password_min_length",
  "password_required_characters",
  "refresh_token_rotation_enabled",
]);

function productionOrigin(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    assert.fail("ALBERT_PUBLIC_ORIGIN must be a valid HTTPS origin.");
  }
  assert.equal(url.protocol, "https:", "ALBERT_PUBLIC_ORIGIN must use HTTPS.");
  assert.equal(url.username, "", "ALBERT_PUBLIC_ORIGIN must not contain credentials.");
  assert.equal(url.password, "", "ALBERT_PUBLIC_ORIGIN must not contain credentials.");
  assert.equal(url.pathname, "/", "ALBERT_PUBLIC_ORIGIN must not contain a path.");
  assert.equal(url.search, "", "ALBERT_PUBLIC_ORIGIN must not contain a query.");
  assert.equal(url.hash, "", "ALBERT_PUBLIC_ORIGIN must not contain a fragment.");
  assert.equal(LOCAL_HOSTS.has(url.hostname), false, "ALBERT_PUBLIC_ORIGIN must not be local.");
  assert.equal(value, url.origin, "ALBERT_PUBLIC_ORIGIN must use its canonical origin form.");
  return url.origin;
}

export function expectedSupabaseAuthRedirects(publicOrigin) {
  const origin = productionOrigin(publicOrigin);
  const recovery = new URL("/auth/callback", origin);
  recovery.searchParams.set("next", "/reset-password?mode=update");
  return Object.freeze([
    `${origin}/auth/callback?next=/dash`,
    recovery.toString(),
  ]);
}

function nonemptyString(value) {
  return typeof value === "string" && value.trim().length > 0 && value === value.trim();
}

function exactRedirectSet(value, expected) {
  if (typeof value !== "string") return false;
  const entries = value.split(",");
  if (entries.some((entry) => !entry || entry !== entry.trim())) return false;
  if (new Set(entries).size !== entries.length || entries.length !== expected.length) return false;
  const actual = new Set(entries);
  return expected.every((entry) => actual.has(entry));
}

function canonicalSmtpHostname(value) {
  if (!nonemptyString(value) || /\s/u.test(value)) return false;
  let url;
  try {
    url = new URL(`smtp://${value}`);
  } catch {
    return false;
  }
  return url.hostname === value
    && url.username === ""
    && url.password === ""
    && url.port === ""
    && url.pathname === ""
    && url.search === ""
    && url.hash === ""
    && !LOCAL_HOSTS.has(url.hostname);
}

function violation(code, message) {
  return Object.freeze({ code, message });
}

export function projectSupabaseAuthConfig(value) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value),
    "Supabase returned invalid Auth configuration metadata.");
  return Object.freeze(Object.fromEntries(AUTH_CONFIG_FIELDS.map((field) => [field, value[field]])));
}

export function evaluateSupabaseAuthProductionPolicy(authConfig, publicOrigin) {
  const expectedRedirects = expectedSupabaseAuthRedirects(publicOrigin);
  const config = projectSupabaseAuthConfig(authConfig);
  const violations = [];
  const redirectAllowListExact = exactRedirectSet(config.uri_allow_list, expectedRedirects);

  if (config.site_url !== publicOrigin) {
    violations.push(violation("supabase_auth_site_url_mismatch",
      "Supabase Auth site_url must exactly match ALBERT_PUBLIC_ORIGIN."));
  }
  if (!redirectAllowListExact) {
    violations.push(violation("supabase_auth_redirect_allow_list_mismatch",
      "Supabase Auth redirect URLs must be the exact canonical signup and recovery callbacks."));
  }
  if (config.external_anonymous_users_enabled !== false) {
    violations.push(violation("supabase_auth_anonymous_users_enabled",
      "Supabase Auth anonymous users must be disabled."));
  }
  if (config.disable_signup !== false) {
    violations.push(violation("supabase_auth_signup_disabled",
      "Supabase Auth user signup must be enabled."));
  }
  if (config.external_email_enabled !== true) {
    violations.push(violation("supabase_auth_email_password_disabled",
      "Supabase Auth email/password authentication must be enabled."));
  }
  if (config.mailer_autoconfirm !== false || config.mailer_allow_unverified_email_sign_ins !== false) {
    violations.push(violation("supabase_auth_email_confirmation_not_required",
      "Supabase Auth must require email confirmation before sign-in."));
  }

  const smtpConfigured = nonemptyString(config.smtp_admin_email)
    && EMAIL_PATTERN.test(config.smtp_admin_email)
    && canonicalSmtpHostname(config.smtp_host)
    && nonemptyString(config.smtp_port)
    && PORT_PATTERN.test(config.smtp_port)
    && nonemptyString(config.smtp_user)
    && nonemptyString(config.smtp_sender_name);
  if (!smtpConfigured) {
    violations.push(violation("supabase_auth_custom_smtp_missing",
      "Supabase Auth must have complete production custom SMTP metadata."));
  }
  if (config.password_min_length !== ALBERT_AUTH_PASSWORD_MIN_LENGTH) {
    violations.push(violation("supabase_auth_password_length_mismatch",
      `Supabase Auth password_min_length must be exactly ${ALBERT_AUTH_PASSWORD_MIN_LENGTH}.`));
  }
  if (config.password_required_characters !== ALBERT_AUTH_PASSWORD_REQUIRED_CHARACTERS) {
    violations.push(violation("supabase_auth_password_character_policy_mismatch",
      "Supabase Auth passwords must require lower-case, upper-case, and numeric characters."));
  }
  if (config.password_hibp_enabled !== true) {
    violations.push(violation("supabase_auth_leaked_password_protection_disabled",
      "Supabase Auth leaked-password protection must be enabled."));
  }
  if (config.refresh_token_rotation_enabled !== true) {
    violations.push(violation("supabase_auth_refresh_token_rotation_disabled",
      "Supabase Auth refresh-token rotation must be enabled."));
  }

  return Object.freeze({
    ok: violations.length === 0,
    expectedRedirectCount: expectedRedirects.length,
    checks: Object.freeze({
      siteUrlExact: config.site_url === publicOrigin,
      redirectAllowListExact,
      anonymousUsersDisabled: config.external_anonymous_users_enabled === false,
      emailPasswordSignupEnabled: config.disable_signup === false && config.external_email_enabled === true,
      emailConfirmationRequired:
        config.mailer_autoconfirm === false && config.mailer_allow_unverified_email_sign_ins === false,
      customSmtpConfigured: smtpConfigured,
      passwordPolicyExact:
        config.password_min_length === ALBERT_AUTH_PASSWORD_MIN_LENGTH
        && config.password_required_characters === ALBERT_AUTH_PASSWORD_REQUIRED_CHARACTERS,
      leakedPasswordProtectionEnabled: config.password_hibp_enabled === true,
      refreshTokenRotationEnabled: config.refresh_token_rotation_enabled === true,
    }),
    violations: Object.freeze(violations),
  });
}

export function assertSupabaseAuthProductionPolicy(authConfig, publicOrigin) {
  const evaluation = evaluateSupabaseAuthProductionPolicy(authConfig, publicOrigin);
  assert.equal(
    evaluation.ok,
    true,
    evaluation.violations.map(({ message }) => message).join(" ") ||
      "Supabase Auth production policy is invalid.",
  );
  return evaluation;
}

export async function fetchSupabaseAuthConfig({
  projectRef,
  token,
  fetchImpl = fetch,
  timeoutMs = 10_000,
}) {
  assert.match(projectRef ?? "", PROJECT_REF_PATTERN, "Supabase project ref is invalid.");
  assert.ok(typeof token === "string" && token.trim().length > 0,
    "Supabase Management API token is required.");
  const endpoint = SUPABASE_AUTH_CONFIG_PATH.replace("{ref}", projectRef);
  let response;
  try {
    response = await fetchImpl(`https://api.supabase.com${endpoint}`, {
      method: "GET",
      headers: { authorization: `Bearer ${token.trim()}`, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    assert.fail("Supabase Auth configuration verification request failed.");
  }
  assert.equal(response.ok, true,
    `Supabase Auth configuration verification failed with status ${response.status}.`);
  let body;
  try {
    body = await response.json();
  } catch {
    assert.fail("Supabase returned invalid Auth configuration metadata.");
  }
  return projectSupabaseAuthConfig(body);
}
