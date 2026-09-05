# Albert eval — before/after: `baseline` → `improved`

Paired turns: 250

## By interaction class

| group | n | pass before → after | overall | correctness | detail | format | p50 s | p95 s | mean q/turn |
|---|---:|---|---|---|---|---|---|---|---|
| chart_reformat | 20 | 75% → 75% | 3.45 → 3.80 | 4.15 → 4.35 | 3.25 → 3.55 | 3.60 → 3.65 | 49 → 11 | 249 → 93 | 2.5 → 0.4 |
| cold_multi_tool | 28 | 32% → 36% | 2.54 → 2.75 | 2.54 → 2.86 | 2.46 → 2.75 | 3.36 → 3.18 | 237 → 129 | 753 → 780 | 5.6 → 4.8 |
| cold_single_tool | 162 | 51% → 69% | 3.12 → 3.55 | 3.60 → 4.06 | 2.70 → 3.22 | 3.17 → 3.48 | 106 → 38 | 780 → 676 | 3.2 → 1.8 |
| drilldown | 16 | 50% → 44% | 3.25 → 3.19 | 3.56 → 3.31 | 3.00 → 3.00 | 3.63 → 3.56 | 101 → 61 | 780 → 780 | 4.3 → 1.6 |
| followup | 12 | 75% → 75% | 3.50 → 3.67 | 4.33 → 4.25 | 3.00 → 4.00 | 3.50 → 3.58 | 183 → 23 | 780 → 780 | 3.2 → 1.0 |
| meta | 12 | 8% → 33% | 2.08 → 3.00 | 2.58 → 3.08 | 1.50 → 3.08 | 2.42 → 4.17 | 62 → 7 | 632 → 625 | 4.1 → 0.4 |
| **all** | 250 | 50% → 63% | 3.06 → 3.44 | 3.51 → 3.86 | 2.69 → 3.21 | 3.24 → 3.50 | 112 → 39 | 780 → 708 | 3.5 → 1.9 |

## By difficulty tier

| group | n | pass before → after | overall | correctness | detail | format | p50 s | p95 s | mean q/turn |
|---|---:|---|---|---|---|---|---|---|---|
| ambiguous | 14 | 29% → 57% | 2.93 → 3.43 | 3.86 → 4.07 | 2.00 → 3.43 | 3.43 → 3.57 | 292 → 15 | 753 → 780 | 7.6 → 1.5 |
| easy | 48 | 67% → 79% | 3.33 → 3.69 | 3.81 → 4.23 | 3.06 → 3.56 | 3.23 → 3.58 | 40 → 15 | 780 → 464 | 2.1 → 1.4 |
| hard | 46 | 33% → 39% | 2.72 → 2.89 | 2.98 → 3.04 | 2.35 → 2.41 | 3.13 → 3.00 | 180 → 148 | 780 → 780 | 3.6 → 2.8 |
| medium | 104 | 61% → 76% | 3.33 → 3.77 | 3.90 → 4.37 | 2.94 → 3.52 | 3.34 → 3.70 | 95 → 24 | 657 → 161 | 3.0 → 1.2 |
| meta | 12 | 8% → 33% | 2.08 → 3.00 | 2.58 → 3.08 | 1.50 → 3.08 | 2.42 → 4.17 | 62 → 7 | 632 → 625 | 4.1 → 0.4 |
| xhard | 26 | 35% → 38% | 2.58 → 2.81 | 2.58 → 2.85 | 2.54 → 2.69 | 3.31 → 3.08 | 227 → 154 | 609 → 780 | 5.3 → 5.1 |
| **all** | 250 | 50% → 63% | 3.06 → 3.44 | 3.51 → 3.86 | 2.69 → 3.21 | 3.24 → 3.50 | 112 → 39 | 780 → 708 | 3.5 → 1.9 |

## By tool scope

| group | n | pass before → after | overall | correctness | detail | format | p50 s | p95 s | mean q/turn |
|---|---:|---|---|---|---|---|---|---|---|
| deputy | 49 | 76% → 80% | 3.76 → 3.76 | 4.35 → 4.45 | 3.41 → 3.47 | 3.82 → 3.65 | 63 → 22 | 248 → 143 | 2.7 → 1.6 |
| lightspeed | 112 | 47% → 65% | 2.96 → 3.46 | 3.49 → 3.96 | 2.60 → 3.19 | 2.96 → 3.36 | 122 → 38 | 780 → 780 | 3.1 → 1.4 |
| meta | 12 | 8% → 33% | 2.08 → 3.00 | 2.58 → 3.08 | 1.50 → 3.08 | 2.42 → 4.17 | 62 → 7 | 632 → 625 | 4.1 → 0.4 |
| multi | 28 | 32% → 36% | 2.54 → 2.75 | 2.54 → 2.86 | 2.46 → 2.75 | 3.36 → 3.18 | 237 → 129 | 753 → 780 | 5.6 → 4.8 |
| xero | 49 | 49% → 63% | 3.12 → 3.57 | 3.51 → 3.82 | 2.61 → 3.31 | 3.41 → 3.69 | 103 → 39 | 281 → 327 | 3.8 → 2.2 |
| **all** | 250 | 50% → 63% | 3.06 → 3.44 | 3.51 → 3.86 | 2.69 → 3.21 | 3.24 → 3.50 | 112 → 39 | 780 → 708 | 3.5 → 1.9 |

