# 0131 — Scheduled: reports Albert texts on a timer

Date: 2026-09-01. Status: accepted.

## The ask

A third surface beside Chat and Discover, called Scheduled. The owner
describes a recurring report in plain language ("send me a message every
morning at 9am with an overview of the sales performance from yesterday"),
Albert turns it into a schedule and runs it at that time, over iMessage
only for now. The owner can change the time and the time zone, pick which
enrolled phone number it goes to, run it by hand to test it, and see every
schedule the organisation has. The Omni harness is the only analyst.

## Decisions

### Where a run executes

A run is an Omni turn as the owner plus a Linq send. Only one process may
do both: the iMessage bridge (`services/imessage-bridge`), which holds the
headless owner session, the Cube signing secret and the Linq token, and
which the service-boundary check keeps out of the codex-runtime bundle.
The web tier cannot run a turn without a browser session and may not hold
service keys, and a cron-triggered Vercel function has neither. So the
bridge grows a scheduler loop (`scheduler.ts`): every poll (20s by default,
`ALBERT_SCHEDULED_POLL_SECONDS`; `ALBERT_SCHEDULED_ENABLED=false` turns it
off) it asks the control plane for due schedules and queued manual runs,
claims each one, runs the analysis and texts the answer to the schedule's
number. `/readyz` reports the loop's last tick.

The turn logic the bridge already used for inbound texts moved unchanged
into `analysis.ts` (`runOwnerAnalysis`); the webhook path and the scheduler
share it, so a scheduled report is persisted, paired and finalized exactly
like a texted question. Each run is a fresh conversation titled
`Scheduled · <title>`, so the tab's "View analysis" opens the full trace and
the standing question never drifts on prior turns.

### The schedule model (migration 0183)

`control_plane.scheduled_tasks` holds a title, the owner's original request,
the standing question Albert answers, a local time of day, the weekdays it
runs, an IANA zone, the destination E.164 number, the on/off switch and
`next_run_at`. `scheduled_task_runs` records every run (trigger schedule or
manual; status queued → running → sent / failed / missed) with the slot it
represents, the conversation and turn it produced, a summary and any error.

Recurrence is weekly-by-weekday at one local time. That covers every
phrasing the owner used ("every morning", "weekdays", "Monday") and stays
honest across daylight saving; monthly and one-off cadences are not offered
yet, and the parser says so when asked for one.

`next_run_at` is computed by one shared function (`services/scheduled/src/
next-run.ts`) from both callers: the web tier on create and edit, the
bridge after each claim. It walks the local calendar of the schedule's zone
and converts the wall time back to an instant by probing the zone's offset
on both sides of the guess, so a 9:00 report stays at 9:00 through the
October and April changes. Postgres never computes it, so there is one
implementation to test.

### Claiming is atomic and optimistic

`albert_scheduled_run_claim` takes the slot the bridge read
(`p_expected_next_run_at`) and the following slot (`p_next_run_at`). It
succeeds only if the task is still enabled, still due, still on that slot
and has no open run; it then advances `next_run_at` in the same statement
and inserts the running row. A long run is therefore claimed once, an edit
during a poll makes the claim miss (the next tick reads the new slot), and
two bridge machines could not double-send. A slot more than three hours
overdue (the bridge was down) is recorded as `missed` rather than sent
late: "yesterday" would no longer mean yesterday. Runs abandoned by a
stopped bridge are swept to `failed` on every read path.

### Plain language → schedule

`POST /api/scheduled { action: "create", text }` reads the description in
two layers. A deterministic reading (`services/scheduled/src/parse.ts`)
extracts the time ("9am", "17:00", "9 in the morning", "at 5", parts of the
day), the days ("every morning", "weekdays", "Monday to Friday", named
days), a named zone, and the standing question with the delivery and
cadence clauses stripped. Luna (fast tier, low effort, strict schema) then
refines the same request into a better title and a self-contained
relative-period question, and may correct the cadence; its output passes
the same acceptance rules (valid time, at least one day, an Intl-valid zone
or the default, trimmed copy). The heuristic is the floor — the surface
never depends on the model — and every assumption is stated back to the
owner on the card ("9:00 am was assumed; adjust below if needed").

The default zone is the browser's (sent with the request) or the
organisation's; the default number is the owner's enrolment. Both are
editable per schedule.

### Access

Enrolment (migration 0180) stays the boundary that decides which numbers
may receive the business's data: a schedule may only target an enabled
enrolment, checked at save time and again by the bridge at send time.
Reads are for any active member; create, edit, delete and manual runs are
owner/manager actions because a run executes with the owner's full
analytical surface. Rate buckets: `scheduled.create` 20/h (one Luna parse
each), `scheduled.mutation` 60/min, `scheduled.run` 12/h (a full Omni turn
and a text each).

### The surface

The Chat / Discover slider gains a third option, Scheduled. The tab is one
composer card (describe → Create schedule) above the list of schedule
cards: title, cadence line, the editable standing question, Time / Days /
Time zone / Send to controls, an on/off switch, two-step removal, "Run
now", the next run and the last run's outcome with a link to its analysis,
and a collapsible history. While a run is queued or running the tab polls
every four seconds; nothing on a card is a governed number.

## Consequences

- The bridge must deploy with migration 0183 applied; until then its loop
  logs `scheduled_tick_failed` on every poll and answers texts as before.
- The bridge remains single-tenant (one owner email); schedules are stored
  per tenant and the loop serves the tenant its owner session resolves.
- Browser acceptance stubs `/api/scheduled` with an in-memory list so the
  create → edit → run → sent loop is exercised without a bridge; the
  scheduler itself is contract-tested with fake store, sender and analyst.
