import { signInternalRequest } from "../../security/src/index.js";
import {
  codexQueryAuditEventSchema,
  codexSemanticTurnResultSchema,
  type CodexQueryAuditEvent,
  type CodexServiceTurn,
} from "./contracts.js";
import type {
  CodexSemanticTurnResult,
  CodexTraceEventInput,
  EmitCodexTrace,
} from "./semantic-runtime.js";

const JOBS_PATH = "/v1/codex/jobs";
const MAX_STREAM_LINE_BYTES = 1_500_000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class CodexRuntimeServiceError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "CodexRuntimeServiceError";
  }
}

function runtimeRejectedError(status: number, body: string): CodexRuntimeServiceError {
  let payload: { error?: { code?: string; message?: string } } | undefined;
  try {
    const decoded: unknown = JSON.parse(body);
    if (isObject(decoded) && isObject(decoded.error)) {
      payload = {
        error: {
          ...(typeof decoded.error.code === "string" ? { code: decoded.error.code } : {}),
          ...(typeof decoded.error.message === "string" ? { message: decoded.error.message } : {}),
        },
      };
    }
  } catch { /* use the public fallback */ }
  return new CodexRuntimeServiceError(
    payload?.error?.message ?? "The Codex runtime rejected the turn.",
    status,
    payload?.error?.code ?? "codex_runtime_rejected",
  );
}

export function codexRuntimeServiceUrl(source: NodeJS.ProcessEnv = process.env): string {
  const configured = source.CODEX_RUNTIME_SERVICE_URL?.trim().replace(/\/+$/u, "");
  if (source.NODE_ENV === "production") return configured ?? "";

  // `.env.local` intentionally mirrors production deployment variables, but
  // local web development must talk to the separately started loopback
  // app-server wrapper. A configured loopback URL still permits a custom local
  // port; a production Fly URL must never silently capture localhost traffic.
  if (configured) {
    try {
      const url = new URL(configured);
      if (["127.0.0.1", "localhost", "::1"].includes(url.hostname)) return configured;
    } catch {
      // The route will use the safe loopback default and fail closed there.
    }
  }
  return "http://127.0.0.1:8792";
}

export class CodexRuntimeServiceClient {
  constructor(
    private readonly baseUrl: string,
    private readonly signingSecret: string,
  ) {
    if (!baseUrl.trim()) throw new Error("The Codex runtime service URL is not configured.");
    if (Buffer.byteLength(signingSecret, "utf8") < 32) {
      throw new Error("The Codex runtime signing secret must contain at least 32 UTF-8 bytes.");
    }
  }

  async runTurn(
    turn: CodexServiceTurn,
    emit: EmitCodexTrace,
    signal?: AbortSignal,
    emitQueryAudit?: (event: CodexQueryAuditEvent) => Promise<void>,
  ): Promise<CodexSemanticTurnResult> {
    const body = JSON.stringify(turn);
    return this.runJob(turn.requestId, body, emit, signal, emitQueryAudit);
  }

