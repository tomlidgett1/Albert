# Albert eval — before/after: `ctx-off` → `ctx-on`

Paired turns: 42

## By interaction class

| group | n | pass before → after | overall | correctness | detail | format | p50 s | p95 s | mean q/turn |
|---|---:|---|---|---|---|---|---|---|---|
| cold_multi_tool | 13 | 38% → 31% | 3.31 → 3.31 | 3.46 → 3.62 | 3.08 → 3.08 | 3.46 → 3.62 | 136 → 135 | 525 → 406 | 5.8 → 5.4 |
| cold_single_tool | 20 | 70% → 70% | 3.80 → 4.00 | 4.30 → 4.50 | 3.40 → 3.55 | 4.00 → 4.20 | 24 → 18 | 386 → 93 | 3.0 → 1.1 |
| drilldown | 2 | 100% → 0% | 4.00 → 3.00 | 4.50 → 3.00 | 3.50 → 3.00 | 3.50 → 4.00 | 30 → 25 | 91 → 101 | 1.5 → 2.5 |
| meta | 7 | 29% → 14% | 3.00 → 2.71 | 3.14 → 2.86 | 3.00 → 3.29 | 3.86 → 3.71 | 20 → 20 | 142 → 211 | 1.9 → 1.7 |
| **all** | 42 | 55% → 45% | 3.52 → 3.52 | 3.86 → 3.88 | 3.24 → 3.33 | 3.79 → 3.93 | 40 → 27 | 521 → 312 | 3.6 → 2.6 |

## By difficulty tier

| group | n | pass before → after | overall | correctness | detail | format | p50 s | p95 s | mean q/turn |
|---|---:|---|---|---|---|---|---|---|---|
| ambiguous | 20 | 55% → 55% | 3.60 → 3.80 | 4.10 → 4.30 | 3.45 → 3.40 | 4.05 → 4.20 | 25 → 18 | 525 → 170 | 4.0 → 1.6 |
| easy | 1 | 100% → 100% | 5.00 → 5.00 | 5.00 → 5.00 | 4.00 → 5.00 | 5.00 → 5.00 | 12 → 27 | 12 → 27 | 1.0 → 1.0 |
| hard | 3 | 67% → 33% | 3.67 → 3.33 | 4.00 → 3.67 | 3.00 → 3.00 | 3.33 → 4.00 | 91 → 88 | 150 → 101 | 1.7 → 2.0 |
| medium | 2 | 100% → 100% | 4.00 → 4.00 | 4.50 → 5.00 | 3.50 → 3.00 | 3.50 → 4.00 | 15 → 16 | 40 → 26 | 1.0 → 1.0 |
| meta | 7 | 29% → 14% | 3.00 → 2.71 | 3.14 → 2.86 | 3.00 → 3.29 | 3.86 → 3.71 | 20 → 20 | 142 → 211 | 1.9 → 1.7 |
| xhard | 9 | 56% → 33% | 3.44 → 3.33 | 3.56 → 3.44 | 2.89 → 3.22 | 3.22 → 3.33 | 113 → 179 | 387 → 406 | 5.6 → 6.2 |
| **all** | 42 | 55% → 45% | 3.52 → 3.52 | 3.86 → 3.88 | 3.24 → 3.33 | 3.79 → 3.93 | 40 → 27 | 521 → 312 | 3.6 → 2.6 |

## By tool scope

