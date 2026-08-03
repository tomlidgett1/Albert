# ADR 0050: Nonce-bound human onboarding acceptance

- Status: Accepted
- Date: 2026-08-04
- Owners: Albert product, identity, data platform, and release engineering
- Relates to: ADR 0003, ADR 0006, ADR 0019, ADR 0035, ADR 0048,
  ADR 0049, ADR 0051
- Supersedes: the M7 onboarding evidence described in ADR 0035

## Context

ADR 0035 originally accepted M7 from current control-plane projections: one
tenant, three healthy OAuth connections, partial readiness, four blocking
answers, and an overlay. Those facts are necessary but do not prove that one
real person completed a fresh, candidate-bound onboarding journey. An operator
could select an older tenant, reuse connections established before the
candidate deployment, or capture readiness produced by a different OAuth
generation or sync run.

Browser automation also cannot close this gap. ADR 0048 intentionally
substitutes unavailable external services and proves only the composed browser
contract. A browser cookie or JavaScript-generated value is evidence of
same-browser continuity, not proof of a human identity, a physical person, or
live vendor consent.

The acceptance mechanism must therefore bind a fresh managed-Auth user, tenant
ownership, three real OAuth generations, recent-first ingestion, blocking
answers, and the browser receipt into one immutable release artefact. It must
not put a bearer code in a URL, workflow log, database row, or signed release
envelope. Continued sync after capture must not invalidate an otherwise valid
snapshot, and candidate code must not be able to attest its own vendor access.

## Decision

### Candidate-bound one-use journey

The protected dogfood operator issues one active journey for an exact candidate
SHA and staging deployment after the three-worker deployment barrier. The
database stores only a SHA-256 digest of a random 256-bit claim code, a bounded
expiry, and immutable issuance metadata. A second active journey for the same
candidate and deployment is rejected.

The issuer runs from immutable trusted tooling in the protected staging
environment. It encrypts the URL and raw claim code with a fresh AES-256-GCM
data key, wraps that key with the named recipient's RSA-OAEP-SHA256 public key,
and publishes only the recipient-encrypted envelope with one-day retention.
The URL contains the journey id but never the claim code. Decryption is a local
recipient operation that creates a new mode-0600 file; no server or release
workflow receives the recipient private key.

### Managed identity and browser continuity

The claimant signs up and signs in through the ordinary hosted Supabase Auth
flow. The database accepts a claim only from an authenticated user, for that
user's selected active tenant, after the deployment barrier, and only when the
code digest matches the unclaimed journey. An administrator-owned compatibility
function reads immutable managed-Auth audit events to prove email confirmation,
signup, post-claim login, tenant creation, owner membership, and bootstrap
through the real product flow. Runtime roles cannot write or counterfeit that
audit evidence.

Before claiming, the page creates a high-entropy browser nonce. The same-origin
server hashes that nonce and a normalized user-agent value and binds both to the
claim. The raw nonce remains only in journey-scoped `sessionStorage`; the raw
claim code is never persisted there. After the deliberate logout/login
transition, the operator-only receipt endpoint accepts only the exact nonce and
user-agent hashes already sealed by the claim. A wrong user, wrong tenant,
wrong browser value, replay, or post-completion mutation fails closed.

This mechanism proves continuity across the intended browser ceremony. It is
not described as a signature, biometric, proof of personhood, or independent
identity credential.

### Exact OAuth and readiness bindings

M7 requires exactly one current healthy OAuth-backed connection for each of
Lightspeed R-Series, Xero, and Deputy. Each connection must have been created
from an OAuth session completed after the human claim, for the same tenant and
user, with the exact selected external-account digest and current connection
generation. The three immutable bindings are content-addressed into the M7
evidence.

The InitialBackfill coordinator records the exact job request, sync run, and
raw batch on every progressive stream phase. Runtime sync authority can register
a phase only when those values match the current connection generation and the
coordinator's immutable request. M7 then requires post-receipt, pre-capture,
current-generation recent-first readiness for all four required domains:
Lightspeed sales, Lightspeed inventory, Deputy workforce, and Xero accounting.
Each domain must bind the exact coordinator job/run/batch, cover its declared
recent range, be queryable, and have a succeeded canonical transform. Partial
readiness is accepted only when the same exact range coverage qualifies it.

Blocking answers use the separately content-addressed four-question contract
and an exact response digest. The published overlay, OAuth set, readiness rows,
claim, receipt, managed-Auth proof, and vendor-attestor result each contribute
to the final journey binding digest.

### Independent live-vendor attestation

