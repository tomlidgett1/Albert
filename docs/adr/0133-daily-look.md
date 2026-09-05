# 0133 — The daily look: what to look at next, once a day

Date: 2026-09-02. Status: accepted. Amends ADR 0117.

## The ask

"What to look at next" on the New Analysis page loaded and then vanished,
and its rows pushed the composer off the vertical centre while they loaded.
The owner asked for one sentence per item with the logo of the tool at the
left, the panel below a composer that stays centred, and for the items to
update once every 24 hours from a Luna Max turn on the Omni harness that
judges whether anything interesting happened in the last 24 hours.

## Decisions

### A daily Omni turn, not a per-visit refinement

ADR 0117 refined a chat-history playbook with a text-only Luna pass on
every homepage visit. The rows now come from one governed analysis a day:
the imessage-bridge (`services/imessage-bridge/src/daily-brief.ts`) runs
`gpt-5.6-luna` at `max` effort on the Omni harness as the owner, in the
standing conversation `Daily look · last 24 hours`, with the message in
`services/recommended-analysis/src/daily-brief.ts`. The message names the
24-hour window in the tenant's zone, the connected tools, what
"interesting" means (a clear move against the same weekday's usual
pattern, a first, a record, an outlier, something that stopped), and fixes
the answer's shape: a `Verdict:` line and up to three `- [Tool] sentence —
why` lines, fewer if fewer things are interesting, none if nothing is.
Every figure must come from a query run in that turn, so the rows are
governed numbers, not copy.

The bridge reads the answer back without a second model call
(`parseDailyBriefAnswer`): the bracketed tool label resolves against the
connected tools, the sentence runs to its question mark, the remainder is
the why. Template echoes are dropped; an answer that ignored the shape
falls back to the harness's own follow-ups; a clarification or an empty
answer is a failure, retried after thirty minutes. "Nothing stood out" is
a verdict with no rows.

### Where and when it runs

It lives in the bridge for the reason ADRs 0131 and 0132 give: only that
process holds the owner session and the Cube secret. The loop polls every
five minutes (`ALBERT_DAILY_BRIEF_POLL_SECONDS`) and runs the look once per
local day from 6am (`ALBERT_DAILY_BRIEF_HOUR`), after the overnight syncs;
a bridge that was down at six catches up when it is back, and a look stored
today is never repeated today. The model is `ALBERT_DAILY_BRIEF_MODEL`
(default `gpt-5.6-luna`); the switch is `ALBERT_DAILY_BRIEF_ENABLED`.
`/readyz` reports the loop beside the scheduler and alerts.

### Storage

The look is stored on the ADR 0117 row (`control_plane.recommended_analysis`,
one per tenant and user) through the same save RPC, with `model` set to
`omni:<model>` and a fingerprint of the run rather than of the chat corpus.
The homepage route returns that row whenever it exists, regardless of the
corpus fingerprint, and no longer generates anything on request; until the
first look lands it returns the chat-history playbook as before. Rows carry
`tool`, the connected tool they read (`services/recommended-analysis/src/tools.ts`
maps a label or a domain to one), which is the logo on the row.

### Surface

The rows sit below the composer stack, positioned out of the flow, so the
composer is vertically centred whether or not a brief has arrived, and
nothing renders until there are rows: no skeleton to appear and vanish.
There is no heading, verdict line, card or border: each row is one sentence
with the bare 14px logo of its tool at the left and an ink-only chevron; the
why is the row's tooltip. The verdict is still stored, for the record. The daily conversation is hidden from history
like `Alerts ·`.

## Consequences

- Deploy the web app before the bridge. The previous route treated an
  unknown row as a stale cache and refined it on the next visit, which would
  overwrite a daily look with a chat-history brief.
- The bridge acts for one owner (`ALBERT_IMESSAGE_OWNER_EMAIL`), so only that
  tenant receives daily looks; every other tenant keeps the playbook rows.
  Extending the loop to every tenant needs a per-tenant owner session.
- The row is per user: another user in the same tenant sees the playbook
  until the read RPC falls back to the tenant's latest look.
- A day with nothing interesting hides the panel rather than filling it.
