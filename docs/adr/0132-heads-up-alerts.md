# 0132 — Alerts: heads-up texts the moment the data lands

Date: 2026-09-02. Status: accepted.

## The ask

An agent with triggers that let the owner know about something when the
data comes in: "heads up, it's the first time that…". Ten triggers chosen
from Ashburton Cycles' own Lightspeed, Xero and Deputy data, a UI to switch
each one and choose which enrolled mobile numbers receive it, and delivery
over iMessage. The UI had to be sleek and minimal.

## Decisions

### Deterministic checks over the governed views, not a model

A trigger is code: a handful of governed Cube queries and a predicate over
the rows (`services/alerts/src/triggers.ts`). Nothing about "did this fire"
depends on a model, so the same data always produces the same text, the
thresholds are reviewable, and a check costs about thirty small queries.
Every query stays inside one governed view and is validated against Cube's
catalogue before it is sent; there is no SQL surface anywhere in the path.

The ten triggers came from the data, not a template: the record day and
the staffed day that took $10; a bike sale and the six-week and
twelve-month service chain (only a third of bike buyers ever come back to
the workshop); $5k-plus customers returning, going quiet or crossing a
lifetime threshold; jobs sitting Finished for months with nothing charged
and jobs past their promised date; a heavy workshop day against a thin
roster and a record intake week; stocked consumables hitting zero; bikes
passing another year on the floor; labour over 30% of takings, pending
leave, leave in the peak and unrostered trading days; first bills from new
suppliers, look-alike supplier names, outsized bills and Monday's overdue
and due-this-week digests; and the till uncounted, a count out by $50, a
big refund, sales below cost, a stocktake write-off and a heavy discount
week.

### Where a check executes

Cube refuses any query without a live owner turn lease or a dashboard
refresh lease, and the capability behind that lease is minted by the
control plane; a direct database path would need the same machinery and a
new credential. So a check is a short owner turn: the imessage-bridge
(`services/imessage-bridge/src/alerts.ts`) opens a turn in the standing
`Alerts · checks` conversation, signs the same Cube bearer the runtime
would, runs the triggers, renews the lease every two minutes, and closes
the turn with `albert_alerts_evaluated`. Every governed query lands in the
analytical query ledger like any other turn. The bridge is the one process
holding the owner session, the Cube secret and the Linq token, which is why
the scheduler already lives there. The dash hides conversations titled
`Alerts ·` from history: they are bookkeeping, not analyses.

### When a check runs

The bridge polls every minute (`ALBERT_ALERTS_POLL_SECONDS`). A manual
"Check now" runs at once. A scheduled evaluation runs when the tenant's
cadence has elapsed (60 minutes by default) and the connectors' data
watermarks have moved since the last one, or six hours have passed on
unchanged data so day-based checks still land. Scheduled evaluations sleep
through quiet hours (`ALBERT_ALERTS_QUIET_HOURS`, 21:00–07:00 local), and
the roll-up digests are only drafted from 07:00, so the "yesterday"
readings arrive with the morning. A day is only judged once the connector's
`data_ready_through` has passed the end of it; until then the card reads
"Waiting for Lightspeed to finish syncing…".

### Firing once

Every event carries a dedupe key naming the condition it describes: a day,
a workorder id, an item and the date it hit zero, a customer and the date
they came back, a bike and the anniversary it passed. `alert_events` is
unique on (tenant, trigger, dedupe key), so a condition that is still true
at the next check fires once. Backlogs (twenty finished jobs, a dozen
duplicate supplier names) roll into one monthly digest keyed by month; new
instances fire individually as they cross the line. On first activation the
digests describe the current state once and then stay quiet.

### Who receives it (migration 0185)

Enrolment (migration 0180) remains the boundary that decides which numbers
may receive the business's data: a trigger's recipients must be enabled
enrolments, checked at save time and again at send time. A trigger without
a stored row is on and goes to the owner's enrolled number; the owner can
switch any trigger off or send it to several numbers from the Alerts tab.
A trigger with no recipients still evaluates and records its events as
`muted` so the tab shows them; nothing is texted.

`control_plane.alert_triggers` (switch, recipients, config),
`alert_trigger_state` (the latest reading per trigger),
`alert_events` (every fired event, deduplicated, with delivery status),
`alert_evaluations` (queued → running → finished / failed, with the lease
it ran under and a summary) and `alert_settings` (cadence, last evaluation,
last freshness digest). Lifecycles are described lookups. Reads for any
active member; switching, choosing recipients and requesting a check are
owner/manager actions. Rate buckets `alerts.mutation` 60/min and
`alerts.check` 12/h.

### Delivery

Fired events for one number are packed four to a bubble, at most three
bubbles per check, each event a bold "Heads up: …" headline over one plain
sentence or two; the overflow is counted ("…and 3 more in the Alerts tab").
An event is `sent` when every recipient received it and `failed` with the
Linq error otherwise.

### The surface

The Chat / Discover / Scheduled slider gains Alerts. The tab is the heading
"Alerts", one status line (last check, and how far each tool's data
reaches) with a quiet Check now pill, then ten cards in a two-column grid
holding only a title, a few words, the recipient chips (one per enrolled
number, pressed = receives) and when it last fired. Readings and numbers
stay off the cards; a Recent list underneath shows exactly what was texted
and whether it arrived. Nothing regenerates on its own; the tab polls only
while a check is open.

## Consequences

- The bridge must deploy with migration 0185 applied and `CUBE_API_URL`
  set; until then its loop logs `alerts_tick_failed` on every poll and the
  webhook and scheduler paths are unaffected.
- The bridge remains single-tenant (one owner email); triggers are stored
  per tenant and the loop serves the tenant its owner session resolves.
- Cube's catalogue does not expose boolean members, so "unpublished roster
  shifts" is approximated by "no shifts rostered on a trading day"; adding
  a segment to the Deputy model would make it exact.
- Customer identity across views is the customer's full name (customer ids
  are not public in the views); Lightspeed's placeholder customers are
  treated as anonymous.
- Browser acceptance stubs `/api/alerts`; the loop is contract-tested with
  a fake store, sender and triggers, and the triggers with fixture rows.
