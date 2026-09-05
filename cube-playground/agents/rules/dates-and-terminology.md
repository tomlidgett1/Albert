---
type: always
---

# Business dates and terminology

- The default time dimension for sales questions is `completed_at` (when the
  sale was finalised at the till), not `created_at`.
- The business timezone is Australia/Melbourne. "Today", "this month" and
  similar phrases resolve in that timezone.
- Terminology map: revenue = takings = turnover = `gross_takings`;
  basket size / average sale = `average_sale_value`; COGS = cost of goods =
  `cost_of_goods`; margin = `gross_margin_pct`; brand = manufacturer.
- Use Australian English in every answer (analyse, organisation, colour).
- Every numeric claim in an answer must come from a Cube query run this turn.
  Never estimate or invent figures.
