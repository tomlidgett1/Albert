# 0146 — Comparisons are tables with both sides and the change

Date: 2026-09-23. Status: implemented.

## The complaint

"I am not overly impressed with the formatting of the responses, the responses
in general. I feel we don't use tables when sometimes we should." The owner
asked for the Omni harness to be pressure-tested rather than patched.

ADR 0143's `style` corpus could not see the problem: it rewards brevity, so a
comparison written as two tight sentences scores well. A new corpus,
`--corpus format` (`questions-omni-format.ts`), asks eighteen questions whose
right shape is known in advance (seven period comparisons, nine rankings,
breakdowns and trends, two prose controls), and `format-fit.mts` scores the
shape deterministically: is there a table where one is needed, does a
comparison show both periods and the change, is prose carrying four or more
figures, are IDs shown, are there em dashes. GPT-6 Sol, high effort, not fast,
Ashburton, 23 September.

The baseline scored 96.4 on the style metric and 61% on shape:

- **No comparison showed both sides and the change**, 0 of 7. "How did sales go
  last week compared with the week before?" came back as three sentences
  holding eight figures. "Sales by category this month vs last month" was a
  table of this month only, with last month and the changes in the prose.
  "How is this month tracking against last month?" had both months and no
  change column.
- Seven passages of dense prose (four or more figures in one paragraph).
- Eleven em dashes across six answers, which the owners' house style bans.
- `\*\*Gross profit\*\*` printed literally in a P&L: the model bolded a pivot's
  row label, and the composer escaped the marks.
- A pivot of weeks headed `31 Aug | 7 Sep | 14 Sep`: bare dates that read as
  days. A missing cell and a missing label both rendered `—`.
- A headline covering one window over a table covering another.

## Causes

1. **The tools could not produce a change column.** `ComposePivotTable`
   pivoted periods across the top with no change. `DeriveResult` had ratio,
   difference, percent_of and sum, but no percent change. So the model showed
   one period in a table and narrated the other, or wrote the whole comparison
   as prose.
