# ADR 0055: Lightspeed R-Series consent scopes

- Status: Superseded for live authorize requests
- Date: 2026-08-04
- Updated: 2026-08-04

## Context

Albert V1 extracts sales, inventory, customers, employees, shops, product cost,
categories, vendors, and purchase orders from Lightspeed Retail R-Series. A
brief product experiment requested the documented `employee:all` grant so one
consent covered every V1 domain.

Live Safari authorize attempts with `employee:all` entered Lightspeed's identity
broker on the legacy `merchantos.com` login domain and failed with a redirect
loop before consent. The prior granular employee scope set completed the same
broker path on `lightspeedapp.com`.

## Decision

New Lightspeed R-Series authorization requests use the documented granular
employee scopes that cover V1 extraction domains:

- `employee:register_read`
- `employee:inventory_read`
- `employee:customers_read`
- `employee:product_cost`
- `employee:admin_employees`
- `employee:admin_shops`
- `employee:categories`
- `employee:vendors`
- `employee:purchase_orders`
- `employee:admin_purchases`

Capability evaluation still treats a stored `employee:all` grant as satisfying
every granular check, so any connection that already holds `employee:all`
continues to work.

Authorize requests also send the exact registered `redirect_uri` with S256
PKCE. Token exchange remains JSON with `client_id`, `client_secret`,
`grant_type`, code, and `code_verifier` per the R-Series Authorization Code
Grant docs.

## Consequences

- Merchants see the previous multi-scope consent list again.
- Live authorize avoids the `employee:all` broker path that looped on
  `merchantos.com` in Safari.
- Re-introducing `employee:all` needs a verified live authorize against the
  production API client before it is requested again.
