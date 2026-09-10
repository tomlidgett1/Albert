# ADR 0138 — Seven-day investigations, refreshed every 24 hours

Date: 2026-09-10. Status: accepted. Supersedes ADR 0137's display and cadence.

The owner rejected passive headlines such as “Transaction volume hit a
four-week high”. The surface should suggest an analysis to run, for example
“Analyse why [category] sales fell to [amount]”. The scope is the most
important issues from the last seven days, refreshed every 24 hours.

## Decision

- Keep the existing per-owner governed Luna Max analysis and separate stored
  display text, detailed question and evidence. The displayed `title` must
  begin with Analyse why, Investigate, Review or Check, name a concrete issue,
  and carry one useful observed figure (at most two). It is limited to 110
  characters and 14 words. The parser and read/display boundaries reject
  passive headlines, jargon, template echoes and figures absent from the
  evidence. The figure check is a presentation safeguard; the existing
  governed query/answer pipeline remains responsible for factual grounding.
- Rank up to three distinct investigations by financial impact, urgency and
  decision value across connected tools. A transaction-count record alone
  does not outrank lost sales, margin pressure, cash collection or cost risks.
  Do not infer an all-period record from four matching weekdays. Compare
  like-for-like completed periods; a dated finding from completed days within
  the last seven days is eligible despite incomplete coverage elsewhere.
- Store exactly 168 hours of observation context using migration 0192 and the
  format version `omni:weekly-v1:<model>`. Historical 24-hour rows remain
  stored but cannot populate the new surface. An older worker cannot
  overwrite a weekly selection during rollout. Tenant and actor scope stay
  unchanged.
- Refresh 24 hours after the last successful generation. The configured
  interval is fixed at 86,400 seconds. Polling/focus reads do not generate
  another analysis. Allow two hours for retry before expiring the display;
  label it “Last 7 days” with the actual update age. A failed or unsupported
  result never becomes a fabricated recommendation.
- Generate and inspect a real candidate before publishing it. Reuse the same
  generator/parser with the cache write captured for review; preserve the
  original evidence window when the candidate is published.

Validation covers the rejected screenshot text, concrete action/figure
examples, evidence mismatches, seven-day windows, the 24-hour boundary,
stale-version rejection, retry behavior, rollover protection, and the
visible prompts/click context in light and dark mode.