2. **A comparison by entity was impossible to build.** `DeriveResult` refused
   to join results whose windows differ ("Join inputs cover different
   periods"), which is every "this month against last month by category".
   Nothing could order rows by a derived column either, so "biggest falls
   first" only worked when the query's own order happened to match. The model
   worked around both: once by running one query per category to feed a pivot
   (24 queries, 134s), once by giving up and putting August in bullets.
3. **The prompt's example of a lookup was a comparison.** "How were sales last
   week?" was the example of a question that gets one to three sentences and
   no table.
4. **Composer gaps.** Emphasis in labels, dashes for empty cells, bare week
   headings and em dashes were all written by the server, so no prompt rule
   could fix them.
5. **A trace bug.** Both Albert's trace and Yellow Jersey's classified every
   `derived_result` query as a pivot, so a DeriveResult join rendered as
   "Pivot · 12 metrics × 4 periods".

## Decision

**A comparison is one table holding both sides and the change, and the tools
make that the easy path.**

Tools:

- `ComposePivotTable` takes `change: true` and adds a closing `Change` column
  (`PIVOT_CHANGE_COLUMN_KEY`): the latest period against the one before it, by
  the dates the period labels name (falling back to column order). Amount and
  count rows get a percent change; rate rows get the difference in percentage
  points. It is a `calculation` cell in the sealed `derived_table_v1`
  transform, so it refreshes on a dashboard like the rest of the pivot. A
  pivot with a change always carries `rowFormats`, because the change's unit
  depends on its row. Metric labels are stored plain (no `*`, `_`, `` ` ``,
  `#`).
- `DeriveResult` compute gains `percent_change` (left is the later period), on
  the same operator the derived-table engine already had.
- `DeriveResult` join may set two periods side by side. The identity, one row
  per key and completeness checks are unchanged; only the same-window rule is
  relaxed (the timezone must still match), and each side's figures are
  labelled with their own window ("Sales (1 Aug 2026–19 Aug 2026)") so
  neither can be read as the other. A join may carry `expressions`, applied
  to the joined rows in the same call, so a comparison by entity is two
  queries and one DeriveResult call. `unmatchedAsZero` fills a left join's
  unmatched figures with 0, for totals and counts only, so "what dropped"
  keeps the products that stopped selling.
- `ComposeAnswer` tables take `sort` (a column and a direction), applied
  before the row limit, blanks last. It is presentation only: every cell
  still cites its own source row.
- `percent_change` is now `(left − right) ÷ |right| × 100` in the engine and in
  DeriveResult. Against a negative base the old formula gave the wrong
  direction: a loss of $2,000 turning into a $15,668 profit read as −883%. It
  now reads +883%. Positive bases are unchanged, and so are existing
  dashboards' digests (the digest covers the transform, not the values).
  Calculation provenance records the `operator`.

Composer (`answer.ts`):

- A pivot's change is signed in a table (`+12.4%`, `-3.1 pts`). Cited in a
  sentence it keeps its own unit whatever its row's format: "up 32.6%", never
  "$32.58" (a currency row's format applied to its change, caught in the first
  re-run). A `percent_change` column from DeriveResult is signed the same way.
- Week headings say so: `Week of 7 Sep`.
- An empty numeric cell is blank, an empty label reads `Not set`, and a value
  placeholder pointing at an empty cell is refused with guidance to say it in
  words.
- A timestamp on the store's clock reads as its calendar day (`16 Jan 2024`,
  not `2024-01-16T17:39:16.000`).
- Emphasis marks are stripped from string cells.
- Em dashes are rewritten as commas in the body and the footnote (tables are
  left alone).
- A single-unit pivot keeps one precision down each column, so a column
  never mixes `$7,137` with `$685.00`.
- A header may name a window by its days ("1–19 Sep"); it still may not
  carry a business figure.
- The truncation note says what was cut: "The table shows 8 of 26 rows."
  from a complete result, "The table shows the first 8 rows, not every row."
  from a capped one.
- DeriveResult's note on blank calculated cells is in plain words and appears
  only when a blank calculated cell is actually on show.

Prompt (`prompts.ts`, Answer Quality & Formatting): a question that asks for a
comparison is never a lookup; no sentence carries more than three figures;
comparisons are tables with both sides and the change (a pivot with
`change: true` for metrics; for named entities, one DeriveResult join on the
governed key with a `percent_change` expression, presented by name, and for
"what dropped" the earlier period on the left with `unmatchedAsZero` and the
table sorted by the change); metrics in a pivot are measures, never entities; the
headline and every table cover the same window; P&L labels are written plain;
an open-ended answer's figures go into a second table rather than the prose;
no em dashes.

Screens: Albert's `OmniTrace`, `formatTraceCell` and dashboard pivot view, and
Yellow Jersey's Analytics trace, mark a card as a pivot only when its topic is
`Composed pivot`, count periods without the change column, and format change
cells in their own unit. A dashboard's transposed pivot shows periods only.

## Evidence

`format-fit.mts --compare`, the same eighteen questions, model and effort:

| | before | first re-run | final |
|---|---:|---:|---:|
| answers in the right shape | 11 of 18 (61%) | 17 of 18 (94%) | 17 of 18 (94%) |
| comparisons with both periods and the change | 0 of 7 | 6 of 7 | 7 of 7 |
| comparisons answered with no table | 1 | 1 | 0 |
| passages of dense prose | 7 | 5 | 4 |
| em dashes | 11 | 0 | 0 |
| median prose words | 37 | 34 | 35 |
| median seconds | 68 | 57 | 60 |

The final run's one miss is the "best selling product" control: product names
("1.2x2000mm", "700 X 35/42") carry digits the scorer counts as figures, and
its prose holds three.

The re-runs found three defects in the new code before it shipped: a change
cell cited in a sentence took its row's money format ("up $32.58"); a
single-unit pivot with a change mixed `$7,137` and `$685.00` in one column;
and the entity recipe was impossible while the join refused two windows.
Entity comparisons on the final tools, twice each: "Sales by category this
month vs last month" returned the category table with both periods and the
change in 8 to 9 queries and 78 to 92s (before: 24 queries and 134s when the
model fed a pivot one category at a time, or a one-period table with August in
bullets when it gave up). "Which products dropped the most" took 9 to 17
queries and 118 to 150s (before: 15 to 17 queries and 185 to 217s).

## Consequences

- `TraceProvenance.calculations[].operator` is optional; Yellow Jersey's
  protocol types it structurally and needed no change.
- A single-unit pivot with a change now carries `rowFormats`; the composer
  still reads its precision down each column, since every row shares a unit.
- The model-facing schemas grow: DeriveResult takes `unmatchedAsZero`, and
  ComposeAnswer tables take `sort` (both required-nullable there, optional for
  programmatic callers of `composeAnswer`).
- A join across two windows is now allowed. What keeps it honest is what
  already guarded joins (a shared governed identity, one row per key, a
  complete second result for left and anti joins) plus the window labels on
  each side's figures.
- Not addressed here: pivot period headings for matched partial windows still
  read `Aug 2026 | Sep 2026` for 1–19 August against 1–19 September (the
  headline says "same days"); averages under $1,000 keep their cents (ADR
  0143's rule); models sometimes put units in row labels ("Takings (AUD)").

## Found along the way

Every answer on 23 September ended its Lightspeed sales on Saturday 19
September, Deputy timesheets on 12 September and Xero supplier payments on 1
September. The cause is outside the harness: the Fivetran account lost the
tier its connectors need (`AccountTierLimit`) on 19 September, and no
connector has synced since. Deputy's weekly timesheet batch and the
bookkeeper's reconciliation cadence explain the rest of the lag. Omni answered
honestly ("no sales records for Tuesday 22 September ... that doesn't mean you
took nothing") but cannot tell a stalled sync from a quiet day, because its
freshness line carries the latest date with rows and not the sync status.
