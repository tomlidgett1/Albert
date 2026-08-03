# ADR 0046: Content-addressed exact M6 answer acceptance

- Status: Accepted
- Date: 2026-08-04
- Owners: Albert agent runtime, semantic platform, and release engineering
- Supersedes in part: ADR 0035's M6 topic/count acceptance policy
- Relates to: ADR 0001, ADR 0012, ADR 0019, ADR 0033, ADR 0035

## Context

ADR 0035 accepted a finalized flagship artifact when it contained at least one
`workforce_labour` query and one `workforce_sales` composite, and accepted a
category artifact when it contained a caller-selected Topic. It counted tables,
narratives and charts and checked that visible provenance was present. That
proved a broad agent path, but it did not prove the two reviewed M6 questions.
An easier question, different period, different lens, partial IR, unrelated
table, or arbitrary chart could satisfy the same counts.

The control-plane artifact is already immutable and content-addressed, but a
release gate must independently recompute those addresses. A well-shaped
64-character string is not proof that a hand-inserted artifact was produced by
`finalize_answer_artifact`. The semantic result digest also uses the semantic
service's whitespace-free, recursively key-sorted JSON encoding, whereas the
control-plane evidence digest intentionally hashes PostgreSQL `jsonb::text`.
Those algorithms are not interchangeable.

Private model reasoning is neither a product surface nor acceptable audit
evidence. M6 must prove only Albert's ordered, user-visible execution narrative:
bounded progress and plan summaries, governed query calls, tables, named
validations, cell-grounded observations, charts, and the final answer.

## Decision

The control plane owns two versioned, content-addressed M6 case contracts in
`protected_dogfood_answer_case_contracts`. Collector inputs cannot redefine
them.

The flagship contract requires the exact founding question, the exact
three-option clarification, and one-use consumption of the `employee.net_sales`
option by the UI label `Net sales`. It requires:

- a `workforce_labour` roster query for `rostered_hours`, dimension `worker`,
  and the tenant-local `today` period;
- a `workforce_sales` aggregate-then-align query over the same canonical worker
  set, with independently aggregated `net_sales_ex_gst` and `worked_hours`;
- an absolute range whose end is exactly six calendar months after its start;
- an end instant within 36 hours of finalization, so “last” cannot be satisfied
  by an old six-month window;
- alignment on `worker`, ranking by the selected net-sales lens, and no extra
  subquery fields or connector-specific join path.

The category contract is the `sales-category` golden question. It requires the
entire normalized IR: `sales_performance`, `net_sales_ex_gst`, dimension
`product.category`, month to date, descending net sales, limit 20, and
`as_currently_classified`. The former caller-selected category Topic is rejected;
the only accepted Topic is `sales_performance`. Its resolved month-to-date
interval must contain finalization and end within 36 hours of it.

`dogfood_answer_artifact_evidence` now fails closed unless it can prove all of
the following:

1. Recompute the exact trace digest from ordered `answer_execution_events` and
   the exact artifact digest from the same canonical artifact document used by
   `finalize_answer_artifact`.
2. Match every ordered query event to the ordered immutable query audit object,
   including normalized IR, registry version, semantic bundle hash, compiler
   output hash, result digest, answer state, and validation.
3. Recompute each visible table's semantic `contentDigest({columns, rows})`
   using a database implementation of the semantic service's stable JSON
   encoding, and require it to equal that query's immutable result digest.
4. Require the table result id and provenance bundle hash to equal
   `semantic:<bundleHash>` and `<bundleHash>`, respectively. Require the exact
   runtime connector projections: `deputy` for the roster, `deputy` plus
   `lightspeed` for the composite, and `lightspeed` for category sales. These
   are the public trace identifiers emitted by `semantic-adapter`, not the pack
   key `lightspeed-r`.
5. Require a contiguous post-deployment public trace. Every query has the
   canonical pre-query progress event, then query, table, one or more named
   validations, and a later observation before another analytical artifact.
   The final answer is last. Every chart refers to an earlier table and real
   x/y columns.
6. Require final quantitative claims to reference existing row and column
   cells and include the reviewed metric. The final answer provenance must be
   exactly the last governed table's provenance; Verified cannot contain a
   warning, and Qualified must retain a durable qualification reason.
7. Reject any artifact that contains control-plane SQL or any trace field
   prohibited by the public-trace privacy contract.

The privacy-safe M6 snapshot contains only booleans, counts and hashes. In
addition to artifact and trace digests it carries the case-contract, question,
semantic-plan, trace-contract, provenance, and combined lineage-binding
digests. It never stores the live question, answer, rows, labels, tenant ids,
connection ids, or SQL in the promotion attestation. The strict Ed25519
attestation schema requires those binding fields, contract version 1, exactly
two flagship queries, and exactly one category query.

## Consequences

- A Topic-shaped mock flow, a different user question, an easier period, or an
  operator-selected lens cannot authorize M6.
- A visible table cannot be paired with an unrelated query receipt even when
  both bundle hashes are well formed; its ordered columns and rows must produce
  the analytical result digest.
- Flagship clarification is proven as a real prior immutable artifact and a
  one-use server-resolved option, not inferred from the answer prose.
- The gate validates public analytical narration without retaining or asking
  for private chain of thought.
- Deliberate changes to either question, IR, lens, trace contract, public
  connector projection, or digest algorithm require a reviewed migration,
  contract-version update, attestation update, and new protected acceptance run.

## Alternatives considered

- **Keep Topic and artifact counts:** rejected because unrelated or reduced
  analytical flows can share those properties.
- **Trust the stored artifact and trace digest strings:** rejected because the
  acceptance boundary must detect hand-inserted or incorrectly finalized rows.
- **Hash tables with `dogfood_evidence_sha256`:** rejected because PostgreSQL's
  rendered JSON contains formatting that differs from the semantic service's
  `stableStringify`; equal content would receive a different digest.
- **Store questions, rows, or narratives in the attestation:** rejected because
  the immutable control-plane artifacts and derived hashes prove the bindings
  without creating a second customer-data store.
- **Retain model reasoning as sequence evidence:** rejected because private
  reasoning is neither stable nor an approved Albert user-visible artifact.

## Verification

- `infra/migrations/control-plane/0063_m6_exact_answer_lineage_dogfood_gate.sql`
- `scripts/dogfood-acceptance-attestation.mjs`
- `tests/contracts/protected-dogfood-m6-lineage.contract.test.ts`
- `tests/contracts/dogfood-acceptance-attestation.contract.test.ts`
- `tests/sql/control-plane-protected-dogfood-m6-lineage.sql`
- `.github/workflows/ci.yml`
