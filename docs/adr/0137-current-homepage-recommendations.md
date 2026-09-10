# ADR 0137 — Clear recommendations from a rolling 24-hour window

Date: 2026-09-10. Status: accepted. Amends ADRs 0117 and 0133.

Display and cadence superseded by ADR 0138 following owner feedback.

## Problem

The owner found the homepage rows dense, irrelevant and apparently frozen.
Production confirmed the last stored look was September 5 in Melbourne:
the September 3 bridge rejected additive terminal metadata from the newer
Omni runtime. The API served that cached look without an age check, and an
open homepage fetched only once. The old prompt also required a numerical
finding and follow-up question together in every displayed sentence.

## Decision

- Keep the existing governed Luna Max analysis, owner-scoped storage and
  composer layout. Refresh the rolling 24-hour window hourly. The five-minute
  worker poll catches up after downtime, including overnight; failed runs
  retry after thirty minutes. `ALBERT_DAILY_BRIEF_REFRESH_SECONDS` replaces
  the local 6am gate, with a supported range of thirty to sixty minutes.
- Migration 0191 records the exact UTC `window_start` and `window_end` on
  the existing per-user row. Current looks use `omni:daily-v2:<model>`.
  Older format rows cannot delay regeneration or populate this surface.
  Tenant and actor derivation and the authenticated RPC grants are unchanged.
- Display a short plain-language `title`; retain the separate `question`
  and numerical `why` evidence. Clicking sends the question, evidence and
  exact observation window into a new analysis. No statistical shorthand,
  chains of figures or unsupported stock-risk claims belong in the title.
- Require current-window observations and comparable baselines. Never slide
  the window backwards to old source data or mistake no rows for no activity.
  Reuse the standing audit conversation without its historical model context.
  A quiet day stays empty; generic harness follow-ups and old chats cannot
  refill it. Invalid, unavailable or clarification results are retried.
- Serve only current-format looks whose evidence window ended less than two
  hours ago. Filter out disconnected sources. The page fetches every minute
  while visible and on focus, and expires displayed rows even if a fetch fails.
  A small theme-aware line shows “Last 24 hours” and the actual update age.
- Terminal result envelopes strip unknown additive metadata while still
  validating all known fields. Request and tool schemas remain strict. This
  prevents an independently deployed caller from discarding a completed
  analysis merely because the runtime added result metadata.

## Release and validation

Apply the migration with the checksummed runner, deploy the web and bridge
with the matching runtime, and verify a real refreshed look. Cover hourly
cadence, old/future/expired windows, disconnected sources, quiet days,
invalid output, retry recovery and additive terminal fields with behavioral
tests. Browser acceptance covers short titles, the full click prompt,
automatic refresh/expiry, composer position and light/dark rendering.
