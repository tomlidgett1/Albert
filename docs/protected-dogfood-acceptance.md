# Protected M3-M8 dogfood release gate

This runbook configures the real-account acceptance gate defined by ADR 0035
and the nonce-bound human onboarding ceremony in ADR 0050.
It is a production release prerequisite, not a fixture suite or UI demo.

## Trust boundary

Create a protected GitHub environment named `dogfood-staging` with at least one
required reviewer, prevent self-review, and disable administrator bypass. Disable
protected-branch deployment, enable custom policies, and install exactly one policy:
`albert-release-authority-v*` of type `tag`. Run
`.github/workflows/dogfood-acceptance.yml` only from the exact signed annotated
release-authority tag also used for production. Set:

```text
ALBERT_DOGFOOD_ACCEPTANCE_WORKFLOW_REF=refs/tags/albert-release-authority-v1
ALBERT_DOGFOOD_TRUSTED_TOOLING_SHA=<full-40-character-authority-tag-target>
ALBERT_RELEASE_AUTHORITY_SIGNER_EMAIL=<exact-annotated-tag-tagger-email>
```

The workflow rejects another ref, SHA, workflow path, event, run
attempt, lightweight tag, invalid GitHub signature, or unexpected tagger email. The
candidate SHA is never executed in the key-bearing job. Production derives the
expected producer ref and SHA from its own authority event; it does not accept
a separate mutable dogfood trust pin.

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

Generate a separate RSA keypair of at least 2048 bits for the named human
acceptance recipient. Configure only the base64url SPKI DER public key as the
`dogfood-staging` variable
`ALBERT_DOGFOOD_ONBOARDING_RECIPIENT_RSA_PUBLIC_KEY_BASE64URL`; keep the PKCS#8
private key outside GitHub, Albert services, and both databases. Also configure
the canonical HTTPS `ALBERT_DOGFOOD_PUBLIC_ORIGIN` variable. The protected
journey issuer uploads only an RSA-OAEP-SHA256/AES-256-GCM envelope and never
prints or outputs the raw claim code.

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

The semantic plan is a strict JSON object whose `suiteVersion`, `suiteDigest`,
case ids/order/kinds, query ids/order, period contracts, row requirements, and
expected answer states are owned by
`evals/golden/dogfood-semantic-suite.mjs`. The current reviewed suite contains
all 20 executable semantic questions from `evals/golden/questions.ts` in source
order: 16 numeric golden cases and four governed aggregate-then-align composite
cases. `sales-refund-rate` has a required explicit comparison, producing 21
exact query inputs. The secret may supply only each registry-owned query id,
complete `run_semantic_query` IR, and protected expected result SHA-256:

```json
{
  "suiteVersion": "albert-v1-m5-semantic-suite@3",
  "suiteDigest": "b0c4d8c281883094cae2382de45e838c95659f44c247e0b0859e5f11e28bc3f5",
  "cases": [
    {
      "caseId": "sales-refund-rate",
      "queries": [
        {
          "queryId": "primary",
          "expectedResultDigest": "<64 lowercase hex characters>",
          "input": { "topic": "sales_performance", "...": "protected live IR" }
        },
        {
          "queryId": "comparison",
          "expectedResultDigest": "<64 lowercase hex characters>",
          "input": { "topic": "sales_performance", "...": "protected comparison IR" }
        }
      ]
    }
  ]
}
```

The abbreviated example is documentation only: the configured secret must
contain every registry case and nested query in exact order. It must not contain
a case `kind`, expected state, row policy, period policy, arbitrary extra item,
or omission. Each query pins a digest of its seed IR contract. Dynamic absolute
instants are normalized only after code-owned validation of their calendar
shape, duration, UTC boundary, weekday where applicable, and cross-query or
composite alignment. The trusted collector then derives one exclusive next-UTC-
midnight anchor from its own clock before any query executes. Current to-date,
rolling, and minimum-history ranges must end at that anchor; prior-month,
prior-week, yesterday, and named-weekday ranges must be the immediately
applicable calendar period; the refund comparison must remain the exact
three-month shift of its anchored primary. Shape-valid but stale or shortened
inputs are rejected before a turn lease is issued. Update protected live ranges
for the intended collection day before dispatching the workflow; there is no
operator-owned `asOf` override. Topics, metrics, dimensions, composite
subqueries, filters, sort, limits, parameters, and comparison behavior must
also match the reviewed seed. Composite registry entries must supply composite
IR and golden entries must not. The collector does not retain returned rows.

