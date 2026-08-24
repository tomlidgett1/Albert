# ADR 0117 — Recommended analysis on the homepage

Date: 2026-08-23 · Status: accepted · Migrations: 0163, 0164

## Context

A good analytics tool does not ask the owner to think of the next question.
The first homepage cut read the last few chats and stacked five recommended
cards on top of four recent-history cards. That was cluttered, and last-four
recency is too shallow for a product whose point of difference is
proactiveness.

Proactive (ADR 0113) is the overnight research fleet. Semantic memory
(ADR 0115) binds vocabulary. Neither, on its own, turns the owner's longer
analysis history into the next brief worth opening the app for.

## Decision

1. **Corpus, not last-four.** The source is a standing corpus: up to twenty
   answered briefs from the last eighty owner conversations, plus a sixty-thread
   coverage index (titles and latest questions). Eval/test threads, archived
   threads and Proactive research conversations are excluded. The playbook
   looks for neglected surfaces, unfinished work, cross-thread tension,
   connector close-the-loop, stale weekly looks, and overnight research
   highlights. Recency is a slight boost, not the ranking.

2. **Two-stage brief.** A deterministic playbook produces an instant verdict
   plus three self-contained next questions. A Luna pass on the fast tier then
   rewrites the verdict and ranks the three questions against the actual
   findings. The playbook is the fallback. Questions never invent figures.

3. **Cache.** One row per `(tenant, user)` keyed by a fingerprint of briefs,
   coverage and the latest proactive run. Homepage GET returns the cache when
   the fingerprint matches, otherwise the playbook. POST refines and persists.
   Rate-limit policy `conversation.recommended_analysis` (12/hour) applies only
   to generation.

4. **Surface.** The New Analysis homepage is the composer plus one briefing
   panel: a two-sentence read and three tap-to-ask rows. Recent history stays
   in the sidebar. Tapping a row starts a fresh conversation. Questions are
   written so they stand alone.

## Consequences

- Recommendations evolve when a new analysis completes, coverage changes, or
  overnight research lands.
- Close-the-loop prompts respect connected tools (no cash question without
  Xero, no labour question without Deputy).
- The panel is hidden when there is no answered analysis and no research
  highlight to continue.
