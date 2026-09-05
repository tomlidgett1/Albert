# ADR 0116 — Realtime voice mode over the governed Codex pipeline

- Status: Accepted
- Date: 2026-08-22

## Context

Owners want to talk to Albert: press a button, ask "tell me about sales today"
out loud, and hear an answer. Codex analytical turns routinely run from tens of
seconds to a couple of minutes, so a voice interface that goes silent while the
harness works feels broken; it must narrate progress the way the visual trail
does.

OpenAI's Realtime API (GA since 2025-08; current flagship model
`gpt-realtime-2.1`) provides native speech-to-speech over WebRTC with function
calling, async tool execution, and out-of-band responses that can be spoken
without polluting conversation context.

## Decision

**The realtime model is the mouth and ears only; Albert stays the brain.**

1. **Server-brokered sessions with a proxied SDP handshake.**
   `POST /api/voice-session` (same-origin assert → `requireUser` → tenant
   check → `conversation.voice_session` rate-limit bucket, DB policy row in
   migration 0162) takes the browser's WebRTC SDP offer, mints a short-lived
   client secret via `POST {base}/realtime/client_secrets`, performs the SDP
   exchange with `POST {base}/realtime/calls` itself, and returns only the
   answer SDP. The page's CSP keeps `connect-src 'self'` (the app CSP blocks
   third-party fetches, which is also why the browser cannot do the handshake
   directly), and the ephemeral key never reaches the browser; audio and the
   `oai-events` data channel then flow directly browser↔OpenAI over the peer
   connection, which `connect-src` does not govern. Model
   (`OPENAI_REALTIME_MODEL`, default `gpt-realtime-2.1`), voice
   (`OPENAI_REALTIME_VOICE`, default `marin`), persona instructions and the
   single `ask_albert` function tool are all fixed server-side. The realtime
   base honours `OPENAI_REALTIME_BASE_URL` and deliberately defaults to the
   **global** `https://api.openai.com/v1`, not `OPENAI_BASE_URL`: the AU
   data-residency endpoint mints client secrets but rejects
   `/realtime/calls` for this organisation ("this session must connect to
   api.openai.com", verified live 2026-08-22). Realtime voice audio is
   therefore processed on OpenAI's global endpoint — a documented exception
   to the AU-residency posture of every other OpenAI call Albert makes, to
   be revisited if OpenAI enables AU-regional realtime for the org.

2. **Every business question goes through the existing governed turn.** The
   session instructions force `ask_albert` for any data question and forbid
   invented figures. The browser fulfils the tool call by running the normal
   chat pipeline (`sendChatMessage` → `/api/codex-conversation` SSE), so the
   spoken question lands in the visible chat thread with its full trace,
   charts and tables. The tool result handed back to the voice model is a
   bounded JSON digest built by `buildAnswerToolOutput`: markdown stripped for
   speech (tables elided to "the full table is on screen"), up to six claim
   statements, up to three follow-ups, and the answer state.

3. **Progress narration from the public trace stream only.**
   `describeTraceEventForVoice` maps `narrative` / `progress` / `query` /
   recoverable `error` events to owner copy (the same softening rules as
   `InsightsStyleTrace`); plans, tables, charts and validations stay silent. A
   narration tracker dedupes lines, enforces a minimum spoken interval (~14s),
   and emits a "still …" heartbeat (~32s) so long turns never go quiet. Updates
   are delivered as **out-of-band** `response.create` events
   (`conversation: "none"`) so they are spoken without entering conversation
   history, and only when no other response is active. The trace's
   `forbiddenTraceKeys` guarantee (no SQL/prompts/tool arguments) therefore
   extends to the voice channel by construction.

4. **Clarifications and failures round-trip through the tool contract.** A
   clarification outcome returns the question + option labels with an
   instruction to ask aloud and call `ask_albert` again with the clarified
   question (the option-id confirmation flow is not used by voice in v1).
   Stopped or failed turns return a `Failed` payload the model apologises for.

5. **UI.** A waveform "voice" button sits in the composer next to dictation.
   While live, the input row shows the existing `DictationWaveform` canvas
   driven by whichever side is speaking (mic analyser, or the remote WebRTC
   track's analyser while the assistant responds) plus a one-line status
   ("Listening" / latest progress line / "Speaking"); the button pulses and
   ends the session on tap. Barge-in is server VAD with
   `interrupt_response: true`.

## Latency posture (added 2026-08-22)

A spoken wait hurts far more than a read one, so voice trades depth for speed
at three layers — none of which adds compute (the analytical DB runs at its
connection ceiling, so "run a second fast turn in parallel" was rejected):

1. **Fast profile.** Voice turns override the selector's preferences with
   `reasoningEffort: "low"` + `fastMode: true` (the default selector profile
   is `max`), falling back to `gpt-5.6-luna` when a non-codex model is
   selected. Typed questions keep whatever depth the selector asks for.
2. **Instant confirmation.** The persona instructs the model to speak a
   one-line "on it" in the same response as the `ask_albert` call (GA async
   function calling), so the user hears feedback before the turn even starts.
3. **Early numbers.** `describeTableEventForVoice` turns the first two
   completed governed `table` events into a spoken "first numbers are in"
   headline (caption + top-row label + up to two measures, technical-name
   guarded). The harness streams these long before the answer; the persona
   frames them as provisional and the final result always wins.
4. **Human cadence, not a status bot.** Substantive lines (commentary, query
   topics, table headlines) speak ~11s apart; fixed stage labels ("looking up
   your numbers") are classed generic — they wait ~26s, most are never spoken,
   and they can never displace pending substance. A quiet stretch produces one
   brief few-word check-in at ~45s instead of a re-announcement, and the
   persona bans filler ("hang tight", "I'll share the results soon") outright.
5. **Numbers are verbalised deterministically.** Realtime models read bare
   digits unreliably ("one two four three" for 1,243), so every figure handed
   to the voice is spelled out in words first (`numberToSpokenWords` /
   `currencyToSpokenWords` / `spellOutNumbersForSpeech`): table headlines,
   the answer digest and claim statements all arrive as "four thousand, one
   hundred and twenty dollars". Numeric strings ("0.00", "$1,234.56"), bare
   decimals and standalone integers of three or more digits convert too;
   year-shaped integers, times and small counts are left alone so dates never
   get mangled.
6. **No machinery vocabulary.** Lines about internal activity ("Albert
   checked the draft, codex is repairing it") are rewritten to plain owner
   language ("double-checking the numbers") or silenced by
   `sanitizeSpokenLine`; the answer digest carries no ceremony for verified
   answers (never "checked against governed evidence"); and the persona bans
   the machinery lexicon (codex, governed, evidence, validation, draft,
   repair, runtime, semantic, catalogue) outright.

## Consequences

- Voice sessions cost realtime audio tokens on top of the codex turn; the
  mint bucket (10/min) and 10-minute secret TTL bound exposure.
- The voice layer is client-orchestrated (like ADR 0111's comparison
  workspace): closing the tab ends narration, but the codex turn itself
  survives (`continueOnClientDisconnect`) and its result stays in the thread.
- `tests/contracts/voice-narration.contract.test.ts` pins the narration
  copy rules, the spoken-answer digest bounds, and the server-side session
  contract (auth, rate limit, ask_albert declaration).