Control-plane connection rows cannot independently prove that credentials still
work at the three providers. Before M7 capture, the isolated vendor-connection
attestor must complete its exact challenge contract for all three connection
generations. Its producer identity, tool reference, and build digest are pinned
by administrator-owned configuration. Portable results carry Ed25519
signatures; database admission additionally requires an HMAC held outside the
narrow attestor database login and verified by a PostgreSQL-owned function.

Capture consumes exactly one complete three-provider result set for the
journey, candidate, deployment, and tenant. M7 stores its append-only
consumption id and evidence digest. Release consumption calls the independent
assertion boundary again and requires the same digest and provider cardinality.
Candidate services and the diagnostic runtime cannot manufacture or replace
that result.

### Immutable release projection

Capture first executes all earlier M3-M8 gates, then replaces the weak M7
projection with the nonce-bound result and inserts a new append-only,
digest-constrained snapshot in the same transaction. Release consumption
validates the snapshot's internal M7 digest, immutable journey/claim/receipt
digests, and consumed vendor-attestor seal before invoking the existing
one-release consumption ledger.

Mutable connection, readiness, and overlay projections are deliberately not
re-read at release time. Their exact row identities and values were checked and
content-addressed at capture; re-reading them would make valid evidence fail as
normal ingestion advances. The trusted collector HMAC-pseudonymizes journey,
tenant, connection, and attestor-consumption identifiers before signing the
strict Ed25519 release envelope. The raw identifiers and claim code never enter
the portable attestation.

## Consequences

- M7 cannot be satisfied by a UI walkthrough, fixture browser, pre-existing
  tenant, old OAuth generation, unrelated sync run, or manually authored JSON.
- The real person uses the normal hosted Auth and OAuth surfaces; no production
  authentication or connector bypass is introduced.
- A same-browser nonce prevents accidental or opportunistic cross-browser
  completion but makes no stronger claim about humanity.
- Recent-first readiness is traceable to exact queue, run, batch, range, and
  canonical-transform evidence for every required V1 domain.
- Continued sync cannot make an accepted immutable release snapshot stale.
- Issuing, claiming, receiving, vendor-attesting, capturing, signing, and
  consuming are distinct least-privilege steps with independent replay guards.
- Production promotion remains unavailable until the protected human ceremony
  and three live provider challenges have actually completed.

## Alternatives considered

- **Accept a browser screenshot or Playwright pass:** rejected because neither
  proves managed identity, live consent, live credentials, or exact ingestion.
- **Put the claim code in the URL or workflow output:** rejected because URLs,
  logs, referrers, and browser history are inappropriate bearer-secret stores.
- **Call the browser nonce a human signature:** rejected because a script can
  generate and replay browser state; it proves continuity only.
- **Trust current `connections` and readiness rows at release:** rejected
  because they are mutable and can refer to another generation or continue to
  advance after valid capture.
- **Let the candidate or diagnostic service probe providers itself:** rejected
  because the subject under test could self-attest and the diagnostic login
  would gain unnecessary credential authority.
- **Store raw tenant, user, connection, or journey identifiers in signed
  evidence:** rejected because keyed, domain-separated references retain the
  required binding without producing a portable identity ledger.
- **Infer the stronger M7 contract for historical snapshots:** rejected. Old
  snapshots lack the required claim, receipt, readiness, and attestor bindings
  and are permanently ineligible for production consumption.

## Verification

- `.github/workflows/dogfood-onboarding-journey.yml`
- `scripts/issue-dogfood-onboarding-journey.mjs`
- `scripts/decrypt-dogfood-onboarding-journey.mjs`
- `app/dash/acceptance/page.tsx`
- `app/api/acceptance/claim/route.ts`
- `app/api/acceptance/receipt/route.ts`
- `services/control-plane/src/protected-dogfood-onboarding-repository.ts`
- `infra/bootstrap-upgrades/control-plane/0009_protected_dogfood_auth_audit_proof.sql`
- `infra/bootstrap-upgrades/control-plane/0010_vendor_connection_attestor_authority.sql`
- `infra/migrations/control-plane/0065_m7_nonce_bound_human_onboarding_acceptance.sql`
- `infra/migrations/control-plane/0067_m7_independent_live_vendor_attestation.sql`
- `scripts/collect-dogfood-acceptance.mjs`
- `scripts/dogfood-acceptance-attestation.mjs`
- `tests/contracts/protected-dogfood-human-onboarding.contract.test.ts`
- `tests/contracts/dogfood-acceptance-attestation.contract.test.ts`
- `tests/sql/control-plane-protected-dogfood-human-onboarding.sql`
