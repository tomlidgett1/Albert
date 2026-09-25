# 0147 — Claude Opus 5.5, Claude Fable 5.1 and Fast on Claude

Date: 2026-09-23. Status: implemented. Opus 5.5 and Fast are live; Fable 5.1
waits for its approval.

## Why

The owner asked for Fast on Anthropic models in Analytics (Yellow Jersey,
ADR 0144) and in Albert, and for the latest models. Albert offered Claude
Sonnet 5 and Haiku 4.5, and `modelSupportsFastMode` returned false for every
Anthropic model.

## What Anthropic offers (docs and live API, 2026-09-23)

| Model | API id | Price per MTok | Thinking | Fast |
| --- | --- | --- | --- | --- |
| Claude Fable 5.1 | `claude-fable-5-1` | $10 / $50 | adaptive, cannot be disabled | no |
| Claude Opus 5.5 | `claude-opus-5-5` | $4 / $20 | adaptive, cannot be disabled | yes: $8 / $40 |
| Claude Sonnet 5 | `claude-sonnet-5` | $2 / $10 | adaptive, can be disabled | no |
| Claude Haiku 4.5 | `claude-haiku-4-5-20251001` | $1 / $5 | manual budgets | no |

Fast mode is a research preview on the native Messages API only:
`speed: "fast"` with the beta header `fast-mode-2026-02-01`, up to 2.5x the
output speed of the same model, with its own rate limit. Probed with Albert's
key:

- Opus 5.5 and Fable 5.1 answer effort `low` to `max`, and 400 on
  `thinking: {type: "disabled"}`.
- `speed` without the beta header 400s ("Extra inputs are not permitted"), and
  on Sonnet 5 it 400s ("does not support the `speed` parameter").
- With the header, Opus 5.5 answers **429: "rate limit of 0 fast mode input
  tokens per minute"**. The account does not have fast-mode access yet; it is
  enabled per organisation by Anthropic.

Retention: fast mode is eligible for zero data retention, and so is Opus 5.5.
Fable 5.1 is one of Anthropic's "Covered Models": Anthropic keeps its requests
for 30 days and does not offer it under ZDR without express authorisation.
Albert runs Claude only under `ALBERT_ANTHROPIC_ZDR_APPROVED`, so Fable would
change what Albert promises about data at Anthropic.

## Decision

**Opus 5.5 ships with Fast; Fable 5.1 is built but runs only under a separate
retention approval.**

- `packages/shared`: both models join the registry. `anthropicRequiresThinking`
  (Opus 5.5, Fable 5.1) clamps effort `none` to `low` and drops it from their
  effort lists; both use adaptive thinking with a 128k output ceiling.
  `anthropicSupportsFastMode` is Opus 5.5 alone, so `modelSupportsFastMode`,
  `normalizeAgentPreferences` and `serviceTierForPreferences` carry Fast for it
  (tier `fast`) and nowhere else on Claude.
  `anthropicModelRequiresRetention` (Fable) makes `resolveAlbertModelTransport`
  refuse the model without `anthropicRetentionApproved`.
- Messages adapter: an Opus request whose tier is `fast` adds `speed: "fast"`
  and the beta header, with no SDK retries. A 429 on a fast request falls back
  to standard speed at once and for the rest of the turn (Anthropic's
  documented fallback), so an account without fast-mode access, or one that
  hits the fast limit, gets a normal answer rather than a failed or stalled
  turn. The response's provider data reports the `speed` that ran and
  `fast_fallback`. Any other error still fails the request.
- Approvals: `ALBERT_ANTHROPIC_RETENTION_APPROVED` gates Fable on the web route
  and in the runtime (refused at job submission, like GPT-6 without its
  approval). It is not set, so Fable is admitted by the Omni allowlist but not
  offered in any picker.
- Pickers: Albert's run controls and Omni list, and Yellow Jersey's Analytics
  picker, offer Claude Opus 5.5 with Fast. Fable is left out until approved.
- Metering: an `anthropic-claude-5-2026-09-23` rate card prices Sonnet 5 (which
  had none and threw in `tokenRatesFor`), Opus 5.5 and Fable 5.1, with Fast at
  2x; Fast is priced only where the model has it. Omni does not write the
  usage ledger, so its model CHECK needs no migration.

## Evidence

`tests/contracts/claude-opus-5-5-fable-5-1-runtime.contract.test.ts` pins the
wire: speed and header only on Opus with Fast, no SDK retries on a fast
request, the 429 fallback and its persistence through the turn, no speed on
Sonnet 5 or Fable, effort `none` as `low`, Fable's approval, and the rates.
A real Omni turn through a local runtime on Opus 5.5, High, Fast answered
"How did sales go last week compared with the week before?" in 82 seconds
over 10 model requests with the comparison table (ADR 0146). Because the
account's fast limit is zero, that turn also exercised the fallback.

## Consequences

- Fast on Opus 5.5 runs at standard speed until Anthropic enables fast mode on
  the account; nothing else changes when it does.
- A fallback turn's cost estimate still carries the Fast multiplier where
  metered, since the meter prices a run at one speed. Omni is not metered by
  this path.
- Enabling Fable: set `ALBERT_ANTHROPIC_RETENTION_APPROVED=true` on Vercel and
  the codex runtime, and add `claude-fable-5-1` to the three picker lists.
