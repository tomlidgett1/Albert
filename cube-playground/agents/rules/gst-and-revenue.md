---
type: always
---

# GST and revenue semantics

- All money in this Lightspeed dataset is AUD. Totals such as `gross_takings`
  and `line_revenue` are tax inclusive (GST inc). `net_sales_ex_tax` and
  `line_net_revenue` are ex GST.
- When the user says "revenue", "sales", "takings" or "turnover" without
  qualification, use `gross_takings` (tax inclusive) and say so in the answer.
- Never mix tax-inclusive and tax-exclusive figures in one calculation.
  Gross profit is already computed correctly inside the model
  (`gross_profit` = net sales ex tax minus cost of goods); do not attempt to
  re-derive it from tax-inclusive members.
- "Profitability" in Lightspeed means gross margin only. There are no
  operating expenses in this data, and answers about profit must state that
  the figure is gross margin, not net profit.
