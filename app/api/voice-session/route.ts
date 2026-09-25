import {
  consumeAlbertRateLimit,
  ControlPlaneError,
  currentTenantContext,
  requireUser,
} from "@/services/control-plane/src/web-repository";
import {
  assertSameOriginMutation,
  rateLimitExceededResponse,
} from "@/services/control-plane/src/request-security";

export const maxDuration = 30;

/**
 * Establishes an OpenAI Realtime WebRTC call for the dash voice mode.
 *
 * The browser sends its SDP offer here; the server mints a short-lived
 * client secret and performs the SDP exchange with OpenAI itself, so the
 * page's CSP stays `connect-src 'self'` and the ephemeral key never reaches
 * the browser. The session is configured entirely server-side — model,
 * voice, persona instructions and the ask_albert tool. Business answers
 * never come from the realtime model itself: it must call ask_albert, which
 * the browser fulfils through the governed /api/codex-conversation stream.
 * (Only the signalling handshake goes through this route; audio and events
 * then flow directly browser <-> OpenAI over WebRTC.)
 */

const SESSION_TTL_SECONDS = 600;
const MAX_SDP_BYTES = 64_000;

const VOICE_INSTRUCTIONS = [
  "You are Albert's voice — the spoken interface to Albert, a governed analytics copilot for the owner's connected business data (point of sale, accounting, rostering).",
  "Language: English. Tone: warm, plain-spoken, unhurried, professional. Keep every reply short — this is a conversation, not a report.",
  "For ANY question about the business — sales, revenue, customers, products, inventory, cash, invoices, staff, rosters, trends, comparisons — you MUST call ask_albert. Never answer a business question from memory and never invent or estimate figures. Restate the user's request as one clear, self-contained analytical question when calling the tool.",
  "The moment you decide to call ask_albert, first say one very short confirmation in the same response — something like 'On it — pulling that up now' — then make the call. The user must hear you immediately, before the analysis starts.",
  "ask_albert can take anywhere from a few seconds to a couple of minutes. While it runs you will be prompted to give brief progress updates; keep each one to a single short, natural sentence, vary the wording, and never invent findings the update text does not contain.",
  "Sound like a sharp colleague thinking aloud, not a status bot. Never pad updates with filler such as 'hang tight', 'bear with me', 'I'll share the results soon' or 'I'll let you know as soon as it's done', and never announce that you're still working on it — either say something with substance or say almost nothing.",
  "Never mention Albert's internal machinery. Words like codex, governed, evidence, validation, draft, repair, runtime, semantic, catalogue, query, or tool must never be spoken. Say what it means for the owner in everyday language: 'double-checking the numbers', 'the numbers check out', 'nothing matched that'.",
  "Some progress updates carry early partial numbers ('first numbers are in'). Share them as a first look, clearly provisional, and read the figures exactly as given. If the final result later differs, the final result wins — deliver it plainly without dwelling on the discrepancy.",
  "When the tool result arrives, deliver it conversationally: lead with the headline numbers from key_findings, keep it to a few sentences. If state is not 'Verified', briefly convey the note. Mention that tables and charts are on screen when relevant. Offer at most one follow-up question.",
  "Numbers: figures are handed to you already written out in words ('four thousand, one hundred and twenty dollars') — read them exactly as written. If you ever encounter a figure in digits, read it as one full natural number ('one hundred and thirty'), NEVER digit by digit.",
  "If the result asks for clarification, ask the user the clarifying question aloud, then call ask_albert again with their clarified question.",
  "If the result state is 'Failed', apologise briefly and offer to try again.",
  "The user can interrupt you at any time; when they do, stop and listen.",
  "For greetings or small talk, reply briefly and invite a business question. For anything unrelated to the business, politely steer back.",
].join("\n");

const ASK_ALBERT_TOOL = {
  type: "function",
  name: "ask_albert",
  description:
    "Run Albert's governed analysis over the user's connected business data. Required for every question about business numbers or records. May take up to two minutes; progress updates are delivered separately while it runs.",
  parameters: {
    type: "object",
    properties: {
      question: {
        type: "string",
        description:
          "The user's request restated as one clear, self-contained analytical question in English, preserving any time period, metric or comparison they asked for.",
      },
    },
    required: ["question"],
  },
} as const;

