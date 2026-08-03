# ADR 0048: Real-browser production acceptance boundary

- Status: Accepted
- Date: 2026-08-04
- Owners: Albert product and release engineering
- Relates to: ADR 0003, ADR 0006, ADR 0019, ADR 0035, ADR 0038

## Context

Albert had component, contract, rendered-HTML, service, SQL, and protected
dogfood gates, but no browser drove the composed application. Those tests could
not prove that Supabase Auth cookies cross the middleware boundary, that the
first-organisation bootstrap actually follows login, that model preferences
reach the conversation request, or that streamed events form an accessible
ordered table/chart narrative in the page users operate.

A browser suite must not claim more than it observes. CI has no production
Supabase project, vendor consent screen, customer account, OpenAI project, or
Sydney data cell. Adding test-only authentication or fixture bypasses to the
production application would weaken the very boundary the suite is intended to
test.

## Decision

CI builds the production bundle, serves its production server behind a local
HTTPS proxy, and runs the real `/login` and `/dash` application in Chromium. A
separate local HTTP process implements the narrow Supabase Auth wire contract
used by the browser and server middleware. Password login therefore writes the
normal secure SSR auth cookie, and the actual middleware validates the session
before rendering `/dash`; Albert production code contains no test bypass.

The suite substitutes only unavailable external boundaries at browser network
level:

- control-plane session, onboarding, connection, and review responses;
- the conversation SSE boundary, using Albert's deterministic validated trace;
- the post-consent Xero account-selection mutation; and
- the final vendor redirect after a supported OAuth start request.

The real OAuth callback handlers cover provider cancellation, missing callback
parameters, unknown providers, and safe same-origin redirects without secrets.
The supported start button must issue the exact same-origin GET path; live
consent and token exchange remain protected dogfood evidence.

The browser gate covers:

1. password login, hostile `next` rejection, and first-organisation bootstrap;
2. sign-up confirmation and safe credential errors;
3. light, dark, and system themes, with an independent zero-violation WCAG A/AA
   scan after each selected theme state;
4. model allowlist selection, independent Fast tier, and every reasoning level
   selected, submitted, and asserted in the actual request payload;
5. ordered progress, plan, table, chart, validation, narrative, final state, and
   provenance rendering;
6. connection tabs, progressive readiness, dossier, blocking question,
   reversible identity-review surface, and multi-account selection;
7. reduced-motion behavior, keyboard navigation/focus return, and mobile page
   overflow; and
8. OAuth callback-safe states and the exact supported launch path.

Playwright and its Axe integration are exact-version development dependencies.
CI installs only the pinned lockfile's Chromium build, retains trace, video, and
screenshot evidence on failure, and runs this job in addition to—never instead
of—the existing build, contract, SQL, release, and dogfood gates. The repo-local
runner acquires an atomic ignored lock before Playwright can build or serve the
bundle. A concurrent invocation fails with its owning PID; an abandoned lock is
recovered only when that PID no longer exists (with age-based recovery for an
invalid pre-write lock). Signal and normal-exit handlers release owned locks.
This prevents concurrent local agents from cleaning the same production asset
directory while another browser is using it; GitHub jobs also remain isolated
on separate runners.

## Live acceptance boundary

This suite is deterministic release evidence, not a production deployment
attestation. A release still fails closed until protected dogfood proves all of
the following with independently stored evidence:

- real Supabase email delivery, user creation, Sydney RLS, and role membership;
- real Lightspeed R-Series, Xero, and Deputy consent, refresh, account discovery,
  reconnect, revocation, and deletion with reviewed scopes and test accounts;
- recent-first and full-history worker execution through raw, staging,
  canonical, marts, readiness, and reconciliation;
- a real AU-region OpenAI Agents SDK turn and sealed answer artefact; and
- the exact flagship and category questions against live dogfood data.

## Consequences

- UI regressions now fail in a real browser instead of only in a DOM or source
  assertion.
- Theme accessibility cannot pass from only the final selected theme, and a
  rendered reasoning option cannot pass without proving its request binding.
- Authentication middleware stays production-identical and secret-free in CI.
- External substitutions are explicit, narrow, and documented, so a green
  browser job cannot be misreported as live vendor acceptance.
- Chromium installation adds CI time and failure artefacts, which is justified
  by the composed-flow coverage.

## Alternatives considered

- **JSDOM or HTML-string assertions:** rejected because they do not execute
  layout, middleware navigation, focus, media queries, SSE consumption, or SVG
  chart rendering.
- **A test-only auth query parameter or middleware bypass:** rejected because it
  creates production-reachable bypass code and does not exercise SSR cookies.
- **Call live vendors from ordinary CI:** rejected because it couples every pull
  request to mutable customer state and long-lived secrets; protected dogfood is
  the correct authority for that evidence.
- **Treat mocked OAuth launch as end-to-end OAuth:** rejected. The suite names
  this as a handoff-boundary assertion and leaves consent/token proof to live
  acceptance.

## Verification

- `playwright.config.ts`
- `scripts/run-browser-acceptance.mjs`
- `tests/browser/auth.setup.ts`
- `tests/browser/albert.e2e.spec.ts`
- `tests/browser/support/https-app-proxy.mjs`
- `tests/browser/support/server-fetch-rewrite.mjs`
- `tests/browser/support/supabase-auth-stub.mjs`
- `.github/workflows/ci.yml`
