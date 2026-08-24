# ADR 0118: Gemini 3.7 Flash on the Codex harness

- Status: Superseded by ADR 0119
- Date: 2026-08-23
- Owners: product and platform
- Extends: ADR 0110
- Does not modify: Albert V3 routing, engine, or release qualification

## Context

The Codex harness is OpenAI Codex CLI plus Albert's governed tools. Google
Gemini 3.7 Flash (`gemini-3.7-flash`, GA 2026-08-13) is useful as a fast
alternative, but Gemini's OpenAI-compatible endpoint does not implement the
Responses API that Codex CLI uses.

## Decision

- Add `gemini-3.7-flash` to the server-owned allowlist and the Codex model
  picker only. V3 keeps the existing five profiles.
- Drive Gemini through the official generateContent API
  (`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent`)
  with `x-goog-api-key`, Albert functionDeclarations, and Gemini 3
  `thinkingConfig.thinkingLevel`. Echo thought signatures and function-call
  ids on every tool step. Do not attach `responseJsonSchema`: Gemini 3.7
  Flash rejects Albert's answer schema as an invalid argument, including
  on a tool-free finalize turn. The host still validates the JSON
  candidate.
- Map Albert effort `none|low`/`medium`/`high|xhigh|max` to thinking
  levels `low`/`medium`/`high`. Gemini 3.7 Flash rejects `minimal`.
  Flash has no Fast service tier.
- Keep host-side sufficiency review and answer editing on Luna so Gemini
  turns do not call OpenAI Responses with a Gemini model id.
- Require `GEMINI_API_KEY` only when Gemini is selected. Credentials are
  never reused with OpenAI, xAI, or Anthropic.

## Consequences

Gemini investigations reuse the same Cube tools, grounding, and public
trace as Codex GPT turns. They do not use the pinned Codex CLI. Google
routes generateContent globally.
