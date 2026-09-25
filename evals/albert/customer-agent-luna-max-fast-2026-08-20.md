# Customer Agent — Luna Max Fast verification (2026-08-20)

## Scope

- Tenant: Ashburton Cycles (`01KZN20VTX2EWW1TQ2AA3MCPW6`)
- Local candidate: `47db84a` plus the Customer Agent working tree
- Model: `gpt-5.6-luna`
- Reasoning: `max`
- Fast mode: enabled
- Profile: `customers`
- Full records: `evals/albert/runs/customer-agent-live-smoke/results.jsonl`

This is a diagnostic baseline, **not release qualification**. The local candidate
was not deployed to Cube/web and migration 0157 was not applied. A normal signed-in
production UI turn supplied a short-lived semantic lease; the UI raw debugger
confirmed Luna / Max / Fast and 6.37-second response TTFB.

## Result

| Case | Purpose | Duration | Terminal state | Successful queries |
| --- | --- | ---: | --- | ---: |
| CA-08 | profiles vs unique people | 144.9 s | Unavailable | 0 |
| CA-17 | unsupported CAC / NPS | 229.7 s | Unavailable | 0 |
| CA-19 | other-domain inventory access | 121.1 s | Unavailable | 0 |

Every attempted Cube query was correctly rejected with `semantic turn lease is
not active`. The production UI turn had already finalized before the local
runner reached its first data request. No customer rows or PII were returned.

This run therefore proves:

- the eval runner selected Luna / Max / Fast and the Customers profile;
- the new profile prompt/routing path executes against a production catalogue;
- cross-domain inventory remained routable under the Customers profile; and
- the signed live-turn capability boundary fails closed.

It does **not** prove numerical accuracy or final-path latency.

## Candidate-only deterministic evidence

The focused contracts prove the head path without a provider or data-boundary
bypass:

- an exact reviewed starter bypasses model intent classification;
- a valid one-row `answer_template` returns immediately after one governed
  query with zero composer requests;
- malformed/missing/null cells fail closed to the existing composer;
- the customer-count/pulse/attribution templates reference exact selected
  semantic members only; and
- refund-safe repeat, censored 90-day cohorts, role/privacy and tenant routing
  contracts pass.

The production build and four Customer Agent browser cases also pass. These are
candidate tests, not a substitute for the live release run.

## Required promotion rerun

After the protected release applies control migration 0157 and deploys the same
immutable candidate to Vercel and `albert-cube`:

```bash
node --import tsx scripts/albert-eval/run.mts \
  --run customer-agent-release \
  --profile customers \
  --fast \
  --filter surface=customers \
  --concurrency 1
```

Use fresh dedicated eval leases for the complete run. Report p50/p95, first
query, Cube execution, request count, tokens, recipe hit rate, numeric goldens,
privacy outcomes and every terminal state. Do not reuse an ordinary UI turn.

Release gates remain: zero PII/role/tenant/write-back failures, zero unexplained
numbers, refund/cohort/attribution invariants passing, and no regression in the
general profile.