## By interaction pattern

| group | n | pass before → after | overall | correctness | detail | format | p50 s | p95 s | mean q/turn |
|---|---:|---|---|---|---|---|---|---|---|
| chart_reformat | 20 | 75% → 75% | 3.45 → 3.80 | 4.15 → 4.35 | 3.25 → 3.55 | 3.60 → 3.65 | 49 → 11 | 249 → 93 | 2.5 → 0.4 |
| cold | 202 | 46% → 62% | 2.98 → 3.41 | 3.40 → 3.83 | 2.59 → 3.15 | 3.15 → 3.48 | 137 → 44 | 780 → 708 | 3.6 → 2.1 |
| drilldown | 16 | 50% → 44% | 3.25 → 3.19 | 3.56 → 3.31 | 3.00 → 3.00 | 3.63 → 3.56 | 101 → 61 | 780 → 780 | 4.3 → 1.6 |
| followup | 12 | 75% → 75% | 3.50 → 3.67 | 4.33 → 4.25 | 3.00 → 4.00 | 3.50 → 3.58 | 183 → 23 | 780 → 780 | 3.2 → 1.0 |
| **all** | 250 | 50% → 63% | 3.06 → 3.44 | 3.51 → 3.86 | 2.69 → 3.21 | 3.24 → 3.50 | 112 → 39 | 780 → 708 | 3.5 → 1.9 |

## Failure tags before → after

| tag | before | after |
|---|---:|---:|
| padded | 153 | 132 |
| missed_facet | 50 | 50 |
| over_investigated | 66 | 32 |
| unavailable_or_error | 47 | 27 |
| format_broken | 24 | 24 |
| timeout | 27 | 20 |
| unsupported_number | 18 | 17 |
| wrong_number | 17 | 14 |
| wrong_entity | 15 | 14 |
| no_chart_when_needed | 16 | 3 |
| re_ran_pipeline_for_reformat | 15 | 3 |
| table_missing | 13 | 5 |
| wrong_period | 8 | 9 |
| assumption_not_stated | 6 | 11 |
| chart_when_not_needed | 8 | 7 |
| methodology_dump | 12 | 1 |
| false_zero | 8 | 4 |
| reformat_not_applied | 4 | 3 |
| too_thin | 1 | 6 |
| stale_data_claim | 3 | 4 |
| wrong_chart_type | 3 | 1 |
| hallucinated_source | 3 | 0 |
| ignored_prior_result | 1 | 1 |
| did_not_use_conversation_context | 0 | 2 |
| not_connected_not_disclosed | 1 | 0 |

## Per-turn deltas (regressions first)