  private async runJob(
    expectedJobId: string,
    body: string,
    emit: EmitCodexTrace,
    signal?: AbortSignal,
    emitQueryAudit?: (event: CodexQueryAuditEvent) => Promise<void>,
  ): Promise<CodexSemanticTurnResult> {
    // A severed connection or a proxy-level 5xx does not mean the turn died:
    // the job keeps running server-side, submits are idempotent while their
    // job is alive, and polls carry an explicit cursor. Ride out transient
    // failures instead of failing a live analysis (a single Fly proxy TLS
    // reset killed four healthy in-flight production turns on 2026-08-29).
    const TRANSIENT_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 8_000];
    const requestJson = async (path: string, requestBody: string): Promise<Record<string, unknown>> => {
      const signed = await signInternalRequest({
        method: "POST",
        path,
        body: requestBody,
        secret: this.signingSecret,
      });
      for (let attempt = 0; ; attempt += 1) {
        const retryDelay = TRANSIENT_RETRY_DELAYS_MS[attempt];
        let transient: string | undefined;
        try {
          let response: Response;
          try {
            response = await fetch(new URL(path, `${this.baseUrl}/`), {
              method: "POST",
              headers: { "content-type": "application/json", accept: "application/json", ...signed },
              body: requestBody,
              signal,
            });
          } catch (error) {
            throw new CodexRuntimeServiceError(
              signal?.aborted
                ? "The Codex turn was cancelled."
                : `The Codex runtime could not be reached (${error instanceof Error ? error.message : "unknown error"}).`,
              503,
              signal?.aborted ? "codex_cancelled" : "codex_runtime_unavailable",
            );
          }
          const text = await response.text();
          if (Buffer.byteLength(text, "utf8") > MAX_STREAM_LINE_BYTES * 8) {
            throw new CodexRuntimeServiceError("The Codex job poll response was oversized.", 502, "codex_stream_oversized");
          }
          if (!response.ok) throw runtimeRejectedError(response.status, text);
          let payload: unknown;
          try { payload = JSON.parse(text); } catch {
            throw new CodexRuntimeServiceError("The Codex job response was malformed.", 502, "codex_stream_invalid");
          }
          if (!isObject(payload)) throw new CodexRuntimeServiceError("The Codex job response was invalid.", 502, "codex_stream_invalid");
          return payload;
        } catch (error) {
          if (error instanceof CodexRuntimeServiceError && !signal?.aborted) {
            if (error.code === "codex_runtime_unavailable") transient = error.code;
            else if ([429, 502, 503, 504].includes(error.status) && error.code !== "codex_cancelled") transient = error.code;
          }
          if (transient === undefined || retryDelay === undefined) throw error;
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
        }
      }
    };

    const started = await requestJson(JOBS_PATH, body);
    if (started.jobId !== expectedJobId) {
      throw new CodexRuntimeServiceError("The Codex job identity was invalid.", 502, "codex_stream_invalid");
    }
    let cursor = 0;
    for (;;) {
      const pollPath = `${JOBS_PATH}/${expectedJobId}/poll`;
      const payload = await requestJson(pollPath, JSON.stringify({ cursor }));
      if (payload.jobId !== expectedJobId || !Number.isInteger(payload.cursor) || Number(payload.cursor) < cursor) {
        throw new CodexRuntimeServiceError("The Codex job cursor was invalid.", 502, "codex_stream_invalid");
      }
      if (!Array.isArray(payload.events) || payload.events.some((event) => !isObject(event))) {
        throw new CodexRuntimeServiceError("The Codex job events were invalid.", 502, "codex_stream_invalid");
      }
      for (const event of payload.events) {
        if ((event as Record<string, unknown>).type === "query_audit") {
          const parsedAudit = codexQueryAuditEventSchema.safeParse(event);
          if (!parsedAudit.success || !emitQueryAudit) {
            throw new CodexRuntimeServiceError(
              "The Codex query audit stream was invalid or had no durable sink.",
              502,
              "codex_stream_invalid",
            );
          }
          await emitQueryAudit(parsedAudit.data);
          continue;
        }
        await emit(event as CodexTraceEventInput);
      }
      cursor = Number(payload.cursor);
      if (isObject(payload.error)) {
        throw new CodexRuntimeServiceError(
          typeof payload.error.message === "string" ? payload.error.message : "The Codex runtime failed.",
          502,
          typeof payload.error.code === "string" ? payload.error.code : "codex_runtime_failed",
        );
      }
      if (isObject(payload.result)) {
        const parsed = codexSemanticTurnResultSchema.safeParse(payload.result);
        if (!parsed.success) {
          throw new CodexRuntimeServiceError("The Codex terminal result was invalid.", 502, "codex_stream_invalid");
        }
        return parsed.data;
      }
      if (payload.events.length === 0) await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
