---
user_request: >
  Total hours worked and wage cost for a period (what did wages cost, how many hours did staff work).
recipe: true
presentation: fact
date_parameter: workforce_analytics.shift_date
answer_hint: >
  One or two sentences with the figure asked for (hours, wage cost, shifts or average shift length).
answer_template: >
  For {{period}}, staff worked **{{workforce_analytics.hours_worked|number}} hours**
  across **{{workforce_analytics.worked_shift_count|integer}} shifts**, at a wage cost of
  **{{workforce_analytics.wage_cost|currency}}**. Average shift length was
  **{{workforce_analytics.avg_shift_hours|number}} hours**.
follow_ups:
  - "What will next week's roster cost us in wages?"
  - "How many hours did each person work last week?"
  - "Are there any timesheets waiting for approval?"
matches:
  - "How many hours did staff work last week?"
  - "What did wages cost last month?"
  - "How many shifts were worked in July?"
  - "Average shift length last month"
  - "Hours and wages last week"
  - "What did labour cost last week?"
---

```json
{
  "measures": [
    "workforce_analytics.hours_worked",
    "workforce_analytics.wage_cost",
    "workforce_analytics.worked_shift_count",
    "workforce_analytics.avg_shift_hours"
  ],
  "timeDimensions": [
    {
      "dimension": "workforce_analytics.shift_date",
      "dateRange": "last week"
    }
  ]
}
```
