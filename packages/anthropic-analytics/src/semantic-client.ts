import { signInternalRequest } from "../../security/src/index.js";
import {
  semanticResponseSchema,
  type SemanticResponse,
} from "./contracts.js";

export class AnthropicSemanticServiceError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
    this.name = "AnthropicSemanticServiceError";
  }
}
export type AnthropicToolContext = Readonly<{
  tenantId: string;
  role: "owner" | "manager" | "bookkeeper" | "internal_operator";
  conversationId: string;
  turnId: string;
  confirmedPreference?: string;
  confirmedValue?: string;
  signal?: AbortSignal;
}>;

const allowedSemanticTools = new Set([
  "search_catalogue",
  "get_definition",
  "get_capabilities",
  "list_field_values",
  "get_data_health",
  "run_sql",
]);

export class AnthropicSemanticClient {
  constructor(private readonly baseUrl: string, private readonly signingSecret: string) {}

  async execute(name: string, input: unknown, context: AnthropicToolContext): Promise<SemanticResponse> {
    if (!allowedSemanticTools.has(name)) throw new Error(`Semantic tool ${name} is not allowed for the Anthropic runtime.`);
    const path = `/v1/tools/${name}`;
    const body = JSON.stringify({
      tenantId: context.tenantId,
      role: context.role,
      conversationId: context.conversationId,
      turnId: context.turnId,
      ...(context.confirmedPreference ? { confirmedPreference: context.confirmedPreference } : {}),
      ...(context.confirmedValue ? { confirmedValue: context.confirmedValue } : {}),
      input,
    });
    const signature = await signInternalRequest({ method: "POST", path, body, secret: this.signingSecret });
    const timeout = AbortSignal.timeout(name === "run_sql" ? 40_000 : 15_000);
    const response = await fetch(new URL(path, this.baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...signature },
      body,
      signal: context.signal ? AbortSignal.any([context.signal, timeout]) : timeout,
    });
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) {
      const raw = payload?.error;
      const error = raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
      const issues = Array.isArray(error?.details)
        ? error.details.slice(0, 5).map((issue) => {
            if (!issue || typeof issue !== "object") return "invalid input";
            const value = issue as { path?: unknown; message?: unknown };
            return `${Array.isArray(value.path) ? value.path.join(".") : "input"}: ${String(value.message ?? "invalid")}`;
          }).join("; ")
        : "";
      throw new AnthropicSemanticServiceError(
        `${String(error?.message ?? "The governed query service rejected the request.")}${issues ? ` (${issues})` : ""}`,
        response.status,
        typeof error?.code === "string" ? error.code : undefined,
      );
    }
    return semanticResponseSchema.parse("result" in (payload ?? {}) ? payload?.result : payload);
  }

  async finalize(input: unknown, signal?: AbortSignal): Promise<Readonly<{ answerArtifactId: string; artifactDigest: string }>> {
    const path = "/v2/answer-artifacts/finalize";
    const body = JSON.stringify(input);
    const signature = await signInternalRequest({ method: "POST", path, body, secret: this.signingSecret });
    const response = await fetch(new URL(path, this.baseUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json", ...signature },
      body,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000),
    });
    const payload = await response.json().catch(() => null) as { result?: Record<string, unknown>; error?: { message?: string } } | null;
    if (!response.ok) throw new AnthropicSemanticServiceError(payload?.error?.message ?? "Anthropic answer finalization failed.", response.status);
    const result = payload?.result;
    if (!result || typeof result.answerArtifactId !== "string" || typeof result.artifactDigest !== "string") {
      throw new Error("Semantic service returned invalid Anthropic finalization state.");
    }
    return Object.freeze({ answerArtifactId: result.answerArtifactId, artifactDigest: result.artifactDigest });
  }
}
