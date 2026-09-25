---
user_request: >
  How has our censored 90-day repeat-purchase rate changed by first-purchase cohort month?
recipe: true
presentation: line
answer_hint: >
  Plot the 90-day repeat rate by first-purchase cohort month and include the
  mature-customer denominator. Only customers whose full 90-day observation
  window has elapsed belong in either numerator or denominator; omit rows with
  no mature denominator. Refunds never count as purchases. Describe changes as
  associations, never causal effects of a campaign or business action.
matches:
  - "What is our 90-day repeat rate by cohort?"
  - "Is 90-day customer repeat improving?"
  - "Show monthly customer cohorts repeating within 90 days"
---

```json
{
  "measures": [
    "customer_analytics.mature_90_day_customers",
    "customer_analytics.repeated_within_90_days",
    "customer_analytics.repeat_within_90_days_pct"
  ],
  "timeDimensions": [
    {
      "dimension": "customer_analytics.first_purchase_at",
      "granularity": "month",
      "dateRange": "last 36 months"
    }
  ],
  "filters": [
    {
      "member": "customer_analytics.mature_90_day_customers",
      "operator": "gt",
      "values": ["0"]
    }
  ],
  "order": { "customer_analytics.first_purchase_at": "asc" },
  "limit": 36
}
```
