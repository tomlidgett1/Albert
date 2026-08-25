# ADR 0125: Codex Super agent test mode

- Status: accepted
- Date: 2026-08-25
- Depends on: ADR 0110, ADR 0112, ADR 0120, ADR 0124
- Ordinary Codex, V3, Proactive, and Swarm turns remain unchanged unless the
  owner explicitly presses Super agent.

## Context

Some owner questions need more than a broad parallel fan-out. “How can we
improve profitability?” needs an analyst to establish the profit baseline,
test revenue and margin levers, inspect operating costs, test capital and
labour productivity, and then challenge the proposed actions against contrary
evidence. A single 12-minute Codex turn often stops after the first plausible
story. One 45-minute Vercel request is not a safe substitute: the web route has
an 800-second ceiling and a disconnected request must not own durable work.

Albert already has the correct execution boundary. ADR 0120 persists a parent
run, executes governed Codex child conversations from the signed-in browser,
renews the parent lease, hides child conversations from ordinary history, and
grounds the final synthesis only in recorded findings.

## Decision

1. **Super agent is an explicit, test-only Codex action.** A `Super agent`
   button beside Swarm opts the next submitted question into this mode. Super
   agent and Swarm are mutually exclusive. Switching it on from another
   runtime starts a clean Codex conversation.
2. **One question receives five ordered evidence passes.** The fixed plan is:
   profit baseline, gross-margin and sales levers, operating-cost structure,
   capital/labour/cash productivity, then adversarial prioritisation. Passes
   run sequentially (`concurrency = 1`), and the final challenge receives the
   earlier distilled findings. Each prompt requires repeated
   hypothesis → governed query → contradiction → drill-down loops and forbids
   stopping at the first plausible explanation.
3. **The wall-clock budget is 45 minutes, not an entitlement to idle.** The
   controller stops launching work at 45 minutes, records unfinished passes
   honestly, and synthesises whatever governed evidence completed. It may
   finish earlier when every pass completes or evidence saturates; it never
   waits merely to make the timer look deeper.
4. **The fixed quality profile uses Sol only as the planner, Luna as the
   explorer, and Pro for final synthesis.** Every pass receives the standard
   Sol/Max planning preflight from ADR 0123, then GPT-5.6 Luna performs the
   governed investigation at Max effort with Fast mode off. The one evidence-
   only Luna/Max parent synthesis uses Pro. The selected composer settings do
   not weaken this test profile. Pro remains independently provider-verified
   under ADR 0124; a provider rejection is visible and never a silent downgrade.
5. **Progress is public, bounded, and content-safe.** While active, the panel
   publishes a checkpoint every two minutes containing elapsed time, the
   current pass, completed-pass count, and governed-query count. Query and
   evidence events may update the panel more frequently. No checkpoint exposes
   private chain-of-thought or source rows.
6. **Persistence reuses the Swarm run contract.** The run stores
   `plan.kind = "super-agent"`, the 45-minute budget, and the two-minute
   checkpoint interval. Its children use the existing tenant-scoped
   conversation and evidence contracts. No new database role, query surface,
   connector permission, or vendor write path is introduced.
7. **The first dogfood question is exact.** The canonical test prompt is “How
   can we improve profitability?” The button remains question-driven,
   so later tests can submit a different owner question through the same
   bounded mode.
8. **Synthesis fails over without becoming shallow.** Pro receives a 48k
   output allowance because Responses counts invisible reasoning tokens inside
   `max_output_tokens`. If Pro still returns an incomplete structured answer,
   Albert retries once on the same Luna/Max profile with Pro and Fast both off.
   If the provider remains unavailable, the deterministic fallback preserves
   every successful finding, every key number, explicit failed obligations and
   a 30/60/90 decision cadence instead of collapsing to one generic next step.
   One shared 12-minute synthesis deadline leaves the web route time to persist
   that governed fallback before its platform ceiling.

## Consequences

- The browser must stay signed in while the sequential fleet is active, as in
  Swarm and Proactive. Navigation inside `/dash` does not stop it; a browser or
  device shutdown can interrupt the client-orchestrated run.
- Five Sol-planned Luna/Max evidence turns plus one Luna/Max/Pro synthesis can
  be materially expensive. The existing run-rate limit, Codex capacity queue,
  Cube isolation, query budgets, grounding, evidence validation, and Stop
  control all continue to apply.
- “45 minutes” is displayed as a hard budget. Completion before the deadline
  is success when every evidence obligation is settled, not a reason to burn
  time with redundant queries.
