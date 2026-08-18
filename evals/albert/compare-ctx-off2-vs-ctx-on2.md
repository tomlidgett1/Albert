# Albert eval — before/after: `ctx-off2` → `ctx-on2`

Paired turns: 42

## By interaction class

| group | n | pass before → after | overall | correctness | detail | format | p50 s | p95 s | mean q/turn |
|---|---:|---|---|---|---|---|---|---|---|
| cold_multi_tool | 13 | 46% → 31% | 3.23 → 3.31 | 3.46 → 3.46 | 3.00 → 2.92 | 3.62 → 3.62 | 112 → 193 | 293 → 339 | 4.6 → 6.8 |
| cold_single_tool | 20 | 75% → 85% | 4.10 → 4.10 | 4.55 → 4.55 | 3.80 → 3.80 | 4.15 → 4.10 | 31 → 24 | 188 → 272 | 2.6 → 2.5 |
| drilldown | 2 | 0% → 0% | 3.00 → 2.50 | 3.00 → 3.00 | 3.00 → 3.00 | 3.50 → 4.50 | 29 → 25 | 100 → 136 | 1.5 → 2.0 |
| meta | 7 | 43% → 43% | 3.29 → 3.14 | 3.57 → 3.14 | 2.57 → 3.14 | 4.14 → 4.29 | 10 → 8 | 210 → 92 | 1.4 → 0.6 |
| **all** | 42 | 57% → 57% | 3.64 → 3.62 | 3.98 → 3.90 | 3.31 → 3.38 | 3.95 → 4.00 | 36 → 32 | 259 → 326 | 3.0 → 3.5 |

## By difficulty tier

| group | n | pass before → after | overall | correctness | detail | format | p50 s | p95 s | mean q/turn |
|---|---:|---|---|---|---|---|---|---|---|
| ambiguous | 20 | 65% → 70% | 3.85 → 3.90 | 4.35 → 4.35 | 3.70 → 3.65 | 4.20 → 4.05 | 31 → 27 | 259 → 339 | 3.3 → 3.9 |
| easy | 1 | 100% → 100% | 5.00 → 5.00 | 5.00 → 5.00 | 5.00 → 5.00 | 5.00 → 5.00 | 10 → 16 | 10 → 16 | 1.0 → 1.0 |
| hard | 3 | 0% → 33% | 3.00 → 3.00 | 3.00 → 3.67 | 2.67 → 3.00 | 3.00 → 4.33 | 100 → 136 | 188 → 266 | 1.7 → 2.3 |
| medium | 2 | 100% → 100% | 4.00 → 4.00 | 5.00 → 5.00 | 3.50 → 3.50 | 4.00 → 4.00 | 16 → 17 | 31 → 33 | 1.0 → 1.0 |
| meta | 7 | 43% → 43% | 3.29 → 3.14 | 3.57 → 3.14 | 2.57 → 3.14 | 4.14 → 4.29 | 10 → 8 | 210 → 92 | 1.4 → 0.6 |
| xhard | 9 | 56% → 33% | 3.44 → 3.33 | 3.44 → 3.22 | 3.00 → 2.89 | 3.44 → 3.44 | 112 → 143 | 293 → 326 | 4.6 → 6.2 |
| **all** | 42 | 57% → 57% | 3.64 → 3.62 | 3.98 → 3.90 | 3.31 → 3.38 | 3.95 → 4.00 | 36 → 32 | 259 → 326 | 3.0 → 3.5 |

## By tool scope

