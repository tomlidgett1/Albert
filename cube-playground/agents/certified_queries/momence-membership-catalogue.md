---
user_request: >
  What memberships do we offer, what are their limits, and which renew automatically?
---

```json
{
  "measures": [
    "momence_membership_catalogue_analytics.membership_plans",
    "momence_membership_catalogue_analytics.enabled_membership_plans",
    "momence_membership_catalogue_analytics.auto_renewing_plans"
  ],
  "dimensions": [
    "momence_membership_catalogue_analytics.plan_name",
    "momence_membership_catalogue_analytics.membership_type",
    "momence_membership_catalogue_analytics.catalogue_state",
    "momence_membership_catalogue_analytics.auto_renewing",
    "momence_membership_catalogue_analytics.duration",
    "momence_membership_catalogue_analytics.duration_unit",
    "momence_membership_catalogue_analytics.session_usage_limit",
    "momence_membership_catalogue_analytics.appointment_usage_limit",
    "momence_membership_catalogue_analytics.combined_usage_limit",
    "momence_membership_catalogue_analytics.price_source_value"
  ],
  "order": {"momence_membership_catalogue_analytics.plan_name": "asc"}
}
```

The plan price is a source value whose response omits currency/unit convention;
do not format it as a currency. Plans are definitions, not member entitlements.

