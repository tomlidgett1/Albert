# ADR 0110: isolated Codex analytics runtime

- Status: accepted for an experimental, separately selected tab
- Date: 2026-08-20
- Owners: product and platform
- Supersedes: nothing
- Does not modify: Albert V3 routing, engine, prompts, tools, models, or release qualification

## Context

Codex often produces stronger long-horizon agent behaviour than a hand-built
model loop because its harness owns thread lifecycle, context management,
tool-use iteration, interruption, and structured output. The product question
is whether that harness improves Albert's novel analytical answers when it is
given the same governed semantic layer.

This must be tested without weakening Albert's constitutional boundaries and
without turning the experiment into a fallback or replacement for V3. Codex is
a coding-oriented harness with shell, filesystem, browser, plugin, and
multi-agent capabilities in its normal product configuration. Its app-server
dynamic-tool API is explicitly experimental. It also persists local thread
state by default. Those defaults are not suitable for multi-tenant customer
analytics.

OpenAI documents app-server as the richer product-integration protocol and
stdio as its local transport. Remote WebSocket support and dynamic tools are
experimental. See [Codex app-server](https://developers.openai.com/codex/app-server)
and [Codex SDK](https://developers.openai.com/codex/codex-sdk).

## Decision

Albert will expose an explicit **Albert / Codex** runtime tab in the existing
chat workspace. Selecting Codex always starts a new conversation whose immutable
runtime profile is `codex-app-server` / `cube-codex-v1`. Selecting Albert starts
a clean general V3 conversation. A conversation can never cross runtimes.

Codex starts on `gpt-5.6-luna` with Max reasoning and Fast processing. The
existing dash model control is available in the Codex composer, restricted to
the reviewed OpenAI Codex profiles `gpt-5.6-luna`, `gpt-5.6-terra`, and
`gpt-5.6-sol`; xAI and Anthropic profiles never cross into this runtime. Model,
effort, and speed are server-normalized on every turn and recorded in that
turn's runtime profile. The comparison workspace pins both lanes to the same
owner-selected reviewed profile and defaults both to Luna / Max / Fast.

Normal V3 remains byte- and dependency-isolated from this experiment:

- `/api/v3-conversation` continues to call `runAlbertV3Turn` exactly as before;
- no V3 engine module imports `packages/albert-codex`;
- the Codex route does not import any V3 agent-engine module;
- specialist-agent selection remains a V3 feature and is reset to `general`
  when Codex is selected.

### Contextual turn acknowledgement

The Codex tab does not use a static “investigate through Albert” sentence. For
every substantive analytical prompt—including follow-ups in an existing
conversation—the web route starts a separate bounded Responses API request
using `gpt-5-nano`, minimal reasoning, Fast processing, a 128-token ceiling and
a 2.5-second timeout. The model selects only an allowlisted action and a short
prompt-specific focus phrase. It is instructed not to copy names or identifiers;
trusted code renders the final owner-facing sentence and rejects literal
figures, dates, amounts, percentages, pronouns, prompt-injection vocabulary and
malformed output.

This auxiliary request starts before conversation-context loading. Once the
Codex service envelope is ready, the main app-server analysis starts without
waiting for it. Runtime trace events are temporarily buffered in memory; the
valid acknowledgement is persisted and delivered first, then buffered events
are drained in order and later events stream directly. Thus the UI remains
acknowledgement-first without putting the Nano request on the analytical
critical path. Failure or timeout produces no fabricated/static sentence and
never cancels the main turn. Model, tier, duration, usage and provider response
id are logged without prompt or result content. Social replies, trusted
date/time answers, and routed general conversation still use their earlier
instant paths and do not generate a misleading analytical preamble.

### Conversational continuity without Codex-local retention

Codex app-server threads are conversation containers, but this experiment does
not persist or resume their local rollout files: doing so would create a second
PII-bearing conversation store outside Supabase retention, RLS and deletion.
Instead, every new ephemeral thread receives the bounded prior user/assistant
messages plus up to four governed results from the last two answered Albert
turns. Each result is capped at 20 rows and 16 columns and retains its immutable
result id, labels, types, provenance, time range and definitions. The signed
service envelope remains bound to the same authenticated tenant/conversation/
turn; Codex receives no selector or broader history authority.

Prior results are registered as first-class evidence before the model runs.
Referential follow-ups resolve “that”, “it”, “those”, “the result” and “the
period” against the newest prior answer. Codex may cite prior cells directly,
give evidence updates from them, or chart them without a new Cube query. A
prior table is re-emitted lazily only when the new answer actually references
it, so the current trace remains replayable without duplicating every earlier
table.

Short provenance follow-ups such as “what time period is that?” and “where did
that result come from?” bypass catalogue loading and app-server startup
entirely. Trusted code answers from the previous result's time-range/source
metadata, emits a validation receipt and terminal Verified answer, and records
zero queries. Questions that require a different period, measure, dimension or
grain continue through the normal Codex investigation with the prior evidence
in context. The dashboard appends ordinary follow-ups to the conversation; it
uses `replaceTurnId` only when superseding a genuinely in-flight accepted turn,
never for the last completed answer.

Greetings, thanks, praise, acknowledgements and sign-offs use an even earlier
deterministic social door. After the durable turn begins, the web route emits
one short conversational answer and returns before loading business context,
minting a Cube bearer, generating a Nano acknowledgement or contacting the
Codex service. Wording such as “nice one” therefore produces “Glad that
helped.” with no planning/validation trail or stale restatement of the prior
analysis. Bare agreement (`ok`, `yes`, `sure`) is deliberately excluded because
it may answer a preceding clarification; mixed messages such as “nice one, now
show sales” remain analytical.

Other normal conversation uses a hybrid route before analytical context is
loaded. Trusted code answers current and relative date/time questions from the authenticated
tenant timezone, so “what’s today’s date?” and “date tomorrow?” never ask Cube for the latest sales
date. A deterministic business/referential detector sends obvious analytical
questions straight to Codex without an extra model call. Only the ambiguous
remainder uses one bounded `gpt-5-nano` structured request (minimal reasoning,
Fast processing, 2.5-second timeout) that both classifies the route and, for
conversation, writes the short reply. The router receives no business rows or
tools. Invalid output, timeout or uncertainty fails safely to analysis. It may
answer stable general conversation, but must disclose when live external
information would require web access rather than invent it. The mere existence
of prior conversation never makes a standalone general question analytical;
the wording itself must refer to the previous business answer.

### Topology

```text
/dash Codex tab
  -> POST /api/codex-conversation (auth, tenant, durable turn, lease, trace)
  -> HMAC-signed background-job start + bounded event polls
  -> albert-codex-runtime in Sydney
  -> local pinned Codex app-server over stdio
  -> host-handled read-only semantic tools
  -> albert-cube -> live-turn capability -> semantic_ro / RLS -> Analytics
```

The browser never speaks app-server. Vercel remains the authority for the user,
tenant, role, conversation, turn, lease, and immutable public trace. Supabase
remains the only conversation store.

The web-to-Fly hop is intentionally not one long analytical HTTP request.
Vercel starts a signed job keyed by the already-minted request id, then retrieves
up to eight sanitized trace events per signed long poll. The single-machine
Codex service owns the ephemeral process and a bounded 32 MiB/600-event buffer
for at most the terminal retention window; Vercel persists each accepted event
into the normal conversation trace. This avoids platform subrequest timeouts
without creating a second durable conversation store. Replays, forged cursors,
oversized events, over-capacity starts and stale terminal jobs fail closed.

### Semantic authority

The Vercel route mints a 15-minute Cube bearer only after the durable turn is
running. It is bound to the authenticated tenant, role, conversation, turn,
and general profile. The Sydney Codex service receives that bearer but no Cube
signing secret and no database credential. It validates the bearer scope before
use. Cube independently verifies its signature and live-turn capability, applies
`semantic_ro`, and enforces tenant RLS.

Codex receives only five namespaced tools:

1. `albert.search_semantic_catalogue`
2. `albert.get_view_schema`
3. `albert.run_semantic_query`
4. `albert.report_evidence_update`
5. `albert.make_chart`

The query tool accepts Cube semantic JSON only. It accepts no SQL, tenant id,
turn id, physical table, join, credential, or write action. Trusted code runs
the existing catalogue, member, one-view, date, row, and aggregate-privacy
validation before Cube execution. Catalogue searches, schema loads, query
attempts, successful queries, and validation-repair turns have no count-based
ceiling. The entire ephemeral investigation instead shares one 12-minute
analytical deadline. The host rejects an exact successful-query digest when
Codex repeats it and instructs Codex to stop as soon as the question is
supported. Row, payload, privacy, and per-query semantic constraints remain
hard security boundaries. The deadline leaves recovery headroom below the web
route and 15-minute Cube-bearer ceilings while broader durable execution is
not yet available.

The fourth tool is presentation-only and creates no new data authority. It may
emit one short owner-facing narrative only after a successful semantic query.
Its request must reference exact result ids from the current turn, contain at
least one result not used by the preceding accepted update, and state a
concrete finding. Trusted code rejects unknown/stale evidence, invented
figures, plans and intentions, duplicate prose, and more than four accepted
updates. Every figure is checked against the referenced result rows before the
message enters the public trace. Only after that check, the same trusted
presentation formatter used for final answers adds the governed currency or
percentage marker, grouping, and bounded decimal precision. An empty-result
update is allowed only when all referenced governed results are empty and the
message plainly reports no matching rows.

The fifth tool is also presentation-only. It accepts an existing result id,
chart purpose, caption and column keys; it never accepts plot rows, Vega,
expressions or a query. Trusted code checks question intent, result grain,
point count, x/y roles, unit compatibility, series cardinality, duplicate
grain, equal-height bars, chart duplication and the two-chart turn limit. It
then derives a bounded chart-data table and compiles the same closed grounded
Flint target used by V3. The chart references that emitted table by result id,
so the browser never renders model-authored data.

Chart choice follows the V3 visualiser policy: lines for ordered trends,
ranked horizontal bars for categories, grouped bars for comparisons and
stacked bars only for composition. Like-for-like periods share a month axis
rather than appearing end to end. Scalar and one-point lookups, two-point
lines, listings, equal values, mixed units, excessive points or series, exploratory results
unrelated to the final answer, and questions without material visual intent
produce no chart. Codex decides near the end of the analysis, uses at most two,
often uses none, and never queries merely to decorate an answer.

### Codex process boundary

The official `@openai/codex` package is pinned exactly to `0.148.0`, and the
service rejects any other CLI version. Each Albert turn receives one fresh
ephemeral Codex thread and one app-server process using stdio. The thread has:

- `environments: []` and no runtime workspace roots;
- read-only sandbox and network access disabled;
- approval policy `never`;
- shell, unified exec, browser, computer use, image generation, apps, plugins,
  remote plugins, hooks, goals, workspace dependencies, code mode, and
  multi-agent features disabled;
- local history persistence disabled;
- a private turn-local Codex state directory, deleted with the turn;
- no repository mount; and
- official API-key login over stdin into that disposable state directory; the
  app-server child environment contains no API key, only the approved OpenAI
  base URL plus basic executable/TLS process values.

Thread start is rejected if app-server reports any external instruction source
or workspace root, and any MCP startup event terminates the turn. The Cube
bearer, service HMAC key, Supabase values, connector credentials, and
database values are never inherited by Codex. Any command, file, MCP, browser,
image, or collaboration item, or any non-Albert server request, terminates the
turn as a forbidden-capability failure. Raw reasoning and provider payloads are
never adapted into Albert trace events. Completed app-server `agentMessage`
items explicitly marked `phase=commentary` are ignored; owner narrative enters
the trace only through the host callback for `albert.report_evidence_update`.
Ordinary app-server commentary is not a product event. Albert opts out of
`item/agentMessage/delta`, ignores completed commentary-phase messages, and
never buffers or projects raw model narration. Final-answer items, reasoning
items, unclassified deltas, JSON-shaped text, structured-answer field names,
and rejected candidate prose are never projected. Trusted lifecycle events for
catalogue mapping, schema review and governed queries remain available in the
collapsible activity trail, while visible prose is reserved for the
evidence-bound update tool.

The harmless built-in plan tool is enabled. For a multi-step question Codex is
instructed to create and maintain a two-to-six-step evidence plan. Every native
`turn/plan/updated` full snapshot is consumed, but trusted code owns the public
checklist: it assigns stable step ids, treats the last step as synthesis, binds
successful result ids only after their tables are emitted, and converts native
completion to `done` only when governed evidence exists. The checklist ticks as
the investigation progresses and is terminally settled before the answer;
unproved work is shown as blocked or incomplete, never falsely green.

If a clearly complex question reaches its first semantic query without a native
plan, the host emits a bounded three-step fallback before that query. Simple
scalar lookups do not receive a plan. Native plan wording is owner-sanitized;
legitimate periods such as “12 months” remain visible, while URLs, structured
answer fragments, credentials and result-reference vocabulary are rejected.
Repair turns cannot replace the original plan. Albert does not switch into
Codex's separate collaboration Plan mode, because that mode plans instead of
executing the requested analysis; the execution thread uses the native plan
tool while continuing through governed evidence and answer validation.

### Grounding and terminal answers

Codex final output is constrained to a versioned JSON schema. Trusted host code
then independently verifies that:

- every presented result id was emitted this turn;
- every numerical token is a faithful restatement of a governed result cell;
- structured claim references address real result cells;
- ordering/comparison language has sufficient typed claim proof; and
- Verified, Qualified, or Exploratory answers have governed query evidence.

After validation, trusted host code applies presentation-only numeric
formatting against the cited governed cells: currency uses two decimals,
percentages and continuous quantities use at most two, whole counts remain
whole, and thousands separators are added. This pass may round display text
but never creates a new figure. Codex is instructed to use a short verdict,
concise Markdown headings, bullets, and short paragraphs for multi-part work.

Cell grounding is necessary but not sufficient for analytical completeness. A
blank/null field or an empty result is a coverage signal, not proof that the
business fact is absent while a materially different governed source or grain
remains. Codex is instructed to search and test plausible alternate semantic
paths before concluding unavailable. Trusted sufficiency guards can reject a
fully cell-grounded draft and continue the same ephemeral thread when a known
recovery path was skipped. The initial shipped guard covers R-Series selling
prices: blank catalogue price members require a completed sale-line check of
observed normal, charged and average selling prices, clearly labelled as
historical proxies rather than current catalogue truth.

For versioned analytical briefs, required views/calculations and the common
period are also server-enforced sufficiency conditions. Employee-performance
briefs require employee-attributed POS contribution plus authoritative Deputy
worked hours when connected; neither may be deferred to a follow-up. Trusted
code aligns exact unique employee labels over the common source watermark and
emits takings and gross-profit per worked hour as a derived governed result.
This is disclosed as source-label alignment rather than a canonical identity
graph; duplicates and unmatched labels are not merged.

After deterministic checks pass, a separate low-effort Fast review call compares
the draft and evidence metadata with the frozen owner goal and must-cover list.
It can return only pass or a bounded list of missing checks. Missing coverage
continues the same ephemeral Codex thread with a targeted repair instruction;
review failure itself fails open to the deterministic gates so it cannot make a
working analytical turn unavailable.

Validation happens while the ephemeral Codex thread is still live. When a
candidate fails, the host returns bounded repair instructions to a new turn on
that same thread. Every successful query also returns a bounded
`hostGeneratedClaims` list: trusted code constructs ready-to-copy value,
ranking, and like-for-like comparison claim objects from exact result cells.
Ranking examples exist only when the governed query ordered that exact numeric
member before applying a limit. The host may remove accidental extra refs from
a typed claim only when one generated candidate exactly matches every selected
numeric result, row, member, and assertion; it never invents or changes the
model's metric, entity, direction, or result. This keeps mechanical citation
assembly out of the model while preserving the independent claim validator.

Repair feedback includes the relevant complete host-generated objects, not
only opaque error codes. The public trace explains the repair in owner language
and suppresses repeated copies of the same failure fingerprint. Codex keeps its
prior governed tool results, may repair cell references or gather genuinely
missing evidence, and can continue repair turns until less than one minute
remains in the shared deadline. Only the candidate that passes host validation
is published. A final candidate that still fails near the deadline produces an
evidence-preserving Unavailable answer; model prose can never upgrade the
evidence state. Only sanitized Albert progress, evidence-bound narrative,
query, table, validation, answer, and error events are persisted or sent to the
UI; rejected candidate prose is never exposed or stored in the public trace.

### Learning boundary

The Codex experiment does not automatically fine-tune or mutate a model per
user or tenant. Failed claims are usually product-contract defects rather than
durable facts about an individual, and raw prompts, customer rows, period
figures, or source text may not become training examples. This also preserves
Albert's platform-wide no-training stance and Xero's contractual data boundary.

Learning is split into three governed layers:

1. **Within-turn adaptation:** the ephemeral thread receives the exact
   validator failure fingerprint plus host-generated claim objects and retries
   immediately. Nothing survives teardown except the ordinary sanitized Albert
   trace.
2. **Product learning:** aggregate error codes, runtime/config versions, query
   digests, and whether a reviewed repair strategy succeeded may inform the
   regression corpus. No question text, result rows, tenant id, customer data,
   reasoning, or tool arguments enter that telemetry. A change ships only
   through tests, review, versioning, and rollback.
3. **User preference memory:** a future user-scoped context may remember only
   explicit, stable presentation or vocabulary preferences (for example the
   preferred sales lens), with provenance, confidence, expiry, review, and
   deletion. It may never store changing business figures, infer identity
   joins, silently redefine a governed metric, relax security, or rewrite the
   agent prompt from unreviewed failure traces.

Tenant semantic improvements therefore follow propose → evaluate → human
review → version → publish. They are never autonomous self-modification.

### Service boundary and capacity

`albert-codex-runtime` is a signed-public Fly service locked to Sydney, with one
warm 1 GB machine and one concurrent Codex turn. It returns 429 before spawning
a process when full. Requests are body-HMAC authenticated, time-bounded, and
replay-rejected by request id. Client disconnect aborts the app-server turn and
terminates the child process.

The service owns `OPENAI_API_KEY`, the approved `OPENAI_BASE_URL`, `CUBE_API_URL`,
and its dedicated request-signing secret. It explicitly does not own
`CUBEJS_API_SECRET`, a Supabase key, or any control/analytics database URL.

Local development runs the same service on loopback with a clearly labelled,
non-production HMAC value; production has no fallback and requires its dedicated
secret. The local service uses the same empty Codex environment and turn-bound
Cube bearer, so the browser/web process never needs child-process authority.

## Consequences

The experiment compares harnesses over the same semantic authority without
risking a V3 regression or creating a model-to-database path. It also preserves
Albert's UI, conversation history, provenance, and cancellation behaviour.

Codex adds a Vercel-to-Fly hop and a process/thread startup, so it is not
expected to beat deterministic V3 recipes on latency. It is intended to test
quality on novel analytical and deep questions. No automatic routing or
fallback is permitted.

The app-server dynamic-tool and environment-suppression fields are experimental.
Every Codex package upgrade therefore requires protocol regeneration, the
forbidden-tool contract, the fake app-server lifecycle suite, and paired evals.

## Promotion gates

The tab remains experimental until all of the following are demonstrated on
the deployed Sydney service:

- exact pinned CLI/build provenance;
- approved AU OpenAI endpoint, `store:false`, and organisation data controls;
- zero forbidden tools in captured model requests and zero forbidden items at
  runtime;
- zero cross-tenant, forged-bearer, replay, cancellation, or cleanup failures;
- complete usage/cost receipts or an explicitly accepted accounting gap;
- no local Codex thread state after teardown;
- zero numeric, privacy, provenance, or terminal-state regressions; and
- non-inferior paired quality with acceptable p50/p95 latency and cost.

Until then, Codex is never a silent production fallback and never qualifies or
supersedes V3.
