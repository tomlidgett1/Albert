# ADR 0010: Source-neutral identity evidence associations

- Status: Accepted
- Date: 2026-08-03
- Owners: Albert engineering
- Complements: ADR 0009 and the M4 canonical identity observation contract

## Context

Some connector APIs separate a canonical subject from the lookup object that
contains its matching evidence. Deputy Employee, for example, stores a Contact
identifier while the corresponding Contact resource carries the work email.
Treating Contact as a worker candidate is incorrect because it has no worker
dimension or source-owned entity link. Ignoring Contact means an exact work
email can never produce the Deputy-to-Lightspeed worker review card required by
V1.

Location evidence has a related portability problem. Deputy represents a
Company address by an Address foreign object, while Lightspeed embeds its shop
address. Vendor IDs, state codes, and country representations are not
cross-source evidence. Teaching the canonical matcher a Deputy/Lightspeed
special case would repeat for every future connector pair and would not scale
to the planned connector fleet.

Identity decisions also must not rewrite source-owned canonical IDs. Candidate
generation has to remain valid after an A-B decision so a later B-C candidate
can still be reviewed and reversed safely.

## Decision

### Connector packs declare evidence ownership

- `identity_hint` accepts at most 16 same-connection `evidenceRefs`, each naming
  a source object type and source record ID. It also supports `evidenceOnly` for
  lookup observations that may enrich a subject but must never appear as a
  review-card subject.
- The Deputy Employee hint references its Contact record. Contact publishes
  `work_email` and normalized phone evidence as `evidenceOnly`.
- The association is persisted with the subject observation. Candidate
  generation resolves active referenced observations at execution time, so it
  works whether Contact or Employee lands first and naturally follows later
  corrections or tombstones.
- Conflicting values for one inherited key are omitted. The matcher never picks
  an arbitrary value from ambiguous evidence.

### Packs publish comparable semantic keys

- Connector mappers normalize evidence into source-neutral deterministic key
  names. The initial shared keys are `work_email` and
  `location_name_address`; there is no connector-pair branch in the matcher.
- Deputy Company and OperationalUnit queries request the documented
  `AddressObject` Resource API join. This scopes collection to addresses already
  attached to location subjects rather than ingesting every Address object,
  which could include employee home addresses.
- A location key combines normalized location name with the comparable street,
  city, and postcode components. State and country are excluded until governed
  code-to-code normalization exists; a matching address alone is not accepted
  as a location identity.
- Raw values remain in typed, access-controlled staging. Identity observations
  persist tenant-salted digests, not email or address text.

### Candidate links remain native and transitive-safe

- Only active, linkable subject observations participate in cross-connection
  matching. Evidence-only Contact records cannot become worker candidates.
- Each candidate is joined through `canonical_record_state` to its stable
  source-owned canonical entity and then to the active accepted native
  `entity_source_link`. `entity_resolution` is deliberately not consulted while
  producing candidates.
- User decisions affect the reversible graph and its query-time resolution,
  not the candidate's source-native anchor. An A-B decision therefore does not
  suppress or redirect a later B-C review card.

## Consequences

- Deputy Contact work email now enriches the correct Employee subject without a
  pairwise Deputy/Lightspeed rule.
- The same contract supports future lookup-owned evidence such as CRM contact
  methods or ERP address records.
- Lookup stream order is irrelevant, and removing or tombstoning evidence stops
  it from contributing to new candidates.
- Adding a new evidence key requires connector-level normalization and fixture
  coverage. It does not require changing the core matcher for a source pair.
- The initial location normalizer is intentionally conservative. State/country
  evidence can be added only after a governed cross-vendor code mapping exists.

## Alternatives considered

- Emit Deputy Contact as a worker: rejected because it has no worker dimension
  or stable source-owned worker link.
- Join Contact directly inside the canonical core: rejected because it embeds a
  Deputy-specific relationship in a source-neutral boundary.
- Compare raw vendor location IDs or state/country fields: rejected because the
  values are scoped and encoded differently by each source.
- Resolve candidate anchors through the current identity representative:
  rejected because a prior merge would hide or redirect transitive candidates
  and make reversal unsafe.

## References

- [Deputy Resource API joins](https://developer.deputy.com/docs/resource-api-objects)
- [Deputy Employee and Contact relationship](https://developer.deputy.com/docs/employee)
- [Deputy Contact resource](https://developer.deputy.com/docs/contact)
- [Deputy Company location resource](https://developer.deputy.com/docs/company)
- [Deputy Address resource](https://developer.deputy.com/docs/address)