| group | n | pass before → after | overall | correctness | detail | format | p50 s | p95 s | mean q/turn |
|---|---:|---|---|---|---|---|---|---|---|
| deputy | 4 | 50% → 75% | 3.75 → 4.00 | 4.00 → 4.25 | 3.25 → 3.50 | 3.50 → 4.00 | 11 → 12 | 235 → 272 | 5.8 → 7.0 |
| lightspeed | 16 | 69% → 81% | 4.00 → 3.94 | 4.50 → 4.50 | 3.75 → 3.75 | 4.13 → 4.06 | 31 → 25 | 148 → 463 | 1.9 → 1.5 |
| meta | 7 | 43% → 43% | 3.29 → 3.14 | 3.57 → 3.14 | 2.57 → 3.14 | 4.14 → 4.29 | 10 → 8 | 210 → 92 | 1.4 → 0.6 |
| multi | 13 | 46% → 31% | 3.23 → 3.31 | 3.46 → 3.46 | 3.00 → 2.92 | 3.62 → 3.62 | 112 → 193 | 293 → 339 | 4.6 → 6.8 |
| xero | 2 | 100% → 50% | 4.50 → 4.00 | 4.50 → 4.00 | 4.50 → 4.00 | 5.00 → 5.00 | 8 → 8 | 31 → 29 | 1.0 → 1.0 |
| **all** | 42 | 57% → 57% | 3.64 → 3.62 | 3.98 → 3.90 | 3.31 → 3.38 | 3.95 → 4.00 | 36 → 32 | 259 → 326 | 3.0 → 3.5 |

## By interaction pattern

| group | n | pass before → after | overall | correctness | detail | format | p50 s | p95 s | mean q/turn |
|---|---:|---|---|---|---|---|---|---|---|
| cold | 40 | 60% → 60% | 3.67 → 3.67 | 4.03 → 3.95 | 3.33 → 3.40 | 3.98 → 3.98 | 36 → 32 | 259 → 326 | 3.0 → 3.6 |
| drilldown | 2 | 0% → 0% | 3.00 → 2.50 | 3.00 → 3.00 | 3.00 → 3.00 | 3.50 → 4.50 | 29 → 25 | 100 → 136 | 1.5 → 2.0 |
| **all** | 42 | 57% → 57% | 3.64 → 3.62 | 3.98 → 3.90 | 3.31 → 3.38 | 3.95 → 4.00 | 36 → 32 | 259 → 326 | 3.0 → 3.5 |

## Failure tags before → after

| tag | before | after |
|---|---:|---:|
| padded | 19 | 21 |
| missed_facet | 10 | 10 |
| over_investigated | 10 | 8 |
| assumption_not_stated | 4 | 5 |
| format_broken | 6 | 2 |
| wrong_period | 3 | 4 |
| wrong_entity | 3 | 3 |
| chart_when_not_needed | 2 | 4 |
| unsupported_number | 1 | 5 |
| wrong_number | 2 | 2 |
| false_zero | 0 | 3 |
| too_thin | 1 | 1 |
| no_chart_when_needed | 1 | 1 |
| unavailable_or_error | 1 | 1 |
| table_missing | 1 | 1 |
| timeout | 1 | 0 |
| stale_data_claim | 0 | 1 |

## Per-turn deltas (regressions first)

