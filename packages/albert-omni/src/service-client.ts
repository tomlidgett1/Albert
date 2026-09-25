import { signInternalRequest } from "../../security/src/index.js";
import { boundOmniTurnContext } from "./context.js";
import {
  codexQueryAuditEventSchema,
  type CodexQueryAuditEvent,
} from "../../albert-codex/src/contracts.js";
import {
  omniSemanticTurnResultSchema,
  type OmniSemanticTurnResult,
  type OmniServiceTurn,
} from "./contracts.js";
import type { EmitOmniTrace, OmniTraceEventInput } from "./runtime.js";

const JOBS_PATH = "/v1/omni/jobs";
const MAX_RESPONSE_BYTES = 12_000_000;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class OmniRuntimeServiceError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "OmniRuntimeServiceError";
  }
}

function runtimeRejectedError(status: number, body: string): OmniRuntimeServiceError {
  let code: string | undefined;
  let message: string | undefined;
  try {
    const decoded: unknown = JSON.parse(body);
    if (isObject(decoded) && isObject(decoded.error)) {
      if (typeof decoded.error.code === "string") code = decoded.error.code;
      if (typeof decoded.error.message === "string") message = decoded.error.message;
    }
  } catch { /* use the public fallback */ }
  return new OmniRuntimeServiceError(
    message ?? "The Omni runtime rejected the turn.",
    status,
    code ?? "omni_runtime_rejected",
  );
}

/** The Omni runtime shares the agent-runtime service deployment with Codex. */
export function omniRuntimeServiceUrl(source: NodeJS.ProcessEnv = process.env): string {
  const configured = source.CODEX_RUNTIME_SERVICE_URL?.trim().replace(/\/+$/u, "");
  // A local web checkout uses the same deployed backends as production.
  // Never discard an explicit Fly URL and silently target a local worker.
  if (configured) return configured;
  if (source.NODE_ENV === "production") return "";
  return "http://127.0.0.1:8792";
}

export class OmniRuntimeServiceClient {
  constructor(
    private readonly baseUrl: string,
    private readonly signingSecret: string,
  ) {
    if (!baseUrl.trim()) throw new Error("The Omni runtime service URL is not configured.");
    if (Buffer.byteLength(signingSecret, "utf8") < 32) {
      throw new Error("The Omni runtime signing secret must contain at least 32 UTF-8 bytes.");
    }
  }

  async runTurn(
    turn: OmniServiceTurn,
    emit: EmitOmniTrace,
    signal?: AbortSignal,
    emitQueryAudit?: (event: CodexQueryAuditEvent) => Promise<void>,
  ): Promise<OmniSemanticTurnResult> {
    const body = JSON.stringify(boundOmniTurnContext(turn));
    // A severed connection or a proxy-level 5xx does not mean the turn died:
    // the job keeps running server-side, submits are idempotent while their
    // job is alive, and polls carry an explicit cursor.
    const TRANSIENT_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 8_000];
    const requestJson = async (path: string, requestBody: string): Promise<Record<string, unknown>> => {
      for (let attempt = 0; ; attempt += 1) {
        const retryDelay = TRANSIENT_RETRY_DELAYS_MS[attempt];
        let transient: string | undefined;
        try {
          const signed = await signInternalRequest({ method: "POST", path, body: requestBody, secret: this.signingSecret });
          const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
          let response: Response;
          try {
            response = await fetch(new URL(path, `${this.baseUrl}/`), {
              method: "POST",
              headers: { "content-type": "application/json", accept: "application/json", ...signed },
              body: requestBody,
              signal: requestSignal,
              redirect: "error",
            });
          } catch (error) {
            throw new OmniRuntimeServiceError(
              signal?.aborted
                ? "The Omni turn was cancelled."
                : `The Omni runtime could not be reached (${error instanceof Error ? error.message : "unknown error"}).`,
              503,
              signal?.aborted ? "omni_cancelled" : "omni_runtime_unavailable",
            );
          }
          const text = await response.text();
          if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
            throw new OmniRuntimeServiceError("The Omni job poll response was oversized.", 502, "omni_stream_oversized");
          }
          if (!response.ok) throw runtimeRejectedError(response.status, text);
          let payload: unknown;
          try { payload = JSON.parse(text); } catch {
            throw new OmniRuntimeServiceError("The Omni job response was malformed.", 502, "omni_stream_invalid");
          }
          if (!isObject(payload)) throw new OmniRuntimeServiceError("The Omni job response was invalid.", 502, "omni_stream_invalid");
          return payload;
        } catch (error) {
          if (error instanceof OmniRuntimeServiceError && !signal?.aborted) {
            if (error.code === "omni_runtime_unavailable") transient = error.code;
            else if ([429, 502, 503, 504].includes(error.status) && error.code !== "omni_cancelled") transient = error.code;
          }
          if (transient === undefined || retryDelay === undefined) throw error;
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
        }
      }
    };

    const started = await requestJson(JOBS_PATH, body);
    if (started.jobId !== turn.requestId) {
      throw new OmniRuntimeServiceError("The Omni job identity was invalid.", 502, "omni_stream_invalid");
    }
    let cursor = 0;
    for (;;) {
      const payload = await requestJson(`${JOBS_PATH}/${turn.requestId}/poll`, JSON.stringify({ cursor }));
      if (payload.jobId !== turn.requestId || !Number.isInteger(payload.cursor) || Number(payload.cursor) < cursor) {
        throw new OmniRuntimeServiceError("The Omni job cursor was invalid.", 502, "omni_stream_invalid");
      }
      if (!Array.isArray(payload.events) || payload.events.some((event) => !isObject(event))) {
        throw new OmniRuntimeServiceError("The Omni job events were invalid.", 502, "omni_stream_invalid");
      }
      for (const event of payload.events) {
        if ((event as Record<string, unknown>).type === "query_audit") {
          const parsedAudit = codexQueryAuditEventSchema.safeParse(event);
          if (!parsedAudit.success || !emitQueryAudit) {
            throw new OmniRuntimeServiceError(
              "The Omni query audit stream was invalid or had no durable sink.",
              502,
              "omni_stream_invalid",
            );
          }
          await emitQueryAudit(parsedAudit.data);
          continue;
        }
        await emit(event as OmniTraceEventInput);
      }
      cursor = Number(payload.cursor);
      if (isObject(payload.error)) {
        throw new OmniRuntimeServiceError(
          typeof payload.error.message === "string" ? payload.error.message : "The Omni runtime failed.",
          502,
          typeof payload.error.code === "string" ? payload.error.code : "omni_runtime_failed",
        );
      }
      if (isObject(payload.result)) {
        const parsed = omniSemanticTurnResultSchema.safeParse(payload.result);
        if (!parsed.success) {
          throw new OmniRuntimeServiceError("The Omni terminal result was invalid.", 502, "omni_stream_invalid");
        }
        return parsed.data;
      }
      if (payload.events.length === 0) await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}