| group | n | pass before → after | overall | correctness | detail | format | p50 s | p95 s | mean q/turn |
|---|---:|---|---|---|---|---|---|---|---|
| deputy | 4 | 50% → 75% | 3.50 → 4.00 | 4.25 → 4.75 | 3.00 → 3.50 | 3.50 → 3.75 | 12 → 88 | 244 → 170 | 6.0 → 2.0 |
| lightspeed | 16 | 75% → 56% | 3.81 → 3.81 | 4.31 → 4.25 | 3.44 → 3.44 | 3.94 → 4.19 | 25 → 18 | 745 → 101 | 2.3 → 1.1 |
| meta | 7 | 29% → 14% | 3.00 → 2.71 | 3.14 → 2.86 | 3.00 → 3.29 | 3.86 → 3.71 | 20 → 20 | 142 → 211 | 1.9 → 1.7 |
| multi | 13 | 38% → 31% | 3.31 → 3.31 | 3.46 → 3.62 | 3.08 → 3.08 | 3.46 → 3.62 | 136 → 135 | 525 → 406 | 5.8 → 5.4 |
| xero | 2 | 100% → 100% | 4.50 → 4.50 | 4.50 → 4.50 | 4.00 → 4.00 | 5.00 → 5.00 | 8 → 7 | 35 → 27 | 1.0 → 1.0 |
| **all** | 42 | 55% → 45% | 3.52 → 3.52 | 3.86 → 3.88 | 3.24 → 3.33 | 3.79 → 3.93 | 40 → 27 | 521 → 312 | 3.6 → 2.6 |

## By interaction pattern

| group | n | pass before → after | overall | correctness | detail | format | p50 s | p95 s | mean q/turn |
|---|---:|---|---|---|---|---|---|---|---|
| cold | 40 | 53% → 48% | 3.50 → 3.55 | 3.83 → 3.92 | 3.23 → 3.35 | 3.80 → 3.92 | 40 → 27 | 521 → 312 | 3.7 → 2.6 |
| drilldown | 2 | 100% → 0% | 4.00 → 3.00 | 4.50 → 3.00 | 3.50 → 3.00 | 3.50 → 4.00 | 30 → 25 | 91 → 101 | 1.5 → 2.5 |
| **all** | 42 | 55% → 45% | 3.52 → 3.52 | 3.86 → 3.88 | 3.24 → 3.33 | 3.79 → 3.93 | 40 → 27 | 521 → 312 | 3.6 → 2.6 |

## Failure tags before → after

| tag | before | after |
|---|---:|---:|
| padded | 22 | 16 |
| missed_facet | 9 | 13 |
| over_investigated | 9 | 7 |
| assumption_not_stated | 7 | 5 |
| wrong_entity | 6 | 4 |
| format_broken | 6 | 2 |
| stale_data_claim | 3 | 4 |
| wrong_number | 3 | 4 |
| too_thin | 3 | 3 |
| unsupported_number | 4 | 0 |
| chart_when_not_needed | 2 | 2 |
| false_zero | 1 | 2 |
| table_missing | 1 | 2 |
| no_chart_when_needed | 1 | 1 |
| unavailable_or_error | 1 | 1 |
| wrong_period | 1 | 0 |
| unnecessary_clarification | 0 | 1 |

## Per-turn deltas (regressions first)

