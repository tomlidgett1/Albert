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
