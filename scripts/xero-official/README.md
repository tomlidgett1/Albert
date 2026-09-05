# Xero official full ingest (`XER_OFFICIAL`)

Production ingest of 100% of the connected Xero organisation's API data into
the analytical Postgres schema `"XER_OFFICIAL"`, within Xero's daily request
allowance.

- Auth: reuses Albert's encrypted credential vault (PKCE public client); the
  launcher refreshes the token and passes it to Python via process env only.
- Coverage: every root endpoint from the pinned scan plan (AU country filter
  applied), all seven AU-relevant reports as monthly snapshots, and bounded
  fan-outs (budget lines, contact group membership, payroll employee detail,
  pay run detail plus payslips, project tasks and time entries, file
  associations, published BAS bodies).
- Excluded by design: attachments/history fan-outs, binary content, Finance
  API (closed partner API), Journals (no dev access yet; recorded
  `unavailable` in the manifest).
- Rate governance: ~1 req/s pacing, Retry-After honoured, and a 50-request
  daily reserve; when reached the run defers with exit code 75 and the
  `ingestion_manifest` table records exactly what remains.

Run:

```bash
npx tsx scripts/xero-official/run.mts --plan     # inspect the plan
npx tsx scripts/xero-official/run.mts --ingest   # full ingest
```

Python: reuses `.xero-dlt-venv` (see `scripts/xero-dlt-test/requirements.txt`),
or set `XERO_DLT_PYTHON`.
