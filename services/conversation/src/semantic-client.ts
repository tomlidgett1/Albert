import { signInternalRequest } from "../../../packages/security/src/index.js";
import {
  semanticToolResponseSchema,
  type AgentToolContext,
  type RemoteSemanticAgentToolName,
  type SemanticToolResponse,
} from "../../../packages/agent/src/semantic-tools.js";

export class SemanticServiceError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "SemanticServiceError";
  }
}

export class SemanticServiceClient {
  constructor(
    private readonly baseUrl: string,
    private readonly signingSecret: string,
  ) {}

  async execute(
    name: RemoteSemanticAgentToolName,
    input: unknown,
    context: AgentToolContext,
  ): Promise<SemanticToolResponse> {
    const path = `/v1/tools/${name}`;
    const body = JSON.stringify({
      tenantId: context.tenantId,
      conversationId: context.conversationId,
      turnId: context.turnId,
      role: context.role,
      ...(context.confirmedValue === undefined ? {} : { confirmedValue: context.confirmedValue }),
      input,
    });
    const signatureHeaders = await signInternalRequest({
      method: "POST",
      path,
      body,
      secret: this.signingSecret,
    });
    const timeoutMs = name === "run_semantic_query" || name === "run_source_query"
      ? 37_000
      : name === "search_catalogue" ? 14_000 : 10_000;
    const timeoutSignal=AbortSignal.timeout(timeoutMs);
    const signal=context.abortSignal
      ? AbortSignal.any([context.abortSignal,timeoutSignal])
      : timeoutSignal;
    const response = await fetch(new URL(path, this.baseUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...signatureHeaders,
      },
      body,
      signal,
    });
    const payload = await response.json().catch(() => null) as
      | { result?: unknown; error?: { code?: string; message?: string } | string }
      | null;
    if (!response.ok) {
      const error = payload?.error;
      const message = typeof error === "string" ? error : error?.message;
      const code = typeof error === "object" ? error?.code : undefined;
      throw new SemanticServiceError(message || "The governed query service rejected the request.", response.status, code);
    }
    const result = payload && "result" in payload ? payload.result : payload;
    return semanticToolResponseSchema.parse(result);
  }
}