Every query executes twice. `nonempty` query contracts require a positive row
count. `allow-empty` contracts permit a valid zero-row table, while still
requiring the exact protected result digest, bundle hash, governed state,
validation, and provenance. Both refund-rate queries must pass independently.

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

`ALBERT_DOGFOOD_CATEGORY_TOPIC` is retained for collector compatibility but is
not an operator-selectable M6 policy input. Set it to exactly
`sales_performance`; the database rejects every other value. The two M6
artifact selectors must refer to post-barrier turns produced by the real agent:

- the flagship conversation first asks “Which of my employees working today
  performed best over the last six months?”, then consumes the exact `Net
  sales` clarification option in the immediately following turn; and
- the category conversation asks “Which categories are performing well this
  month?” and uses the complete reviewed month-to-date category IR.

The control plane independently recomputes the immutable trace and artifact
digests, every visible table result digest, and the ordered question, semantic
plan, trace-contract, and provenance bindings described by ADR 0046. The signed
snapshot contains only those derived hashes, counts, states, and booleans. It
does not contain questions, narratives, table cells, user labels, or SQL.

Do not prepare acceptance evidence before deploying the candidate. Once all
candidate runtimes are healthy, their fresh worker heartbeats establish the
barrier. After it, run live sync/backfill/reconciliation, canonical projection,
identity generation, the pipeline snapshot, and both finalized answer flows.
Dispatch `Issue protected dogfood onboarding journey` from the immutable
trusted-tooling tag with the deployed candidate SHA. Download its one-day
encrypted artifact and decrypt it only on the recipient workstation into a new
mode-0600 file:

`node scripts/decrypt-dogfood-onboarding-journey.mjs <encrypted-file> <new-output-file>`

Supply the private key to that local process only as
`ALBERT_DOGFOOD_ONBOARDING_RECIPIENT_RSA_PRIVATE_KEY_BASE64URL`, then clear the
process environment and securely remove the decrypted file after the journey.

Open the exact URL in that file, create and confirm a new email account through
hosted Supabase Auth, create its organisation through Albert, and paste the
separate one-use code. Follow the page's deliberate same-tab logout/login and
seal the browser continuity receipt. The claim code must not be copied into a
URL, workflow input, chat, issue, or environment variable.

As that fresh owner, complete real browser OAuth for one Lightspeed R-Series
account, one Xero tenant, and one Deputy installation. Allow the protected live
vendor attestor to complete its exact three-provider challenge set; cached
control-plane health is not a substitute. Answer all four content-addressed
blocking questions and publish the overlay. Run the
flagship and category conversations through the real agent and record their
finalized artifact ids. Execute a real Lightspeed or Xero disconnect and a
separate three-provider tenant deletion after migrations 0054 and 0094 are
deployed; older proofs lack mandatory evidence.

## Produce and promote

1. Deploy the exact candidate SHA with one new deployment id and verify all
   seven readiness endpoints.
2. After the durable barrier, execute every M3-M8 operation above; pre-barrier
   rows are intentionally rejected.
3. Dispatch `Protected staging dogfood acceptance` from the same exact
   `albert-release-authority-v*` tag as production, with the full candidate SHA
   and the non-secret journey ULID from the decrypted operator file. The
   collector requires that exact completed journey and will not infer a current
   tenant or journey. Only a successful first workflow attempt is eligible.
4. After approval, the trusted collector derives control evidence, probes every
   runtime SHA, executes all 21 query inputs in the 20-case pinned suite twice,
   requires each result digest and answer state to match its protected/code-owned
   expectation, signs the suite version, suite digest, trusted collection
   anchor, protected plan digest, and ordered results into the envelope, and
   uploads `dogfood-acceptance-<sha>` for one day. The collection anchor is the
   exclusive upper bound (`value < to`), so it never requires a source row at
   the next-midnight boundary. Both the signer and verifier recompute the nested
   M5 digest from the exact signed M5 fields and reject mismatches. The
   signature expires after two hours.
5. Record the successful dogfood workflow run ID and exact unexpired artifact
   ID. Production authority looks up that explicit pair, verifies GitHub's
   `sha256:<64-lowercase-hex>` artifact digest and producer provenance, then
   downloads that exact JSON artifact and runs:

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
