import { verifyInternalRequest } from "../../../packages/security/src/index.js";
import {
  assertPinnedCodexVersion,
  codexChildEnvironment,
  resolveCodexBinary,
} from "../../../packages/albert-codex/src/app-server.js";
import {
  codexServiceTurnSchema,
  type CodexServiceTurn,
} from "../../../packages/albert-codex/src/contracts.js";
import {
  runCodexSemanticTurn,
  type CodexSemanticTurnResult,
  type CodexTraceEventInput,
} from "../../../packages/albert-codex/src/semantic-runtime.js";
import type { CodexRuntimeConfig } from "./config.js";

const TURN_PATH = "/v1/codex/turn";
const JOBS_PATH = "/v1/codex/jobs";
const JOB_POLL_PATH = /^\/v1\/codex\/jobs\/([0-9A-HJKMNP-TV-Z]{26})\/poll$/u;
const MAX_BODY_BYTES = 180 * 1024;
const REPLAY_TTL_MS = 10 * 60_000;
const JOB_POLL_WAIT_MS = 8_000;
const MAX_JOB_EVENTS = 600;
const MAX_JOB_EVENT_BYTES = 1_500_000;
const MAX_JOB_BUFFER_BYTES = 32 * 1024 * 1024;
const encoder = new TextEncoder();

type CodexBackgroundJob = {
  readonly id: string;
  readonly events: CodexTraceEventInput[];
  readonly waiters: Set<() => void>;
  readonly abort: AbortController;
  createdAt: number;
  updatedAt: number;
  eventBytes: number;
  result?: CodexSemanticTurnResult;
  failure?: Readonly<{ code: string; message: string }>;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonError(code: string, status: number, message: string): Response {
  return Response.json({ error: { code, message } }, {
    status,
    headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
  });
}

function unknownErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  try {
    return JSON.stringify(error) ?? "";
  } catch {
    return String(error ?? "");
  }
}

function publicFailure(error: unknown): Readonly<{ code: string; message: string }> {
  if (error instanceof DOMException && error.name === "AbortError") {
    return { code: "codex_cancelled", message: "The Codex analysis was cancelled." };
  }
  const message = unknownErrorMessage(error);
  if (/version|pinned Codex runtime|unavailable|ENOENT/iu.test(message)) {
    return { code: "codex_runtime_unavailable", message: "The pinned Codex runtime is unavailable." };
  }
  if (/Cube|semantic/iu.test(message)) {
    return { code: "codex_semantic_unavailable", message: "The governed semantic layer was unavailable to Codex." };
  }
  if (/forbidden/iu.test(message)) {
    return { code: "codex_forbidden_capability", message: "Codex attempted a capability this experiment does not permit." };
  }
  return { code: "codex_runtime_failed", message: "The Codex analysis could not be completed safely." };
}

function diagnosticFailureCode(error: unknown): string {
  const message = unknownErrorMessage(error);
  if (/completed without a final structured answer/iu.test(message)) return "missing_final_answer";
  if (/malformed structured output|output schema/iu.test(message)) return "invalid_structured_output";
  if (/external instruction|external workspace|external MCP|forbidden/iu.test(message)) return "isolation_rejected";
  if (/thread\/start|turn\/start|rejected the request/iu.test(message)) return "protocol_request_rejected";
  if (/app-server exited/iu.test(message)) return "app_server_exited";
  if (/timed out/iu.test(message)) return "turn_timeout";
  if (/Cube|semantic|catalogue/iu.test(message)) return "semantic_unavailable";
  if (/401|API key|authentication|model/iu.test(message)) return "model_request_rejected";
  return "unknown";
}

function localDiagnosticDetail(error: unknown): string | undefined {
  if (process.env.NODE_ENV === "production") return undefined;
  const message = unknownErrorMessage(error);
  if (!message) return undefined;
  return message
    .replace(/sk-[A-Za-z0-9_-]{8,}/gu, "[redacted]")
    .replace(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/gu, "[redacted-token]")
    .replace(/\s+/gu, " ")
    .slice(0, 500);
}

export class CodexRuntimeHttpHandler {
  private activeTurns = 0;
  private readonly requestIds = new Map<string, number>();
  private readonly jobs = new Map<string, CodexBackgroundJob>();

