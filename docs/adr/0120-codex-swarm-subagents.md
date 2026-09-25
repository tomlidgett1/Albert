# ADR 0120: Codex Swarm sub-agents

- Status: accepted
- Date: 2026-08-24
- Depends on: ADR 0110, ADR 0111, ADR 0112, ADR 0113
- Ordinary Codex and V3 turns remain unchanged unless the owner presses Swarm.

## Context

Hard owner questions span more than one system, period, or causal path.
A single Codex turn has one context window and tends to chase the first
promising slice. Codex's own product solves this with sub-agent threads:
the main chat stays on the question, specialists work in isolated threads,
and the parent waits, then writes one answer.

Albert already has the pieces. ADR 0110 isolates the Codex harness.
ADR 0111 and 0113 prove that the signed-in browser can fan out real
`/api/codex-conversation` turns (leases stay on `authenticated`;
`service_role` cannot begin a turn). What is missing is an on-demand,
question-driven allocation, a Codex-style progress slide-out, and a
parent answer that is synthesised from the child evidence.

Blind clones of the same question are Compare, not Swarm. A production
swarm has to allocate disjoint work, cap fan-out, and keep numbers
Cube-backed.

## Decision

1. **Swarm is an explicit Codex mode.** A Swarm button on the Codex
   composer opts the next send into the fleet. It never auto-fires from
   Albert V3. Switching Swarm on while a V3 conversation is open starts a
   new Codex conversation (runtime lock from ADR 0110).
2. **The orchestrator allocates, it does not clone.** A structured
   planner (no Cube, no lease) reads the question, active connectors, and
   a short business-context excerpt, then emits 2-5 work packages. Each
   package has a role, a must-cover assignment, and an explicit exclude
   list so agents do not duplicate. A shared period is used only when the
   question names one or is a movement/KPI question; snapshot briefs stay
   "As asked" and must not invent a 13-week window. A deterministic
   fallback splits by connected domain (sales, labour, cash) and adds a
   challenge agent on causal questions when the model plan is missing or
   invalid.
3. **Every worker is a real Codex conversation.** The browser fans the
   packages through `/api/codex-conversation` with bounded concurrency
   (3). Each child owns its own conversation, turn, Cube orchestrator,
   and trace. Child conversations stay out of the sidebar, the same way
   Proactive research threads do.
4. **The parent conversation is the owner's thread.** `/api/swarm`
   begins a Codex parent turn for the submitted question, persists a
   `plan` event, and later appends the synthesised `answer`. Child traces
   are never merged into the parent (ADR 0111). The slide-out is a view
   over the child conversations, not a second source of truth.
5. **Synthesis waits for the fleet.** When every agent has completed or
   failed, a second structured call reads only the distilled findings.
   It may not invent figures. The parent answer state is Derived when any
   child returned governed numbers, Exploratory when that is all they
   had, and Unavailable when nothing completed. Disagreements are named,
   not averaged away.
6. **Coordination is hub-and-spoke, depth 1.** Workers do not talk to
   each other. They receive the shared period and the other agents'
   titles so they stay in lane. There is no nested swarm and no
   blackboard. One extra wave is out of scope for this version.
7. **The slide-out matches Codex's agents panel.** Active and Done
   lists, a live status line per agent, stop, and a tap-through to that
   child's own trace. Opening the panel does not pause the fleet.

## Persistence

Migration 0168 adds `control_plane.swarm_runs` and
`control_plane.swarm_agents`, written through `albert_swarm_*` RPCs.
Access is membership-scoped. Rate-limit policy `swarm.run` is 10 starts
per hour. Connection-scope deletion invalidates swarm rows tenant-wide
with the other query-derived artefacts.

## Comparability and cost

A swarm consumes one parent lease plus one lease per concurrent child.
Workers inherit the owner's Codex model and effort. The planner and
synthesizer use Terra at medium effort and never open Cube. The UI
discloses that Swarm runs several governed turns.

## Out of scope

Automatic delegation without the Swarm button. Nested swarms. Agent-to-
agent chat. V3 workers. A durable cross-device live pair beyond the
persisted run row (reload resumes from that row).

## Update — 2026-08-24: staged waves, grounded periods, governed synthesis

Five hardening changes, still within the original decision:

1. **Challenge and reconcile run as a second wave.** Measure and explain
   agents go first; when they settle, the browser briefs the second wave
   with their distilled findings (headline, key numbers, confidence) so a
   challenge argues against the real story. Still hub-and-spoke, depth 1:
   the brief is one-way and marked untrusted evidence.
2. **The shared window is resolved once into ISO dates.** When a plan
   carries a shared window (`plan.period`), workers are told the exact
   query and comparison dates instead of re-deriving a label — period
   grounding is Codex's biggest measured failure mode (ADR 0114). Snapshot
   briefs keep `period: null` and the "As asked" rule. The parent answer's
   provenance time range now carries the resolved dates.
3. **Model plans are validated, not trusted.** Paraphrased-overlapping
   assignments (token-Jaccard, not string equality) and work naming a
   source the tenant has not connected reject the plan to the fallback;
   an invalid period alone is salvaged with the computed default.
4. **Allocation and synthesis are observable.** The plan jsonb records
   `source`, `periodSource`, and `issue`; the stored synthesis records
   `source` and `unsupportedFigures`; fallbacks log at warn with the
   reason instead of being swallowed.
5. **Synthesis figures are enforced, not just instructed.** Every dollar
   and percentage figure in the draft must match a finding (by magnitude,
   0.5% tolerance). Unsupported figures get one named repair attempt;
   whatever survives demotes the parent answer from Derived to
   Exploratory and is persisted for review.

## Update — 2026-08-24: the fleet survives the browser that started it

The orchestrator lives in a tab, so a close, reload, or slept laptop used
to strand `swarm_runs`/`swarm_agents` in 'running' forever, and a record
POST that failed could mark a finished analysis failed. Migration 0169,
still within the original decision (browser-authenticated leases;
`service_role` never begins a turn):

1. **Stranded runs reconcile on hydrate.** Reopening a conversation whose
   run is still open, with no fleet in that browser, asks
   `/api/swarm/reconcile`. The RPC is gated on the parent turn's lease —
   a live orchestrator renews it from the heartbeat and agent lifecycle
   routes — so an expired lease is proof the browser is gone, and a live
   run on another device is untouched. Still-open agents fail with a
   disconnect note, the run settles, and the normal hydration path then
   asks synthesis to salvage whatever completed.
2. **Child answers are recovered server-side.** Each child turn persists
   its answer on its own conversation before the browser relays it.
   Synthesis re-reads every child's persisted answer by its stored
   conversation/turn ids, prefers it over the browser-relayed copy, and
   recovers a 'failed' agent row whose analysis actually finished
   (`albert_swarm_agent_completed` now accepts recovery from 'failed';
   'stopped' stays terminal because the owner chose it).
3. **A synthesised parent turn completes instead of failing.**
   `albert_swarm_complete_parent_turn` closes the turn as completed with
   the answer state taken from the persisted synthesis — lineage the
   retired browser-callable `complete_albert_turn` could not establish.
   History and model context accept the swarm completion receipt in
   `result_digest` in place of an answer artifact. Unavailable synthesis
   still releases the turn as failed, matching the other runtimes.

Relaunching unfinished agents from their persisted prompts on hydrate was
considered and deliberately left out: a page visit must not silently spend
model budget; salvage-then-settle is deterministic.
