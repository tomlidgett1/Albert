---
title: Customer health review
description: >
  Use when the user asks about the state of their customer base, retention,
  loyalty, churn risk, or "how are my customers doing".
---

# Customer health review

Start with the certified customer-pulse and attribution-coverage shapes. Add a
query only when it answers a requested facet; do not expand a quick question
into a generic audit.

1. Population: `customer_count` counts POS profiles, not deduplicated humans;
   `active_customer_count` excludes archived profiles. State that distinction
   when the user says people, unique customers or "real customers".
2. Buying behavior: `purchase_count`, `first_purchase_at` and
   `last_purchase_at` use positive completed purchases only. Refunds never make
   a profile repeat or move recency forward. `lifetime_net_spend` is signed;
   pair it with `refund_count` / `lifetime_refund_value` when refunds matter.
3. Repeat health: `repeat_purchase_rate_pct` is the lifetime share of purchasing
   profiles with at least two positive purchases. It is not cohort retention.
   `repeat_within_90_days_pct` is the censored cohort measure: its denominator
   contains only `mature_90_day_customers` whose complete 90-day window has
   elapsed, and its numerator is `repeated_within_90_days`. Recent immature
   profiles are excluded, never counted as non-repeaters. For a period's
   new/returning mix, follow the new-vs-returning rule and report attribution
   coverage for the same period.
4. Value concentration: rank profiles by `lifetime_net_spend`, or use
   sales_analytics for a named period. Customer profitability is Lightspeed
   gross profit only; never call it net or whole-business profit.
5. Recency: use the published `recency_band` / `frequency_band`. The lapsed
   starter uses a fixed definition: latest positive purchase more than 180
   elapsed days ago. Call it an operational segment, not predicted churn.
6. Geography and contactability: aggregate by suburb/state/postcode and safe
   booleans only. `contacts_has_email = true` plus `contacts_no_email = false`
   means an address exists and no opt-out is recorded in this source; it does
   not prove legal marketing consent. Never request or expose email, phone,
   street address, date of birth, custom values or customer-note text.
7. Recommendations: propose analysis-only experiments tied to retrieved facts
   (for example review a lapsed high-value segment or improve till attribution).
   Do not claim causality, response lift, churn, consent, or likely success
   without evidence, and never claim to send a campaign or write back to a
   source system.

When comparing 90-day cohort months, report the mature denominator with every
rate. A cohort month may be partially observable near the censoring boundary;
never describe a recent null/zero denominator as poor retention. Differences
between cohort rates are associations, not proof that a campaign, product or
staff action caused the change.

Answer with the smallest evidence-backed shape that resolves the question. A
full review may include: base/attribution headline, repeat and recency signals,
value concentration, one bounded opportunity list when explicitly requested,
and at most three clearly labelled hypotheses or next analyses.
