# 0113. The Proactive control panel

Date: 2026-08-21
Status: Accepted

## Context

Albert answers questions the owner already knows to ask. The Proactive tab
inverts that: the owner presses Start once, a fleet of research agents studies
every surface of the business overnight-style, and each morning the owner opens
a control panel of findings — headlines, key numbers, and questions worth
exploring — instead of a blank composer.

Constraints discovered before design:

- **Leases.** `begin_albert_turn` is granted to `authenticated` only and
  `service_role` is denied across the control plane (0105). Cube's analytical
  capability is turn-bound (or dashboard-lease-bound). A background fleet
  therefore cannot run from a worker without a whole new lease kind; it *can*
  run from the signed-in browser session, which is exactly what the Start
  button provides.
- **Budget.** The Codex runtime allows up to 16 concurrent turns
  (`ALBERT_CODEX_MAX_CONCURRENT_TURNS`), each turn owning its own Cube
  orchestrator pool against an analytical Postgres capped at
  `max_connections = 60` that interactive turns and dashboard refreshes share.
- **Serverless windows.** One codex turn fits a route invocation
  (`maxDuration = 800`, analysis deadline 720 s); fifteen sequential waves do
  not.
- **Quality machinery.** ADR 0110/0112 give codex turns isolation, the
  analytical brief, sufficiency review, `derive_result`, grounded charts and
  the 8 k answer contract. A parallel "research runtime" would fork all of it.

## Decision

1. **Every research agent is a real codex conversation.** The client sends the
   agent's research prompt through the existing `/api/codex-conversation`
   route with `gpt-5.6-terra` at `max` effort ("Terra Max"). Nothing about the
   turn pipeline is forked; each agent's full evidence trace persists in
   `conversation_turn_events` like any other analysis.
2. **The fleet is client-orchestrated** (the ADR 0111 pattern): the Proactive
   workspace fans the roster out with bounded concurrency
   (`PROACTIVE_CLIENT_CONCURRENCY = 5`) from a module-level controller that
   survives tab switches. Codex streams carry
   `continueOnClientDisconnect: true`, so a mid-run reload costs at most the
   finding record, never the analysis; the panel offers resume for agents whose
   findings never landed.
3. **Findings are distilled server-side and persisted in two new
   control-plane tables**, `proactive_runs` and `proactive_findings`
   (migration 0158), written through SECURITY DEFINER RPCs
   (`albert_proactive_*`) with the 0153 posture: members read, owner/manager
   write, rate-limit policy `proactive.run`. A finding stores the headline,
   key numbers, the full answer markdown, the model's follow-up questions and
   the `(conversation_id, turn_id)` provenance pointer.
4. **The roster is code, not config**: fifteen agents in
   `services/proactive/src/roster.ts`, each declaring the connectors it needs,
   so the same roster degrades gracefully for tenants with fewer sources. The
   run route resolves the roster against `loadConnectorRouting` at Start time.
5. **Explore continues the agent's own conversation.** The explore popup shows
   the finding and its questions; choosing one opens a side-chat drawer that
   sends the question as a follow-up turn in that agent's conversation, so
   prior-result reuse and conversation context apply. The drawer renders with
   the production `InsightsStyleTrace` component.
6. **Proactive conversations stay out of the sidebar.** The panel RPC returns
   the proactive conversation ids and the dash shell filters them from the
   conversation list; they are reachable through the control panel instead.
7. **Deletion.** Tenant-scope purge discovers the new tables via the generic
   `tenant_id` column walk; connection-scope purge is extended in 0158 to
   invalidate proactive rows tenant-wide alongside the other query-derived
   artefacts.

## Iteration 2: the morning brief (2026-08-21)

Fifteen equal cards of dense figures overwhelmed the first user. The finished
panel now leads with a **synthesized three-tier brief** instead: a
plain-English verdict, the 3-5 ranked highlights that deserve attention this
week (each with why it matters and the tap-to-ask question routed into the
side chat), and one quiet line plus a collapsed list covering everything else.
Synthesis is one direct structured-output model call over the distilled
findings (`services/proactive/src/synthesis.ts` — no Cube, no lease),
triggered by the client when a run completes, persisted on the run row
(migration 0159, `albert_proactive_record_synthesis`). The research density
did not disappear; it moved one click deeper into the explore popup and the
agent conversations.

## Iteration 3: bento highlights and the question wall (2026-08-21)

The ranked highlights render as a bento grid — rank decides real estate. The
top highlight is a hero card (why + the question as its primary action), the
second a tall card, the rest compact tap-to-ask cards, each washed with a
subtle tone gradient. A hover-expand accordion was tried first and rejected:
text panels collapse into empty spines, so that pattern is reserved for image
content. Below the brief sits a refreshable wall of
~40 owner-voice questions written for this specific business by Luna at max
effort on the fast tier (`services/proactive/src/question-bank.ts`, migration
0160, `/api/proactive/questions`); tapping a sticker opens the side chat on a
fresh codex conversation. Luna reasoning tokens share `max_output_tokens`, so
the call carries a 20k budget and only complete question-mark-terminated
sentences survive validation.

## Consequences

- Starting a run consumes interactive-turn budget (Cube pools, the codex
  runtime concurrency, `conversation.turn` rate limit at ≤5 starts in flight).
  The concurrency bound and the `proactive.run` policy (6/hour) keep a run
  from starving live chat; a scheduled pre-dawn variant would need the new
  lease kind this ADR explicitly avoided and remains future work.
- A run is 15 Terra-max turns: minutes of wall clock and real model spend per
  press. The Start button says so instead of pretending it is free.
- Findings are extracted client→server from the answer event of a stream the
  same authenticated user just ran; the server re-distills from the submitted
  answer text and stores provenance ids, so a hostile client can only vandalise
  its own tenant's panel.
- The sidebar filter depends on the panel RPC; if it fails, proactive
  conversations appear in history (harmless, titled by the nano titler).
