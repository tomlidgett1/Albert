/** Shared failure vocabulary for API-backed and subscription-backed graders. */
export const FAILURE_TAGS = [
  "wrong_number", "unsupported_number", "wrong_period", "wrong_entity", "false_zero", "stale_data_claim",
  "hallucinated_source", "missed_facet", "over_investigated", "padded", "too_thin", "jargon", "methodology_dump",
  "no_chart_when_needed", "chart_when_not_needed", "wrong_chart_type", "table_missing", "markdown_table",
  "unnecessary_clarification", "assumption_not_stated", "ignored_prior_result", "re_ran_pipeline_for_reformat",
  "reformat_not_applied", "did_not_use_conversation_context", "unavailable_or_error", "timeout", "escalated_needlessly",
  "not_connected_not_disclosed", "format_broken",
] as const;
