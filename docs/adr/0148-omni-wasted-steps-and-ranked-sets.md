# 0148 — Omni stops paying for wasted steps, and answers ranked sets whole

Date: 2026-09-23. Status: implemented.

## The complaint

"show me the top 40 items that sell through workorders, then show me current
price, current GP margin, and the price of that item 12 months ago" took 2m38s
on Claude Haiku 4.5 at max effort (turn `01M36YYEW1838X3HJJ5GWA88WK`, 183 s end
to end), showed "Query call had invalid arguments: Invalid JSON input for tool"
twice, and answered with units and SKUs only: no current price, no margin, no
price a year ago. Its top row was "Not set" (lines with no item), explained as
"a discount or adjustment", and it said most items had no workshop sales a
year ago. That was false: the gear inner wire, for one, sold on 16 workorder
lines in September 2025 at $9.99. "The real Omni I use for my other work is
much faster."

## What the trace showed

Cube was not the cost: three queries at about a second each. The turn made 18
model requests, and about half of the 183 seconds was requests that produced
nothing the owner saw:

- **Two invalid query calls (~18 s).** Replaying the question on a private
  runtime with tool data unredacted caught the input: a filter
  `{member, operator, values}` without its unused `and` / `or`. The Anthropic
  adapter samples any tool past Anthropic's strict-grammar budget without the
  grammar (GenerateSemanticQuery, ComposeAnswer, DeriveResult and
  ComposePivotTable always are), so Claude leaves out nullable fields that
  OpenAI's strict mode would have forced as null, and Zod rejects the whole
  call. Fourteen days of production: Haiku 23 invalid calls, Sonnet 5 14,
  Opus 5.5 5 in 3 turns, GPT-6 Sol 0. The SDK also redacted the Zod issues, so
  the model was told only "Invalid JSON input for tool" and guessed.
- **The analysis could not be answered from what it ran.** Query 2 ("current
  prices and margins") and query 3 ("prices 12 months ago") were the 100 highest
  priced workorder items in their own windows (bikes, groupsets), not the 40
  ranked parts, so almost nothing matched and the model concluded the SKUs had
  changed. The prompt even said never to put result values into a new query.
  Query 3 also used `normal_unit_price`, which the Lightspeed connector leaves
  at 0 on every line (June 2025 to September 2026), while the view's guidance
  called it "the pre-discount line price actually charged at the time".
- **Three refused compositions (~30 s) and a 43 s first draft,** mostly a hand
  typed table of figures it could not bind. Across Omni in the last five days,
  97 of Luna max's 185 refusals were only "Placeholder {{x}} was defined but not
  used": a value the prose never places, which cannot reach the owner anyway.
  Headers like "Price 12 months ago" (the owner's own words) and years of a
  joined table's input window were refused as unbound figures too.
- **One request after the answer was accepted** for a hand-over the answer path
  discards.

## Changes

1. **Claude tool arguments are restored to their declared shape**
   (`repairToolInput` in `packages/agent/src/anthropic-messages-provider.ts`):
   an omitted required-nullable field becomes null and an object or array
   parameter sent as a JSON string is parsed. Values are never coerced (a
   number where a string belongs still fails closed), unknown keys and every
   constraint still fail Zod, and the replay marker keeps Claude's own
   `tool_use` block. The captured call is the regression test.
2. **Invalid arguments carry their Zod issues.** The runtime service enables
   the Agents SDK's tool-data retention (`setSensitiveDataLoggingEnabled`); the
   SDK writes tool data only through its `debug` logger, which production never
   turns on. The generic guidance no longer claims the `query`-as-string cause.
3. **An accepted ComposeAnswer ends the run** (`isFinalToolResult` on the
   driver input, the SDK's `toolUseBehavior`): chat content only ever comes from
   the accepted composition, so the extra request is gone from every turn.
   Dashboard builds still get their hand-over.
4. **The composer drops a value the prose never places** instead of refusing
   it, as the managed composer already did; an unplaced table is still refused.
   An unbound figure is reported with its sentence, and the model is told not to
   swap in a number word. A header may repeat a number the owner typed or the
   result's window carries, and a derived result's input windows count as
   evidence for a year.
5. **The prompt answers a ranked set whole:** the ranking query carries every
   fact its topic holds (price, margin); a fact from another period comes from
   one query filtered to the ranked identifiers (the one sanctioned reuse of
   result values), joined back with DeriveResult `left`; rows with no entity are
   left out and never explained by guesswork; prices are compared like with
   like. Task-list updates and independent queries ride along with the next
   tool call instead of costing their own step. The filter value cap rose from
   40 to 100 so a top-N list fits.
6. **Semantic model:** `normal_unit_price` is hidden (always 0), `unit_price` is
   described as what it is (the pre-discount shelf price on the list-price tax
   basis), and `product_sales_analytics.average_shelf_price` is the price an item
   carried in a period, comparable with `items_default_price`.
   `average_selling_price` stays ex tax and after discounts, and the view's
   guidance now says never to set it beside a list price.

## Results

The owner's question, before and after. "Replay" runs are the eval harness
(`scripts/albert-eval/run-omni.mts --question …`) against a private runtime;
"production" runs are the same harness against `albert-codex-runtime` after the
deploy.

| Run | Model | Time | Model requests | Invalid calls | Refusals | Price, margin and price a year ago |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Owner's production turn, before | Haiku 4.5 max | 183 s | 18 | 2 | 3 | No |
| Replay, before | Haiku 4.5 max | 314 s | 23 | 1 | 7 | No |
| Replay, after (new Cube) | GPT-6 Sol high | 90 s | 6 | 0 | 0 | Yes |
| Replay, after (new Cube) | Haiku 4.5 max | 188 s | 8 | 1 | 2 | Yes |
| **Production, after** | **Haiku 4.5 max** | **62 s** | **7** | **0** | **3** | **Yes** |
| **Production, after** | **GPT-6 Sol high** | **76 s** | **5** | **0** | **0** | **Yes** |

GPT-6 Sol ran the intended plan every time: one ranking query carrying the
current list price and margin, one September 2025 `average_shelf_price` query
filtered to the ranked SKUs, one DeriveResult left join, one composition.
Haiku 4.5 at max answers every column now but stays the slower and weaker
analyst: one replay spent 82 s thinking on a single step, its ranking window
drifts (all time, or a one-week "12 months ago"), and its prose still types
figures the composer sends back. Its remaining invalid call was fixed in one
step because the model now saw the Zod issue (member names not written as
view.field).

Suites: `npm run test:contracts` 1706/1709 (the one failure is the known
`runtime-comparison-isolation` source-regex test, two skipped); the Omni,
Claude and managed suites 223/223; `tsc` shows only the known
`scripts/test-managed-state.mts` error.

## Deploy (2026-09-23)

1. Cube `albert-cube:shelf-price-20260923` (previous image
   `deployment-01M25TGAYTB2TVH31EVCSAW203`): live meta shows
   `average_shelf_price` and no `normal_unit_price`.
2. Runtime `albert-codex-runtime` deployment `omni-wasted-steps-20260923`,
   release `47b7abf` (readyz confirms).
3. Web `dpl_8nXVf54NsKDDv7cTJXjmzt3sqmXg`, aliased to albert-chi, `/api/health`
   release `47b7abf`, `/dash` redirects to login. The web bundles the same
   Claude adapter (the v3 path) and runs the Omni runtime in-process for
   `/newagent`, so it ships too. No contract changed, and the iMessage bridge
   calls the runtime over HTTP, so it needs no deploy.
