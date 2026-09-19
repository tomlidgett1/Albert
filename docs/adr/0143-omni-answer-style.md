# 0143 — Omni answers that read like a good analyst wrote them

Date: 2026-09-19. Status: implemented; not yet deployed.

## The complaint

"Responses seem quite verbose, and formatting is poor. ChatGPT responses for
analytics are 10x better. Ours are poor: sizing, formatting and general
verboseness." The owner's own production turns from 18 September bear it out:

- "yooooo what should we discount" came back as 987 words under four
  headings, with two six-column tables headed `Stock value (at retail list
  price)` and `Units sold (last 365 days)`, cents on every figure, and two
  closing paragraphs of caveats that said the same thing.
- "when was the store last closed - best guess" took 317 words and a
  seventeen-row table and never named the day: "the Sunday gap between the
  recorded Saturday activity and the following Monday activity".
- "sales this month compared to same month last year" was three paragraphs,
  two of them caveats, with "partial month" stated twice.

Replaying those questions locally at the owner's real profile (Luna, high,
fast) added defects the earlier max-effort acceptance runs never showed:
`$$9,126.74` and `26.8%%` in a quarter of answers, a narration that told the
owner "the first draft was rejected because the date numerals also need
governed bindings", and the line "Some planned checks remain unfinished."
closing an answer that lacked nothing.

## Causes

The verbosity had two independent sources, and only one of them was the model.

1. **The prompt asked for length.** "Structure generously", "There is no
   length limit", "Several hundred words is right here, never cut a deep
   analysis short", "Use the full formatting toolkit". The 30 August quality
   pass (commits ecf96b6, 97e0304) added these when answers were thin. The cure
   for thin analysis was breadth of investigation; the prompt bought it with
   breadth of prose.
2. **The harness repeated the caveats itself.** `composeAnswer` appended the
   model's `limitations`, each result's qualifications and its own completeness
   boilerplate as body paragraphs, after a body the chat prompt had separately
   told to "close with a one-line basis note" and "say which range you used".
   Every caveat arrived two or three times. Across the last max-effort run,
   43% of all prose the owner read was basis and caveat text.

The formatting defects were all deterministic, and none could be fixed by
asking the model nicely, because since the ComposeAnswer contract the server,
not the model, writes every figure and every table:

- currency always rendered to two decimals, so `$43,193.54` in every cell;
- table headers were the governed field labels, which are written for the
  model;
- a month bucket rendered as the day it starts (`1 Aug 2026`), a week as
  `6 July 2026`;
- a placeholder renders with its own symbol, and the model typed another
  beside it (`${{sales}}`, `{{change}}%`, `down {{change}}` on a negative);
- number grounding rejected every typed digit, so a closure date, which by
  definition has no row to bind to, could not be written at all. The same rule
  rejected the article "one" (twice running, on a third of turns), costing a
  full model round-trip each time: eleven of twelve baseline turns had at least
  one rejected composition.

And the screen compounded it: working notes rendered in the same size, weight
and colour as the answer, so findings mentioned while working read as the
reply and were then read again; prose ran the chat column's full 885px, about
150 characters a line; a two-column table stretched the same width, stranding
its figures from their labels.

## Decision

**The composer owns how an answer looks; the prompt owns how much it says.**
Everything that can be made impossible is made impossible in
`packages/albert-omni/src/answer.ts`, and the prompt is left with the judgement
calls.

Composer (deterministic, contract-tested in
`tests/contracts/omni-answer-style.contract.test.ts`):

- **Precision follows magnitude.** Whole dollars from $1,000, cents below;
  one decimal on a percentage; a money column takes one precision from its
  largest figure so a table never mixes `$7,199` with `$824.99`; count and rate
  columns share one precision down the column. `compact` writes `$3.7k` and
  `$1.2M`, and never half-abbreviates an amount under a thousand.
- **A period is named as a period.** `Aug 2026`, `6 Jul`, `Sat 12 Sep`,
  `Q3 2026`, from the query's own grain, inferred from the bucket shape for
  derived and earlier results. An ordinary date column (last sold) keeps its
  full date. Pivot headings, which arrive pre-formatted, are renamed the same
  way.
- **Short headers.** `tables[].headers` lets the model name columns
  ("Product", "Revenue"). A header may not carry a figure its field does not,
  and cannot rename a period heading, so a header can shorten a label but never
  relabel the data.
