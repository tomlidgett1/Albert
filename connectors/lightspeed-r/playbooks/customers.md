# Customers dimension — who buys, repeat business, credit, marketing reach

Primary tables: `ls_customers` · `ls_contacts` (address + marketing flags) ·
`ls_contact_emails` / `_phones` / `_websites` · `ls_customer_types` ·
`ls_credit_accounts` · `ls_customer_notes` · `ls_ship_tos` · the custom-field trio.
Spend questions join `ls_sales.customer_id`.

## Customer rules

- **Unidentified sales.** `ls_sales.customer_id = 0` means no customer was attached.
  Measure its share for the current tenant. Any per-customer metric covers identified
  customers only; **say so** in the answer. Never collapse the zeros into one phantom
  mega-customer.
- **Duplicate identities are normal.** Till, webstore and workshop each create their own
  row for the same human. Lifetime-value and repeat-rate answers cover identified,
  possibly-duplicated customers; disclose it.
- **Names:** `first_name` + `last_name` on `ls_customers` (no `full_name` column).
  Contact detail lives on `ls_contacts` joined via `contact_id`, with emails and phones
  in their own child tables (a customer can have several of each).
- **Marketing flags are negatives.** `no_email = true` means *do not email*. A
  reachable-by-email list must join `ls_contact_emails` AND check the opt-out flags on
  `ls_contacts`.
- **Store credit and gift cards** live on `ls_credit_accounts`. Balance
  sign convention: on a Credit Account tender, positive **debits** the account,
  negative **deposits** to it.
- **Customer segments** are tenant-defined in `ls_customer_types` via
  `customer_type_id`.
- **Archived customers** keep their history; exclude them only for "current customer"
  lists, never from historical spend.

## Worked shape

"Who are our best customers this year":

```sql
WITH pack AS (
  SELECT mapping_version AS mv FROM source_lightspeed.ls_sales
  GROUP BY 1 ORDER BY max(ingested_at) DESC LIMIT 1
)
SELECT c.customer_id,
       c.first_name || ' ' || c.last_name AS customer,
       COUNT(*)          AS tickets,
       SUM(s.calc_total) AS spend_inc_gst
FROM source_lightspeed.ls_sales s
JOIN source_lightspeed.ls_customers c ON c.customer_id = s.customer_id
  AND c.mapping_version = (SELECT mv FROM pack) AND NOT c.tombstone
JOIN source_lightspeed.ls_shops sh ON sh.shop_id = s.shop_id
  AND sh.mapping_version = (SELECT mv FROM pack) AND NOT sh.tombstone
WHERE s.mapping_version = (SELECT mv FROM pack) AND NOT s.tombstone
  AND s.completed AND NOT s.voided
  AND s.customer_id <> 0
  AND s.complete_time AT TIME ZONE sh.time_zone >= date_trunc('year', now() AT TIME ZONE sh.time_zone)
GROUP BY 1, 2
ORDER BY spend_inc_gst DESC
LIMIT 20;
```

Disclose: *"Covers sales with a customer attached — walk-in sales have no customer
recorded."*
