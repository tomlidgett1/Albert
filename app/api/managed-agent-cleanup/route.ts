import { createHash, timingSafeEqual } from "node:crypto";
import OpenAI from "openai";
import { cleanupManagedSessions } from "@/packages/albert-agents-api/src/retention";
import { createServiceLogger, safeErrorEvidence } from "@/packages/observability/src";

export const maxDuration = 300;
const logger = createServiceLogger("albert-managed-retention");

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  const supplied = request.headers.get("authorization") ?? "";
  if (!secret || !timingSafeEqual(createHash("sha256").update(supplied).digest(), createHash("sha256").update(`Bearer ${secret}`).digest())) {
    return new Response("Unauthorized", { status: 401 });
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return Response.json({ error: "Agent retention is not configured." }, { status: 503 });
  try {
    const counts = await cleanupManagedSessions(new OpenAI({ apiKey, baseURL: "https://api.openai.com/v1", maxRetries: 2, timeout: 15_000 }), { signal: AbortSignal.timeout(240_000) });
    logger.info("managed_retention.completed", counts);
    return Response.json(counts, { status: counts.failed ? 503 : 200, headers: { "cache-control": "no-store" } });
  } catch (error) {
    logger.error("managed_retention.failed", safeErrorEvidence(error));
    return Response.json({ error: "Agent retention did not complete." }, { status: 503 });
  }
}
