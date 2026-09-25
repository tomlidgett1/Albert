# Codex opportunity-discovery smoke — Luna Max Fast

- Date: 2026-08-21
- Prompt: `Find one high-confidence opportunity I could test this month`
- Model: `gpt-5.6-luna`
- Reasoning: `max`
- Service tier: `fast`
- Data: synthetic fixture only

## Acceptance result

Passed in 160,161 ms with a `Qualified` grounded answer through signed
background-job polling and the isolated Codex sidecar.

- 11 successful governed queries
- 15 visible plan snapshots
- 4 evidence-bound progress updates
- All seven required lenses queried: sales, customers, product economics,
  inventory, workshop, workforce and Xero finance
- Owner-facing number formatting passed
- No terminal error event

The test exercises the real pinned Codex app-server, signed background-job
service boundary, bounded event polls, and Luna model against a fixture Cube
surface. It verifies research depth and orchestration without sending
production customer rows to a test harness.
