# 0135 — Omni evidence composition and durable execution

Date: 2026-09-04. Status: implemented and locally qualified; production job-store activation awaits administrator configuration.

The owner requested implementation of the Omni harness review. This amends
ADR 0129/0130 without reintroducing retired semantic services or canonical
database layers. Cube remains the sole analytical execution authority.

## Answer boundary

Chat answers are composed through `ComposeAnswer`. The model supplies prose,
result/cell references and table references. Host code resolves placeholders
and renders the actual cells. Free-form model output cannot replace an
accepted composition or earn Verified because a query happened to return a
row. Unknown references, unsupported figures, malformed placeholders and
false empty-result claims are rejected with actionable repair feedback.

The host derives the terminal state. Incomplete evidence, reused snapshots,
disclosures and failed checks lower the state to Qualified. Explanations and
clarifications have distinct outcomes. Numerical claims retain their exact
result ID, row and column in the trace. Deterministic numeric binding does
not independently prove every linguistic inference; semantic review remains
part of the evaluation suite.

Dashboard composition keeps its existing result-bound plan contract. Chat
and dashboard share analytical rules; presentation instructions remain
specific to the delivery surface. Existing renderers and themes are reused.

## Result semantics

Every new query result carries host-authored coverage, retained row count,
row limit, grain, key domains, window and semantic/query digests. This
metadata survives snapshots and derivations. A preview cannot turn a capped
result into complete evidence.

Absence tests require a complete right side. Joins require compatible
declared identifier domains or time buckets, identical windows, and unique
right-hand keys. Display names and independently numbered source IDs do not
establish identity. The refresh materializer rejects duplicate matches too.
Population aggregates require complete inputs; an explicit selected-row
subtotal remains labelled and qualified. Addition/subtraction require
compatible types and currencies.

The model-facing query schema and its conversion live together. Exactly one
filter form is allowed; malformed filters cannot disappear. Repairs that
would discard requested periods fail for model correction instead.

## Context and recovery

Follow-ups carry bounded, governed prior results. Their source identity,
period and completeness stay attached. The whole serialized request is
budgeted in bytes, including multibyte text and metadata. The current
question is preserved; older prose is shed before recent evidence.

The runtime checkpoints completed SDK tool-call/result pairs, evidence,
allowances, tasks, usage and accepted compositions. Interrupted runs resume
from these checkpoints. A changed semantic catalogue invalidates a saved
checkpoint. Queue wait is part of the deadline.

Production jobs live in `control_plane.omni_runtime_jobs`, accessed through
the dedicated `albert_omni_control` role. Checkpoint content, including the
short-lived Cube bearer, is AES-GCM encrypted using a domain-separated key
derived from the runtime signing secret. The database stores ciphertext;
private SDK history is never emitted on the public trace. Worker leases and
revision checks fence concurrent executors. Deletion of a conversation turn
cascades to the job, and a fixed hourly cron removes expired jobs.

Local development uses encrypted SQLite WAL checkpoints with equivalent
revision and lease semantics. Production cannot fall back to local files.
Production activation requires `ALBERT_OMNI_JOB_DATABASE_URL` for the
dedicated runtime login. Provisioning follows the existing runtime-login
script; credentials are configured directly, never through chat.

## Trace durability

Migration 0188 makes append retries idempotent for the exact event identity
and body, while retaining contiguous ordering and tenant/actor checks.
Omni retries writes in order and stops advancing a broken sequence. Answers
and dashboard plans are delivered only after the preceding evidence and the
terminal event have been persisted. Other runtimes retain their existing
emitter behavior unless they opt into this contract.

The new runtime group and fixed retention installer are introduced through
administrator upgrade 0015. Migration 0189 creates the encrypted job store
using the migration owner. The streams remain checksummed and separate.

## Evaluation contract

Qualification must bind results to the service's actual harness build and
semantic model, preserve each attempt, include deterministic numeric and
adversarial fixtures, and fail the command when expected outcomes fail.
Repeated trials report first-attempt reliability and total cost/latency,
including retries. Live qualification uses the owner's requested
`gpt-5.6-luna` with `max` effort and standard processing.

The tenant briefing lookup has no process-wide file fallback. Missing
tenant context stays missing.

Qualification evidence is recorded in
[`evals/albert/omni-reliability-2026-09-04.md`](../../evals/albert/omni-reliability-2026-09-04.md).
