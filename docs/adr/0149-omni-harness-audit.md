# 0149 — Omni harness audit: failures, wasted context and wrong figures

Date: 2026-09-23. Status: implemented.

## The ask

After ADR 0148, the owner asked for any other fundamental errors in the Omni
harness to be found and fixed, optimising for speed and quality. This ADR
records what production telemetry, three code audits and eval batteries
found, and what changed.

## What production showed (14 days)

- **One Omni turn in eight failed.** 79 of ~620 turns ended as
  `omni_runtime_failure`, after a median of 183 s. Most were not the
  harness's fault in the moment (OpenAI and Anthropic credit exhaustion on
  23 September, the hourly brief), but the runtime reported nearly all of
  them as "The analysis could not be completed safely", so none could be
  diagnosed after Fly's log buffer rolled over.
- **Long turns threw away their work.** Several Luna max and Sonnet max turns
  ran 10 to 23 governed queries and died at exactly 720 s, the turn deadline,
  with nothing delivered.
- **Claude was unusable for a week and nobody could tell why.** From 16
  September until 06:56 UTC on 23 September every Claude turn failed within
  1 to 5 s (zero answered, web and iMessage alike); from then on 76 answered.
  The Anthropic account was out of credit and has since been topped up. The
  iMessage bridge runs only Haiku, so every iMessage question and every daily
  scheduled report failed all week, reported as "The analysis could not be
  completed safely" and later "The model request was rejected by the
  provider". The 13:05 UTC scheduled report on 23 September was the first to
  be sent since 14 September.
- **Data stopped syncing on 19 September** (Lightspeed last synced 06:56 UTC):
  the Fivetran trial ended. Every answer since carries a data-cutoff note and
  the hourly brief often reports that nothing can be confirmed. This is an
  account decision, not a code defect.

## Defects found and fixed

Reliability:

1. **The deadline discarded all evidence.** Exploration now stops 75 to 120 s
   before the hard deadline and leaves three model requests in reserve; the
   answer nudge composes from the evidence already gathered, queries refused
   after the cut are not reported as failures, and a hard timeout is
   classified as a timeout.
2. **A cut Claude turn replayed tool calls without results**, which Anthropic
   rejects with a 400. The adapter drops unanswered `tool_use` blocks on replay.
3. **Failure classification** now orders our own defects, quota, rate limits,
   provider outages, context overflow and rejections explicitly, matches
   status codes only at the start of a provider message, and the web records
   the class on the turn (`omni_runtime_failure.<code>`). The failure log line
   carries the job, turn, model and effort.
4. **Durable job saves** rewrote the whole encrypted snapshot (up to 48 MB)
   once per trace event, every emit waited for it, and one busy-database error
   failed the analysis. Saves now coalesce (one in flight, one queued), retry
   transient errors, and trace events no longer wait; polls still return only
   committed events.
5. **Exceptions inside tools were reported as invalid arguments**, sending the
   model off rewriting arguments that were fine.

Speed (context the model re-reads every step):

6. **History compaction never ran.** The Agents SDK records tool output as
   `{type: "text", text}` and the compactor only read strings.
7. **Results are sent compactly**: columns once, rows as arrays in column
   order, numeric strings without Cube's trailing zeros, midnight timestamps as
   dates, and only the semantics the model uses. Keyed rows were over half of
   all result characters.
8. **Field search matches names first**, reading descriptions only for an
   alternative that names no field.

Quality:

9. **The composer refused data cutoffs** the prompt requires ("Sales data runs
   through 19 September"), a clock time after a placeholder, and a "(24h)"
   header: three of twenty baseline turns paid a round trip for it.
10. **Derived arithmetic got units wrong.** Revenue ÷ units lost its dollars
    ("100.0" for $99.99); a margin moving from 40% to 45% read "5%" or "12.5%"
    instead of 5 points (percent_change on a percentage is now refused in
    favour of a points difference); a left join's unmatchedAsZero filled
    rates with 0%; sum and avg of percentages were allowed (two margins of 20%
    and 80% averaged to 50% where the blended margin was 20.06%);
    `matched_` keys were cut at 40 characters, breaking the documented
    join-plus-change recipe for every long product-sales measure; aggregates
    dropped identity keys; anti joins refused duplicate right-hand keys; and
    replayed float noise (0.30000000000000004) is now rounded.
11. **The composer accepted contradictions.** "Sales fell {{c}}" over a +8.2%
    change, a typed minus on a positive figure, "$" on a count and "%" on a
    plain number all passed as Verified; a cut table's row count grounded a
    population count in prose; suggested follow-ups were never grounded (one
    with an unsupported figure is now dropped); "FY2025-26" and "the top
    three" of a ranking were refused; and a value rounding to zero showed as
    "-0.0%" or "-$0".
12. **Claude left out required lists** (citedResultIds, limitations and
    followUps on ComposeAnswer: 31 invalid calls in one eval turn). The adapter
    restores an omitted required list as empty, and the repair guidance now
    says [] for an unused list and null for an unused nullable field.

## Results

The omni20 battery (20 production-shaped questions across Lightspeed, Xero and
Deputy, including follow-up threads) on a private runtime, before and after
every change. Times exclude queue waits; "rejections" are refused answer
compositions and "invalid" refused tool arguments.

| Run | Pass | Verified | p50 | p90 | Max | Requests | Queries | Rejections | Invalid | Input tokens per turn |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| GPT-6 Sol high, before | 20/20 | 2 | 37 s | 76 s | 85 s | 5.9 | 3.9 | 8 | 0 | 131k |
| GPT-6 Sol high, after | 20/20 | 5 | 36 s | 74 s | 77 s | 5.5 | 3.5 | 2 | 0 | 113k |
| Haiku 4.5 max, before | 20/20 | 5 | 75 s | 172 s | 203 s | 7.8 | 2.0 | 28 | 7 | 220k |
| Haiku 4.5 max, after | 20/20 | 8 | 73 s | 164 s | 185 s | 7.8 | 1.8 | 25 | 8 | 192k |
| Haiku 4.5 high, after | 20/20 | 5 | 55 s | 124 s | 153 s | 7.8 | 1.9 | 23 | 10 | 193k |
| GPT-6 Sol high, second pass | 20/20 | 6 | 44 s | 64 s | 71 s | 5.6 | 3.9 | 2 | 0 | 114k |
| Haiku 4.5 max, second pass | 20/20 | 6 | 62 s | 120 s | 133 s | 7.4 | 1.6 | 27 | 4 | 180k |

Haiku's remaining rejections are legitimate (figures typed instead of bound,
"no data" without an empty query); its latency is its own per-step thinking.
At high effort Haiku passed the same 20 as at max, with three fewer answers
Verified, and was 18 s faster at the median and 40 s faster at p90.
GPT-6 Sol high is twice as fast as the product default (Haiku max), runs
twice the queries, and almost never has an answer refused.

