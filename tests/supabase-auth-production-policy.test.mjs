import assert from "node:assert/strict";
import test from "node:test";
import {
  ALBERT_AUTH_PASSWORD_MIN_LENGTH,
  ALBERT_AUTH_PASSWORD_REQUIRED_CHARACTERS,
  assertSupabaseAuthProductionPolicy,
  evaluateSupabaseAuthProductionPolicy,
  expectedSupabaseAuthRedirects,
  fetchSupabaseAuthConfig,
  projectSupabaseAuthConfig,
} from "../scripts/supabase-auth-production-policy.mjs";

const projectRef = "abcdefghijklmnopqrst";
const publicOrigin = "https://albert.example";

function validConfig() {
  return {
    site_url: publicOrigin,
    uri_allow_list: expectedSupabaseAuthRedirects(publicOrigin).join(","),
    external_anonymous_users_enabled: false,
    disable_signup: false,
    external_email_enabled: true,
    mailer_autoconfirm: false,
    mailer_allow_unverified_email_sign_ins: false,
    smtp_admin_email: "no-reply@auth.albert.example",
    smtp_host: "smtp.auth.albert.example",
    smtp_port: "587",
    smtp_user: "albert-production",
    smtp_sender_name: "Albert",
    password_min_length: ALBERT_AUTH_PASSWORD_MIN_LENGTH,
    password_required_characters: ALBERT_AUTH_PASSWORD_REQUIRED_CHARACTERS,
    password_hibp_enabled: true,
    refresh_token_rotation_enabled: true,
  };
}

test("production Auth policy derives only the exact signup and recovery callbacks", () => {
  assert.deepEqual(expectedSupabaseAuthRedirects(publicOrigin), [
    "https://albert.example/auth/callback?next=/dash",
    "https://albert.example/auth/callback?next=%2Freset-password%3Fmode%3Dupdate",
  ]);
  const evaluation = assertSupabaseAuthProductionPolicy(validConfig(), publicOrigin);
  assert.equal(evaluation.ok, true);
  assert.deepEqual(evaluation.violations, []);
  assert.deepEqual(evaluation.checks, {
    siteUrlExact: true,
    redirectAllowListExact: true,
    anonymousUsersDisabled: true,
    emailPasswordSignupEnabled: true,
    emailConfirmationRequired: true,
    customSmtpConfigured: true,
    passwordPolicyExact: true,
    leakedPasswordProtectionEnabled: true,
    refreshTokenRotationEnabled: true,
  });
});

