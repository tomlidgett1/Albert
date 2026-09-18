# 0142 — A present-day freshness anchor, and business context that reads as history

Date: 2026-09-18. Status: implemented and deployed the same day.

## The incident

Asked "when was the store last closed - best guess" side by side, Omni
answered Sunday 13 September 2026 (correct: no in-store sales, no roster,
trading resumes Monday) while the OAI Codex pane answered 8 June 2026. The
OAI Codex run's second narration read "The data currently covers activity
through 24 August 2026"; every date range it then wrote was capped at
2026-08-24, so the September gap was invisible. Another OAI Codex run of the
same question minutes earlier queried to 18 September and answered correctly.
The failure was stochastic anchoring on a stale date, not a harness fault.

Two causes combined:

1. The tenant's business-context profile (generated and owner-confirmed on 24
   August) carries per-connector coverage notes: "Lightspeed … [data from
   2016-01-01 through 2026-08-24]". The shared analyst instructions pasted the
   profile in with a generic "written earlier" line and no generation date. Read
   cold, the bracket is a data cutoff.
2. The prompt's real freshness mechanism was empty. Every active connection of
   the tenant has no `control_plane.readiness` row and no `stream_cursors` row
   (Fivetran-fed connectors have no Albert-side cursor), so both the routing
   freshness and the `albert_connector_freshness()` fallback return nothing.
   Every turn, including the hourly briefs, ran without a single "data
   through" line, and every provenance source said `dataThrough: unknown`.

ADR 0140 had met the same trap on the `/newagent` page and fixed it only in
the native managed instructions.

## Decision

**Derive freshness from the data on every Omni-style turn.** The v3 engine
already had `deriveConnectorFreshness`: per configured probe (a connector's
primary time dimension), the latest day holding a row, run in parallel,
cached per tenant for ten minutes and bounded to five seconds on the critical
path. The Omni runtime now runs it beside the catalogue fetch through a
bearer-scoped Cube client (no query-audit rows), merging under the
control-plane watermarks, which still win when present. The freshness lines,
query provenance and the native-mode context all read the derived list, so
the model, the trace and the answer's `dataThrough` agree.

**Render business context as history.** The service turn carries the
profile's generation date; the shared section now opens with "written on
24 August 2026 from the data available then … never as evidence of current
data freshness", and rewrites every "[data from X through Y]" note in place
as "[covered X through Y when this profile was written on …; not today's
cutoff]". The freshness rule in the analyst instructions is explicit: never
take a cutoff from the business context, never cap a date range at such a
date, and start recency questions (latest trading day, when the store was
last open or closed, this week or month to date) from the most recent period.

**Keep the profile current.** The regeneration CLI can seed from the stored
profile (owner-locked sections survive) and records the derived data-through
date on the row instead of leaving the old one in place. The Ashburton profile
was regenerated with this change.

## Consequences

Cold turns for a tenant pay up to five seconds once per ten minutes per
runtime process for the probes; warm turns pay nothing. Older runtimes ignore
the new turn field. The probes are declared in the agent config, so a new
connector needs a probe entry to gain a data-derived anchor; without one it
falls back to the control-plane watermark or "unknown", exactly as before.

## Verification

Re-run against production after the deploy (runtime d04b084, GPT-5.6 Luna,
high, fast, the settings of the failing run): OAI Codex answered "last
Sunday" (13 September) in 129s with provenance `dataThrough` 2026-09-18 for
both Lightspeed and Deputy, starting from a 14-day window and confirming the
current day; Omni answered "the Sunday between 12 Sept and 14 Sept" in 50s.
The regenerated Ashburton profile is revision 5 (data through 2026-09-18).
