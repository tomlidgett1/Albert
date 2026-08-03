# ADR 0055: Use one Lightspeed R-Series `employee:all` consent grant

- Status: Accepted
- Date: 2026-08-04

## Context

Albert V1 extracts sales, inventory, customers, employees, shops, product cost,
categories, vendors, and purchase orders from Lightspeed Retail R-Series. The
previous authorization request enumerated ten granular employee scopes. Product
direction requires the documented `employee:all` grant so a new connection does
not lose a V1 domain because an individual grant was omitted.

## Decision

New Lightspeed R-Series authorization requests use only `employee:all`. The
OAuth builder keeps a fixed allowlist and rejects caller-supplied scopes outside
that list. A stored `employee:all` grant satisfies every granular capability
check used by the connector.

Albert remains operationally read-only: its R-Series data-plane implementation
issues GET requests and exposes no source mutation methods. Existing credentials
with granular scopes remain valid and retain granular capability evaluation.

## Consequences

- New merchants see one broad Lightspeed employee-level consent grant.
- All V1 Lightspeed extraction domains become available from that grant.
- Existing granular connections require re-consent if `employee:all` is desired.
- The authorization grant is broader than least privilege, while Albert's own
  connector continues to enforce read-only behaviour.