  constructor(private readonly config: CodexRuntimeConfig) {}

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/livez") {
      return Response.json({ ok: true, service: "albert-codex-runtime" }, { headers: { "cache-control": "no-store" } });
    }
    if (request.method === "GET" && url.pathname === "/readyz") {
      try {
        const binary = await resolveCodexBinary(this.config.binaryPath);
        const runtime = await assertPinnedCodexVersion(binary, codexChildEnvironment({
          baseUrl: this.config.openaiBaseUrl,
        }));
        return Response.json({
          ready: true,
          status: "ready",
          releaseSha: this.config.releaseSha,
          deploymentId: this.config.deploymentId,
          runtime,
          activeTurns: this.activeTurns,
        }, { headers: { "cache-control": "no-store" } });
      } catch {
        return jsonError("not_ready", 503, "The pinned Codex runtime is unavailable.");
      }
    }
    const pollMatch = JOB_POLL_PATH.exec(url.pathname);
    if (
      request.method !== "POST"
      || (url.pathname !== TURN_PATH && url.pathname !== JOBS_PATH && !pollMatch)
    ) {
      return jsonError("not_found", 404, "Not found.");
    }
    const body = await request.text();
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
      return jsonError("request_too_large", 413, "The Codex turn request is too large.");
    }
    const verified = await verifyInternalRequest({
      method: request.method,
      path: url.pathname,
      body,
      secret: this.config.signingSecret,
      timestamp: request.headers.get("x-albert-timestamp"),
      signature: request.headers.get("x-albert-signature"),
      maxSkewMs: 60_000,
    }).catch(() => false);
    if (!verified) return jsonError("unauthorised", 401, "The Codex runtime request was rejected.");
    let payload: unknown;
    try { payload = JSON.parse(body); } catch {
      return jsonError("invalid_request", 400, "The Codex turn request is invalid.");
    }
    if (pollMatch) {
      const cursor = isObject(payload) && Number.isInteger(payload.cursor) ? Number(payload.cursor) : -1;
      if (cursor < 0) return jsonError("invalid_request", 400, "The Codex job poll request is invalid.");
      return this.pollJob(pollMatch[1]!, cursor, request.signal);
    }
    const parsed = codexServiceTurnSchema.safeParse(payload);
    if (!parsed.success) return jsonError("invalid_request", 400, "The Codex turn request is invalid.");
    this.pruneReplayIds();
    if (this.requestIds.has(parsed.data.requestId) || this.jobs.has(parsed.data.requestId)) {
      return jsonError("replayed_request", 409, "This Codex turn request has already been used.");
    }
    if (this.activeTurns >= this.config.maxConcurrentTurns) {
      return jsonError("codex_overloaded", 429, "The Codex experiment is at capacity. Try again shortly.");
    }
    this.requestIds.set(parsed.data.requestId, Date.now());
    if (url.pathname === JOBS_PATH) {
      this.startJob(parsed.data);
      return Response.json({ jobId: parsed.data.requestId }, {
        status: 202,
        headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
      });
    }
    this.activeTurns += 1;
    const runAbort = new AbortController();
    const abort = () => runAbort.abort(request.signal.reason);
    request.signal.addEventListener("abort", abort, { once: true });
    let streamClosed = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        const write = (value: unknown) => {
          if (streamClosed || runAbort.signal.aborted) return;
          controller.enqueue(encoder.encode(`${JSON.stringify(value)}\n`));
        };
        heartbeat = setInterval(() => write({ kind: "heartbeat" }), 10_000);
        void runCodexSemanticTurn({
          turn: parsed.data,
          cubeApiUrl: this.config.cubeApiUrl,
          openaiApiKey: this.config.openaiApiKey,
          openaiBaseUrl: this.config.openaiBaseUrl,
          codexBinaryPath: this.config.binaryPath,
          signal: runAbort.signal,
          emit: (event: CodexTraceEventInput) => write({ kind: "event", event }),
        }).then((result) => {
          write({ kind: "complete", result });
        }).catch((error) => {
          const failure = publicFailure(error);
          process.stdout.write(`${JSON.stringify({
            event: "codex_turn_failed",
            code: failure.code,
            diagnosticCode: diagnosticFailureCode(error),
            errorClass: error instanceof Error ? error.name : "unknown",
            ...(localDiagnosticDetail(error) ? { detail: localDiagnosticDetail(error) } : {}),
          })}\n`);
          write({ kind: "error", ...failure });
        }).finally(() => {
          if (heartbeat) clearInterval(heartbeat);
          this.activeTurns -= 1;
          request.signal.removeEventListener("abort", abort);
          if (!streamClosed) {
            streamClosed = true;
            try { controller.close(); } catch { /* client already disconnected */ }
          }
        });
      },
      cancel(reason) {
        if (heartbeat) clearInterval(heartbeat);
        streamClosed = true;
        runAbort.abort(reason);
      },
    });
    return new Response(stream, {
      status: 200,
      headers: {
        "cache-control": "private, no-store, no-transform",
        "content-type": "application/x-ndjson; charset=utf-8",
        "x-content-type-options": "nosniff",
      },
    });
  }

  private startJob(turn: CodexServiceTurn): void {
    const now = Date.now();
    const job: CodexBackgroundJob = {
      id: turn.requestId,
      events: [],
      waiters: new Set(),
      abort: new AbortController(),
      createdAt: now,
      updatedAt: now,
      eventBytes: 0,
    };
    this.jobs.set(job.id, job);
    this.activeTurns += 1;
    const publish = (event: CodexTraceEventInput) => {
      const bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
      if (
        bytes > MAX_JOB_EVENT_BYTES
        || job.events.length >= MAX_JOB_EVENTS
        || job.eventBytes + bytes > MAX_JOB_BUFFER_BYTES
      ) {
        throw new Error("The Codex background job exceeded its bounded event buffer.");
      }
      job.events.push(event);
      job.eventBytes += bytes;
      job.updatedAt = Date.now();
      this.notifyJob(job);
    };
    void runCodexSemanticTurn({
      turn,
      cubeApiUrl: this.config.cubeApiUrl,
      openaiApiKey: this.config.openaiApiKey,
      openaiBaseUrl: this.config.openaiBaseUrl,
      codexBinaryPath: this.config.binaryPath,
      signal: job.abort.signal,
      emit: publish,
    }).then((result) => {
      job.result = result;
    }).catch((error) => {
      const failure = publicFailure(error);
      job.failure = failure;
      process.stdout.write(`${JSON.stringify({
        event: "codex_job_failed",
        code: failure.code,
        diagnosticCode: diagnosticFailureCode(error),
        errorClass: error instanceof Error ? error.name : "unknown",
        ...(localDiagnosticDetail(error) ? { detail: localDiagnosticDetail(error) } : {}),
      })}\n`);
    }).finally(() => {
      job.updatedAt = Date.now();
      this.activeTurns -= 1;
      this.notifyJob(job);
    });
  }

  private async pollJob(jobId: string, cursor: number, signal: AbortSignal): Promise<Response> {
    this.pruneReplayIds();
    const job = this.jobs.get(jobId);
    if (!job) return jsonError("job_not_found", 404, "The Codex background job is unavailable.");
    if (cursor > job.events.length) return jsonError("invalid_cursor", 409, "The Codex job cursor is invalid.");
    if (cursor === job.events.length && !job.result && !job.failure) {
      await this.waitForJobChange(job, signal);
    }
    const events = job.events.slice(cursor, cursor + 8);
    const nextCursor = cursor + events.length;
    const terminalDelivered = nextCursor >= job.events.length;
    return Response.json({
      jobId,
      cursor: nextCursor,
      events,
      ...(terminalDelivered && job.result ? { result: job.result } : {}),
      ...(terminalDelivered && job.failure ? { error: job.failure } : {}),
    }, {
      headers: { "cache-control": "private, no-store", "x-content-type-options": "nosniff" },
    });
  }

  private async waitForJobChange(job: CodexBackgroundJob, signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolveWait) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        job.waiters.delete(settle);
        signal.removeEventListener("abort", settle);
        resolveWait();
      };
      const timeout = setTimeout(settle, JOB_POLL_WAIT_MS);
      job.waiters.add(settle);
      signal.addEventListener("abort", settle, { once: true });
      if (signal.aborted || job.result || job.failure) settle();
    });
  }

  private notifyJob(job: CodexBackgroundJob): void {
    for (const waiter of [...job.waiters]) waiter();
  }

  private pruneReplayIds(): void {
    const cutoff = Date.now() - REPLAY_TTL_MS;
    for (const [requestId, seenAt] of this.requestIds) {
      const job = this.jobs.get(requestId);
      if (seenAt < cutoff && (!job || job.result || job.failure)) this.requestIds.delete(requestId);
    }
    for (const [jobId, job] of this.jobs) {
      if ((job.result || job.failure) && job.updatedAt < cutoff) this.jobs.delete(jobId);
    }
  }
}