test("production Auth policy rejects every weaker, broader, or ambiguous configuration", () => {
  const expectedAllowList = validConfig().uri_allow_list;
  const cases = [
    ["site URL trailing slash", { site_url: `${publicOrigin}/` }, "supabase_auth_site_url_mismatch"],
    ["missing recovery URL", { uri_allow_list: expectedSupabaseAuthRedirects(publicOrigin)[0] }, "supabase_auth_redirect_allow_list_mismatch"],
    ["extra redirect URL", { uri_allow_list: `${expectedAllowList},https://attacker.example/callback` }, "supabase_auth_redirect_allow_list_mismatch"],
    ["wildcard redirect", { uri_allow_list: `${publicOrigin}/**` }, "supabase_auth_redirect_allow_list_mismatch"],
    ["allow-list whitespace", { uri_allow_list: expectedAllowList.replace(",", ", ") }, "supabase_auth_redirect_allow_list_mismatch"],
    ["anonymous users", { external_anonymous_users_enabled: true }, "supabase_auth_anonymous_users_enabled"],
    ["missing anonymous setting", { external_anonymous_users_enabled: null }, "supabase_auth_anonymous_users_enabled"],
    ["signup disabled", { disable_signup: true }, "supabase_auth_signup_disabled"],
    ["email provider disabled", { external_email_enabled: false }, "supabase_auth_email_password_disabled"],
    ["email auto-confirm", { mailer_autoconfirm: true }, "supabase_auth_email_confirmation_not_required"],
    ["unverified sign-in", { mailer_allow_unverified_email_sign_ins: true }, "supabase_auth_email_confirmation_not_required"],
    ["SMTP sender missing", { smtp_admin_email: null }, "supabase_auth_custom_smtp_missing"],
    ["SMTP sender invalid", { smtp_admin_email: "not-an-email" }, "supabase_auth_custom_smtp_missing"],
    ["SMTP host missing", { smtp_host: "" }, "supabase_auth_custom_smtp_missing"],
    ["SMTP host whitespace", { smtp_host: "smtp host.example" }, "supabase_auth_custom_smtp_missing"],
    ["SMTP host scheme", { smtp_host: "smtp://smtp.auth.albert.example" }, "supabase_auth_custom_smtp_missing"],
    ["SMTP host credentials", { smtp_host: "user@smtp.auth.albert.example" }, "supabase_auth_custom_smtp_missing"],
    ["SMTP host path", { smtp_host: "smtp.auth.albert.example/path" }, "supabase_auth_custom_smtp_missing"],
    ["SMTP host embedded port", { smtp_host: "smtp.auth.albert.example:587" }, "supabase_auth_custom_smtp_missing"],
    ["SMTP port wrong type", { smtp_port: 587 }, "supabase_auth_custom_smtp_missing"],
    ["SMTP port zero", { smtp_port: "0" }, "supabase_auth_custom_smtp_missing"],
    ["SMTP port above range", { smtp_port: "65536" }, "supabase_auth_custom_smtp_missing"],
    ["SMTP user missing", { smtp_user: "" }, "supabase_auth_custom_smtp_missing"],
    ["SMTP sender name missing", { smtp_sender_name: "" }, "supabase_auth_custom_smtp_missing"],
    ["short password", { password_min_length: 11 }, "supabase_auth_password_length_mismatch"],
    ["UI-mismatched longer password", { password_min_length: 13 }, "supabase_auth_password_length_mismatch"],
    ["weak character classes", {
      password_required_characters: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789",
    }, "supabase_auth_password_character_policy_mismatch"],
    ["UI-mismatched symbol requirement", {
      password_required_characters:
        "abcdefghijklmnopqrstuvwxyz:ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789:!@#$%^&*()_+-=[]{};'\\:\"|<>?,./`~",
    }, "supabase_auth_password_character_policy_mismatch"],
    ["HIBP disabled", { password_hibp_enabled: false }, "supabase_auth_leaked_password_protection_disabled"],
    ["refresh rotation disabled", { refresh_token_rotation_enabled: false }, "supabase_auth_refresh_token_rotation_disabled"],
  ];

  for (const [label, patch, expectedCode] of cases) {
    const evaluation = evaluateSupabaseAuthProductionPolicy({ ...validConfig(), ...patch }, publicOrigin);
    assert.equal(evaluation.ok, false, label);
    assert.ok(evaluation.violations.some(({ code }) => code === expectedCode), label);
  }
  assert.equal(evaluateSupabaseAuthProductionPolicy({
    ...validConfig(),
    uri_allow_list: expectedSupabaseAuthRedirects(publicOrigin).toReversed().join(","),
  }, publicOrigin).ok, true, "Supabase does not guarantee redirect provider order retention.");
  assert.throws(() => evaluateSupabaseAuthProductionPolicy(null, publicOrigin), /invalid Auth configuration/u);
  for (const invalidOrigin of [
    "http://albert.example",
    "https://albert.example/extra",
    "https://localhost",
    "https://albert.example/",
  ]) {
    assert.throws(() => evaluateSupabaseAuthProductionPolicy(validConfig(), invalidOrigin));
  }
});

test("Management API fetch is GET-only, bounded, fail-closed, and secret-free", async () => {
  const calls = [];
  const token = "management-token-canary";
  const projected = await fetchSupabaseAuthConfig({
    projectRef,
    token,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({
        ...validConfig(),
        smtp_pass: "NEVER-OUTPUT-SMTP-PASSWORD",
        provider_secret: "NEVER-OUTPUT-PROVIDER-SECRET",
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.supabase.com/v1/projects/${projectRef}/config/auth`);
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.headers.authorization, `Bearer ${token}`);
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.doesNotMatch(JSON.stringify(projected), /NEVER-OUTPUT|smtp_pass|provider_secret/u);
  assert.deepEqual(projected, projectSupabaseAuthConfig(validConfig()));

  await assert.rejects(
    () => fetchSupabaseAuthConfig({
      projectRef,
      token,
      fetchImpl: async () => new Response("NEVER-OUTPUT-RESPONSE-BODY", { status: 403 }),
    }),
    (error) => /status 403/u.test(error.message)
      && !error.message.includes(token)
      && !error.message.includes("NEVER-OUTPUT"),
  );
  await assert.rejects(
    () => fetchSupabaseAuthConfig({
      projectRef,
      token,
      fetchImpl: async () => { throw new Error("NEVER-OUTPUT-TRANSPORT-DETAIL"); },
    }),
    (error) => /request failed/u.test(error.message)
      && !error.message.includes(token)
      && !error.message.includes("NEVER-OUTPUT"),
  );
});
