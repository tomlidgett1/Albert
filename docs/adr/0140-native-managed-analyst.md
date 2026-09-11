# ADR 0140: Native managed analyst and answer-first results

- Date: 2026-09-11
- Status: implemented at the owner's request
- Supersedes: ADR 0139's per-turn provider-session lifecycle and SDK tool bridge

The initial integration returned governed figures but repeatedly rejected tool
arguments, lost follow-up requirements, and exposed implementation errors in the
main answer. Successful HTTP requests were insufficient evidence of product quality.

## Native runtime

Use the Agents API as a durable conversation harness. Keep stable instructions,
tool definitions and provider history across user turns. A schema-constrained
final response replaces the ComposeAnswer function call. Albert validates every
number and materializes tables from immutable results before publishing an answer.
Native tools parse their original Zod contracts directly, return useful field
errors as `success:false`, and use compact conversation-scoped result handles.
Unused nullable parameters may be omitted without weakening any actual constraint.

The existing governed Cube executors, exact arithmetic, provenance, row-limit
semantics and tenant claims remain authoritative. The model receives no database
credentials or raw SQL execution tool. It cannot change tenant scope or mark an
answer Verified itself. Failed or cancelled provider turns never become success.

## State and lifecycle

Store the provider session ID, profile digest and result-handle mapping in the
control plane. State access requires both the authenticated conversation owner
and a separate server capability; writes also require a live turn and matching
revision. Reusing a provider session additionally checks provider metadata against
the authenticated tenant, actor and conversation. Never trust a browser-supplied
session ID. Results load on demand from the existing immutable event ledger.

Sessions expire after 24 hours of inactivity, and an authenticated hourly cleanup
removes only this feature's tagged provider sessions. Stop cancels the active turn.
Interrupted sessions are marked dirty and rotated on retry, preserving the saved
Albert evidence. A model/profile change starts a new session with bounded context.
Rewinding a turn also invalidates provider history, so retracted content is not reused.
US storage remains the explicit, owner-approved
exception from ADR 0139; this does not claim Zero Data Retention.

## Product and verification

Show the answer first, with its period and sources. During work, show concise
business-readable progress. Preserve technical errors and successful query details
in an expandable evidence panel; never hide an unresolved failure in a success
state. Reused results say they were not refreshed.

Evaluate complete task fulfillment, correct scope, exact figures, useful tables,
follow-up continuity, recoverability and latency. Use a frozen synthetic corpus
with independent numeric oracles, then live tenant checks. Select the default
model using measured quality and reliability, not the lowest token price.

The release default is Sol with medium reasoning. The release corpus exercises
an aggregate, store reconciliation, two presentation follow-ups, a period change,
a name filter, a cross-source rate, empty results, a transient outage and hostile
text in a product label. It checks presented cells, requested tables/charts,
percentage change, currency units, session reuse and actual data reads. Evaluation
artifacts include source hashes, full synthetic traces and per-turn timings.

Regression checks cover provider failure semantics, stream recovery, root-turn
completion, foreign-session isolation, dirty-session rotation, checkpoint failures,
retention and exact number binding. Transaction-only production RPC checks verify
server capability, ownership, revisions, original evidence restoration, completed
history and rewind isolation. UI acceptance uses the production Next.js build in
light, dark and system themes, a narrow viewport, keyboard navigation and Axe.

Run `scripts/albert-eval/run-managed-frozen.mts` with the configured API environment
for the real-provider corpus. Run `scripts/test-managed-state.mts --rollback-production`
with the deployer environment for the database checks. Neither writes credentials
to artifacts. Provider token usage remains explicitly unavailable when the API
does not return it; it is never presented as a measured zero.

References: [sessions](https://developers.openai.com/api/docs/guides/agents-api/sessions),
[function results](https://developers.openai.com/api/docs/guides/agents-api/tools/functions),
[observability and caching](https://developers.openai.com/api/docs/guides/agents-api/observability),
[data analyst example](https://developers.openai.com/showcase/agents-api-data-analyst).
