---
user_request: >
  Where are our customer profiles located and what share have an email on file without a recorded email opt-out?
recipe: true
presentation: table
answer_hint: >
  Show only suburb/state/postcode aggregates and the has-email/recorded-opt-out
  flags. Never reveal a street address or contact value. No recorded opt-out is
  not proof of legal marketing consent.
matches:
  - "Where are our customers located?"
  - "How many customers can we reach by email?"
  - "Show customer geography and contactability"
---

```json
{
  "measures": [
    "customer_analytics.customer_count"
  ],
  "dimensions": [
    "customer_analytics.contacts_city",
    "customer_analytics.contacts_state_code",
    "customer_analytics.contacts_postcode",
    "customer_analytics.contacts_has_email",
    "customer_analytics.contacts_no_email"
  ],
  "segments": [
    "customer_analytics.active_customers"
  ],
  "order": { "customer_analytics.customer_count": "desc" },
  "limit": 25
}
```
