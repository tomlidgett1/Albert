# ADR 0015: Compiler ordering proof and authority-scoped provenance

- Status: Accepted
- Date: 2026-08-03
- Owners: Albert engineering
- Related: ADR 0001, ADR 0009, ADR 0011

## Context

Albert returns bounded query windows, but a row being the largest or smallest
inside a returned window does not by itself prove that it is the global extreme
for the governed query population. A model could otherwise call an unsorted or
differently sorted query with `LIMIT`, inspect only those rows, and make an
unsupported “highest” or “lowest” claim.

Tenant context can contain many connected systems. Applying every connection's
watermark and pack version to every semantic result lets an unrelated stale
connection qualify an otherwise current answer, exposes non-contributing source
labels, and invalidates caches for changes that cannot affect the query.

Source exploration also needs to distinguish the records requested from the
freshness of the selected connection. A watermark describes when ingestion last
advanced; it is not the query's time filter and must not be presented as one.

## Decision

### Compiler-issued rank evidence

- Every compiled semantic plan records a `resultWindow` containing the requested
  limit, the resolved output-column ordering, and the invariant that the
  outermost `ORDER BY` executes before `LIMIT`.
- The semantic service serialises that compiler-owned proof through its signed
  response contract. The conversation adapter rejects proofs that reference an
  absent column or claim fewer rows than were returned.
- “Highest” and “lowest” claims fail closed unless the referenced numeric column
  is the primary ordered column, the direction is respectively descending or
  ascending, the compiler ordering preceded the limit, and the selected value
  is the corresponding extreme among returned non-null numeric cells.
- The rank is global only within the exact governed query population: its tenant,
  filters, resolved period, dimensions, and metric definition.

### Authority-scoped bundles, freshness, and provenance

- Determine contributing authority concepts from every compiled metric plus the
  recursively referenced metric dependencies recorded by validation evidence.
- Resolve those concepts through the server-owned tenant authority overlay, then
  deduplicate the authoritative connection IDs.
- Use only those connections' watermarks and connector pack versions in the
  semantic bundle hash and freshness checks. Emit only those connections in
  tenant-visible source watermarks and source details.
- Missing authority selection, connection metadata, pack version, watermark, or
  a source-detail/watermark timestamp mismatch blocks verified output.
- A change to an unrelated connection therefore does not change the result ID,
  cache key, freshness state, or displayed source lineage.

### Source-exploration periods

- Source exploration accepts period provenance from at most one allowlisted
  `date` or `timestamp` field and resolves contiguous `eq`, `gt`, `gte`, `lt`,
  and `lte` constraints before execution.
- Date values must be valid `YYYY-MM-DD` values. Timestamp values must be valid
  RFC 3339 values with an explicit UTC offset. Non-contiguous time predicates or
  filters across multiple time fields are rejected because one displayed range
  could not represent them truthfully.
- An unbounded source query is labelled as all retained source records and uses
  explicit open interval bounds. It does not borrow a freshness timestamp.
- The selected connection's exact watermark is emitted separately as
  `dataThrough`. A missing or invalid selected-source watermark fails closed;
  Albert never substitutes another connection's watermark or the current time.
- Source bundle hashes include only the selected connection watermark and the
  active connector-pack version proven by the allowlisted catalogue.

## Consequences

### Positive

- Bounded tables can support truthful global rank language without loading every
  row into the model context.
- Narrative grounding remains deterministic across fresh and cached executions.
- Freshness, cache invalidation, and visible lineage track only data capable of
  changing the answer.
- Query periods and ingestion freshness have distinct, auditable meanings.

### Costs and constraints

- Queries intended to support rank language must explicitly sort the claimed
  metric in the required direction; otherwise the agent must use non-ranking
  wording or issue another governed query.
- Metric dependency authority is part of result identity, so registry dependency
  changes can intentionally alter bundle hashes and verification requirements.
- Source time predicates that cannot be represented as one interval require a
  semantic promotion or multiple separately labelled source queries.

## Tests

- `tests/contracts/structured-claim-grounding.contract.test.ts` proves limited
  results cannot support rank language without matching compiler evidence.
- `tests/contracts/semantic-query-invariants.contract.test.ts` proves ordering
  survives the compiler/service boundary, recursive authority dependencies are
  enforced, unrelated stale systems do not qualify or invalidate an answer, and
  composite provenance includes every contributing source.
- `tests/contracts/source-exploration-security.contract.test.ts` proves source
  filter periods are resolved independently from watermarks, non-contiguous time
  filters fail closed, source provenance contains one connection, and no
  selected-source watermark fallback exists.
- `evals/runner.ts` independently reconstructs authority-scoped golden bundle
  hashes; the full deterministic eval suite must remain reproducible.

## Alternatives considered

- Compare only the rows returned by `LIMIT`: rejected because it proves a local
  window extreme, not a global query extreme.
- Include every tenant connection in all bundle hashes and provenance: rejected
  because unrelated systems cannot contribute to or invalidate a result.
- Reuse the latest available watermark as a source-query period or fallback:
  rejected because it conflates record selection with ingestion freshness and
  can attribute one connection's state to another.
