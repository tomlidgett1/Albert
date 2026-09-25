# Tokyo decommission runbook

Written 2026-08-13, after the analytical consolidation. Read
`AGENTS.md` → "Production topology" first.

## Where things stand

Everything user-facing already runs on the two Sydney projects:

| Concern | Where it lives now |
| --- | --- |
| Web + auth + conversations | Vercel → **Control** `jjiugnriaypjoxsupjft` |
| Connections + credential vault + raw-batch storage | **Control** |
| All analytical data (`source_*`, `XER_OFFICIAL`) | **Analytics** `ndncknjodgoovbojedaa` (ledger at `0158`) |
| Semantic layer | `albert-cube` on Fly → Analytics only |
| OAuth / sync worker | `albert-sync-worker-dogfood` on Fly (rebuilt 2026-08-13, Sydney region, correct two-project targets) |
| Synthetic Square demo data | Analytics, tenant `01KZN20VTX2EWW1TQ2AA3MCPW6`, connection `01KZWEVH2P0HSQKS49H98JW0AW` |

The legacy Tokyo project `qthltvbbgnhprsflmzfj` no longer serves any live
runtime. Its former dependents (dogfood workers, `.env.local`) were destroyed
or repointed on 2026-08-13.

## What was destroyed on 2026-08-13

Fly apps (source code was deleted from the repo the same day):
`albert-prod-semantic`, `albert-prod-anthropic`, `albert-prod-transform`,
`albert-prod-transform-autoscaler`, `albert-semantic-query-dogfood`,
`albert-transform-worker-dogfood`, and the old Tokyo-pointing
`albert-sync-worker-dogfood` (rebuilt fresh against the Sydney pair).

## Remaining steps (supervised — do these in order)

1. **Deploy the cleaned web to Vercel.** The repo now has V2 routes deleted,
   the fleet-only admin UI, and the trimmed env contract. Until the deploy,
   the live site still exposes dead V2 runtime pickers that will error if
   selected. V3 (the default) is unaffected.
2. **Watch one real V3 conversation + one Connect flow** (Square or
   Lightspeed) end-to-end. The OAuth worker was rebuilt from assembled
   secrets; a real browser flow is the only proof that redirect URIs and
   cookie signing survived intact. If Square token refresh fails within a few
   days, reconnect Square once (its credential was vaulted under the same
   TOKEN_ENCRYPTION_KEY, so it should survive — verify, don't assume).
3. **Rename the worker when convenient.** `albert-sync-worker-dogfood` is a
   production service with a legacy name. To retire the name: deploy the same
   image/secrets to `albert-prod-sync`, change Vercel's
   `SYNC_WORKER_INTERNAL_URL` (a *sensitive* env var — dashboard only), then
   destroy the dogfood app. Zero-downtime if done in that order.
4. **Copy anything you still want out of Tokyo.** Nothing live needs it, but
   it holds history the Sydney pair never received: 387k
   `ingestion.source_records`, 13k batch manifests, the raw-batch Storage
   bucket, the old `source_xero` (208-table) sync, Deputy data
   (`DEPUTYNEW` + `source_deputy`), and pre-Aug-10 conversations. If the
   evaluation snapshot in Analytics is enough (it has been since Aug 10),
   skip this.
5. **Pause, then delete Tokyo.** In Supabase: pause `qthltvbbgnhprsflmzfj`
   and wait two weeks. If nothing breaks (it will not — see step-4 caveat),
   delete the project. Pausing first makes the mistake reversible.
6. **Rotate the operator credential.** `.env.local` now uses a temporary
   `albert_cutover_operator` login on both Sydney projects (password appears
   in the session transcript that created it). When cutover work is done:
   `DROP ROLE albert_cutover_operator` on both projects and replace the
   `.env.local` URLs with proper per-role credentials, or mint a fresh
   operator password.
7. **Local-dev leftovers.** `.env.local` lines prefixed
   `DECOMMISSIONED_TOKYO_` are inert. If you need the Supabase service-role
   key or storage keys locally, fetch **Production Control's** values from
   the dashboard (the old values were Tokyo's).
8. **Optional tidy.** The empty never-deployed Fly app `albert-8qhpoq` can be
   destroyed whenever.

## Purging the synthetic Square data

Before activating real Square ingestion, remove the demo rows (they sit under
the REAL Square connection so the dashboard works today):

```sql
-- Analytics (ndncknjodgoovbojedaa) — all synthetic rows share one sync run id
DO $$ DECLARE t record; BEGIN
  PERFORM set_config('albert.tenant_id','01KZN20VTX2EWW1TQ2AA3MCPW6',true);
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='source_square' LOOP
    EXECUTE format('DELETE FROM source_square.%I WHERE sync_run_id=$1', t.tablename)
      USING '01KZWQ8N5C0PMKX4TDA9VBEHR3';
  END LOOP;
  DELETE FROM ingestion.source_records WHERE sync_run_id='01KZWQ8N5C0PMKX4TDA9VBEHR3';
  DELETE FROM quality.connector_stream_state
   WHERE connector_id='square' AND connection_id='01KZWEVH2P0HSQKS49H98JW0AW';
END $$;
-- batch_manifests / landing_commits are append-only by design and stay.
```

## Why two projects and why Fly (asked 2026-08-13)

- **Two Supabase projects, not one:** the old single project ran at its
  max_connections=60 ceiling with control-plane OLTP and analytical scans
  starving each other. Splitting isolates failure domains and lets each be
  sized independently. Not three — Tokyo's continued existence was migration
  debt, not design.
- **Fly stays, smaller:** Supabase hosts Postgres/Auth/Storage/short-lived
  edge functions. It cannot run Cube.js (a long-lived Node server with its
  own query engine) or the sync workers (long-lived processes with per-vendor
  rate governors and hours-long backfills). Managed Cube Cloud is the only
  real alternative to `albert-cube`, at a new vendor and subscription. The
  Fly fleet went from 11 apps to 7:
  cube, sync worker (+autoscaler), webhook, deletion, operator-diagnostic,
  vendor-attestor.
