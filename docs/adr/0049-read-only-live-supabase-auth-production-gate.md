# ADR 0049: Read-only live Supabase Auth production gate

- Status: Accepted
- Date: 2026-08-04
- Owners: Albert web identity and release engineering
- Relates to: ADR 0007, ADR 0038, ADR 0048

## Context

Albert's application implements real email/password signup, email confirmation,
sign-in, and password recovery against hosted Supabase Auth. Repository code can
prove that those flows exist, but cannot prove that the selected production
project has compatible and secure live Auth settings. A project with anonymous
users enabled, automatic email confirmation, a broad redirect wildcard, the
non-production mail service, or weak password controls could still pass the
previous release preflight because it checked only project identity, region, and
health.

The Supabase Management API exposes the authoritative live configuration at
`GET /v1/projects/{ref}/config/auth`. The official response fields required by
this decision are `site_url`, `uri_allow_list`, `disable_signup`,
`external_anonymous_users_enabled`, `external_email_enabled`,
`mailer_autoconfirm`, `mailer_allow_unverified_email_sign_ins`, the non-secret
SMTP configuration metadata, `password_min_length`,
`password_required_characters`, `password_hibp_enabled`, and
`refresh_token_rotation_enabled`. The endpoint requires OAuth `auth:read` or
fine-grained `auth_config_read`; production release and audit identities need no
Auth mutation permission.

## Decision

One code-owned policy in `scripts/supabase-auth-production-policy.mjs` validates
the Management API response. The public origin must be a canonical, non-local
HTTPS origin, and `site_url` must equal it byte for byte. The redirect allowlist
must be an exact two-item set containing only the final URLs emitted by Albert's
application:

1. `<origin>/auth/callback?next=/dash` for signup confirmation; and
2. `<origin>/auth/callback?next=%2Freset-password%3Fmode%3Dupdate` for password
   recovery.

Whitespace, empty entries, duplicates, wildcards, missing URLs, and additional
destinations fail. Item order does not affect the policy because the provider
does not promise to retain operator input order. The vendor OAuth `/api/oauth/*`
callbacks are a separate protocol and are never valid Supabase Auth redirect
entries.

The policy also requires anonymous users off; global signup and email/password
signup on; automatic confirmation and unverified-email sign-in off; complete
custom SMTP sender, port, user, and sender-name metadata plus a canonical host
name with no scheme, credentials, path, or embedded port; a password length of
exactly 12 with lower-case, upper-case, and numeric character classes; leaked
password protection on; and refresh-token rotation on. Exact password settings
keep the server contract aligned with the existing signup and recovery UI;
silently strengthening it in the dashboard would make the UI promise false and
therefore also fails until both receive a reviewed change.

The policy projects only named non-secret fields from the response. It never
reads, returns, or logs an SMTP password or provider secret. Status and failure
output contains only booleans, counts, stable finding codes, and safe policy
messages.

`scripts/audit-production-environment.mjs` reads the live configuration through
the official endpoint and fails closed on missing authority, transport errors,
invalid JSON, or any policy violation. `scripts/release-preflight.mjs` fetches
the same live response for production and validates it before any mutating job.
Staging may exercise different Auth behavior and is not blocked by the
production-only exact policy. Both consumers use `GET`, a ten-second timeout,
redirect refusal, and the existing protected `SUPABASE_MANAGEMENT_TOKEN`; no
additional secret or workflow input is introduced.

## Consequences

- A production release cannot proceed merely because application-side Auth UI
  exists; the selected hosted project must be configured and observable.
- Redirect drift and wildcard broadening stop promotion before migrations,
  provisioning, or deployment.
- Production requires a Supabase plan that supports leaked-password protection.
- The Management token must include `auth_config_read` in addition to project
  read access, but must not include Auth write scope.
- Configuration remains an explicit operator/provisioner action. The audit and
  release paths are read-only and cannot repair drift.
- Custom SMTP credential correctness and deliverability still require a live
  operational test; this gate proves that the non-secret provider metadata is
  fully configured without exposing the credential.

## Alternatives considered

- **Trust dashboard screenshots or an environment declaration:** rejected
  because neither is bound to the selected live project at release time.
- **Use public Auth `/settings`:** rejected because it does not expose the full
  redirect, SMTP, password, and leaked-password policy.
- **Accept a supplied JSON snapshot:** rejected for production because it can be
  stale or refer to another project. The release fetches the selected project.
- **Let the release mutate Auth configuration:** rejected because promotion
  requires read authority only and should not silently change identity policy.
- **Inspect the SMTP credential:** rejected because the gate needs only proof of
  complete custom-provider metadata and must minimize secret exposure.
- **Allow any same-origin redirect or wildcard:** rejected because the app emits
  exactly two destinations and broader redirect authority has no V1 use case.

## Verification

- `scripts/supabase-auth-production-policy.mjs`
- `scripts/audit-production-environment.mjs`
- `scripts/release-preflight.mjs`
- `tests/supabase-auth-production-policy.test.mjs`
- `tests/production-environment-audit.test.mjs`
- `tests/release-preflight.test.mjs`
- `deploy/README.md`
- [Supabase Management API](https://supabase.com/docs/reference/api/gets-projects-auth-config)
- [Supabase password security](https://supabase.com/docs/guides/auth/password-security)
- [Supabase custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp)