| id | pattern | overall before → after | correct | s before → after | q | tags after |
|---|---|---|---|---|---|---|
| X-15 | cold | 5 → 1 | 5 → 1 | 237 → 691 | 8 → 3 | unsupported_number, wrong_entity, missed_facet, unavailable_or_error, assumption_not_stated |
| D-01b | drilldown | 4 → 1 | 5 → 1 | 495 → 780 | 3 → ? | unavailable_or_error, timeout |
| M-DP-05 | cold | 4 → 1 | 5 → 1 | 30 → 52 | 1 → 2 | wrong_entity |
| T-08 | cold | 4 → 1 | 4 → 1 | 42 → 8 | 1 → 0 | too_thin, unavailable_or_error |
| X-16 | cold | 5 → 2 | 5 → 2 | 280 → 49 | 4 → 2 | wrong_number, missed_facet, format_broken |
| C-04a | cold | 4 → 2 | 4 → 2 | 237 → 87 | 3 → 3 | missed_facet, padded, format_broken |
| F-04b | followup | 4 → 2 | 5 → 2 | 225 → 14 | 9 → 1 | wrong_number, ignored_prior_result, did_not_use_conversation_context |
| E-LS-19 | cold | 4 → 2 | 5 → 1 | 13 → 17 | 1 → 1 | wrong_number |
| H-DP-05 | cold | 4 → 2 | 5 → 2 | 80 → 148 | 2 → 2 | wrong_number, unsupported_number, wrong_period, padded |
| H-LS-05 | cold | 3 → 1 | 3 → 1 | 704 → 263 | 3 → 3 | wrong_number, missed_facet, unavailable_or_error, timeout, format_broken |
| M-XR-03 | cold | 4 → 2 | 5 → 2 | 108 → 139 | 4 → 5 | missed_facet, padded |
| C-01c | chart_reformat | 4 → 3 | 5 → 3 | 29 → 32 | 1 → 1 | wrong_number, padded, format_broken |
| C-02a | cold | 2 → 1 | 2 → 1 | 403 → 19 | 6 → 1 | wrong_number, wrong_period, missed_facet |
| C-07b | chart_reformat | 3 → 2 | 4 → 2 | 112 → 223 | 1 → 3 | over_investigated, padded, re_ran_pipeline_for_reformat, reformat_not_applied, format_broken |
| C-08b | chart_reformat | 2 → 1 | 2 → 1 | 49 → 12 | 1 → 0 | no_chart_when_needed, reformat_not_applied |
| C-09b | chart_reformat | 4 → 3 | 5 → 5 | 57 → 10 | 1 → 0 | padded |
| D-02c | drilldown | 3 → 2 | 3 → 2 | 63 → 19 | 2 → 1 | missed_facet, table_missing, format_broken |
| D-04a | cold | 5 → 4 | 5 → 5 | 40 → 12 | 2 → 1 | format_broken |
| C-10a | cold | 4 → 3 | 5 → 5 | 344 → 52 | 4 → 2 | padded, format_broken |
| D-03b | drilldown | 4 → 3 | 5 → 2 | 103 → 52 | 3 → 1 | unsupported_number, padded |
| D-03c | drilldown | 5 → 4 | 5 → 5 | 10 → 72 | 0 → 2 | padded |
| D-07b | drilldown | 3 → 2 | 3 → 2 | 122 → 15 | 3 → 0 | missed_facet, too_thin |
| D-08b | drilldown | 4 → 3 | 5 → 3 | 146 → 327 | 6 → 5 | wrong_number, over_investigated, padded |
| F-02b | followup | 4 → 3 | 5 → 4 | 53 → 37 | 1 → 1 | format_broken |
| F-07a | cold | 5 → 4 | 5 → 5 | 77 → 21 | 3 → 1 | padded |
| A-11 | cold | 5 → 4 | 5 → 5 | 45 → 9 | 3 → 1 | padded |
| E-DP-01 | cold | 5 → 4 | 5 → 5 | 97 → 14 | 6 → 1 |  |
| E-DP-10 | cold | 5 → 4 | 5 → 5 | 27 → 16 | 1 → 1 |  |
| E-DP-12 | cold | 5 → 4 | 5 → 5 | 23 → 6 | 1 → 1 | padded |
| E-DP-14 | cold | 4 → 3 | 5 → 5 | 36 → 143 | 2 → 4 | over_investigated, padded |
| A-09 | cold | 2 → 1 | 3 → 1 | 593 → 780 | 25 → ? | over_investigated, padded, too_thin, timeout, assumption_not_stated, unavailable_or_error, format_broken |
| E-LS-10 | cold | 5 → 4 | 5 → 5 | 34 → 7 | 1 → 1 | padded |
| E-XR-03 | cold | 2 → 1 | 1 → 1 | 142 → 143 | 11 → 2 | wrong_entity |
| E-XR-14 | cold | 5 → 4 | 5 → 4 | 45 → 19 | 1 → 1 |  |
| H-DP-04 | cold | 5 → 4 | 5 → 4 | 125 → 109 | 3 → 2 | padded, chart_when_not_needed |
| H-LS-02 | cold | 4 → 3 | 5 → 2 | 453 → 714 | 7 → 9 | unsupported_number, over_investigated, padded, format_broken |
| H-LS-08 | cold | 2 → 1 | 2 → 1 | 355 → 118 | 7 → 0 | unavailable_or_error, timeout |
| H-XR-06 | cold | 3 → 2 | 3 → 2 | 137 → 39 | 6 → 1 | wrong_period, padded |
| H-XR-05 | cold | 3 → 2 | 3 → 1 | 281 → 150 | 2 → 1 | wrong_number, unsupported_number, wrong_entity, padded |
| M-DP-09 | cold | 4 → 3 | 5 → 5 | 30 → 102 | 2 → 3 | over_investigated, padded |
| M-DP-06 | cold | 4 → 3 | 5 → 3 | 237 → 44 | 4 → 1 | missed_facet, assumption_not_stated |
| M-XR-09 | cold | 4 → 3 | 5 → 2 | 35 → 22 | 1 → 1 | unsupported_number, padded |
| M-XR-08 | cold | 5 → 4 | 5 → 5 | 43 → 13 | 1 → 1 | padded, format_broken |
| M-XR-11 | cold | 4 → 3 | 5 → 2 | 30 → 60 | 1 → 2 | unsupported_number, padded |
| X-02 | cold | 2 → 1 | 1 → 1 | 151 → 176 | 7 → 6 | missed_facet, unavailable_or_error |
| X-03 | cold | 3 → 2 | 3 → 2 | 227 → 212 | 4 → 4 | wrong_entity, missed_facet, over_investigated, padded |
| X-17 | cold | 2 → 1 | 2 → 1 | 609 → 780 | 16 → ? | over_investigated, unavailable_or_error, timeout |
| C-03a | cold | 4 → 4 | 5 → 4 | 187 → 87 | 4 → 1 | missed_facet |
| C-03b | chart_reformat | 4 → 4 | 5 → 5 | 68 → 9 | 1 → 0 | padded |
| C-04b | chart_reformat | 4 → 4 | 5 → 5 | 28 → 18 | 1 → 1 | padded, re_ran_pipeline_for_reformat |
| C-03c | chart_reformat | 4 → 4 | 5 → 5 | 28 → 8 | 1 → 0 | padded |
| C-04c | chart_reformat | 4 → 4 | 5 → 5 | 31 → 28 | 1 → 1 | re_ran_pipeline_for_reformat |
| C-06a | cold | 3 → 3 | 2 → 3 | 61 → 18 | 1 → 1 | wrong_period, padded |
| C-07a | cold | 4 → 4 | 5 → 5 | 69 → 27 | 1 → 1 | padded |
| C-06c | chart_reformat | 4 → 4 | 5 → 5 | 25 → 10 | 1 → 0 | padded |
| C-02b | chart_reformat | 4 → 4 | 5 → 5 | 48 → 9 | 1 → 0 | padded |
| C-08a | cold | 4 → 4 | 4 → 5 | 74 → 10 | 2 → 1 | padded |
| C-08c | chart_reformat | 4 → 4 | 5 → 5 | 29 → 23 | 1 → 0 |  |
| C-05b | chart_reformat | 4 → 4 | 5 → 4 | 250 → 40 | 9 → 1 | padded, format_broken |
| C-09a | cold | 4 → 4 | 5 → 5 | 137 → 68 | 2 → 1 | padded |
| D-02a | cold | 4 → 4 | 5 → 5 | 53 → 15 | 2 → 1 | padded, format_broken |
| C-09c | chart_reformat | 4 → 4 | 5 → 5 | 56 → 93 | 1 → 1 | padded |
| D-02b | drilldown | 5 → 5 | 5 → 5 | 57 → 14 | 2 → 1 |  |
| D-04b | drilldown | 3 → 3 | 3 → 3 | 25 → 25 | 1 → 1 | missed_facet, padded |
| D-04c | drilldown | 3 → 3 | 3 → 3 | 52 → 63 | 1 → 2 | missed_facet |
| C-10c | chart_reformat | 4 → 4 | 5 → 5 | 249 → 8 | 16 → 0 | padded |
| D-06b | drilldown | 4 → 4 | 5 → 5 | 120 → 435 | 1 → 1 | padded |
| D-07a | cold | 4 → 4 | 5 → 5 | 32 → 24 | 1 → 1 | padded |
| D-06c | drilldown | 4 → 4 | 5 → 4 | 101 → 164 | 3 → 1 | padded |
| D-08a | cold | 4 → 4 | 5 → 5 | 119 → 11 | 4 → 1 | padded |
| D-07c | drilldown | 5 → 5 | 5 → 5 | 99 → 89 | 2 → 2 |  |
| F-01a | cold | 4 → 4 | 5 → 5 | 18 → 8 | 1 → 1 | padded |
| F-01b | followup | 4 → 4 | 5 → 5 | 64 → 23 | 1 → 1 | format_broken |
| F-02a | cold | 4 → 4 | 5 → 5 | 76 → 21 | 2 → 1 | no_chart_when_needed |
| D-08c | drilldown | 2 → 2 | 2 → 2 | 49 → 41 | 2 → 2 | wrong_entity, missed_facet |
| F-03a | cold | 4 → 4 | 5 → 5 | 28 → 15 | 1 → 1 | padded |
| F-03b | followup | 4 → 4 | 5 → 5 | 26 → 11 | 1 → 1 |  |
| F-05a | cold | 4 → 4 | 5 → 4 | 40 → 21 | 2 → 1 |  |
| F-09a | cold | 3 → 3 | 2 → 4 | 9 → 399 | 1 → 10 | missed_facet, over_investigated, padded |
| F-09b | followup | 4 → 4 | 5 → 4 | 183 → 163 | 3 → 1 | missed_facet, format_broken |
| F-11a | cold | 4 → 4 | 5 → 5 | 90 → 45 | 1 → 1 | padded |
| F-10a | cold | 5 → 5 | 5 → 5 | 248 → 16 | 4 → 1 |  |
| F-10b | followup | 5 → 5 | 5 → 5 | 135 → 22 | 1 → 1 |  |
| F-12a | cold | 4 → 4 | 5 → 5 | 29 → 10 | 1 → 1 | padded |
| F-12b | followup | 4 → 4 | 5 → 5 | 325 → 9 | 1 → 1 | padded |
| F-06b | followup | 4 → 4 | 5 → 5 | 541 → 18 | 1 → 0 |  |
| A-06 | cold | 4 → 4 | 5 → 5 | 21 → 47 | 1 → 1 | padded |
| A-07 | cold | 4 → 4 | 5 → 4 | 63 → 20 | 1 → 1 | assumption_not_stated |
| F-11b | followup | 1 → 1 | 1 → 1 | 780 → 780 | ? → ? | unavailable_or_error, timeout |
| A-04 | cold | 2 → 2 | 2 → 4 | 307 → 27 | 7 → 1 | assumption_not_stated |
| E-DP-03 | cold | 4 → 4 | 5 → 5 | 18 → 6 | 1 → 1 | padded |
| E-DP-04 | cold | 4 → 4 | 5 → 5 | 22 → 9 | 1 → 1 |  |
| A-14 | cold | 3 → 3 | 5 → 4 | 257 → 29 | 6 → 1 | no_chart_when_needed, assumption_not_stated |
| E-DP-06 | cold | 4 → 4 | 5 → 5 | 17 → 5 | 1 → 1 | padded |
| E-DP-05 | cold | 4 → 4 | 5 → 5 | 23 → 15 | 1 → 1 | padded |
| E-DP-09 | cold | 4 → 4 | 5 → 4 | 29 → 14 | 2 → 1 | stale_data_claim, padded |
| E-DP-08 | cold | 2 → 2 | 1 → 2 | 34 → 132 | 1 → 7 | wrong_entity, stale_data_claim, over_investigated |
| E-DP-07 | cold | 4 → 4 | 5 → 5 | 40 → 12 | 1 → 1 | padded |
| E-DP-11 | cold | 4 → 4 | 5 → 5 | 21 → 6 | 1 → 1 | padded |
| E-DP-13 | cold | 4 → 4 | 5 → 5 | 24 → 43 | 2 → 3 | over_investigated, padded |
| E-LS-01 | cold | 4 → 4 | 5 → 5 | 20 → 8 | 1 → 1 | padded |
| A-12 | cold | 3 → 3 | 5 → 5 | 387 → 10 | 4 → 1 | missed_facet, too_thin, assumption_not_stated |
| E-LS-03 | cold | 4 → 4 | 5 → 5 | 19 → 8 | 1 → 1 | padded |
| E-LS-05 | cold | 4 → 4 | 4 → 5 | 41 → 23 | 1 → 1 | padded |
| E-LS-07 | cold | 5 → 5 | 5 → 5 | 46 → 44 | 1 → 1 |  |
| E-LS-11 | cold | 4 → 4 | 5 → 5 | 13 → 111 | 1 → 1 |  |
| A-13 | cold | 2 → 2 | 2 → 2 | 753 → 15 | 12 → 1 | missed_facet, assumption_not_stated |
| E-LS-17 | cold | 4 → 4 | 5 → 5 | 53 → 147 | 2 → 1 | padded |
| E-LS-14 | cold | 4 → 4 | 5 → 5 | 404 → 77 | 6 → 1 | padded |
| E-XR-01 | cold | 4 → 4 | 5 → 4 | 175 → 9 | 8 → 1 | padded |
| E-XR-07 | cold | 1 → 1 | 1 → 1 | 9 → 242 | 0 → 4 | missed_facet, over_investigated, padded, methodology_dump, table_missing, unavailable_or_error |
| E-LS-13 | cold | 1 → 1 | 1 → 1 | 780 → 117 | ? → 1 | unavailable_or_error, timeout, false_zero |
| E-XR-10 | cold | 4 → 4 | 5 → 5 | 71 → 12 | 2 → 1 |  |
| E-XR-09 | cold | 4 → 4 | 5 → 5 | 52 → 16 | 1 → 1 | padded |
| E-XR-11 | cold | 4 → 4 | 5 → 5 | 57 → 11 | 1 → 1 | padded |
| E-LS-16 | cold | 1 → 1 | 1 → 1 | 780 → 637 | ? → 0 | unavailable_or_error, timeout |
| E-LS-20 | cold | 1 → 1 | 1 → 1 | 699 → 780 | 3 → 4 | wrong_period, missed_facet, over_investigated, unavailable_or_error, timeout, format_broken |
| H-DP-07 | cold | 4 → 4 | 5 → 5 | 153 → 37 | 2 → 2 | padded, chart_when_not_needed |
| H-LS-06 | cold | 3 → 3 | 5 → 4 | 479 → 285 | 2 → 3 | missed_facet, over_investigated, padded, chart_when_not_needed |
| H-LS-04 | cold | 1 → 1 | 1 → 1 | 780 → 676 | ? → 1 | wrong_period, missed_facet, too_thin, unavailable_or_error, timeout |
| H-LS-12 | cold | 3 → 3 | 3 → 3 | 231 → 544 | 2 → 7 | wrong_number, unsupported_number, over_investigated, padded |
| H-LS-07 | cold | 1 → 1 | 1 → 1 | 780 → 158 | ? → 0 | unavailable_or_error, timeout |
| H-LS-15 | cold | 4 → 4 | 5 → 4 | 292 → 81 | 5 → 2 | missed_facet, padded |
| H-LS-09 | cold | 1 → 1 | 1 → 1 | 780 → 129 | ? → 0 | unavailable_or_error, timeout, table_missing |
| H-LS-10 | cold | 1 → 1 | 1 → 1 | 780 → 780 | ? → ? | unavailable_or_error, timeout, table_missing |
| H-LS-11 | cold | 1 → 1 | 1 → 1 | 780 → 780 | ? → ? | missed_facet, too_thin, unavailable_or_error, timeout |
| H-XR-01 | cold | 4 → 4 | 4 → 5 | 112 → 226 | 8 → 8 | over_investigated, padded |
| H-XR-04 | cold | 3 → 3 | 3 → 3 | 181 → 342 | 11 → 16 | wrong_entity, missed_facet, over_investigated, padded |
| H-LS-14 | cold | 1 → 1 | 1 → 1 | 780 → 155 | ? → 0 | unavailable_or_error, timeout |
| H-XR-07 | cold | 4 → 4 | 5 → 5 | 158 → 269 | 2 → 8 | over_investigated, padded |
| M-DP-07 | cold | 4 → 4 | 5 → 5 | 101 → 52 | 2 → 1 | padded |
| M-DP-03 | cold | 4 → 4 | 5 → 5 | 488 → 12 | 5 → 1 |  |
| M-LS-07 | cold | 4 → 4 | 5 → 5 | 93 → 24 | 2 → 1 | padded |
| M-LS-08 | cold | 4 → 4 | 5 → 5 | 101 → 119 | 2 → 4 |  |
| M-LS-12 | cold | 5 → 5 | 5 → 5 | 21 → 21 | 1 → 1 |  |
| M-LS-13 | cold | 4 → 4 | 5 → 4 | 58 → 61 | 2 → 1 | missed_facet, padded |
| M-LS-06 | cold | 3 → 3 | 3 → 4 | 275 → 38 | 4 → 1 | missed_facet |
| M-LS-16 | cold | 4 → 4 | 5 → 5 | 79 → 27 | 1 → 1 | padded |
| M-XR-04 | cold | 3 → 3 | 4 → 4 | 186 → 12 | 5 → 1 | missed_facet, format_broken |
| M-LS-15 | cold | 1 → 1 | 1 → 1 | 657 → 130 | 0 → 0 | unavailable_or_error, timeout |
| M-XR-05 | cold | 4 → 4 | 5 → 5 | 280 → 50 | 2 → 1 | padded, format_broken |
| M-LS-17 | cold | 1 → 1 | 1 → 1 | 780 → 780 | ? → ? | unavailable_or_error, timeout, table_missing |
| M-XR-12 | cold | 4 → 4 | 5 → 4 | 177 → 19 | 7 → 1 | missed_facet |
| T-10 | cold | 1 → 1 | 1 → 1 | 62 → 84 | 2 → 3 | wrong_entity, false_zero, stale_data_claim, missed_facet, padded, assumption_not_stated, unavailable_or_error |
| T-02 | cold | 3 → 3 | 3 → 3 | 270 → 18 | 4 → 0 | stale_data_claim, unsupported_number |
| X-05 | cold | 4 → 4 | 5 → 5 | 77 → 33 | 2 → 2 | padded |
| T-12 | cold | 3 → 3 | 5 → 5 | 271 → 41 | 7 → 1 | over_investigated, padded |
| X-06 | cold | 2 → 2 | 2 → 2 | 150 → 154 | 8 → 8 | unsupported_number, false_zero, missed_facet, over_investigated, padded, unavailable_or_error |
| X-07 | cold | 4 → 4 | 5 → 5 | 323 → 176 | 11 → 10 | over_investigated, padded |
| T-09 | cold | 1 → 1 | 1 → 1 | 632 → 625 | 0 → 1 | unavailable_or_error, timeout, format_broken |
| X-09 | cold | 2 → 2 | 1 → 2 | 526 → 193 | 8 → 4 | unsupported_number, missed_facet, over_investigated, padded |
| X-19 | cold | 4 → 4 | 4 → 4 | 199 → 111 | 3 → 5 | missed_facet, padded |
| X-21 | cold | 4 → 4 | 5 → 4 | 145 → 129 | 4 → 4 | padded |
| X-18 | cold | 4 → 4 | 4 → 4 | 338 → 241 | 4 → 7 | over_investigated, padded |
| X-14 | cold | 1 → 1 | 1 → 1 | 780 → 780 | ? → ? | missed_facet, unavailable_or_error, timeout |
| X-20 | cold | 1 → 1 | 1 → 1 | 459 → 780 | 1 → ? | over_investigated, unavailable_or_error, timeout |
| X-24 | cold | 2 → 2 | 2 → 2 | 392 → 214 | 10 → 3 | unsupported_number, wrong_entity, missed_facet, wrong_chart_type, assumption_not_stated |
| X-23 | cold | 1 → 1 | 1 → 1 | 478 → 631 | 3 → 4 | false_zero, missed_facet, over_investigated, padded, assumption_not_stated, unavailable_or_error |
| C-01b | chart_reformat | 4 → 5 | 4 → 5 | 79 → 8 | 2 → 0 |  |
| C-05a | cold | 3 → 4 | 2 → 4 | 50 → 16 | 2 → 1 |  |
| C-06b | chart_reformat | 4 → 5 | 5 → 5 | 16 → 11 | 1 → 0 |  |
| C-02c | chart_reformat | 1 → 2 | 1 → 2 | 30 → 14 | 1 → 0 | reformat_not_applied |
| C-05c | chart_reformat | 4 → 5 | 4 → 5 | 55 → 9 | 1 → 0 |  |
| D-01a | cold | 3 → 4 | 3 → 4 | 338 → 80 | 6 → 1 | missed_facet |
| D-06a | cold | 4 → 5 | 5 → 5 | 25 → 16 | 1 → 1 |  |
| F-04a | cold | 3 → 4 | 5 → 4 | 52 → 6 | 3 → 1 | padded |
| F-05b | followup | 3 → 4 | 5 → 5 | 216 → 87 | 7 → 3 | padded |
| F-08a | cold | 4 → 5 | 5 → 5 | 34 → 8 | 2 → 1 |  |
| F-07b | followup | 4 → 5 | 5 → 5 | 101 → 28 | 6 → 1 |  |
| F-06a | cold | 3 → 4 | 3 → 4 | 414 → 29 | 5 → 1 | missed_facet |
| D-01c | drilldown | 1 → 2 | 1 → 2 | 780 → 61 | ? → 2 | wrong_entity, missed_facet, padded, did_not_use_conversation_context |
| A-03 | cold | 4 → 5 | 5 → 5 | 36 → 18 | 1 → 1 |  |
| A-08 | cold | 3 → 4 | 4 → 5 | 193 → 13 | 6 → 1 | padded |
| A-05 | cold | 3 → 4 | 3 → 5 | 522 → 59 | 7 → 2 | padded |
| A-10 | cold | 2 → 3 | 2 → 2 | 292 → 6 | 17 → 1 | wrong_number |
| E-DP-02 | cold | 4 → 5 | 5 → 5 | 43 → 23 | 1 → 1 |  |
| E-LS-02 | cold | 4 → 5 | 5 → 5 | 21 → 9 | 1 → 1 |  |
| E-LS-09 | cold | 4 → 5 | 5 → 5 | 22 → 8 | 1 → 1 |  |
| E-LS-04 | cold | 4 → 5 | 5 → 5 | 127 → 13 | 1 → 1 |  |
| E-LS-12 | cold | 4 → 5 | 4 → 5 | 23 → 7 | 1 → 1 |  |
| E-LS-15 | cold | 3 → 4 | 3 → 5 | 33 → 464 | 1 → 1 | padded |
| E-XR-02 | cold | 3 → 4 | 5 → 5 | 263 → 6 | 14 → 1 | padded |
| E-XR-06 | cold | 1 → 2 | 1 → 1 | 49 → 46 | 0 → 1 | wrong_period |
| E-XR-12 | cold | 4 → 5 | 5 → 5 | 58 → 12 | 2 → 1 |  |
| H-DP-01 | cold | 3 → 4 | 4 → 5 | 180 → 320 | 6 → 7 | over_investigated, padded |
| H-DP-03 | cold | 3 → 4 | 3 → 5 | 171 → 56 | 2 → 1 | padded |
| H-LS-03 | cold | 1 → 2 | 1 → 1 | 780 → 708 | ? → 4 | wrong_number, unsupported_number, missed_facet, padded |
| M-DP-02 | cold | 4 → 5 | 4 → 5 | 115 → 20 | 3 → 1 |  |
| H-XR-08 | cold | 2 → 3 | 2 → 3 | 187 → 223 | 1 → 3 | padded, format_broken |
| M-DP-01 | cold | 3 → 4 | 4 → 5 | 191 → 51 | 3 → 2 | padded |
| M-DP-04 | cold | 3 → 4 | 4 → 5 | 141 → 87 | 7 → 2 | padded, chart_when_not_needed |
| M-DP-10 | cold | 3 → 4 | 5 → 5 | 162 → 52 | 12 → 1 | padded |
| M-LS-03 | cold | 3 → 4 | 4 → 5 | 106 → 29 | 2 → 1 | padded |
| M-LS-09 | cold | 4 → 5 | 5 → 5 | 62 → 16 | 2 → 1 | format_broken |
| M-LS-10 | cold | 3 → 4 | 3 → 5 | 98 → 49 | 2 → 1 | padded |
| M-LS-02 | cold | 3 → 4 | 2 → 5 | 474 → 39 | 6 → 1 | padded |
| M-LS-18 | cold | 3 → 4 | 2 → 5 | 130 → 58 | 1 → 1 | padded, chart_when_not_needed |
| M-XR-07 | cold | 4 → 5 | 5 → 5 | 82 → 15 | 1 → 1 |  |
| T-05 | cold | 3 → 4 | 4 → 4 | 89 → 5 | 2 → 0 | missed_facet |
| T-04 | cold | 2 → 3 | 3 → 3 | 244 → 10 | 24 → 0 | unsupported_number, missed_facet |
| T-11 | cold | 2 → 3 | 2 → 2 | 152 → 6 | 7 → 0 | wrong_entity, missed_facet |
| X-01 | cold | 2 → 3 | 2 → 2 | 145 → 80 | 4 → 2 | wrong_number, wrong_entity |
| X-10 | cold | 4 → 5 | 5 → 5 | 73 → 52 | 4 → 2 |  |
| X-04 | cold | 2 → 3 | 2 → 3 | 321 → 343 | 7 → 14 | missed_facet, over_investigated, padded |
| X-13 | cold | 4 → 5 | 4 → 5 | 162 → 73 | 4 → 2 |  |
| X-11 | cold | 2 → 3 | 2 → 3 | 491 → 548 | 5 → 8 | missed_facet, over_investigated |
| X-25 | cold | 1 → 2 | 1 → 2 | 191 → 113 | 9 → 2 | wrong_period, missed_facet, over_investigated |
| C-01a | cold | 2 → 4 | 2 → 5 | 164 → 23 | 3 → 1 | padded |
| D-05a | cold | 1 → 3 | 1 → 4 | 222 → 135 | 14 → 3 | over_investigated, padded |
| A-02 | cold | 2 → 4 | 5 → 5 | 416 → 9 | 7 → 1 | padded |
| E-LS-18 | cold | 2 → 4 | 2 → 4 | 189 → 21 | 5 → 1 | missed_facet |
| E-XR-04 | cold | 2 → 4 | 1 → 5 | 28 → 11 | 1 → 1 | padded |
| E-XR-05 | cold | 1 → 3 | 1 → 4 | 20 → 132 | 0 → 3 | missed_facet |
| E-XR-08 | cold | 2 → 4 | 2 → 5 | 40 → 7 | 2 → 1 | padded |
| H-DP-02 | cold | 1 → 3 | 1 → 3 | 182 → 139 | 8 → 2 | wrong_number, unsupported_number, padded, format_broken |
| H-DP-06 | cold | 2 → 4 | 2 → 5 | 164 → 44 | 2 → 1 | padded |
| H-LS-01 | cold | 1 → 3 | 1 → 3 | 780 → 267 | ? → 2 | missed_facet, padded, format_broken |
| H-XR-02 | cold | 2 → 4 | 2 → 4 | 73 → 135 | 2 → 2 | unsupported_number, padded |
| M-LS-01 | cold | 3 → 5 | 5 → 5 | 33 → 14 | 1 → 1 |  |
| M-LS-05 | cold | 2 → 4 | 2 → 5 | 100 → 52 | 3 → 1 | padded |
| M-LS-11 | cold | 2 → 4 | 2 → 5 | 95 → 115 | 1 → 2 | padded |
| M-XR-01 | cold | 3 → 5 | 4 → 5 | 294 → 14 | 9 → 1 |  |
| M-XR-06 | cold | 2 → 4 | 1 → 5 | 183 → 38 | 3 → 1 | padded |
| M-LS-14 | cold | 1 → 3 | 1 → 5 | 780 → 161 | ? → 1 | padded, chart_when_not_needed |
| T-01 | cold | 1 → 3 | 1 → 3 | 33 → 6 | 0 → 0 |  |
| T-03 | cold | 3 → 5 | 5 → 5 | 38 → 7 | 2 → 0 |  |
| X-08 | cold | 2 → 4 | 1 → 4 | 43 → 53 | 1 → 2 | padded |
| X-12 | cold | 1 → 3 | 1 → 2 | 537 → 69 | 2 → 2 | wrong_period, padded |
| C-07c | chart_reformat | 2 → 5 | 2 → 5 | 67 → 12 | 1 → 0 |  |
| D-03a | cold | 2 → 5 | 2 → 5 | 247 → 25 | 7 → 1 |  |
| D-05b | drilldown | 1 → 4 | 1 → 5 | 322 → 61 | 13 → 2 | padded |
| D-05c | drilldown | 1 → 4 | 1 → 4 | 609 → 275 | 26 → 2 | wrong_entity |
| F-08b | followup | 1 → 4 | 1 → 5 | 780 → 94 | ? → 1 | padded |
| A-01 | cold | 2 → 5 | 3 → 5 | 479 → 12 | 9 → 1 |  |
| E-LS-06 | cold | 2 → 5 | 2 → 5 | 477 → 19 | 6 → 1 |  |
| E-LS-08 | cold | 1 → 4 | 1 → 5 | 780 → 15 | ? → 1 | padded |
| E-XR-13 | cold | 1 → 4 | 1 → 4 | 53 → 54 | 0 → 1 | unsupported_number |
| H-XR-03 | cold | 2 → 5 | 1 → 5 | 168 → 95 | 2 → 2 |  |
| H-LS-13 | cold | 1 → 4 | 1 → 5 | 780 → 759 | ? → 7 | over_investigated, padded |
| M-DP-11 | cold | 1 → 4 | 1 → 5 | 95 → 26 | 3 → 2 | padded |
| M-DP-08 | cold | 1 → 4 | 1 → 5 | 386 → 32 | 9 → 1 | padded |
| M-LS-04 | cold | 1 → 4 | 1 → 5 | 435 → 88 | 9 → 2 | over_investigated, padded |
| M-XR-02 | cold | 1 → 4 | 1 → 5 | 12 → 38 | 0 → 1 |  |
| M-LS-19 | cold | 1 → 4 | 1 → 5 | 780 → 59 | ? → 1 | padded |
| T-06 | cold | 1 → 4 | 1 → 4 | 51 → 7 | 0 → 0 | padded |
| M-XR-10 | cold | 2 → 5 | 2 → 5 | 273 → 66 | 8 → 2 |  |
| X-22 | cold | 2 → 5 | 1 → 5 | 97 → 85 | 2 → 2 |  |
| X-26 | cold | 1 → 4 | 1 → 5 | 145 → 68 | 6 → 3 | padded, chart_when_not_needed |
| C-10b | chart_reformat | 1 → 5 | 1 → 5 | 94 → 10 | 8 → 0 |  |
| T-07 | cold | 1 → 5 | 1 → 5 | 19 → 6 | 0 → 0 |  |