| id | pattern | overall before → after | correct | s before → after | q | tags after |
|---|---|---|---|---|---|---|
| T-10 | cold | 3 → 1 | 3 → 1 | 110 → 92 | 4 → 3 | wrong_entity, false_zero, stale_data_claim, missed_facet, padded, unavailable_or_error |
| A-03 | cold | 5 → 4 | 5 → 5 | 25 → 22 | 1 → 1 | padded |
| D-04b | drilldown | 3 → 2 | 3 → 2 | 29 → 25 | 1 → 1 | unsupported_number, missed_facet, padded |
| A-10 | cold | 4 → 3 | 4 → 3 | 8 → 8 | 1 → 1 | assumption_not_stated |
| A-08 | cold | 5 → 4 | 5 → 4 | 35 → 63 | 1 → 2 | padded, over_investigated |
| T-01 | cold | 5 → 4 | 5 → 4 | 5 → 6 | 0 → 0 |  |
| T-04 | cold | 4 → 3 | 4 → 3 | 10 → 10 | 0 → 0 | missed_facet, padded |
| X-07 | cold | 4 → 3 | 4 → 2 | 136 → 208 | 12 → 16 | unsupported_number, wrong_period, over_investigated, padded |
| X-19 | cold | 4 → 3 | 5 → 4 | 112 → 100 | 4 → 4 | missed_facet, padded, format_broken |
| X-21 | cold | 5 → 4 | 5 → 5 | 95 → 138 | 2 → 4 | padded, chart_when_not_needed |
| A-02 | cold | 5 → 5 | 5 → 5 | 10 → 9 | 1 → 1 |  |
| D-04a | cold | 4 → 4 | 5 → 5 | 16 → 17 | 1 → 1 | format_broken |
| A-04 | cold | 3 → 3 | 5 → 5 | 27 → 37 | 1 → 1 | assumption_not_stated |
| A-06 | cold | 5 → 5 | 5 → 5 | 31 → 29 | 1 → 1 |  |
| A-05 | cold | 4 → 4 | 5 → 5 | 44 → 27 | 1 → 1 | padded |
| A-01 | cold | 4 → 4 | 5 → 4 | 77 → 24 | 2 → 1 |  |
| A-07 | cold | 5 → 5 | 5 → 5 | 11 → 12 | 1 → 1 |  |
| A-11 | cold | 5 → 5 | 5 → 5 | 10 → 8 | 1 → 1 |  |
| A-12 | cold | 4 → 4 | 5 → 5 | 36 → 25 | 1 → 1 | padded |
| E-LS-17 | cold | 5 → 5 | 5 → 5 | 10 → 16 | 1 → 1 |  |
| D-04c | drilldown | 3 → 3 | 3 → 4 | 100 → 136 | 2 → 3 | missed_facet |
| M-LS-06 | cold | 4 → 4 | 5 → 5 | 31 → 33 | 1 → 1 | padded |
| T-06 | cold | 4 → 4 | 4 → 4 | 8 → 7 | 0 → 0 |  |
| A-09 | cold | 3 → 3 | 3 → 3 | 148 → 463 | 7 → 2 | unsupported_number, assumption_not_stated |
| T-11 | cold | 3 → 3 | 3 → 2 | 5 → 7 | 0 → 0 | false_zero, unsupported_number, missed_facet |
| V-02 | cold | 5 → 5 | 5 → 5 | 30 → 36 | 1 → 1 |  |
| V-01 | cold | 4 → 4 | 4 → 5 | 126 → 108 | 4 → 5 | over_investigated, padded |
| V-06 | cold | 2 → 2 | 3 → 2 | 235 → 272 | 19 → 23 | unsupported_number, wrong_period, over_investigated, padded, chart_when_not_needed, assumption_not_stated |
| V-05 | cold | 4 → 4 | 5 → 4 | 282 → 230 | 8 → 12 | over_investigated, padded |
| X-05 | cold | 5 → 5 | 5 → 5 | 36 → 32 | 3 → 2 |  |
| X-08 | cold | 5 → 5 | 5 → 5 | 46 → 29 | 2 → 1 |  |
| X-01 | cold | 2 → 2 | 2 → 2 | 293 → 193 | 8 → 3 | wrong_entity, missed_facet, padded |
| X-04 | cold | 2 → 2 | 2 → 1 | 139 → 143 | 3 → 4 | wrong_number, false_zero, missed_facet, table_missing |
| A-13 | cold | 2 → 3 | 2 → 3 | 21 → 313 | 1 → 9 | missed_facet, over_investigated, padded, assumption_not_stated |
| A-14 | cold | 3 → 4 | 4 → 5 | 13 → 14 | 1 → 1 | no_chart_when_needed |
| H-DP-02 | cold | 3 → 4 | 3 → 5 | 188 → 266 | 2 → 3 | padded |
| T-08 | cold | 3 → 4 | 5 → 5 | 210 → 42 | 6 → 1 | padded |
| V-03 | cold | 3 → 4 | 5 → 5 | 95 → 9 | 4 → 1 | missed_facet, too_thin |
| V-04 | cold | 2 → 3 | 2 → 4 | 259 → 339 | 9 → 11 | over_investigated, padded, chart_when_not_needed |
| X-16 | cold | 2 → 3 | 1 → 2 | 75 → 282 | 2 → 8 | wrong_number, padded, chart_when_not_needed |
| X-11 | cold | 2 → 3 | 2 → 3 | 242 → 326 | 5 → 14 | wrong_period, wrong_entity, over_investigated, padded |
| T-02 | cold | 1 → 3 | 1 → 3 | 25 → 8 | 0 → 0 | wrong_period |