# ADR 0080: Optional Deputy runtime for Semantic V2

- Status: accepted
- Date: 2026-08-10
- Extends: ADR 0077 and ADR 0079

## Context

Albert Analytical Architecture V2 is qualified and launched against real
Lightspeed and Xero data. Deputy is explicitly excluded until real Deputy data
is available. The production sync worker nevertheless required both Deputy
OAuth values and eagerly constructed a Deputy connector at startup. That made
an out-of-scope vendor credential a deployment prerequisite for the in-scope
Lightspeed and Xero ingestion path.

## Decision

Lightspeed and Xero credentials remain mandatory startup configuration for the
production sync worker. Deputy's client ID and client secret are an optional,
atomic provider configuration:

- when both values are present, the existing Deputy connector is registered;
- when either value is absent, Deputy is not registered and any attempted use
  fails with `oauth_provider_not_configured:deputy`;
- no placeholder or synthetic Deputy credential may be used to satisfy a
  deployment contract;
- Deputy connector, staging and historical code remain intact for later
  qualification with real data.

This does not relax tenant isolation, credential encryption, the independent
vendor-attestation boundary, or any Lightspeed/Xero requirement. The webhook
gateway's existing vendor-verification contract is unchanged.

## Consequences

- The V2 ingestion fleet can deploy truthfully for its locked Lightspeed/Xero
  scope without inventing Deputy configuration.
- A Deputy OAuth route fails explicitly instead of making the whole sync fleet
  unready.
- Enabling Deputy later requires supplying both OAuth values and completing a
  separate real-data semantic and release qualification.
