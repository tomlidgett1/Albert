# Protected M3-M8 dogfood release gate

This runbook configures the real-account acceptance gate defined by ADR 0035.
It is a production release prerequisite, not a fixture suite or UI demo.

## Trust boundary

Create a protected GitHub environment named `dogfood-staging` with required
reviewers. Run `.github/workflows/dogfood-acceptance.yml` only from the ref in
`ALBERT_DOGFOOD_ACCEPTANCE_WORKFLOW_REF` (an immutable tag such as
`refs/tags/dogfood-attestor-v1`). Restrict the environment deployment policy to
that protected tag family. Pin
`ALBERT_DOGFOOD_TRUSTED_TOOLING_SHA` to the independently reviewed commit that
the tag resolves to. The workflow refuses to run unless both `github.ref` and
`github.sha` match; the candidate SHA is never executed in the key-bearing job.
Configure the same tooling SHA in production verification.

Generate an Ed25519 keypair outside CI. Store the base64url-encoded PKCS#8 DER
private key only as the `dogfood-staging` secret
`ALBERT_DOGFOOD_ACCEPTANCE_ED25519_PRIVATE_KEY_BASE64URL`. Store the base64url-
encoded SPKI DER public key in the protected production environment as
`ALBERT_DOGFOOD_ACCEPTANCE_ED25519_PUBLIC_KEY_BASE64URL`. Production must never
receive the private key. Store a separate random 32-64 byte base64url key as
`ALBERT_DOGFOOD_REFERENCE_HMAC_KEY_BASE64URL` in `dogfood-staging` only.
Also store `ALBERT_DOGFOOD_FLY_READONLY_TOKEN`, created with a short expiry via
`fly tokens create readonly`; it must not be a deploy or personal token.

The staging and production environments both need
`ALBERT_DOGFOOD_CONTROL_DATABASE_URL`, using the dedicated
`albert_operator_diagnostic_control_runtime` login against the staging control
cell. It can execute only capture/consume functions through its NOLOGIN group
role; it has no table grants.

## Protected staging configuration

Configure these selectors as environment secrets:

- `ALBERT_DOGFOOD_TENANT_ID`
- `ALBERT_DOGFOOD_LIGHTSPEED_CONNECTION_ID`
- `ALBERT_DOGFOOD_XERO_CONNECTION_ID`
- `ALBERT_DOGFOOD_DEPUTY_CONNECTION_ID`
- `ALBERT_DOGFOOD_ONBOARDING_TENANT_ID`
- `ALBERT_DOGFOOD_FLAGSHIP_ARTIFACT_ID`
- `ALBERT_DOGFOOD_CATEGORY_ARTIFACT_ID`
- `ALBERT_DOGFOOD_DISCONNECT_PROOF_ID`
- `ALBERT_DOGFOOD_TENANT_DELETION_PROOF_ID`
- `ALBERT_DOGFOOD_SEMANTIC_SIGNING_SECRET`
- `ALBERT_DOGFOOD_SEMANTIC_CASE_PLAN_JSON`

The semantic plan is a strict JSON array. Each item contains a safe case id,
`golden` or `composite` kind, the exact protected expected result SHA-256, and
the complete `run_semantic_query` IR under `input`. Include at least one of each
kind. The collector does not retain returned rows.

Configure these reviewed environment variables:

- `ALBERT_DOGFOOD_DEPLOYMENT_ID`, the unique `ALBERT_DEPLOYMENT_ID` supplied to
  every runtime in the staging deployment
- `ALBERT_DOGFOOD_ONBOARDING_TARGET_MINUTES`
- `ALBERT_DOGFOOD_CATEGORY_TOPIC`
- `ALBERT_DOGFOOD_SEMANTIC_QUERY_URL`
- `ALBERT_DOGFOOD_RUNTIME_PROBES_JSON`, an array containing exactly `web`,
  `sync-worker`, `transform-worker`, `webhook-gateway`, `semantic-query`,
  `operator-diagnostic`, and `deletion-worker`. The five public entries use
  `{ "name", "url" }` at distinct HTTPS origins. Web is probed at
  `/api/health`; the other public services use `/readyz`. Every response must
  self-identify the expected runtime and carry the candidate SHA and deployment
  id. The semantic query URL must use the same origin as the semantic runtime
  probe. The two private entries are `{ "name": "transform-worker",
  "flyApp": "..." }` and `{ "name": "deletion-worker", "flyApp": "..." }`.
  The collector verifies their Machines and platform `/readyz` checks through
  Fly's read-only control plane and fails if the apps are not distinct, their
  worker identity does not match the named runtime, or either app has a public
  IP.

Do not prepare acceptance evidence before deploying the candidate. Once all
candidate runtimes are healthy, their fresh worker heartbeats establish the
barrier. After it, run live sync/backfill/reconciliation, canonical projection,
identity generation, the pipeline snapshot, and both finalized answer flows.
Use a newly created post-barrier onboarding tenant. Complete real browser OAuth for one
Lightspeed R-Series account, one Xero tenant, and one Deputy installation;
answer at least four blocking questions and publish the overlay. Run the
flagship and category conversations through the real agent and record their
finalized artifact ids. Execute a real Lightspeed or Xero disconnect and a
separate three-provider tenant deletion after migrations 0054 and 0094 are
deployed; older proofs lack mandatory evidence.

## Produce and promote

1. Deploy the exact candidate SHA with one new deployment id and verify all
   seven readiness endpoints.
2. After the durable barrier, execute every M3-M8 operation above; pre-barrier
   rows are intentionally rejected.
3. Dispatch `Protected staging dogfood acceptance` from the immutable attestor
   tag with the full candidate SHA.
4. After approval, the trusted collector derives control evidence, probes every
   runtime SHA, executes each semantic case twice, signs the envelope, and
   uploads `dogfood-acceptance-<sha>` for one day. The signature expires after
   two hours.
5. The production preflight obtains that exact JSON artifact and runs:

   `node scripts/dogfood-acceptance-attestation.mjs`

   Supply `ALBERT_DOGFOOD_ACCEPTANCE_EVIDENCE`, the Ed25519 public key, protected
   workflow ref, trusted tooling SHA, staging diagnostic database URL, release
   SHA, repository, and production `GITHUB_RUN_ID`. The command verifies and atomically consumes the
   snapshot. Calling only the exported pure verifier is insufficient for a
   release because it does not perform one-use consumption.
6. Make every production-mutating job depend on the successful preflight. Never
   retry with the same envelope; run dogfood again after any consumed or expired
   attempt.

The artifact and logs contain only hashes, generations, counts, boolean gates,
bounded timings, and workflow identity. Do not print the selector environment,
semantic inputs, database URL, or provider responses.
