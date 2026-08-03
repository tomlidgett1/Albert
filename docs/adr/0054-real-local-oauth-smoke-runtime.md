# ADR 0054: Real local OAuth smoke runtime

## Status

Accepted

## Context

Albert's production sync worker deliberately fails readiness unless its control
plane, analytical cell, durable queues, capability verifier, and raw object
store are all healthy. That is the correct production boundary, but it made a
real vendor-consent journey impossible during local UI development whenever the
analytical and raw-storage services were not also running. Replacing the flow
with fixtures would fail to exercise PKCE, signed internal requests, encrypted
credential envelopes, vendor account discovery, or durable connection writes.

The database also had two inconsistencies with the existing non-production web
and worker policy: constrained runtime callers could not execute the immutable
`control_plane.is_ulid(text)` predicate used by their table checks, and the
OAuth session constraint rejected the loopback HTTP redirects that both
application layers already restrict to local development.

## Decision

- Add a non-production-only OAuth worker entry point. It uses the same
  `OAuthWorkerHttpHandler`, connector implementations, control-plane runtime
  role, PKCE flow, envelope cryptography, and durable OAuth session store as the
  production sync worker.
- The local entry point exposes only liveness, readiness, and the signed OAuth
  routes. It does not run extraction loops or claim that downstream sync is
  ready.
- Fail startup when `NODE_ENV=production`. Production continues to run the full
  sync worker and retains its complete dependency readiness barrier.
- Grant constrained runtime groups execute permission only on the immutable
  ULID validator required by table constraints. No table or mutating-routine
  authority is added.
- Permit database OAuth redirects over HTTP only for `localhost` and
  `127.0.0.1`. The credential-owning worker still allow-lists one exact callback,
  and production runtime configuration still requires HTTPS.

## Consequences

Developers can complete a real Lightspeed, Xero, or Deputy consent journey from
the dash without deploying the full ingestion fleet. Credentials are still
encrypted and stored through the production code path, and the resulting sync
request remains durable for a full worker to process later. A healthy local
OAuth worker is not evidence that the production data plane or an initial sync
is healthy; production acceptance continues to require the protected release
and live vendor attestations defined by ADRs 0048, 0052, and 0053.
