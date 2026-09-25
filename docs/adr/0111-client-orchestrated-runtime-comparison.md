# ADR 0111: client-orchestrated Albert and Codex comparison

- Status: accepted for an experimental product comparison
- Date: 2026-08-20
- Depends on: ADR 0110
- Ordinary runtime behavior remains unchanged unless a request explicitly sets
  the comparison-mode flag.

## Context

The owner wants to submit one question and watch normal Albert V3 and the
isolated Codex harness analyse it at the same time. The existing dashboard chat
state has one active runtime, conversation, turn, trace and cancellation owner.
Driving that state twice would race message caches, runtime locks and SSE event
ordering.

Albert also enforces conversation runtime immutability. One conversation cannot
contain one V3 turn and one Codex turn. App-server itself exposes independent
thread/turn lifecycle and interruption events, but Compare must not weaken the
separate Albert trust boundaries. OpenAI documents this lifecycle through the
[Codex app-server protocol](https://developers.openai.com/codex/app-server).

## Decision

Compare is a third client workspace alongside Albert and Codex. It owns two
independent lanes and calls the existing authenticated endpoints concurrently:

- Albert lane: `/api/v3-conversation`
- Codex lane: `/api/codex-conversation`

No Compare code is imported by either backend. Each lane receives an exact copy
of the submitted user text and starts a fresh, runtime-locked durable
conversation. It owns its own abort controller, immutable conversation/turn
headers, SSE buffer, event-id set, trace, status and latency observations. A
run identifier fences late events after stop/reset.

For a useful harness comparison, the Albert lane is snapshotted to the same
reviewed model profile as Codex: GPT-5.6 Luna, Max reasoning and Fast tier. The
Albert specialist is always `general`. Both calls are launched before either is
awaited; a failure or capacity rejection in one lane never cancels or hides the
other.

Both requests carry `comparisonMode: true`. Each authenticated route derives
the same versioned analytical brief from the exact message, active connectors
and freshness vector. The brief freezes the owner goal, must-cover obligations,
required views/calculations and a common period end. Both responses return its
digest; the client fails the affected lane if the digests differ. Ordinary V3
and Codex requests omit this comparison contract, except that Codex may still
derive a domain-specific brief for a governed flagship question.

The UI renders one shared question and two equal-width, independently scrolling
trace panes. Desktop is side-by-side; compact layouts stack both panes without
destroying either stream. Users can stop either lane or both. Follow-up chips
populate the shared composer and never auto-send to only one runtime.

## Comparability boundary

This is an observed product comparison, not a controlled benchmark:

- the user text, model, effort, service tier and analytical-brief digest are shared;
- prompts, context encoding and tool sets are intentionally runtime-specific;
- reads are live and do not share one database snapshot or frozen watermark;
- each run consumes two independently rate-limited governed turns; and
- each child appears as its own normal conversation in history. There is no
  cross-device durable pair entity in this version.

The UI states these caveats. It reports first-evidence and terminal-answer
latency separately, using client receipt time from the shared submit. It does
not compare acknowledgement time, stream-close time, stopped/failed lanes, or
declare a single-run winner. When both lanes return a terminal answer or
clarification, it shows the two observed answer times neutrally.

## Security and evidence

Compare never merges trace arrays, result identifiers, provenance or answer
states. Every pane uses the same sanitized public TraceEvent contract as its
ordinary runtime. Raw prompts, provider payloads, tool arguments and reasoning
remain unavailable. The feature doubles provider exposure and persistence for
the submitted question; the UI discloses that it runs and saves two governed
turns.

Opening another runtime or unmounting Compare aborts both active client
requests. Server-side leases and terminal handling remain owned by the existing
routes. There is no automatic retry because a request may have created a
durable turn before a client loses its response headers.

## Future benchmark mode

A statistically meaningful benchmark requires a server-owned, tenant-scoped
comparison envelope, atomic two-turn rate reservation, one frozen analysis
clock/context/watermark vector, common semantic-version evidence, paired usage
receipts and repeated randomized trials. Those are deliberately not implied by
this product view.