The second pass (items 13 to 17 below) took Haiku max to a 62 s median and
120 s p90, with half the invalid calls and no answer labelled as a question;
every refusal left was an unbound figure. Sol ran slightly more queries per
turn, checking recency and answering from the latest period that has data:
"How many hours did my team work last week?", with timesheets ending
12 September, went from No data to a Verified answer for the latest week.

Production after the deploy (release fc2181e): the owner's workorder question
answered in 42 s on GPT-6 Sol high with every asked column (items, revenue,
current list price, margin, September 2025 shelf price on the same basis);
an iMessage-channel Haiku turn answered honestly that the latest sales data is
Saturday 19 September.

## Second pass: when data stops

Probing the deployed fixes with recency questions ("How were sales
yesterday?", "How is this week tracking against last week?") while the
Fivetran sync was stopped showed five more defects:

13. **Freshness probes missed their budget whenever turns overlapped.** The
    control-plane freshness feed is empty for Ashburton, so every turn derives
    each source's last day from latest-date probes and waits at most 5 s.
    Each turn fired its own 14 queries; four turns starting together each
    waited the full 5 s and got no cutoff at all, so each spent a step finding
    the latest day itself and the composer refused correct dates after it (a
    lone cold turn took about 3 s). Concurrent turns now share one probe run,
    a caller keeps every probe that landed within the budget, and Omni probes
    only the last day (the earliest-date half serves only the business
    profile). Four concurrent cold turns: 2.7 s, all seven cutoffs.
14. **Answers explained a gap they cannot see.** "Lightspeed typically
    completes its sync within a few hours of trading", "hasn't synced yet",
    "will fill in when that syncs": with the sync stopped for four days, each
    told the owner nothing was wrong. The prompt says to state where data
    stops and never guess why or when; the composer refuses sync guesses,
    because Haiku ignored the prompt rule in two of three probes.
15. **An empty asked-for period became a question or an empty answer.** "How
    is this week tracking?" drew "Which would you prefer?", labelled "Needs a
    choice", or "I can't compare yet". The prompt now says to state the gap
    first and answer with the latest period that has data, like for like; a
    clarification carrying figures is refused; and the no_data and answer
    refusals each name the other outcome (models bounced between them two or
    three times).
16. **Weeks were misnamed.** A week bucket dated 14 September was called "the
    week ending 14 September", and Haiku compared Tuesday to Saturday
    ("15–19 September") as last week. The prompt now spells out yesterday and
    this and last week's dates, and the composer instructions name a week by
    its first day.
17. **"-2.5% fewer transactions".** A comparative after a change figure now
    drops its minus, as a direction word before it already did, and one that
    contradicts the figure is refused.

## Open

- The iMessage bridge has no fallback model: when the one provider it uses
  is out of credit, every iMessage answer fails. With this change the failure
  now says "The model provider account is out of credit"; a fallback model or
  an alert on `omni_model_quota` is a product decision.
- The hourly brief runs every hour (`ALBERT_DAILY_BRIEF_REFRESH_SECONDS=3600`
  on the deployed bridge) while `deploy/fly/imessage-bridge.toml` says 86400;
  redeploying the bridge from mainline would switch it to daily.
- The Omni product default is Claude Haiku 4.5 at max effort
  (`DEFAULT_OMNI_PREFERENCES`, `ALBERT_OMNI_DEFAULT_MODEL`). On the evidence
  above GPT-6 Sol high is the faster and stronger default, and Haiku at high
  effort is faster than at max for the same result; switching is a cost and
  provider decision for the owner.

## Deploy (2026-09-23)

Runtime `albert-codex-runtime` deployment `omni-audit-20260923` and web
`dpl_Hw5KTvjcmM6ihSXAQT7qzLuHyrJ5`, both release fc2181e. No contract or
schema changed and no migration was needed: the failure class rides in the
existing `result_digest` pattern. The iMessage bridge calls the runtime over
HTTP and was not redeployed.
