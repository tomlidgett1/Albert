# Codex employee-performance qualification — Luna Max Fast

- Date: 2026-08-21
- Prompt: `I need an overview of which employee has performed the best this month - give me your thinking.`
- Runtime: pinned Codex app-server `0.148.0`
- Model: `gpt-5.6-luna`
- Reasoning: Max
- Processing: Fast
- Data: synthetic Lightspeed and Deputy rows only
- Runner: `scripts/codex-employee-performance-smoke.mts`

## Result

Passed.

| Gate | Result |
| --- | --- |
| Required POS contribution evidence | `sales_analytics` queried |
| Required authoritative labour evidence | `workforce_analytics` queried |
| Common freshness period | Both queries aligned through 2026-08-16 |
| Trusted productivity calculation | Derived productivity table emitted |
| Answer uses productivity | Yes |
| Answer discloses identity/attribution limitation | Yes |
| Terminal state | Qualified |
| Cube queries | 2 |
| Wall time | 167.4s |

The run records only gate outcomes, queried view names, counts and timings. It
does not record the generated answer, real employee data, tenant identifiers,
credentials or private reasoning.