- **One footnote, said once.** Limitations, qualifications and harness notes
  become a single closing `Note: ...` paragraph. A note the body already makes,
  or another note makes, is dropped from display. The answer **state is decided
  from the facts, never from what survives the de-duplication**: limited or
  reused evidence is still Qualified. The truncation note is kept only when a
  table is actually cut short and the question did not ask for the head of a
  ranking.
- **Symbols and signs are not doubled.** `$`, `%` and `-` typed beside a
  placeholder are absorbed; a minus is dropped after a change-word ("down",
  "fell by", "a drop of") but kept after a level-word ("fell from", "below"),
  because a level can really be negative.
- **Bold is the headline.** Figure-bearing bold survives once; bullet
  lead-ins, verdict words and statement total rows are left alone. Statement
  totals (Gross profit, Net profit, Total ...) are emphasised by the composer,
  since the model no longer writes those rows.
- **Scope is not a figure.** A calendar date or day range inside a span the
  cited evidence covers, or today, may be typed; the weekday is checked
  against the date. So may a window length taken from a governed field the
  result used ("no sale in 90 days" from `unsold_90_days`) and the article
  "one". A date outside the evidence, any other count in words and any amount
  still fail. This extends the precedent `protectReportingDates` set for window
  boundaries on the managed path.

Prompt (`renderOmniInstructions`, "Answer Quality & Formatting"): word budgets
by question type (50 / 110 / 230 words of prose), one table by default at five
columns and eight rows, a list of what never appears in the body (basis and
method commentary, prose that re-reads the table, signposting, the same fact
twice), register matching, and the rule that thoroughness lives in the
investigation. The investigation rules (three angles for an open-ended
question, comparison anchors, named entities, pivots, statements, partial
periods) are unchanged. Narration is one short sentence, never a finding, and
never mentions how the answer is assembled.

Runtime: a task that only says to write the answer is settled when the answer
is accepted, and an open evidence task keeps the Qualified state without
appending a sentence.

Screen (`OmniTrace`): once the answer lands the working trail folds behind the
"Worked for 1m 1s · 3 queries" header, one click from coming back. Charts and
composed pivots are deliverables and stay; a dashboard build keeps its trail.
Working notes are set smaller, lighter and unbolded. Reading text holds a 74ch
measure while tables size to their columns, and label cells wrap instead of
truncating.

## Evidence

A new corpus, `--corpus style` (`questions-omni-style.ts`), holds twelve turns:
five typed exactly as the owner typed them, the rest covering each presentation
shape. `style-metrics.mts` scores a run deterministically, so runs compare
exactly; `omni-answer.screenshot.spec.ts` replays a run's real events through
the app for the visual half. Luna / high / fast, Ashburton, 19 September:

| | before | after |
|---|---:|---:|
| style score (of 100) | 66.7 | 94.4 |
| prose words per answer | 160 | 59 |
| share of prose that is caveat | 33% | 14% |
| cents-precision figures per answer | 9.3 | 0 |
| field-label headers, dated buckets, filler | 2.2 | 0 |
| answers with `$$`, `%%` or `down -` | 3 of 12 | 0 of 12 |
| answers leading with the answer | 10 of 12 | 12 of 12 |

The answers did not get thinner. "What should we discount" fell from 435 words
of prose to 126 while running ten queries instead of seven, and surfaced a
finding the long version missed (a clearance candidate whose last sale ran at
-58.8% margin). The closure question now opens "**Sunday 13 September 2026** is
the best guess".

## Consequences

- iMessage, scheduled reports, the daily look and the managed (OAI Codex)
  path all compose through the same function and inherit the formatting. The
  managed prompt already carried its own brevity rules and is untouched.
- `ComposeAnswerInput.tables[].headers` is optional for programmatic callers
  and required-nullable in the model-facing strict schema.
- Table dates use three-letter months (`Sep`); ICU's `en-AU` and `en-GB` both
  emit `Sept`, which breaks a column's alignment.
- The trail folding is a default, not a removal: `trailOpen` is one boolean if
  the owner would rather keep the work on show.
- Not addressed here: answers at other efforts and on Sonnet/Haiku were not
  re-measured; the `style` corpus runs against any model.
