# Extended Sigma dashboard QA — 5–6 September 2026

## Environment and scope

Computer-use testing in Chrome covered the **Production verification dashboard**
on `albert-chi.vercel.app` and the corrected checkout at `localhost:3002`.
Both used the real saved dashboard and production data services. Its five
elements were a KPI, weekly line chart, category bar chart, product table,
and composed weekly pivot. The checkout started at `b70f720`.

The open production tab initially held the older editor bundle. A reload
loaded the docked editor before the main tests. Fixes below are local changes;
this pass did not deploy a release. Test formatting, filters, query additions,
column order, and resizing were restored to their original appearance. Both
tested origins use System theme again, and temporary viewport overrides were reset.

## Sigma comparison

References were Sigma's official documentation for
[table styling](https://help.sigmacomputing.com/docs/format-and-customize-a-table),
[pivot totals](https://help.sigmacomputing.com/docs/format-pivot-table-totals),
[axis positions](https://help.sigmacomputing.com/docs/format-chart-axis-position),
and [chart legends](https://help.sigmacomputing.com/docs/format-chart-legend).
Sigma treats presets as starting points for independently editable appearance
settings and applies the same table-style concepts to tables and pivots.
The ordinary table editor now shares Albert's existing pivot style controls.
This was a documentation comparison, not a test inside a signed-in Sigma workbook.

## Computer-use results

| Area | Checks | Result |
| --- | --- | --- |
| Table and pivot styles | 2 element types × 2 presets × 3 cell spacings × banding on/off × vertical grid on/off × light/dark | **96 combinations passed after fixes**; displayed values unchanged |
| Selected pivot cells | Select a cell in a banded row in light and dark | **2 checks passed after fix**; selection fill remains visible |
| Themes | Light, Beige, Sage, Dark, Green, System | Table/pivot surfaces and chart marks/labels checked; System resolved to light on this machine |
| Responsive editor | 1440, 1024, 768, 390, and 320 px widths at 900 px height | Rail stays inside viewport; close control remains available; mobile dismissal restores all five elements |
| Pivot arithmetic | No aggregation, Sum, Average, Min, Max, Count, Count distinct | Expected values verified; sales total `$40,320.23`, mean `$10,080.06`, count `4`; ambiguous unaggregated totals remain explicitly unavailable |
| Pivot formatting | Automatic and 0–6 decimals; four row/column-header visibility combinations | Values and units preserved; all 12 measure cells remain when headers are hidden |
| Pivot layout | Swap axes; move Values with menus and native dragging; expand/collapse a period hierarchy | Currency and count units survive transposition; native drag and hierarchy checks passed |
| Table operations | Automatic and 0–6 decimals; number/text formats; rename; reorder; hide/show; ascending/descending/clear sort; Keep only/remove filter | Passed; original labels, order, five rows and formats restored |
| Bar charts | Add/remove gross profit through the real query endpoint; grouped/stacked bars in both orientations; maximize/minimize | Both series and all 20 marks verified while enabled; stacking geometry checked; original query restored |
| Line charts | Convert the two-series chart to a line; inspect the weekly line across themes | Two lines and 20 points verified for the converted chart; original bar type restored |
| KPI | Four comparison modes and Higher/Lower preference | Difference `$1,326.55`, prior `$44,520.09`, `97.0% of prior`, and `3.0%` agree; direction tone switches and restores |
| Keyboard and menus | Arrow-key tabs, cell navigation, mouse/keyboard column menus, Escape | Passed locally; Escape closes the menu while retaining the editor |
| Resizing and saves | Three rapid left/right/down/up keyboard cycles; native mouse resize afterward; leave and reopen | Passed after race fixes; tablet pivot returned to width 8, height 7, with identical geometry and values after reopening |

The completed style matrix comprises **98 checks** including selected-cell
contrast. Other functional checks above are separate. Native screenshots
were inspected during computer use. Some repeated responsive DOM measurements
timed out in the browser automation interface; native screenshots confirmed
the mobile layout. No new application console errors appeared after the
final resize fixes and fresh-page checks.

## Fixes made

- Presentation preset CSS overrode the vertical-grid switch. Explicit grid
  settings now work with either preset.
- Banded-row CSS overrode selected-cell fill. Selected cells keep the theme's
  selection color.
- Ordinary tables rendered table-style metadata but offered no way to edit
  it. `TableStyleEditor` supplies the same controls for tables and pivots.
- Flint's contrast calculations accept hex colors, while computed browser
  tokens arrive as RGB/RGBA. Conversion preserves color channels and alpha;
  chart labels use the host's text colors instead of inherited preset colors.
- Bar labels ignored authored precision and units. They use the same formatter
  as line labels. Narrow vertical charts keep a readable subset of labels;
  outside placement preserves contrast above short dark-mode bars. Every bar
  and exact tooltip remains available.
- Rapid keyboard resizing raced both network saves and older grid callbacks.
  Layout writes now share the ordered mutation queue, pending layouts remain
  visible across earlier responses, and keyboard input remains authoritative
  until a pointer gesture takes over. Older refresh revisions cannot replace
  a newer document. Failed layout saves retain their error message.

## Automated verification

- **1,576 contract tests passed; 2 optional tests skipped.** Initial sandbox
  failures came from blocked localhost test servers; the authorized rerun passed.
- **30 new chart regression tests** cover RGB/RGBA conversion, rendered currency
  and percentage labels, ratio versus percentage-point scale, precision, zero
  and negative values, both orientations, grouped/stacked series, narrow/wide
  rendering, label density, and preservation of governed input data.
- **2 rendered-HTML tests passed.**
- TypeScript passed. Full ESLint completed with **0 errors and 22 existing
  warnings outside the changed files**; targeted lint was clean.
- Both the Vinext application build and the **Vercel `next build --webpack`
  production build passed**. The latter used the existing cache-disable option
  and required network access for the app's Google Fonts download.
- No Playwright fixture suite or automated Axe audit was run in this pass;
  browser interaction checks used computer control against the real app.

## Remaining Sigma differences

Albert still lacks Sigma's arbitrary header/cell/subheader color and font
controls, conditional formatting and data bars, Extra small spacing, full
four-way grid controls, individual column resizing/freezing, separate total
styling/position controls, and user-editable legend placement/typography.
These need product work rather than being counted as passing tests.

Pivot calculations still operate on the bounded loaded snapshot, up to 50
source rows. These tests do not establish warehouse-wide pivot aggregation,
cross-browser coverage, OS-level System-theme switching, or complete Sigma parity.
