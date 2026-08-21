# Codex visible-plan smoke test — Luna Max Fast

- Date: 2026-08-21
- Runtime: pinned Codex app-server `0.148.0`
- Model: `gpt-5.6-luna`
- Reasoning: Max
- Processing: Fast
- Data: synthetic `Fixture Cycles` metadata and rows only
- Runner: `scripts/codex-plan-smoke.mts`

## Result

All five genuinely complex cases emitted a native plan before the first
semantic query, used two to six steps, and emitted more than one status
snapshot. The scalar control emitted no plan. All six turns completed.

| Case | Expected plan | Plan snapshots | Steps | Before first query | Status progression | Native final all completed | Duration |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Multi-domain health | Yes | 3 | 4 | Yes | Yes | Yes | 37.4s |
| Margin-driver diagnosis | Yes | 3 | 4 | Yes | Yes | Yes | 35.9s |
| Stock readiness | Yes | 4 | 5 | Yes | Yes | Yes | 43.1s |
| Workshop capacity | Yes | 2 | 4 | Yes | Yes | Yes | 32.8s |
| Customer health | Yes | 2 | 5 | Yes | Yes | No | 28.5s |
| Scalar net-sales control | No | 0 | 0 | n/a | n/a | n/a | 29.7s |

The customer-health turn completed after two native snapshots without marking
every native task `completed`. This is why Albert cannot blindly mirror Codex
statuses: the host now terminally settles the public checklist, marking only
evidence-backed work done and any unsupported remainder incomplete before the
answer event.

The test records plan/event/timing metadata and tool counts only. It does not
record answer text, prompts from a real tenant, customer rows, credentials or
private reasoning.
