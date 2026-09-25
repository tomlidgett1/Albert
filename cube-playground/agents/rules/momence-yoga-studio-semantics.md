---
type: always
---

# Momence yoga and wellness studio semantics

Apply these rules whenever a result comes from a `momence_*` view:

- Keep native grains separate. A schedule occurrence, reservation, member,
  membership plan, bought entitlement, sale item, tender item, detailed payment
  item and refund event are different facts. Query one view at a time and
  reconcile independently aggregated results in the answer; never raw-join two
  array/event grains.
- `momence_schedule_analytics` answers what is scheduled and reserved. Booked
  places are not attendance, unique people, captured payments or revenue.
  Capacity minus booked places is an availability estimate, not guaranteed
  bookability. Draft/cancelled activities never count as scheduled performance.
- `momence_attendance_analytics` answers member reservation/check-in outcomes.
  Momence session bookings expose a booking-level `checkedIn` boolean while one
  booking may have multiple `ticketsBought`; label the attendance rate as
  reservation-record weighted. “No-show” is an Albert proxy for an ended,
  non-cancelled, unchecked record and must always be called a proxy.
- A teacher is an instructor identity/assignment only. Never infer employment,
  rostered or actual hours, labour cost, wage, payroll or productivity from
  `momence_instructor_analytics` or the teacher dimensions on schedule/attendance.
- A member profile is not an entitlement. Member visit counters are current
  lifetime-style source snapshots and may be API-history bounded; `first_seen`
  and `last_seen` are observed activity bounds, not guaranteed signup/churn.
- A membership plan is a definition. A bought membership from
  `momence_member_entitlement_analytics` is a current active-endpoint entitlement
  snapshot. Frozen is not cancelled. Declined renewal is risk evidence, not
  proof that access ended. Never sum current balances across ingestion dates.
- Event credits, money credits, session limits and appointment limits are
  different units. Never add them together or call credit units cash/revenue.
- HostSale is experimental and does not return status, void state, location or
  currency. `momence_sales_analytics` and
  `momence_product_sales_analytics` expose reported source arithmetic, not
  certified revenue. Never add item totals to tender totals and never invent a
  currency for HostSale or membership-plan price values.
- Captured cash uses `momence_payment_analytics.captured_currency_amount` with
  `payment_status = succeeded`, grouped by `currency_code`. Payment header and
  payment-item amounts are alternative grains, not additive. Host/customer
  covered processor and platform fees remain separate.
- Detailed payment and refund coverage is partial: Momence exposes no global
  payment transaction list, so Albert can retrieve only transaction IDs found in
  member notes. Never treat missing rows as zero, claim full processor
  reconciliation or compare the partial total to all HostSales as if complete.
- Refund flow uses `momence_refund_analytics` over `refund_created_at`. Keep
  refunded currency, money credits and event credits separate. A refund method
  cannot identify the returned yoga class, appointment, product or membership.
- Public location/catalogue streams and experimental sales/payment streams can
  be unavailable for a staff role. Missing optional coverage produces an honest
  partial/unavailable answer, not a synthetic zero.
- Use `momence_source_explorer` only after curated views fail to expose the
  exact concept. Filter one `parent_stream` or `source_object_type` and one exact
  stable `field_path`; use `field_pointer` for a specific array occurrence and
  the value member matching `value_kind`. Numeric values are not automatically
  additive and a missing path means no returned value, never permission to infer.
- Member contact fields, notes, contracts, payment identifiers and online/Zoom
  credentials can appear in the exhaustive explorer. Reveal source PII or
  sensitive text only for an explicit tenant-authorized request; otherwise
  aggregate, redact or state that access is governed.
