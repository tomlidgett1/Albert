# ADR 0005: Reviewed source-field disposition and raw-only retention

- Status: Accepted
- Date: 2026-08-03
- Owners: Albert engineering

## Context

Albert keeps immutable vendor responses for replay and lineage, but only reviewed,
typed fields may enter analytical staging. Connector APIs can add fields, vary the
capitalisation of documented names, or include presentation metadata whose shape
and privacy characteristics are not stable enough for analytics. Treating every
extra field as queryable would bypass the connector pack's semantic and PII review.
Treating every documented-but-opaque field as schema drift would instead quarantine
otherwise valid records and make normal vendor response variation an outage.

The V1 pack contract already requires every accessible field to be mapped to a
canonical model, admitted as a governed source extension, or intentionally
unsupported with a reason. The staging boundary needs to enforce those three
outcomes distinctly.

## Decision

- Each connector manifest is the only allowlist for typed staging. Canonical and
  governed-extension dispositions generate typed columns. Unsupported dispositions
  do not generate a column.
- A field explicitly marked unsupported is recognized during drift detection, so
  its presence does not quarantine an otherwise valid response. Its value remains
  available only in the immutable raw object and raw batch lineage.
- A field absent from all three reviewed dispositions is schema drift. The record
  is quarantined before either generic or physical typed staging is written.
- Vendor aliases are normalized to one reviewed field name before drift detection.
  Albert currently normalizes Deputy `ExternalId` to `ExternalID` and `Timezone` to
  `TimeZone`; both spellings therefore have the same disposition and typed column.
- Connector schemas remain permissive enough to capture additive response fields
  in raw storage, while normalization and typed projection remain fail closed.
- The complete top-level field catalogue for each shipped resource is checked in
  as reviewed source data and contract-tested against the manifest. Xero is pinned
  to immutable official Accounting OpenAPI revision
  `45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f`; Lightspeed R-Series is pinned to
  the official V3 documentation build dated `2026-07-27T19:51:56Z`. Documented
  fields outside V1 analytics receive an explicit raw-only `unsupported`
  disposition and PII class instead of being mistaken for schema drift.
- Canonical mappers accept only the generated typed columns plus lineage columns.
  Post-staging additions or source-identity mismatches fail closed.

### Canonical evidence and time semantics

- A Xero Payment is polymorphic settlement evidence, not a second invoice or
  journal fact. Albert resolves exactly one of `Invoice`, `CreditNote`,
  `Prepayment`, or `Overpayment` and emits a `settlement_of` event link with exact
  source and bank amounts, payment date, account, reconciliation state, type,
  status, and reference. Xero's empty-array relationship representation is treated
  as absent. More than one populated settlement target is ambiguous and fails
  closed. `BatchPaymentID` or `BatchPayment` independently emits a
  `part_of_batch` link.
- A Deputy Leave response with both `Start` and `End` uses those source instants;
  one without the other fails closed. When neither instant exists, Albert treats
  `DateStart` and `DateEnd` as inclusive local calendar dates and derives the
  half-open interval from local midnight in the response `TimeZone`, falling back
  to the reviewed tenant timezone. This preserves daylight-saving transitions.
  Non-positive or unresolvable intervals fail closed. Deputy status codes 0–5 are
  mapped explicitly; future codes remain visible as unknown rather than being
  guessed.

Deputy's `_DPMetaData` is the first explicit raw-only field. It is opaque
presentation metadata and can contain nested creator profiles and media URLs. Its
shape and analytical meaning are not stable enough to approve, but it is a normal
part of documented Leave responses and therefore must not quarantine the Leave
record.

## Consequences

### Positive

- Legitimate Xero Payment and Deputy Leave responses do not fail because of
  reviewed variants or presentation-only metadata.
- Full documented Xero and Lightspeed response objects can land even when they
  contain fields that the smaller recorded fixtures do not exercise.
- Typed staging, source exploration, semantic tools, and prompts cannot reach
  unsupported values.
- New vendor fields still produce a visible schema-drift failure instead of being
  silently promoted into production analytics.
- Raw replay preserves the evidence needed to review and later promote a field
  without re-extracting the source.

### Costs and risks

- Every newly observed field needs an explicit review before it becomes queryable.
- Aliases must be narrowly proven from primary documentation or live recordings;
  heuristic case-folding is intentionally not used.
- Raw-object access remains privileged because raw-only fields can contain personal
  information even when typed staging excludes them.

## Alternatives considered

- Stage every schema-valid field as JSON: rejected because it bypasses field-level
  typing, PII classification, and semantic review.
- Quarantine all unsupported fields: rejected because known presentation metadata
  would turn legitimate records into avoidable ingestion failures.
- Drop unsupported values before raw persistence: rejected because it breaks replay,
  lineage, and later field-promotion review.

## References

- [Xero Accounting API Payments](https://developer.xero.com/documentation/api/accounting/payments)
- [Xero official Accounting OpenAPI pin](https://github.com/XeroAPI/Xero-OpenAPI/blob/45ab7e8ceccbbbfb41a0487a47f9d1d00cbb4a0f/xero_accounting.yaml)
- [Lightspeed R-Series V3 endpoint reference](https://developers.lightspeedhq.com/retail/endpoints/Sale/)
- [Deputy Leave resource](https://developer.deputy.com/docs/leave)
- [Deputy leave-request response guide](https://developer.deputy.com/docs/adding-a-leave-request-for-an-employee)
- [Albert V1 connector pack contract](../albert-v1-spec.md#the-connector-pack-contract)
