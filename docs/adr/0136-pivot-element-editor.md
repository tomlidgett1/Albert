# 0136 — Pivot elements and the docked editor

Date: 2026-09-04. Status: accepted; migration 0190 not yet applied.

The owner requested Sigma's right-hand pivot editor and table appearance in
the dashboards created by the Omni harness. This supersedes the floating
Properties popover and the instruction to use the Albert wand for every
composed-pivot change in ADR 0134.

## References inspected

Sigma's current official documentation and its embedded product screenshots:

- [Working with pivot tables](https://help.sigmacomputing.com/docs/working-with-pivot-tables):
  Properties/Format tabs, Pivot rows, Pivot columns, Values, the movable
  Values placeholder, source-column list, swap, hierarchy and formatting.
- [Format and customize a table](https://help.sigmacomputing.com/docs/format-and-customize-a-table):
  Spreadsheet and Presentation presets, compact cells, gray headers, grid
  lines and row banding. The minimized table reference has no row-number gutter.

The product screenshots, rather than the documentation website's own styles,
are the visual reference. The owner explicitly requested this appearance;
square element edges and compact field shelves are intentional exceptions to
the general control radii, documented in AGENTS.md. Existing dash theme and
motion conventions remain in force, including system and reduced-motion modes.

## Interaction and persistence

Selecting an element opens a 320 px right rail shared by dashboard mode and
the standalone dashboard. Properties and Format use the dash measured
underline motion. Pivot fields can be dragged from the source list, reordered
inside a shelf, moved across shelves, added with +, or moved with accessible
menus. Values is a layout placeholder and can move above or below dimensions
on either axis. Field menus expose aggregation, sort, reorder and removal.
Format exposes totals, row layout, headers, empty values, number formats and
table styling. Selecting another element retargets the rail. Closing it does
not undo edits. The dashboard preview and individual elements can maximize.

The dashboard's responsive layout depends on the workspace frame, not the
space remaining after the editor opens. Thus selecting an element cannot
change the saved grid breakpoint or move it offscreen. On compact canvases
the rail overlays the canvas. It remains keyboard-operable and dismissible.

`display.pivot` stores a bounded, column-keyed presentation configuration on
the existing tile; `display.tableStyle` stores its table preset. `pivot: null`
explicitly opts a composed pivot into regular table presentation. No browser
query, SQL, executable formula or source identifier is accepted by this path.
Existing display and revision-checked mutation RPCs persist the change.
Pending optimistic mutations are replayed over incoming documents so an
earlier response cannot overwrite a later drag or format change.

An additional model field uses the existing deterministic requery endpoint,
with the display configuration in the same transaction. Requery carries pivot
field references across a date column's changed spelling. The Omni harness,
its immutable evidence and the sealed replay recipe remain unchanged.

## Values and scope

Composed pivots are recognized by their trusted transform metadata, not merely
by `replayKind: derived_v1`: a derived join is still a table. The document adds
the original trace's row formats inside `snapshot.provenance.dashboardPivot`,
an existing extensible metadata object that older application schemas accept.
The browser normalizes the wide scorecard into period records with one typed
field per metric. Both preview and saved elements use that same normalization.
Moving Values preserves currency, percentage scale and count units.

Pivoting rearranges the element's governed result. Existing measures default
to No aggregation: sums of rates, balances and distinct counts are not safe
inferences. Explicit Sum, Average, Min, Max, Count and Count distinct operate
on contributing result rows; numeric aggregation uses the existing decimal.js
dependency. Totals recompute from those rows, not displayed subtotals. Totals
never combine distinct measures. A nonaggregated cell with multiple inputs
is blank with an actionable message; it never silently picks the first value.

This remains bounded by the existing 50-row dashboard snapshot. The footer
identifies incomplete results and totals say “Total (loaded rows)” when only
part of a result is available. It does not claim warehouse-wide pivot
aggregation, Sigma's complete formula engine, writeback, conditional-format
rules, or new source selection. Those require additional governed contracts.

## Deployment and verification

0190 extends the SQL display validator and adds composed-pivot metadata to the
document. No source or analytical database changes are needed. The runner was
attempted immediately using the configured control-plane connection, but the
connection is malformed and there is no separate valid Sydney deployer URL.
It is unapplied. A credential fragment appeared in the URL parser error; that
credential must be rotated locally. Never log raw connection/parser errors.

Validation covers numerical correctness, mixed-unit transposition, hierarchy,
missing data, schema bounds, and browser drag/persistence/formatting alongside
the existing Omni dashboard and element-editing acceptance tests. Screenshot
checks cover light, system dark and compact layouts.

Final verification: production web build, service build, TypeScript and
targeted ESLint pass. All 65 related contract tests and 10 browser scenarios
pass (plus the browser authentication setup). The migration executes in a
local PostgreSQL engine; 34 SQL/Zod cases agree, and duplicate source-event
IDs in a second tenant do not leak row formats into the first tenant's
document. Production migration application remains pending.

## Amendment — real-browser verification, 5 September

The editor now exposes bar/line category and value axes and compatible
additional measure series. All field pickers use the full visible member
list of the element's governed Cube view. Adding a date already used as a
filter promotes it into a grouping while preserving the range; hidden
members cannot be added by guessing a key. Filter-only dates are no longer
minted as empty result columns.

Chart presentation keeps explicit percentage scale and authored precision,
uses a single currency prefix, and names a shared multi-measure axis by its
unit. Calendar-date charts use a UTC scale. Horizontal stacking honors the
orientation control. Theme changes notify memoized charts directly and
system-theme changes resolve to the effective appearance.

Drag operations carry synchronous refs as well as visual React state, so
fast native drag events do not race a deferred render. Field labels are
draggable. Sort and filter overrides update the visible rows optimistically,
including when a filtered column is hidden.

Local web iteration honors the configured deployed Omni URL. An empty
optional prior-result array is omitted on the wire for compatibility with
the deployed strict v1 request contract; actual prior evidence is retained.
The environment fixes include the documented development-only Next CSP and
an optional build-cache disable flag for constrained local disks.

See [the real-browser QA report](../dashboard-editor-qa-2026-09-05.md) for
coverage and release status.

## Amendment — production schema, 5 September

The protected Sydney administrator connection and dedicated deployer are now
working. The administrator-upgrade runner passed and the migration runner
applied 0190 as albert_control_deployer with the migration-owner role. Actual
Chrome dragging, saving, leaving and reopening the dashboard now passes;
currency and count metadata remain correct after transposition. The complete
release check passes with 1,546 contracts and two optional live tests skipped.
