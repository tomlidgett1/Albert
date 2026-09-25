# ADR 0119: Remove Gemini 3.7 Flash from Albert

- Status: accepted
- Date: 2026-08-23
- Owners: product and platform
- Supersedes: ADR 0118

## Context

ADR 0118 added Gemini 3.7 Flash on the Codex harness through Google's
generateContent API. A 15-question eval against Luna Max Fast showed Gemini
was slower in-harness (median 93s vs 28s) because of extra Cube queries and
Luna host review, not because Flash tokens were faster. The product does not
need a third Codex provider.

## Decision

- Remove `gemini-3.7-flash` from the live model catalogue, Codex picker, and
  Codex runtime. V3 never selected it.
- Delete the generateContent driver and Gemini env, transport, and rate-card
  wiring.
- Keep `gemini-3.7-flash` on the usage-ledger check and answer-lineage
  metering enum so historical eval rows still validate. New turns cannot
  select it.

## Consequences

Codex is Luna, Terra, and Sol only. Stale Gemini preferences normalise to
Luna. Historical Gemini usage rows remain readable.
