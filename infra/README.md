# Albert infrastructure

Production uses two Sydney PostgreSQL cells: Supabase for Auth, control, queues, semantic catalogue, and raw Storage; and a separate managed PostgreSQL 17 analytical host.

For a new environment, enable `pgmq`, `pg_cron`, and `vector` in Supabase, then run the one-time administrator bootstrap:

```bash
npm run migrate -- --target=control-plane --bootstrap
npm run migrate -- --target=analytical --bootstrap
npm run provision:runtime-logins
```

`--bootstrap` creates NOLOGIN migration/runtime groups and is used only for a new database or an explicitly reviewed role-bootstrap addition. The provisioner reconciles fixed NOINHERIT LOGIN identities, removes unexpected memberships, and grants exactly one group per credential. Routine releases use deployer logins without `--bootstrap`.

Sync, webhook, transform, semantic, and deletion each receive distinct control-plane identities. Connector landing, canonical transform, semantic reads, semantic metadata, and deletion each receive distinct analytical identities. The final isolation migration revokes Albert private-schema access from Supabase's generic `service_role`; it is not an application deployment credential. The migration runner switches to a NOLOGIN migration owner, takes an advisory lock, verifies immutable SHA-256 checksums, and commits each migration with its ledger row atomically.

The Supabase Data API exposes `public` only. `control_plane`, `pgmq`, `cron`, Auth internals, and raw objects are service-only. Sync, webhook, and deletion use separate Storage S3 key pairs; an S3 key can access Storage but cannot query Auth or Postgres. Semantic publication runs `npm run registry:publish` with the control deployer and OpenAI credentials; every 1,536-dimension `text-embedding-3-large` document commits as one immutable snapshot.

Build the always-on service image with:

```bash
docker build -f Dockerfile.services -t albert-services .
```

The image contains five separately deployed commands:

- `node --enable-source-maps services/semantic-query.js`
- `node --enable-source-maps services/sync-worker.js`
- `node --enable-source-maps services/transform-worker.js`
- `node --enable-source-maps services/webhook-gateway.js`
- `node --enable-source-maps services/deletion-worker.js`

Transform and deletion have internal top-level health checks and no public Fly service. Sync exposes non-sensitive health plus HMAC-authenticated OAuth routes; semantic exposes non-sensitive health plus independently signed tool routes; webhook is the signature-verifying vendor edge. A browser must never call sync or semantic directly.

See [the production runbook](../deploy/README.md) for exact regions, identities, secret ownership, release gates, rotation, recovery, and human acceptance.
