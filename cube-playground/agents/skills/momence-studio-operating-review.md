---
title: Momence yoga studio operating review
description: >
  Use when a Momence yoga, pilates or wellness studio asks for a weekly studio
  review covering schedule demand, attendance, members, memberships, instructors,
  locations, reported sales, payments and refunds.
---

# Momence yoga studio operating review

Use the last complete local Monday-Sunday week and compare it with the preceding
complete week. Keep each query at one native grain:

1. `momence_schedule_analytics`: scheduled session/appointment occurrences,
   booked/capacity/available places, weighted reservation utilization, full
   occurrences and waitlist demand by day, activity, instructor and location.
2. `momence_attendance_analytics`: eligible past reservations, checked-in rate,
   cancellations, late cancellations and ended-unchecked no-show proxy. State
   that rates are reservation-record weighted and session tickets may exceed one.
3. `momence_member_analytics`: current member count, engagement bands, observed
   visit counters, recent last-seen distribution and contactability. This is a
   current snapshot rather than a weekly new/returning cohort.
4. `momence_member_entitlement_analytics`: current usable/frozen entitlements,
   expiries inside 30 days, declined renewal risk and current limit utilization.
   Keep event, money, session and appointment credits separate.
5. `momence_instructor_analytics` and `momence_location_analytics`: future
   assignment and schedule footprint. Never call assignment labour hours or
   instructor performance; use attendance/schedule facts to describe classes.
6. If optional experimental sales are present,
   `momence_product_sales_analytics`: reported item type/quantity/value. Explain
   that HostSale omits currency and lifecycle status, so this is not certified
   revenue. Do not compare or add it to embedded tender totals.
7. If detailed payments are discoverable, query
   `momence_payment_analytics`, `momence_payment_method_analytics` and
   `momence_refund_analytics` separately for succeeded captures, failures, fees,
   methods and dated refunds by currency. State that transaction coverage is
   partial because Momence exposes no global payment-transaction list.

Structure the response as: studio headline, schedule demand, attendance and
cancellations, member/entitlement health, instructor/location capacity, then
commercial signals with a prominent source-coverage qualifier. End with at most
three evidence-backed actions such as schedule changes, targeted waitlist
capacity, or proactive entitlement renewal follow-up. Never manufacture a
currency, no-show status, cancellation history or complete payment total.