function realtimeBaseUrl(): string {
  // Deliberately NOT OPENAI_BASE_URL: the AU data-residency endpoint mints
  // client secrets but refuses /realtime/calls for this organisation
  // ("this session must connect to api.openai.com", verified 2026-08-22).
  // Realtime voice is therefore global-routed, unlike every other OpenAI
  // call Albert makes — documented in ADR 0116.
  const configured = process.env.OPENAI_REALTIME_BASE_URL?.trim()
    || "https://api.openai.com/v1";
  return configured.replace(/\/+$/u, "");
}

function errorResponse(error: unknown) {
  if (error instanceof ControlPlaneError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  return Response.json({ error: "Voice mode is unavailable right now." }, { status: 503 });
}

export async function POST(request: Request) {
  try {
    assertSameOriginMutation(request);
    await requireUser();
    const tenant = await currentTenantContext();
    if (!tenant) {
      throw new ControlPlaneError("Voice mode needs an active organisation.", 409);
    }

    const rateLimit = await consumeAlbertRateLimit("conversation.voice_session");
    if (!rateLimit.allowed) return rateLimitExceededResponse(rateLimit);

    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      throw new ControlPlaneError("Voice mode is not configured.", 503);
    }

    const body = await request.json().catch(() => null) as { sdp?: unknown } | null;
    const offerSdp = typeof body?.sdp === "string" ? body.sdp : "";
    if (!offerSdp.startsWith("v=0") || offerSdp.length > MAX_SDP_BYTES) {
      throw new ControlPlaneError("A WebRTC offer is required.", 400);
    }

    const model = process.env.OPENAI_REALTIME_MODEL?.trim() || "gpt-realtime-2.1";
    const voice = process.env.OPENAI_REALTIME_VOICE?.trim() || "marin";
    const base = realtimeBaseUrl();

    const minted = await fetch(`${base}/realtime/client_secrets`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        expires_after: { anchor: "created_at", seconds: SESSION_TTL_SECONDS },
        session: {
          type: "realtime",
          model,
          instructions: VOICE_INSTRUCTIONS,
          // OpenAI's production guidance for voice agents; higher tiers add
          // speech latency the thin relay persona doesn't need.
          reasoning: { effort: "low" },
          tools: [ASK_ALBERT_TOOL],
          tool_choice: "auto",
          audio: {
            input: {
              noise_reduction: { type: "near_field" },
              transcription: { model: "whisper-1", language: "en" },
              turn_detection: {
                type: "server_vad",
                create_response: true,
                interrupt_response: true,
              },
            },
            output: { voice },
          },
        },
      }),
    });

    if (!minted.ok) {
      const detail = await minted.text().catch(() => "");
      console.error("voice-session mint failed", minted.status, detail.slice(0, 500));
      throw new ControlPlaneError("Voice mode could not start a realtime session.", 502);
    }

    const payload = await minted.json().catch(() => null) as {
      value?: unknown;
    } | null;
    if (!payload || typeof payload.value !== "string" || !payload.value) {
      throw new ControlPlaneError("Voice mode received an invalid realtime session.", 502);
    }

    // Server-side SDP exchange: the ephemeral key stays here, and the page's
    // CSP can keep connect-src 'self'. Media then flows over WebRTC directly.
    const call = await fetch(`${base}/realtime/calls`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${payload.value}`,
        "Content-Type": "application/sdp",
      },
      body: offerSdp,
    });
    if (!call.ok) {
      const detail = await call.text().catch(() => "");
      console.error("voice-session call failed", call.status, detail.slice(0, 500));
      throw new ControlPlaneError("Voice mode could not establish the realtime call.", 502);
    }
    const answerSdp = await call.text();
    if (!answerSdp.startsWith("v=0")) {
      throw new ControlPlaneError("Voice mode received an invalid call answer.", 502);
    }

    return Response.json(
      { sdp: answerSdp, model, voice },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