| id | pattern | overall before → after | correct | s before → after | q | tags after |
|---|---|---|---|---|---|---|
| A-05 | cold | 4 → 2 | 5 → 2 | 25 → 4 | 1 → 0 | missed_facet, unnecessary_clarification |
| T-01 | cold | 5 → 3 | 5 → 3 | 6 → 5 | 0 → 0 | stale_data_claim |
| D-04b | drilldown | 4 → 3 | 5 → 3 | 30 → 25 | 1 → 1 | missed_facet, padded |
| A-12 | cold | 4 → 3 | 4 → 4 | 52 → 10 | 1 → 1 | missed_facet, too_thin |
| D-04c | drilldown | 4 → 3 | 4 → 3 | 91 → 101 | 2 → 4 | missed_facet |
| T-04 | cold | 3 → 2 | 4 → 2 | 142 → 83 | 6 → 4 | false_zero, stale_data_claim, missed_facet, over_investigated, padded, chart_when_not_needed |
| X-16 | cold | 4 → 3 | 5 → 3 | 81 → 406 | 3 → 6 | wrong_number, padded, chart_when_not_needed |
| X-07 | cold | 4 → 3 | 4 → 3 | 181 → 135 | 18 → 14 | wrong_number, over_investigated, padded, table_missing |
| X-21 | cold | 4 → 3 | 4 → 3 | 136 → 179 | 2 → 7 | missed_facet, over_investigated, padded |
| X-11 | cold | 3 → 2 | 3 → 2 | 387 → 312 | 8 → 11 | wrong_number, wrong_entity, over_investigated, padded, table_missing |
| A-02 | cold | 5 → 5 | 5 → 5 | 11 → 11 | 1 → 1 |  |
| D-04a | cold | 4 → 4 | 5 → 5 | 15 → 16 | 1 → 1 | padded |
| A-04 | cold | 3 → 3 | 4 → 5 | 10 → 10 | 1 → 1 | too_thin, assumption_not_stated |
| A-07 | cold | 4 → 4 | 5 → 5 | 12 → 93 | 1 → 1 |  |
| A-06 | cold | 5 → 5 | 5 → 5 | 35 → 27 | 1 → 1 |  |
| A-10 | cold | 4 → 4 | 4 → 4 | 8 → 7 | 1 → 1 |  |
| A-08 | cold | 4 → 4 | 5 → 5 | 17 → 18 | 1 → 1 |  |
| A-11 | cold | 5 → 5 | 5 → 5 | 8 → 11 | 1 → 1 |  |
| E-LS-17 | cold | 5 → 5 | 5 → 5 | 12 → 27 | 1 → 1 |  |
| A-14 | cold | 3 → 3 | 4 → 4 | 24 → 11 | 1 → 1 | no_chart_when_needed, assumption_not_stated |
| M-LS-06 | cold | 4 → 4 | 4 → 5 | 40 → 26 | 1 → 1 | padded |
| T-02 | cold | 3 → 3 | 2 → 3 | 18 → 20 | 0 → 0 | stale_data_claim |
| T-06 | cold | 4 → 4 | 5 → 5 | 6 → 10 | 0 → 0 | padded |
| T-11 | cold | 3 → 3 | 3 → 3 | 20 → 6 | 0 → 0 | missed_facet |
| T-10 | cold | 1 → 1 | 1 → 1 | 77 → 110 | 4 → 3 | wrong_entity, false_zero, stale_data_claim, missed_facet, padded, unavailable_or_error |
| V-03 | cold | 4 → 4 | 5 → 5 | 10 → 9 | 1 → 1 | missed_facet |
| A-13 | cold | 3 → 3 | 3 → 3 | 525 → 18 | 10 → 1 | missed_facet, assumption_not_stated |
| V-05 | cold | 3 → 3 | 3 → 3 | 199 → 103 | 3 → 1 | wrong_number, padded |
| X-05 | cold | 5 → 5 | 5 → 5 | 32 → 34 | 2 → 3 |  |
| X-01 | cold | 2 → 2 | 2 → 2 | 355 → 234 | 8 → 6 | wrong_entity, over_investigated, padded |
| V-01 | cold | 3 → 3 | 4 → 3 | 745 → 18 | 11 → 1 | missed_facet, too_thin |
| A-03 | cold | 4 → 5 | 4 → 5 | 27 → 22 | 1 → 1 |  |
| A-01 | cold | 4 → 5 | 4 → 5 | 60 → 11 | 1 → 1 |  |
| H-DP-02 | cold | 3 → 4 | 3 → 5 | 150 → 88 | 2 → 1 | padded |
| T-08 | cold | 2 → 3 | 2 → 3 | 107 → 211 | 3 → 5 | wrong_entity, format_broken |
| A-09 | cold | 2 → 3 | 2 → 4 | 386 → 43 | 10 → 1 | missed_facet, assumption_not_stated |
| V-06 | cold | 2 → 3 | 4 → 4 | 244 → 170 | 20 → 5 | over_investigated, padded, assumption_not_stated, format_broken |
| X-04 | cold | 2 → 3 | 2 → 3 | 113 → 332 | 4 → 5 | missed_facet |
| V-04 | cold | 3 → 4 | 3 → 5 | 521 → 310 | 11 → 11 | over_investigated, padded |
| X-08 | cold | 4 → 5 | 4 → 5 | 41 → 29 | 1 → 1 |  |
| X-19 | cold | 3 → 4 | 3 → 5 | 93 → 100 | 4 → 3 | padded |
| V-02 | cold | 3 → 5 | 4 → 5 | 13 → 37 | 1 → 1 |  |