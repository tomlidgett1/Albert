# ADR 0083: Personal live dashboard

- Status: accepted
- Date: 2026-08-11
- Amends: Albert v1 section 5 and ADR 0077

## Context

Albert is conversation-first, but customers need a small number of governed
results to remain visible between analyses. A conventional BI dashboard would
introduce a second query-authoring surface, mutable definitions, and a route
around Albert's evidence and tenant boundaries. Simply saving rendered cells
would also create a stale scrapbook rather than a live operational view.

## Decision

Albert provides one private live dashboard per tenant member. It is a
conversation-derived pinboard, not a BI surface. A tile can originate only from
a table event carrying an explicit trusted replay reference:

- `cube_v3` pins the immutable query event, query digest, and semantic-version
  digest.
- `semantic_v2` pins the execution result and exact publication hash.
- `derived_v1` pins a bounded deterministic table transform plus the immutable
  direct table events it consumes. This supports owner-facing pivots and
  cross-query tables: refresh replays each governed source and applies the
  exact sealed cell transform without running a model.

The browser submits only conversation, turn, table-event and result identifiers.
Trusted control-plane code resolves the replay recipe from immutable events and
never accepts SQL or a browser-authored recipe. Every new owner-visible table
must therefore be emitted as a first-class replayable table event. The runtime
uses the structured composition tool for pivots and tabular comparisons; it
does not render a new Markdown-only table. SQL-first, Anthropic, Cubecore, and
historical tables created before this invariant cannot be retrofitted by
guessing lineage and remain readable but ineligible.

Dashboard data is tenant- and owner-scoped. Direct table grants are denied;
security-definer functions verify both the current tenant and authenticated
owner. Every mutation uses an expected dashboard revision. Refresh evidence is
append-only, records no cell contents, and a failed refresh retains the last
successful bounded snapshot.

Each claimed Cube refresh receives a new short-lived, unguessable analytical
lease bound to the tenant, dashboard tile and claim. The Cube driver exchanges
that lease for the existing `semantic_read` capability; it never revives or
impersonates the historical source conversation turn. Completion must present
the same lease and claim timestamp, so a stale worker cannot overwrite a newer
refresh. Semantic V2 replay remains protected by its signed internal service
request and exact publication hash.

The dashboard renders its saved snapshot immediately and refreshes on open,
when a stale visible tab regains focus, every five minutes while visible, and on
request. Relative Cube periods remain relative and fixed periods remain fixed.
Pinned semantic versions/publications must match before execution. A dashboard
contains at most 24 table tiles; each snapshot contains at most 50 displayed
rows plus total count, digest, provenance, source watermarks and timing.

An owner may attach bounded presentation metadata to columns in their own tile:
a display label, one allowlisted value format, and zero to six decimal places.
These preferences are keyed only to columns in the current governed snapshot,
are revision-controlled with the tile, and survive refreshes. They never rewrite
snapshot values, source labels, replay recipes, semantic definitions, result
digests, or refresh evidence.

## Consequences

- Chat remains the only place to ask and refine analytical questions.
- Tiles cannot contain charts, text, filters, SQL, or dashboard-authored
  analysis in this version.
- Existing traces remain readable because the replay reference is optional.
- All newly produced owner-visible V3 tables, including final pivots assembled
  from several query results, expose the same compact Dashboard action.
- A semantic change is visible as an incompatible/stale tile instead of
  silently changing a saved result's meaning.
- Column renaming and formatting remain explicitly presentational; opening the
  source analysis still exposes the governed labels and immutable values.
- Dashboard deployment is migration and API first; the UI is enabled only when
  that boundary is available.
