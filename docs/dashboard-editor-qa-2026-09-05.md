# Dashboard editor QA — 5 September 2026

## Scope and environment

Manual computer-use testing in Chrome, using a local Next.js web checkout
and the real production control plane, Cube and Omni services. The separate
**Dashboard QA — all elements** dashboard contains five real-data elements.
The existing **Ashburton Workshop Control** dashboard was not edited.

This report distinguishes actual backend verification from isolated browser
regression tests. It does not claim every physical warehouse table has data.

## Observed results

| Surface | Manual verification | Result |
| --- | --- | --- |
| Dashboard button / Omni build | Build five requested elements, expand the preview, save and reopen the document | Passed after routing and request-compatibility fixes |
| Bar chart | Horizontal and vertical orientations, change row limit through Cube, add another measure, grouped/stacked values, horizontal stacking, maximize and reopen | Passed |
| Line graph | Add gross profit through Cube, plot two measures, change the value axis and restore it, verify accessible point dates and values | Passed |
| Metric card | Read current and prior periods, check their difference, change decimal precision and better-when color, restore settings and reopen | Passed |
| Table | Move the name column first, sort the full query ascending/descending, rename a column, change decimals, keep only a value, remove the filter and reopen | Passed |
| Pivot rendering | Build the four-week, three-metric scorecard from governed results and refresh it | Passed |
| Pivot drag | Drag Values from rows to columns using the real browser, including a fast drag from the field label | Passed after drag handling fix |
| Pivot persistence | Drag Values into columns, leave and reopen the saved dashboard, then drag Period into rows and refresh governed results | Passed against production after migration 0190 |
| AI edit of one element | Request a vertical bar chart while preserving its data and period; verify five elements remain and only the selected chart changes | Passed |
| Theme | Switch the populated dashboard to dark mode, inspect charts/table/card, and restore system preference | Passed |

The initial failed pivot save restored its original arrangement and displayed
the failure. Migration 0190 now enables the pivot configuration and mixed row
formatting metadata in the production control plane.

## Cube coverage

The deployed catalogue exposes **96 public views and 3,176 visible fields**.
The tracked view definitions and deployed names match exactly: **zero missing
or additional views**. Every element's field list comes from its governed
view, with no 400-field truncation. Hidden members are excluded from the
picker and cannot be added by guessing a key.

Actual queries succeeded against Lightspeed, the official Xero P&L view,
and Deputy workforce data. The Xero and Deputy checks used explicit periods
and returned source-backed values. This verifies the connected providers,
not account connectivity for every provider represented in the model.

## Issues fixed

- Local web requests ignored the configured Fly URL and silently chose an
  unavailable localhost Omni worker.
- Empty optional prior-result context was emitted to a strict older v1
  runtime, breaking even a new dashboard build. Empty context is now omitted;
  non-empty evidence is retained.
- Bar and line value/category bindings were not editable.
- Horizontal stacking ignored the orientation control.
- Currency tick labels could contain two currency prefixes.
- Percentage labels could interpret 0.5 percentage points as 50 percent.
- Authored chart names, units and precision were not applied consistently.
- Filter-only time dimensions appeared as empty table columns and chart axes.
- Adding a date already used as a filter did not promote it into a grouping.
- Sort/filter changes waited for the save before updating the visible rows.
- Fast pivot drags depended on a deferred React state update, and field
  labels did not themselves participate in native dragging.
- Chart theme subscriptions depended on incidental parent renders.
- The Next.js development CSP prevented hydration; the documented
  development-only allowance was added. Production continues to forbid eval.
- Next-generated route types exposed an unsupported exported Discover helper;
  it is now private to its route.

## Automated verification

- The complete release check passed: 1,546 contracts passed, two optional
  live tests skipped, plus lint, typecheck, service/application builds,
  deterministic evals and rendered-HTML tests. The 114 focused dashboard
  and Omni contracts also passed earlier.
- 11 browser tests passed, including authentication setup and the dashboard,
  element editing, pivot, accessibility, dark and compact-screen scenarios.
- TypeScript, targeted ESLint, the web build and service build passed.
- The Next/Vercel production build also passed. On the constrained local
  disk it used ALBERT_BUILD_NO_CACHE=true, which only disables build caching.
- Migration 0190 was previously executed against a local PostgreSQL engine:
  syntax, 34 SQL/Zod cases and tenant-scoped metadata checks passed.

Browser regressions use isolated fixtures; they do not substitute for the
manual real-account checks above.

## Production release preparation

The protected Sydney administrator connection is working. The checksummed
administrator-upgrade runner passed, and scripts/migrate.ts applied
**0190_m6_dashboard_pivot_editor.sql** using the dedicated
albert_control_deployer login and albert_control_migration_owner role.
Administrator upgrade 0015 and Omni job-storage migration 0189 were already
present. No migration checksum or existing ledger entry was changed.

The production branch requires one independent approval of the latest push
and all four GitHub checks. The updated web and services builds are being
prepared while those release requirements remain enforced. The pivot renderer
currently operates on bounded dashboard snapshots (up to 50 source rows).
