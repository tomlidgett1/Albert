# Omni harness acceptance — 2026-08-29

Engine `omni-86224d3` · model `gpt-5.6-luna` · effort `max` · fast mode **off** ·
tenant Ashburton Cycles (lightspeed-r, xero, deputy) · private runtime on :8799,
production-shaped leases minted per turn via `begin_albert_turn`.

Runner: `npx tsx scripts/albert-eval/run-omni.mts --run omni-acceptance-20 --concurrency 3`
Corpus: `scripts/albert-eval/questions-omni-20.ts` (20 turns: 7 lightspeed, 7 xero,
4 deputy/labour, 2 cross-connector; two 2-turn follow-up threads).

## Result

**20/20 Verified.** One turn (OM-XO-07) initially died to a provider stall
(`ModelBehaviorError: Model did not produce a final response!`, no retry); the runtime
gained a one-shot transient-run retry and the rerun verified in 41s. No other failures,
no clarifications, no `No data`, no empty answers.

## Latency (wall clock, submit → terminal answer)

| metric | Omni (this run) | Codex luna-max baseline / v6 (50 turns) |
| --- | --- | --- |
| p50 | **30s** | 207s / 224s |
| mean | 48s | 238s / 213s |
| p90 | 82s | 442s / 394s |
| max | 234s | — |
| first governed query p50 | 16.8s | 24.1s / 22.3s |
| first trace event p50 | 0.7s | — |

Per connector (mean): deputy 19s · xero 42s · lightspeed 61s · cross 55s.
64 governed queries across the battery (p50 2 per turn).

The one slow outlier (OM-LS-04, 234s, 27 queries) is the bucket-by-weekday shape: the
harness has no derive/group-by tool, so the model decomposed into many small queries.
Candidate improvement: expose a bounded aggregate tool like codex `derive_result`.

## Behaviour verified

- Task lists on 11/20 turns (every multi-step turn; single-query lookups skip per the
  Omni contract), ticked incrementally and settled truthfully before the answer.
- Semantic model research on 20/20 turns: whole-topic YAML lookups (8–19KB field
  definitions grouped by view) and keyword field searches, rendered as
  `research` trace events with the document body.
- Interleaved owner-readable narration between tool calls; parallel searches and
  parallel queries observed (4-topic lookup + 4-query batch in one turn).
- Follow-up suggestions on 20/20 first-turn answers via `?ai-query=` links,
  extracted into chips.
- Follow-up threads (LS-06→07, XO-06→07) resolved anaphora correctly.
- Failed Cube validations self-corrected in-turn (compareDateRange form).

## Production verification (same day)

- Fly `albert-codex-runtime` deployed at `86224d32…` (`omni-harness-86224d3`),
  `/readyz` ready; `/v1/omni/jobs` live.
- 3 production turns through the deployed runtime with fresh prod leases:
  OM-DP-01 15s, OM-XO-01 13s, OM-LS-01 26s — all Verified
  (`evals/albert/runs/omni-prod-verify`).
- Vercel production deployment `albert-n65m424c9` aliased to `albert-chi.vercel.app`;
  `/api/omni-conversation` responds 401 unauthenticated (same gate as codex), `/dash`
  serves. Note: the albert-chi alias is manually pinned — `vercel alias set` is required
  after every production deploy.

## Test evidence

- `services/codex-runtime/omni-runtime.test.ts` — 8 contract tests (YAML model
  rendering, field search, follow-up extraction, config, endpoint auth fail-closed).
- `npm run test:contracts` — 1341 tests, 0 fail.
- Browser acceptance (stubbed harness): "Omni harness renders tasks, research steps,
  query cards and the answer" + codex default-harness regression — both pass.
- Raw event streams per turn: `evals/albert/runs/omni-acceptance-20/events/`.

---

# Hard30 quality program — 2026-08-30

The owner's verdict on the first release: fast, but answers not thorough enough when
needed, and formatting poor. Two root causes found and fixed, validated by a 30-turn
hard battery run twice (baseline vs improved), every answer read and graded.

**Corpus** (`questions-omni-hard30.ts`): 7 open-ended/strategic, 5 data-model/meta,
7 cross-connector, 8 hard single-domain, one 3-turn diagnostic thread. Luna, max
effort, fast off, fresh prod-shaped leases per turn.

## Root causes

1. **Formatting**: answer markdown rendered unstyled in the UI — the omni prose class
   only styled paragraphs, so headings, lists and tables fell back to browser defaults.
   Fixed with a complete prose treatment (card-styled tables, figure-column
   right-alignment via a post-commit DOM pass) — commit ecf96b6.
