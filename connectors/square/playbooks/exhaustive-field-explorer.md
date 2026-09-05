# Square exhaustive field explorer

Every Square stream stages the exact source object in `payload_json` and a
recursive `field_index`. The analytical view `source_square.sq_source_fields`
expands every scalar field occurrence (and explicit empty-container marker),
and Cube publishes it as
`square_source_explorer`.

Use it only when the requested concept is not already in a curated Square view:

1. Identify the Square stream or object type.
2. Discover/filter one exact `field_path`. Stable paths use `[]` for array
   positions; `field_ordinal_path` retains the concrete occurrence pointer.
3. Check `value_type` and select only the corresponding typed value member.
4. Aggregate only after the source field's grain and additivity are known.
5. Pair money minor units with currency; never assume two decimals.

`number_value` can represent identifiers, versions, rates, quantities, balances,
snapshots or money. Its numeric type does not make it additive. `json_value` is
the lossless scalar/empty-container fallback; it is not a licence to invent
undocumented joins. Nested object and array leaves receive their own paths.
Empty arrays/maps and explicit nulls remain indexed so “none returned” can be
distinguished from a missing stream.

Contact and team fields may contain PII. Prefer counts and grouping. Reveal a
specific contact value only for an explicit authorized tenant request.
