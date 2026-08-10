import { createHash } from "node:crypto";
import {
  ANTHROPIC_ALLOWED_TOOLS,
  ANTHROPIC_ANALYTICS_SYSTEM_PROMPT,
  ANTHROPIC_PRIMARY_MODEL,
  anthropicInternalTurnSchema,
  internalCompletionSchema,
  runAnthropicAnalyticsTurn,
  type AnthropicRunConfiguration,
} from "../../../packages/anthropic-analytics/src/index.js";
import { verifyInternalRequest, INTERNAL_SIGNATURE_HEADER, INTERNAL_TIMESTAMP_HEADER } from "../../../packages/security/src/index.js";
import { createServiceLogger, safeErrorEvidence } from "../../../packages/observability/src/index.js";
import type { TraceEvent } from "../../../packages/shared/src/index.js";
import type { AnthropicSessionRepository } from "./persistence.js";
import { TenantPostgresSessionStore } from "./persistence.js";
import { AnthropicAnalyticsMetrics } from "./metrics.js";

const encoder = new TextEncoder();
const logger = createServiceLogger("anthropic-analytics");

function databaseErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = Reflect.get(error, "code");
  return typeof code === "string" && /^[A-Z0-9]{5}$/u.test(code) ? code : undefined;
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function json(value: unknown, status: number): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

function internalEvent(name: string, value: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`;
}

function encodeTraceSseEvent(event: TraceEvent): string {
  return `id: ${event.sequence}\nevent: trace\ndata: ${JSON.stringify(event)}\n\n`;
}

export function createAnthropicAnalyticsHttpHandler(input: Readonly<{
  signingSecret: string;
  repository: AnthropicSessionRepository;
  runConfiguration: Omit<AnthropicRunConfiguration, "sessionStore" | "sessionId">;
  releaseSha: string;
  deploymentId: string | null;
  providerReady: () => Promise<boolean>;
  metrics?: AnthropicAnalyticsMetrics;
}>): (request: Request) => Promise<Response> {
  const metrics = input.metrics ?? new AnthropicAnalyticsMetrics();
  return async (request) => {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") return json({ status: "ok", runtime: "anthropic-analytics" }, 200);
    if (request.method === "GET" && url.pathname === "/metrics") return json(metrics.snapshot(), 200);
    if (request.method === "GET" && url.pathname === "/readyz") {
      const [storage, provider] = await Promise.all([input.repository.ready(), input.providerReady()]);
      return json({
        status: storage && provider ? "ready" : "not_ready",
        runtime: "anthropic-analytics",
        model: input.runConfiguration.model ?? ANTHROPIC_PRIMARY_MODEL,
        checks: { sessionStore: storage, provider },
        releaseSha: input.releaseSha,
        deploymentId: input.deploymentId,
      }, storage && provider ? 200 : 503);
    }
    if (request.method !== "POST" || url.pathname !== "/v1/turns") return json({ error: { code: "NOT_FOUND", message: "Unknown Anthropic analytics endpoint." } }, 404);

    const rawBody = await request.text();
    const verified = await verifyInternalRequest({
      method: request.method,
      path: url.pathname,
      body: rawBody,
      secret: input.signingSecret,
      timestamp: request.headers.get(INTERNAL_TIMESTAMP_HEADER),
      signature: request.headers.get(INTERNAL_SIGNATURE_HEADER),
    });
    if (!verified) return json({ error: { code: "INVALID_SIGNATURE", message: "Signed internal transport is required." } }, 401);

    const parsed = anthropicInternalTurnSchema.safeParse(JSON.parse(rawBody));
    if (!parsed.success) return json({ error: { code: "INVALID_REQUEST", message: "Anthropic turn input is invalid.", details: parsed.error.issues } }, 400);
    const turn = parsed.data;
    metrics.recordAccepted();
    let sessionBinding: Readonly<{ sessionId: string; created: boolean }>;
    try {
      sessionBinding = await input.repository.ensureSession({
        tenantId: turn.tenantId,
        actorUserId: turn.actorUserId,
        conversationId: turn.conversationId,
        turnId: turn.turnId,
        model: input.runConfiguration.model ?? ANTHROPIC_PRIMARY_MODEL,
        promptDigest: hash(ANTHROPIC_ANALYTICS_SYSTEM_PROMPT),
        toolsetDigest: hash(ANTHROPIC_ALLOWED_TOOLS),
      });
    } catch (error) {
      logger.error("session_establishment_failed", {
        ...safeErrorEvidence(error),
        databaseErrorCode: databaseErrorCode(error),
        conversationId: turn.conversationId,
        turnId: turn.turnId,
      });
      return json({ error: { code: "SESSION_UNAVAILABLE", message: "The Anthropic session could not be established." } }, 503);
    }

    const abortController = new AbortController();
    const abort = () => abortController.abort(request.signal.reason);
    request.signal.addEventListener("abort", abort, { once: true });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const enqueue = (value: string) => {
          if (!closed && !abortController.signal.aborted) controller.enqueue(encoder.encode(value));
        };
        const heartbeat = setInterval(() => enqueue(": keepalive\n\n"), 15_000);
        void runAnthropicAnalyticsTurn(turn, {
          ...input.runConfiguration,
          sessionStore: new TenantPostgresSessionStore(input.repository, turn.tenantId),
          sessionId: sessionBinding.sessionId,
          resumeSession: !sessionBinding.created,
          signal: abortController.signal,
        }, (event) => {
          // The proxy persists and finalizes the terminal event before exposing it.
          if (event.type !== "answer" && event.type !== "clarification") enqueue(encodeTraceSseEvent(event));
        }).then((result) => {
          metrics.recordCompletion(result.completion);
          enqueue(internalEvent("albert_internal_completion", internalCompletionSchema.parse(result.completion)));
        }).catch((error) => {
          metrics.recordRuntimeFailure();
          logger.error("turn_runtime_failed", {
            ...safeErrorEvidence(error),
            conversationId: turn.conversationId,
            turnId: turn.turnId,
          });
          enqueue(internalEvent("albert_internal_failure", { code: "ANTHROPIC_RUNTIME_FAILURE", message: "The Anthropic analytics runtime failed safely." }));
        }).finally(() => {
          clearInterval(heartbeat);
          request.signal.removeEventListener("abort", abort);
          if (!closed) {
            closed = true;
            controller.close();
          }
        });
      },
      cancel(reason) {
        metrics.recordAbort();
        abortController.abort(reason);
        request.signal.removeEventListener("abort", abort);
      },
    });
    return new Response(body, {
      headers: {
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "Content-Type": "text/event-stream; charset=utf-8",
        "X-Accel-Buffering": "no",
        "X-Albert-Runtime": "anthropic",
        "X-Albert-Conversation-Id": turn.conversationId,
        "X-Albert-Turn-Id": turn.turnId,
      },
    });
  };
}
