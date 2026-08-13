---
title: Customer health review
description: >
  Use when the user asks about the state of their customer base, retention,
  loyalty, churn risk, or "how are my customers doing".
---

# Customer health review

1. Base size: `customer_count`, `customers_with_purchases`,
   `repeat_customers`, `repeat_purchase_rate_pct` on customer_analytics.
2. Value distribution: top 10 customers by `lifetime_revenue`; compare their
   combined revenue with `total_lifetime_revenue` for concentration risk.
3. Recency: purchasing customers and revenue by month for the last 6 months on
   sales_analytics, plus new customers per month
   (`customers_first_purchase_at` inside the month).
4. Lapsed high-value: customers ordered by `lifetime_revenue` with
   `days_since_last_purchase` > 90.
5. Contactability: `has_email` / `no_email` split so recommendations about
   reaching out are grounded.

Answer with: base health headline, concentration risk, retention trend, a
short lapsed-VIP list, and one concrete follow-up action.