2. **Depth + rates**: the prompt had no depth calibration, and the blanket mental-math
   ban made the model refuse to state implied rates (staff sales-per-hour answered
   with raw pairs and an explicit refusal to divide). Fixed with the answer-quality
   contract and bounded arithmetic — commit 97e0304.

## Baseline → v2 (same 30 questions, both 30/30 complete, zero infra failures)

| Signal | Baseline | v2 |
| --- | --- | --- |
| Answers using tables | 18/30 | **27/30** |
| Rankings presented as tables | 3/4 | **4/4** |
| Implied rates computed and stated | 1/3 | **3/3** |
| Thin (<300 words) hard/xhard answers | 8 | **5** (3 of them correctly scoped) |
| Median answer length | 452 words | 604 words |
| Median turn time | 125s | 184s |
| Verified terminal states | 27/30 | 26/30 (4 correctly-scoped no-query answers) |

## Deep grade (every v2 answer read; 12-point rubric: directness, depth match,
anchors/rates, formatting, tone, actionability)

- **27/30 met the world-class bar (≥10/12, no accuracy flags)**; mean ≈ 11.2/12.
- ~20 derived figures spot-checked against their shown components: **zero arithmetic
  errors** (sales/hour, wage shares, stock-weeks, discount burdens, percent changes).
- Standouts: OH-DM-04 reconciles Lightspeed vs Xero to within $92 of the identified
  journal noise; OH-TH-02 traces the August workshop backlog to 91 rostered vs 7.18
  recorded hours in the final week; OH-XT-02 delivers the exact weekly staffing table
  with per-hour rates and a roster trial recommendation; OH-XT-04 identifies the
  $157k Funds In Transfer clearing pattern behind the cash-vs-profit gap.
- Sub-bar: OH-DM-05 (trusted stale business context for freshness — fixed: freshness
  questions now verify with latest-date queries; rerun produced an exact per-source
  freshness table and Verified state), OH-DM-01 (orphaned lead-in line after follow-up
  extraction — fixed + regression test), OH-LS-02 (borderline lean, acceptable scope).
- Known eval-environment distortion: eval turns carry no connector freshness lines and
  a stale business-context doc, which seeded "data ends 31 July" claims in several
  baseline/v2 answers; production turns carry live freshness. The prompt now forbids
  using business context as freshness evidence regardless.

Runs: `evals/albert/runs/omni-hard30-baseline`, `omni-hard30-v2`, `omni-hard30-v3-spot`.
Deployed to production 2026-08-30: Fly `omni-quality-97e0304`, Vercel aliased.

---

# Daily60 program — 2026-08-31

The 20 most commonly asked questions per system (Lightspeed, Xero, Deputy), written
as an owner types them (`questions-omni-daily60.ts`, `--corpus daily60`). Luna, max
effort, fast off. **60/60 complete, 59 Verified + one honest No-data** ("is anyone
clocked in right now" with no live clock-in data). Latency: p50 40s, p90 135s, mean
56s (deputy mean 36s, lightspeed 59s, xero 74s).

## Critical findings

- **Statements are now statement-grade.** "Show me my P&L" returns accounting order
  with itemised expenses largest-first, bolded ruled subtotal/total rows, a June
  comparison column, parenthesised negatives, and an accrual/ex-GST basis note — and
  reconciles to Xero. "Show me my balance sheet" returns sectioned assets/liabilities/
  equity with section totals, proves A = L + E, and flags oddities (GST debit position,
  vehicle depreciation placement). Verified again through the production runtime
  (85s, all statement markers present).
- **One genuine defect found in 60 answers**: statement detail lines indented with
  `&nbsp;` entities rendered as literal text. Fixed in the shared inline renderer
  (restores exactly that entity after escaping), codified in the prompt, asserted in
  browser acceptance (real non-breaking indentation, zero literal entities).
- Crispness held where it should: simple questions get correctly tight answers
  ("13 staff on the books: 9 active, 4 archived"), with partial periods flagged
  ("one-day-to-one-day comparison because today is Monday") and named-entity
  questions (Pon Bike spend, Jack's hours) resolving through value lookups with
  cross-checked figures.

Runs: `evals/albert/runs/omni-daily60`, `omni-prod-statements`.
Deployed 2026-08-31: Fly `omni-statements-b914be8`, Vercel aliased, routes verified.
