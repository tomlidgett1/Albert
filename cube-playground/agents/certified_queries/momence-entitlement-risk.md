---
user_request: >
  Which members have memberships expiring soon, frozen or with a declined renewal?
---

```json
{
  "measures": [
    "momence_member_entitlement_analytics.active_endpoint_entitlements",
    "momence_member_entitlement_analytics.frozen_entitlements",
    "momence_member_entitlement_analytics.expiring_within_30_days",
    "momence_member_entitlement_analytics.declined_renewal_entitlements"
  ],
  "dimensions": [
    "momence_member_entitlement_analytics.momence_members_full_name",
    "momence_member_entitlement_analytics.membership_name",
    "momence_member_entitlement_analytics.entitlement_state",
    "momence_member_entitlement_analytics.ends_at",
    "momence_member_entitlement_analytics.is_frozen",
    "momence_member_entitlement_analytics.declined_renewal_at"
  ],
  "order": {"momence_member_entitlement_analytics.ends_at": "asc"},
  "limit": 100
}
```

This endpoint is a current active-entitlement snapshot. Frozen is not cancelled,
and a declined renewal is risk evidence rather than proof the entitlement ended.

