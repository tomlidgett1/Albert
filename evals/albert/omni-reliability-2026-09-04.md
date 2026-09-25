# Omni reliability qualification — 4 September 2026

The implementation is complete in the working tree. The new production job
store is **not activated**: administrator upgrade 0015 and migration 0189
remain blocked on the protected control-plane administrator configuration.
Trace idempotency migration 0188 is applied. Production activation remains
pending; the release-preparation record below distinguishes staged builds
from the live deployment.

## Changes delivered

| Review item | Implementation |
| --- | --- |
| Verified answer eligibility | `ComposeAnswer` resolves scalar and table references, rejects unbound figures and unknown cells, checks explicit requested periods, and derives the confidence state. Raw final model prose cannot replace it. |
| Complete, compatible evidence | Results retain coverage, grain, source key domains, windows and digests. Incomplete absence tests, ambiguous identities, duplicate join keys and incompatible arithmetic are rejected. |
| Durable trace completion | Ordered retries use an idempotent database append. Successful answers and dashboard plans wait for their evidence and terminal event to be saved. |
| Evidence-aware continuity | Prior governed results are reusable; whole requests are bounded in bytes. Model context can shed old row previews while retaining the full evidence registry. |
| Repeatable release evaluation | Immutable run manifests bind service build/model/corpus settings; every attempt is preserved; numeric oracles and missing-claim checks fail the command. Live tests use production-duration bearer and lease renewal. |
| Interrupted execution | Checkpoints retain completed tool pairs, evidence, tasks, allowances and usage. Encrypted SQLite development storage and PostgreSQL production storage implement durable identity, leases and revision fencing. |
| Enforced shared contracts | Shared analytical rules and strict query conversion replace divergent query handling. Malformed filters and meaning-changing period repairs are refused. |
| Tenant context isolation | Neither chat runtime falls back to a shared sales-briefing file. |

Arithmetic uses exact decimal operations. Explicit percentage units prevent
0.5 percentage points from rendering as 50%. Composed tables support a single
column and preserve literal source punctuation; follow-up links become chips.

## Validation

All model runs below use **GPT-5.6 Luna, max effort, standard processing**.

| Suite | Outcome |
| --- | --- |
| Frozen model evaluation | **36/36 passed**: 17 scenarios, two trials, including a separate chart-follow-up step in each trial |
| Real-business-data evaluation | **20/20 passed structural smoke checks**, across Lightspeed, Xero and Deputy |
| Repository contracts | **1,522 passed, 2 skipped, 0 failed** |
| Focused Omni regressions | Passed; includes final-answer binding, incomplete joins, decimal arithmetic, context budgets, ciphertext/tenant isolation, separate-process recovery, lease fencing and hidden-field rejection |
| TypeScript and targeted ESLint | Passed |
| Service builds and service-boundary checks | Passed |
| Deployment validation | Passed after reconciling the existing iMessage manifest, dedicated Codex CPU profile, Sydney routing and the new Omni job-store requirement |
| Browser | **3 passed**: authentication setup plus light- and dark-theme composition/unit checks; screenshots visually inspected |
| Existing deterministic eval tests | **2/2 passed** |

The two skipped repository tests are optional live **V3** Luna/Grok schema
checks. The Omni Luna Max evaluations above ran explicitly.

The live smoke checks establish successful completion and resolvable evidence
references. The frozen suite independently checks known numeric answers;
live smoke success is not an independent audit of every business conclusion.

## Model-run evidence

- [Frozen manifest](runs/omni-frozen-luna-max-v3/manifest.json),
  [results](runs/omni-frozen-luna-max-v3/results.jsonl),
  [summary](runs/omni-frozen-luna-max-v3/summary.json).
- [Live manifest](runs/omni-live-luna-max-v3/manifest.json),
  [results](runs/omni-live-luna-max-v3/results.jsonl),
  [summary](runs/omni-live-luna-max-v3/summary.json).
- Shared model-evaluation harness build:
  `ba7853b0155a37098e6bed434e6bd79aba8d1be138d54f717d77b1df89820e32`.
- Frozen fixture/oracle digest:
  `9446c9c929270e6bbffa717ab80aa41ec2b6b94a9467a76ab88d9e54a7799adc`.
- A subsequent hidden-field lookup guard was exercised by an actual-tool
  regression test, followed by the passing `omni-final-guard-smoke` Luna run.
  Its separate manifest records the resulting build identity. PostgreSQL
  role activation was also verified to share one transaction with each job
  statement, including rollback behavior, for transaction-pooler support.

