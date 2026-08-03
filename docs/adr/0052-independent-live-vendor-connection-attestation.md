# ADR 0052: Independent live-vendor connection attestation

- Status: Accepted
- Date: 2026-08-04
- Supersedes: the M7 self-reported connection evidence in ADR 0035
- Extends: ADR 0050

## Context

M7 must prove that a newly onboarded human connected the selected Lightspeed R,
Xero, and Deputy accounts and that the current credential generation can still
make a real vendor request. Candidate web and sync services possess the OAuth
workflow and token vault. Letting those same services write their own proof
would allow a candidate release, a migration credential, or a compromised
worker to manufacture acceptance without contacting a vendor.

The proof also cannot copy refresh tokens into a second service, persist vendor
response bodies, or place an internet-facing diagnostic endpoint beside the
credential relay.

## Decision

Albert uses a separately deployed `vendor-connection-attestor` trust service
and an administrator-owned PostgreSQL admission boundary.

Administrator upgrade 0010 creates a NOLOGIN attestor group, verifier material,
an admission HMAC, append-only guards, and a one-use finalization capability.
Migration 0067 may declare the reviewed tables and functions, but the finalizer
accepts them only when their column contracts, ownership, security attributes,
search path, result types, and exact function-body SHA-256 digests match the
administrator-approved contract. It truncates any pre-handoff rows, replaces
candidate triggers, transfers the three stores and eleven boundary functions to
`postgres`, records a protected contract digest, and revokes itself from the
migration owner. A replay fails before any mutation.

For each provider, the protected collector issues a two-minute nonce challenge
bound to the completed human journey, candidate SHA, deployment, tenant,
connection id, connection generation, selected-account digest, and credential
reference digest. The sync worker claims that nonce once, rechecks the current
database and vault binding, and sends only the current access-token bytes over
TLS 1.3 mutual TLS. It never sends or logs a refresh token. Token and response
buffers are zeroed after use.

The independent service performs only these fixed identity probes:

- Lightspeed R: `GET https://api.lightspeedapp.com/API/V3/Account.json`
- Xero: `GET https://api.xero.com/connections`, followed by tenant-bound
  `GET https://api.xero.com/api.xro/2.0/Organisation`
- Deputy: `GET https://{install}.{au|eu|uk|us}.deputy.com/api/v1/me`

Redirects, private or reserved DNS answers, non-JSON responses, oversized
bodies, schema mismatches, non-200 responses, wrong selected accounts, and
deadline overruns fail closed. Evidence retains endpoint identifiers, response
timings, status codes, safe identity digests, and header/body digests—not names,
tokens, or bodies.

The service signs the database-canonical result digest with Ed25519 and proves
online possession of a separate 32-byte admission HMAC. PostgreSQL admits only
the pinned key id, tool ref, immutable image digest, fixed evidence shape, and
HMAC. M7 consumption requires exactly one fresh passing result for each of the
three providers, revalidates the current generation/account/credential binding,
consumes all three once, and seals their evidence into the protected human
onboarding snapshot.

The service has no public ingress. The sync worker's normal readiness performs
an authenticated `GET /readyz` on the same mTLS port and requires the pinned
tool ref and image digest, proving reachability and trust identity before a live
challenge. The unauthenticated health port is private platform health only and
does not accept credentials.

Deployment is allowed only from a signed annotated
`vendor-attestor-vMAJOR.MINOR.PATCH` tag. The workflow proves its own exact tag
workflow ref, target SHA, expected GitHub signer, protected environment reviewer
and tag policy, a creation-only ruleset whose sole bypass is the tag-issuer App,
a separate no-bypass update/deletion ruleset, and the remote registry digest
before provisioning or deploying trust material.

## Consequences

- A candidate release can request a proof but cannot write, admit, consume,
  replace, or replay one.
- A sync credential compromise exposes neither the signing/HMAC authority nor
  a refresh token to the attestor; an attestor compromise does not expose the
  OAuth vault or vendor client secrets.
- M7 now depends on vendor availability, private mTLS reachability, an unexpired
  access token, and a two-minute challenge window. Any dependency failure blocks
  acceptance and is retried with a new challenge; it never degrades to cached or
  self-reported evidence.
- Key or certificate rotation requires a reviewed authority-tag deployment.
  Client-certificate rotation may temporarily pin exactly two fingerprints;
  remove the old fingerprint after every sync instance reports the new pinned
  readiness identity.

## Rejected alternatives

- Candidate-owned health checks or connector `testConnection` results: the
  system under test could forge them.
- Copying refresh tokens into the attestor: it widens durable credential
  authority and makes the trust service a second OAuth vault.
- A database-only signature column: a migration or service with write access
  could populate it without live network traffic.
- Public attestor ingress: it adds an unnecessary credential-bearing attack
  surface when the sync worker and attestor share private networking.
