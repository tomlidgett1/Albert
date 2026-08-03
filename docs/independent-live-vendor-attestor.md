# Independent live-vendor attestor runbook

This runbook operates the M7 trust service selected in ADR 0052. The deploy and
secret inventory remains authoritative in `deploy/README.md` and
`deploy/vendor-attestor/runtime-contract.json`.

## Initial installation

1. Apply control-plane administrator upgrades as protected `postgres`, then
   migrations. Migration 0067 completes the one-use administrator hand-off.
2. Create a private Fly app from
   `deploy/vendor-attestor/vendor-connection-attestor.reference.toml`; do not add
   public IPs or an `http_service`.
3. Create separate Ed25519, 32-byte admission-HMAC, server TLS, and sync-client
   TLS material. Do not reuse OAuth, webhook, acceptance, or release keys.
4. Configure `vendor-attestor-trust` with one required reviewer, self-review
   disabled, administrator bypass disabled (`can_admins_bypass: false`), and
   exactly one deployment policy: tag `vendor-attestor-v*`.
5. Configure two active rulesets for only `refs/tags/vendor-attestor-v*`:
   creation-only with the protected tag-issuer GitHub App as its sole bypass,
   and update/deletion with no bypass actors, including administrators.
6. Store `ALBERT_GITHUB_CONFIGURATION_AUDIT_TOKEN` in `vendor-attestor-trust`.
   Its non-dispatcher audit principal must have repository-administrator
   visibility while the token grants only Metadata (read) and Actions (read).
   Prove during provisioning that ruleset responses include `bypass_actors`;
   hidden actor metadata fails closed. The principal has no issuer or deploy role.
7. Dispatch the deploy workflow from the same signed annotated authority tag
   passed as `trusted_tag`.
8. Set the sync relay origin, TLS server name, client certificate/key, server
   CA, expected tool ref, and expected image digest. Deploy sync and require its
   `/readyz` before issuing an onboarding journey.

## Healthy invariants

- The attestor has two private instances and no public IP.
- Its platform `/readyz` is healthy, and sync `/readyz` proves the mTLS path and
  pinned tool/build identity.
- `extensions.albert_vendor_attestor_boundary_state.finalized_at` is set and its
  contract digest matches ADR 0052's migration contract.
- Evidence tables and all boundary/capture/consume functions are owned by
  `postgres`; the migration owner has no mutation or execute path back in.
- The runtime login is `NOINHERIT`, non-superuser, connection-limited, and is a
  member only of `albert_vendor_connection_attestor`.

## Rotation

For an Ed25519 or admission-HMAC rotation, publish a new reviewed authority tag,
deploy its immutable image, and atomically reprovision the database verifier
before accepting challenges. In-flight challenges from the former verifier are
allowed to expire and must be reissued.

For client TLS rotation, deploy the attestor with old and new SHA-256 client
fingerprints, deploy every sync instance with the new certificate, verify sync
readiness, then deploy the attestor again with only the new fingerprint. Never
leave more than two fingerprints configured.

## Incident response

If signing, HMAC, database-login, or TLS private material may be compromised,
stop the attestor and mark sync not ready. Rotate the affected authority through
a new signed tag. Existing unconsumed challenges expire after two minutes;
consumed evidence remains immutable and can be traced by challenge, result,
consumption, tool-ref, and build digests without exposing vendor payloads.
