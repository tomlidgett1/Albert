# 0074. Agent-owned recovery for inconclusive searches

Date: 2026-08-09

## Status

Superseded for V2 by ADR 0077. Typed workspace repair and bounded adaptive
investigation rounds replace SQL search recovery; this ADR remains historical
V1 rollback documentation.

## Context

An identity lookup attempted a customer-phone query, repaired a database type
error, then executed two successful queries that returned no rows. The second
statement claimed to cover formatting variants but did not account for the
stored numeric representation losing a local leading zero. Albert still had
tool capacity, but interpreted the prompt's two-alternative guidance as a
completion threshold and returned a no-match answer after roughly half a
minute. The runtime had no evidence-phase gate capable of challenging that
premature conclusion.

The prompt already told the analyst to revise empty searches and try materially
different routes. Prompt wording and unused tool capacity did not make the
agent use that capacity intelligently. Increasing every result ceiling would
still allow cosmetic retries. Encoding Australian
phone variants in trusted code would fix one example while moving business
reasoning out of the agent and failing on emails, SKUs, external identifiers,
names and future source formats.

## Decision

A successful zero-row result is treated as inconclusive search evidence, not a
terminal proof of absence. When every successful result in the primary evidence
phase is empty, the runtime opens one bounded search-resilience continuation in
the lead analyst's existing history. This applies across execution lanes and
identifier types; it is not selected by phone-number phrases.

The continuation receives the original question, the count of empty and failed
attempts, and a completion standard. It must revise its working plan with
`reason=recovery` before another schema or data call. It is explicitly
responsible for deriving materially different hypotheses from table
definitions, field types, prior errors and stored data shape; this may involve
representation-normalised comparisons, alternate fields or relationships, a
different grain, or another relevant table. These are examples of analytical
dimensions, not a server-authored variant list. The agent also owns ambiguity
checking and must not select an arbitrary candidate.

The normal lane result ceiling remains intact for successful work. Only the
inconclusive continuation receives a separate fixed result allowance and turn
ceiling. Quick lookups receive a larger wall-clock envelope so this continuation
has time to operate while preserving a final-answer reserve. The continuation
runs at most once; a supported match ends it, while a remaining no-match may be
reported only after at least one materially different statement executes.

Trusted code records SQL-statement outcomes independently of owner-facing tool
purpose text. Re-executing the same normalised statement returns duplicate-query
guidance and consumes no new result slot. This is a loop guard, not an answer
planner: the runtime judges only whether the attempted statement is unchanged,
never which transformation or source the analyst should try next.

If the recovery continuation itself is unavailable, Albert retains the
grounded draft but records the incomplete recovery as a limitation and lowers
confidence through the existing answer guards. It never upgrades an incomplete
search into a definitive no-match.

## Consequences

- A fast positive lookup still stops after the first sufficient result.
- Empty searches can run longer and challenge their own assumptions without
  granting every lookup an unbounded budget.
- Phone, email, SKU, name and other record searches share the same recovery
  mechanism without deterministic format lists.
- Cosmetic retries cannot masquerade as additional research.
- Negative answers cost extra model and query work because false negatives are
  more damaging than one bounded recovery continuation.
- Production traces expose whether the initial empty result was successfully
  challenged or the conclusion remains qualified.
