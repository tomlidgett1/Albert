# 0150 — Short answers that carry the facts, and empty values last

Date: 2026-09-24. Status: implemented.

## The ask

The owner asked "when did we last sell a trace" and got back "You last sold a
Trace on 10 May 2026, a Trace 10 M Matte Charcoal / Black / Red for $650.00."
Their feedback: responses are sometimes not very detailed; why did it not say
who it was sold to? That was one example of a wider pattern.

## What the turn showed

The answer was thin, and it was also wrong.

- **Empty values sorted first.** The query asked for Trace sale lines by
  completion date, newest first. Postgres sorts NULL first in a descending
  order, and Cube renders every order as `ORDER BY <column> DESC`, so the top
  rows were lines on quotes and open work orders, which have no completion
  date. The turn spent three queries on it. The same happened to any
  all-time ranking: "top items by revenue" with no date range led with items
  that never sold, and Cube's default order (the first measure, descending)
  did the same for queries with no order at all.
- **"Trace" became "Trace 10".** The value lookup for "trace" listed the first
  25 matching names alphabetically, all Trace 10 variants, and flagged the
  list as truncated. The model filtered to "Trace 10" and never saw the
  Trace 20 range. The last Trace sold was a Trace 20 L on 7 August, to a
  named customer, served by a named staff member, at list price.
- **Nothing asked for the context.** The queries requested the item, date and
  revenue only. The view carries the customer, the staff member, the store,
  the price paid and the list price, but no rule asked for them.
- **The prompt capped the reply.** ADR 0143 cured verbose answers with a
  lookup budget of "one to three sentences, under 50 words" with "one
  supporting number", "ruthless in the write-up", and "a casual one-liner gets
  a short, casual reply". A casual one-liner like this one got a bare fact.
  Straight after, the owner had to ask "who to?" to learn the customer.

## Decisions

1. **Cube puts empty values last on descending sorts.** A Postgres dialect
   subclass (`cube-playground/nulls-last-dialect.js`, wired through
   `dialectFactory`) appends `NULLS LAST` to every descending sort. Cube 1.7
   renders ORDER BY in two places: the Tesseract planner (the default) through
   the dialect's `order_by` SQL template, and the legacy planner through
   `orderHashToString`. Both are covered, and the module refuses to load if
   either has moved, following the pattern of the orchestrator guard in
   cube.js. Ascending sorts already put NULL last. This fixes every Cube
   client, dashboards included, not only Omni.
2. **A cut value list says so.** When a value lookup with a match is
   truncated, the result tells the model to filter with contains on the
   owner's word for a product family, rather than equals on the listed
   values. The prompt says the same: "a Trace" is every item whose name
   contains the word.
3. **One record carries its context.** A question about one record or event
   (the last sale of an item, the biggest sale, one invoice, one job) asks for
   its context in the same query: who bought it, who served them, which
   store, the price paid against list, any discount. The product sales view's
   guidance gives the recipe (the completed_lines segment, contains on the
   family word, newest first, the context fields). Facts added for context
   keep their own scope ("5 purchases all time" beside this year's spend).
4. **Short in words, never thin in facts.** A lookup now gets two to four
   sentences under 80 words: the answer, its anchor, and the two or three
   facts the owner would ask about next. The write-up is "ruthless with
   padding, never with facts", a casual one-liner gets a casual reply "short
   in words, never thin in facts", and the send test also asks whether the
   one fact the owner will ask for next is there. ADR 0143's lesson stands:
   detail comes from investigating (one more field in the same query), never
   from caveats or licence to write more. Standard and open-ended budgets are
   unchanged.
5. **Model numbers in shortened names are names.** A detailed answer names
   products ("the IZALCO MAX 9.7 road bike", "a Trace 20"), and the composer
   refused the number unless the whole label was quoted. A number that
   follows the capitalised words of a name is now excused when a cited label
   carries those words and that number together; a number after ordinary
   words ("sold 20") is still a figure.
6. **The seller of record is the sale's.** Checking who served the biggest
   sale showed product_sales_analytics' "seller of record" returning the
   line's staff member: sale 61992 listed two sellers against one header.
   Cube joins a cube once per query, and the view reached employees through
   both the line and the sale. The header seller now has its own cube
   (`sale_employees`), joined on the `sale_employee_id` the line already
   carried; the member name is unchanged, so saved dashboards keep working.
7. **Identifiers read as names.** A numeric identifier (a key ending `_id` or a
   label ending "ID") renders without grouping: "ticket 61802", not "61,802".

## Results

A new eight-question battery (`--corpus detail`: the owner's Trace question,
the biggest sale last month, the most expensive bike, the last helmet,
Saturday's takings, the best customer, the last workshop job, e-bikes last
month), run before and after on a private runtime:

| Run | Mean | Median | Refused compositions | Words per answer |
| --- | ---: | ---: | ---: | ---: |
| Haiku 4.5 high, before | 41 s | 36 s | 9 | 20 |
| Haiku 4.5 high, after | 49 s | 46 s | 4 | 46 |
| GPT-6 Sol high, before | 30 s | 27 s | 0 | 34 |
| GPT-6 Sol high, after | 40 s | 43 s | 2 | 45 |
| GPT-6 Luna high, after | 35 s | 33 s | 4 | 39 |

After the change every model answers the Trace question with the Trace 20 sold
on 7 August, the customer, the staff member, the price against list and the
sale before it. Before it, Haiku gave "7 August, a Trace 20 L" (16 words), its
Saturday answer was the figure alone (7 words), and its helmet answer named
the wrong month. The added seconds are the context the answers now carry:
one more field or query, not more steps (Haiku made fewer requests after the
change than before).

Guards against the old verbosity held. The style battery on GPT-6 Sol high
scored 96 against 96.5 before, with 7% more prose and nothing over budget;
omni20 on Sol high passed 20 of 20 (median 37 s, p90 64 s, one refusal).

Haiku alone still put a lifetime purchase count beside this year's spend
("$7.7k across 5 purchases", 2 of them this year). The sales view's guidance
now says lifetime fields are all-time and how to count a period.