| Measurement | Frozen, 36 turns | Live, 20 turns |
| --- | ---: | ---: |
| Median duration | 32.3 s | 63.6 s |
| 90th percentile | 54.9 s | 173.0 s |
| Maximum | 88.6 s | 357.1 s |
| Model requests | 258 | 214 |
| Input tokens | 2,445,477 | 5,011,752 |
| Cached input tokens | 1,710,982 | 3,907,119 |
| Output tokens | 94,684 | 177,853 |
| Verified / Qualified | 28 / 8 | 3 / 17 |

Qualification is expected when source coverage is partial, a result is a
bounded slice, prior results are reused, or checks remain incomplete. The
confidence label is not the eval pass criterion. These timings describe the
current corpora; they do not establish a paired speedup against an older run.

## Issues found during qualification

1. A model could finish with an empty postscript after successfully composing
   its answer. The accepted composition is now the deliverable, and a
   regression exercises that exact path.
2. The browser correctly rejected a fixture response whose model header did
   not match the selected model. The fixture now echoes the requested model.
3. A one-column composed table exposed an existing Markdown renderer gap.
   Single-column tables and escaped source labels now render correctly.
4. The first version of frozen F11 required the August total even though the
   question requested only dollar and percentage change. The recorded answer
   correctly gave **400 and 200%**. That oracle was corrected, and F17 now
   explicitly requests and verifies both monthly totals plus the changes.
   Earlier runs and their original failure records remain intact.
5. A hidden catalogue field could otherwise be guessed through field-value
   lookup. That path now rejects hidden fields before issuing a data request.

## Remaining production activation

The final read-only control-plane check returned:

```json
{
  "job_role_exists": false,
  "job_table_exists": false,
  "trace_migration_applied": true
}
```

`scripts/admin-bootstrap-upgrades.ts` requires both `current_user` and
`session_user` to be `postgres`. The configured administrator URL currently
uses another database role. The user was asked to configure the protected
Sydney control-plane connection directly in `.env.local`, without sharing
credentials in chat.

Once configured, apply administrator upgrade 0015 using the checksummed
administrator runner, then migration 0189 using `scripts/migrate.ts` with
the control-plane deployer and migration-owner role. Provision the dedicated
`albert_omni_control_runtime` login and configure `ALBERT_OMNI_JOB_DATABASE_URL`
on the runtime with TLS. Production readiness and the deployment contract
require this store configuration; production cannot fall back to local SQLite.

The migration runner also applied the already-pending 0187 dashboard editor
migration before 0188, preserving the ledger's exact migration prefix.

## Production release preparation — 5 September 2026

The owner requested production deployment after qualification. Vercel access
was verified and the existing Fly CLI session was renewed through its normal
browser sign-in. The control-plane administrator connection still uses a
restricted role; the job-storage role and table remain absent.

The complete `npm run check` passed after fixing React lifecycle lint errors
in the Omni work timer and iMessage manager: **1,525 contracts passed, two
optional tests skipped**, along with the full lint/typecheck, deterministic
evals, service builds, application build and rendered-HTML tests. CI now has
the test-only Omni login password. The login provisioner supports an explicit
single-login target, with three regression cases, so enabling Omni does not
reconcile other services' credentials. Browser authentication state and local
evaluation artifacts are excluded from deployment uploads.

Before this release, the live web health endpoint returned HTTP 503 with
`syncWorker: false` and `operatorDiagnostic: false`. Cube and the previous
private runtime were healthy. The new Omni readiness endpoint was not yet
present on the deployed runtime.

The first Vercel production candidate built successfully at
`albert-fquhtuntv-tom-lidgettnets-projects.vercel.app`; the primary
`albert-chi.vercel.app` alias still points to the previous release. GitHub's
control-plane and analytical database gates passed, including the new schema
and runtime login on disposable CI databases. The full browser run exposed
collapsed evidence in the accessibility tree; closed research/query/pivot
bodies now use `aria-hidden` and `inert`. The statement-formatting assertion
is scoped to the statement table rather than an identically named pivot cell.

The first remote services image build failed in the inherited unpinned Xero
MCP installation. Its dependencies now have a dedicated lockfile and use
`npm ci`, preserving the official 0.0.17 server and existing executable path.
The image also includes Supabase's public root CA for a `verify-full`
job-store connection. No certificate verification is disabled.

## Re-run

```sh
npm run test:omni
npm run eval:omni:frozen:luna-max
REPRO_SERVICE_URL=http://127.0.0.1:8798 npm run eval:omni:live:luna-max
```

The live command expects a separately running private runtime built from the
candidate source. Every invocation uses a fresh run directory unless an exact
same-build resume is requested explicitly.
