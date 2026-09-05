import OpenAI, { toFile } from "openai";
import {
  consumeAlbertRateLimit,
  ControlPlaneError,
  requireUser,
} from "@/services/control-plane/src/web-repository";
import {
  assertSameOriginFormMutation,
  rateLimitExceededResponse,
} from "@/services/control-plane/src/request-security";

const MAX_AUDIO_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set([
  "audio/webm",
  "audio/mp4",
  "audio/mpeg",
  "audio/mpga",
  "audio/m4a",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
]);

function errorResponse(error: unknown) {
  if (error instanceof ControlPlaneError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  return Response.json({ error: "Transcription is unavailable." }, { status: 503 });
}

function extensionForMime(mimeType: string): string {
  if (mimeType.includes("webm")) return "webm";
  if (mimeType.includes("mp4") || mimeType.includes("m4a")) return "mp4";
  if (mimeType.includes("mpeg") || mimeType.includes("mpga")) return "mp3";
  if (mimeType.includes("wav")) return "wav";
  if (mimeType.includes("ogg")) return "ogg";
  return "webm";
}

export async function POST(request: Request) {
  try {
    assertSameOriginFormMutation(request);
    await requireUser();

    const rateLimit = await consumeAlbertRateLimit("conversation.transcribe");
    if (!rateLimit.allowed) return rateLimitExceededResponse(rateLimit);

    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) {
      throw new ControlPlaneError("Speech transcription is not configured.", 503);
    }

    const declaredLength = request.headers.get("content-length");
    if (declaredLength !== null) {
      if (!/^\d+$/u.test(declaredLength)) {
        throw new ControlPlaneError("Content-Length is invalid.", 400);
      }
      if (Number(declaredLength) > MAX_AUDIO_BYTES + 64_000) {
        throw new ControlPlaneError("Audio recording is too large.", 413);
      }
    }

    const form = await request.formData();
    const audio = form.get("audio");
    if (!(audio instanceof File)) {
      throw new ControlPlaneError("An audio recording is required.", 400);
    }
    if (audio.size < 1) {
      throw new ControlPlaneError("The recording was empty.", 400);
    }
    if (audio.size > MAX_AUDIO_BYTES) {
      throw new ControlPlaneError("Audio recording is too large.", 413);
    }

    const mimeType = (audio.type || "audio/webm").split(";", 1)[0]?.trim().toLowerCase() || "audio/webm";
    if (!ALLOWED_MIME_TYPES.has(mimeType)) {
      throw new ControlPlaneError("Unsupported audio format.", 415);
    }

    const openai = new OpenAI({
      apiKey,
      baseURL: process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1",
    });

    const bytes = Buffer.from(await audio.arrayBuffer());
    const file = await toFile(bytes, `dictation.${extensionForMime(mimeType)}`, {
      type: mimeType,
    });

    const transcription = await openai.audio.transcriptions.create({
      file,
      model: "gpt-transcribe",
    });

    const text = typeof transcription.text === "string" ? transcription.text.trim() : "";
    return Response.json(
      { text },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
