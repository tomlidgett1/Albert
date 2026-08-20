# 0107 — Deputy fast paths, recipe empty answers, and the Cube session time zone

Date: 2026-08-19
Status: Accepted

## Context

The twenty questions a shop owner most plausibly asks of Deputy (hours last
week, wages last month, who is rostered today/tomorrow, who worked the most,
headcount, who is on leave, wage cost by month, who is on shift now,
unapproved timesheets, next week's roster and its cost, rostered hours per
person, open shifts, a named person's hours, average shift length, wages as a
share of sales, sick days this year, busiest weekday, week-on-week hours) were
run against production. Eleven answered in 5–20 s through certified recipes;
the rest took 40–265 s because they fell to the analytical lane, and three
were wrong or evasive:

- "Who is on leave this month" returned nothing: a request running 31 July –
  2 August has `leave_starts` in July, so a start-date filter misses it and
  the engine spent 100 s investigating the empty window.
- "Are there any open shifts this week" / "any sick days this year" returned
  zero rows — a true negative — and the empty-window diagnostics turned it
  into an 80–265 s "data may not be synced" hedge.
- Every raw time value in every view was **10 hours late**: Cube 1.7.16
  applies the query-time-zone conversion twice to a view's raw `time`
  dimension (`((col::timestamptz AT TIME ZONE tz)::timestamptz AT TIME ZONE
  tz)`); with the driver's default UTC session the inner naive local time is
  re-read as UTC. A 10:00–18:00 shift was answered as "8 pm to 4 am", invoice
  due dates came out as 8 pm.

## Decision

1. **Cube Postgres session time zone** — `cube.js` passes
   `storeTimezone: ALBERT_CUBE_SESSION_TIMEZONE || 'Australia/Melbourne'` to
   the driver, so the second conversion is idempotent. Granularity time
   dimensions, UTC date-range parameters and measures are unaffected;
   `CURRENT_DATE` becomes the local date (what "overdue" should mean).
   Revisit when Cube fixes view conversion or tenants span time zones.
2. **Leave at day grain** — analytical 0176 adds local start/end dates to
   `dp_leave` and a `dp_leave_days` view (one row per request per local day,
   capped at 367 days); cube `deputy_leave_days` and `leave_day_*` members in
   `workforce_analytics`. "Who is on leave in <period>" is one day-range query.
3. **Roster/timesheet helpers** — `shift_weekday` / `rostered_weekday` (+
   ISO number for ordering), `roster_shift_timing` ('On now' / 'Finished' /
   'Upcoming'), `rostered_on_now_count`, `open_shifts` / `on_now` segments.
4. **Recipes** — leave-for-period (day grain), leave-by-type, on-shift-now,
   open-shifts, roster-cost, rostered-hours-by-staff, unapproved-timesheets,
   rostered/worked hours by weekday, hours-and-wages-by-week. The orchestrator
   now routes consecutive-period comparisons ("last week vs the week before")
   to a by-week / by-month trend recipe with its default span.
5. **`empty_answer` on recipes** — a recipe may declare what zero rows means
   ("no open shifts", "nobody on leave", "nothing awaiting approval"). The
   recipe lane then composes that answer directly, and the grounding rules
   keep it `Verified` (`context.emptyResultIsAnswer`) instead of downgrading
   a true negative to "No data" or escalating into diagnostics.

## Consequences

- All twenty Deputy questions answer in 5–17 s except wages-as-a-share-of-
  sales (cross-source, ~30–100 s) — and the answers are correct, including
  shift times.
- The time-zone pin is a deployment-wide assumption (single business time
  zone). It is documented in `cube.js` and must be revisited before onboarding
  tenants in other zones.
- Recipes with `empty_answer` will no longer trigger the empty-window probe;
  use it only where an empty result is a genuine business answer.

## Addendum (ADR 0108 folded in, 2026-08-20): the full P&L statement

"Show me the P&L" was answering with the monthly-summary recipe (1–3 header
rows), not the statement. Commit 87643cf had removed the live P&L from the
statement lane when the Fivetran-landed P&L became the figures authority —
which was right for figures and wrong for presentation.

- The live `xero_profit_and_loss` tool (MCP `list-profit-and-loss`) is back in
  the statement lane and on every answer route: fromDate+toDate required,
  ≤ 12-month window, periods/timeframe for comparison columns. The statement
  lane attaches every line in Xero's own layout (verified: 29–33 rows, 7–13 s).
- Detection is split: explicit statement wording ("P&L", "profit and loss",
  "income statement") routes to the statement lane; figure-shaped wording
  (net profit, biggest expenses, income this year) stays on the governed
  landed views (ADR 0099) — verified A05/A08 still answer in ~9 s without a
  live call.
- When the live report fails, the fallback finding now demands the COMPLETE
  statement composed from the governed views (headline totals + every account
  line by section), not headline figures.
- `XeroMcpClient.callTool` timeout 45 s → 75 s: a cold MCP session (~30 s npx
  spawn) colliding with a running sync's 429 backoff exceeded 45 s and made
  the live path look broken.
