# 0130 — Discover: the chat gets a second surface, and one harness

Date: 2026-09-01. Status: accepted.

## The ask

Three changes to the main chat. Remove the harness selector (Albert / Codex /
Omni / Compare) — Omni is the product and must be the default. Remove the
Key Insights side panel. Move the raw debugger out of the header and into
the model selector. Then add a Chat / Discover slider, where Discover shows
about thirty well-designed cards of questions worth asking, each grounded in
the owner's business and connected tools, with the tools the analysis will
most likely use.

## Decisions

### One harness in the chat

Omni (ADR 0129 era `packages/albert-omni`) is the only runtime the chat
offers. The `ChatRuntime` state and the Albert, Codex and Compare code paths
stay: saved conversations restore their runtime from the server receipt,
voice mode pins Codex, and Compare is a workspace of its own. They are simply
no longer a header control. An internal `?runtime=albert|codex|compare`
query parameter opens them for verification (browser acceptance uses it);
it is not a product surface and nothing links to it.

### Key Insights retired

The side panel derived per-turn signals from returned tables. With Omni's
inline trace, pivot cards and the dashboard preview it duplicated what the
answer already shows. The toggle, the panel branch and its styles are gone;
Reasoning, Swarm and the dashboard preview keep the shared side-panel slot.
The pure `key-insights.ts` derivation stays with its contract test.

### Debugger inside run settings

The raw debugger is a developer inspector, not an owner control. It now sits
in the model selector popover as a "Developer" switch, so the header carries
only owner-facing actions. The trigger's accessible summary is unchanged.

### Chat / Discover slider

A measured segmented pill (the dash 36px track / 30px thumb control) sits at
the top-left of the chat card as a `tablist`, with 12px of top padding above
it. The chat header becomes a three-column grid — slider, title, actions — so
the title truncates beside the slider while the actions hug the right.
Discover replaces the conversation body inside the same workspace card;
header actions and side panels are untouched.
New Analysis, opening a saved conversation, and asking from a card all
return to Chat.

### Discover cards

Discover is a `library → model` surface, mirroring the homepage recommended
analysis (ADR 0117):

- **Library floor.** `services/discover/src/library.ts` holds ~66 curated
  entries keyed to *capabilities* (point of sale, accounting, labour, till,
  stored value, studio, subscriptions, online…) rather than tools. Selection
  resolves each capability to the tenant's connected connector, so one entry
  covers Lightspeed, Square and Shopify and shows whichever logos the tenant
  really has. Cards whose capabilities are not connected never appear.
  Domains are interleaved so the grid reads as a tour of the business, and
  cross-tool cards rank slightly higher because they show what connecting
  tools unlocks. The grid paints from the library immediately.
- **Model personalisation.** `POST /api/discover` rewrites the library for
  the business with Luna (fast tier, low effort, strict schema) over the
  rendered business context (ADR 0098), the connected tools and the governed
  data areas each exposes (`accessibleViews`). Output is accepted only when
  it names connected tools, has no duplicates, keeps every domain to at most
  six cards, and returns at least twenty; otherwise the library stays.
- **Per-tenant cache.** Migration 0182 stores the cards per tenant, keyed by a
  fingerprint of connected tools, business-context revision and library
  version. Cache hits never consume the `conversation.discover_prompts` rate
  bucket (8/hour). The repository treats a missing migration as "no cache",
  so the surface works before 0182 is applied.
- **Copy, never numbers.** A card carries a title, a one-sentence why and the
  owner-voice prompt that is sent to chat. Nothing on a card is presented as
  governed data; the answer is.

## Consequences

- Browser acceptance no longer drives a runtime menu; helpers navigate with
  `?runtime=` and assert the workspace's `data-chat-runtime` stamp.
- `conversation-runtime-tabs.tsx` and `KeyInsightsPanel.tsx` are deleted;
  the `ConversationRuntimeTab` type now lives with the Compare workspace.
- Applying 0182 to the production control plane follows the usual migrate
  ceremony; until then Discover regenerates on each refresh within the rate
  bucket.
