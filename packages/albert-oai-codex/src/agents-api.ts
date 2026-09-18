/**
 * A small typed client for OpenAI's managed Agents API (public beta,
 * 2026-09-10): `POST /agents/sessions`, the session event stream, input
 * events (messages, tool results, cancel), items and deletion.
 *
 * The client is deliberately dependency-free (fetch + an SSE reader) so the
 * OAI Codex harness can track the beta surface without moving the pinned
 * `openai` package the other harnesses rely on. Shapes mirror the
 * `openai@7.18` `beta.agents` resources.
 */

export const OPENAI_AGENTS_BETA_HEADER = "agents=v1";
export const OPENAI_AGENTS_DEFAULT_BASE_URL = "https://api.openai.com/v1";

export type AgentsApiReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type AgentsApiServiceTier = "auto" | "default" | "flex" | "priority" | "fast";

export type AgentsApiFunctionToolParam = Readonly<{
  type: "function";
  name: string;
  description: string;
  parameters: Readonly<Record<string, unknown>>;
}>;

export type AgentsApiInputMessage = Readonly<{
  type?: "message";
  role: "user";
  content: readonly Readonly<{ type: "input_text"; text: string }>[];
}>;

export type AgentsApiAgentParam = Readonly<{
  model: string;
  instructions: string;
  reasoning?: Readonly<{ effort?: AgentsApiReasoningEffort; summary?: "concise" | "detailed" | "auto" | null }>;
  service_tier?: AgentsApiServiceTier;
  text?: Readonly<{ verbosity?: "low" | "medium" | "high" }>;
  tools?: readonly AgentsApiFunctionToolParam[];
  multi_agent?: Readonly<{ enabled: boolean; max_concurrent_subagents?: number }>;
}>;

export type AgentsApiSessionCreateBody = Readonly<{
  agent: AgentsApiAgentParam;
  environment: Readonly<{ type: "none" }>;
  input?: string | readonly AgentsApiInputMessage[];
  metadata?: Readonly<Record<string, string>>;
}>;

export type AgentsApiInputEvent =
  | Readonly<{ type: "agent.session.input.message"; input: readonly AgentsApiInputMessage[] }>
  | Readonly<{ type: "agent.session.input.cancel" }>
  | Readonly<{
    type: "agent.session.input.tool_result";
    turn_id: string;
    call_id: string;
    success: boolean;
    output?: string | null;
    error?: string | null;
  }>;

export type AgentsApiUsage = Readonly<{
  input_tokens?: number;
  input_tokens_details?: Readonly<{ cached_tokens?: number }> | null;
  output_tokens?: number;
  output_tokens_details?: Readonly<{ reasoning_tokens?: number }> | null;
  total_tokens?: number;
}>;

export type AgentsApiTurnStatus = "queued" | "in_progress" | "waiting" | "completed" | "failed" | "cancelled";

export type AgentsApiTurn = Readonly<{
  id: string;
  status: AgentsApiTurnStatus;
  subagent_id: string | null;
  error: Readonly<{ code: string; message: string }> | null;
  usage: AgentsApiUsage | null;
}>;

export type AgentsApiRequiredAction =
  | Readonly<{ type: "function_call"; call_id: string; turn_id: string; name: string; arguments: unknown }>
  | Readonly<{ type: "environment_connection"; environment_id: string }>;

export type AgentsApiSessionStatus = "idle" | "in_progress" | "requires_action" | "failed";

export type AgentsApiSession = Readonly<{
  id: string;
  object?: "agent.session";
  status: AgentsApiSessionStatus;
  error: string | null;
  required_actions: readonly AgentsApiRequiredAction[];
  usage: AgentsApiUsage | null;
}>;

export type AgentsApiFunctionCallItem = Readonly<{
  type: "function_call";
  id: string;
  call_id: string;
  turn_id: string;
  name: string;
  arguments: unknown;
  status?: string;
}>;

export type AgentsApiMessageItem = Readonly<{
  type: "message";
  id: string;
  turn_id?: string;
  role: "assistant" | "user";
  phase?: "commentary" | "final_answer" | null;
  status?: string;
  content: readonly Readonly<{ type: string; text?: string }>[];
}>;

export type AgentsApiItem =
  | AgentsApiFunctionCallItem
  | AgentsApiMessageItem
  | Readonly<{ type: string; id?: string; turn_id?: string | null; [key: string]: unknown }>;

/** Every event the session stream can deliver, discriminated by `type`. */
export type AgentsApiEvent = Readonly<{
  type: string;
  event_id?: string;
  session_id?: string;
  turn_id?: string | null;
  item?: AgentsApiItem;
  turn?: AgentsApiTurn;
  session?: AgentsApiSession;
  usage?: AgentsApiUsage | null;
  error?: Readonly<{ code?: string | null; message?: string; type?: string }>;
  delta?: string;
  text?: string;
}>;

export class AgentsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | undefined,
  ) {
    super(message);
    this.name = "AgentsApiError";
  }
}

export type ServerSentEvent = Readonly<{ event?: string; id?: string; data: string }>;

/**
 * Reads a `text/event-stream` body block by block: `data:` lines join with
 * newlines, comments are dropped, CRLF is normalised, and a trailing block
 * without a terminating blank line is still delivered at end of stream.
 */
export async function* parseServerSentEvents(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<ServerSentEvent, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const parseBlock = (block: string): ServerSentEvent | null => {
    let event: string | undefined;
    let id: string | undefined;
    const data: string[] = [];
    for (const rawLine of block.split("\n")) {
      if (!rawLine || rawLine.startsWith(":")) continue;
      const separator = rawLine.indexOf(":");
      const field = separator === -1 ? rawLine : rawLine.slice(0, separator);
      let value = separator === -1 ? "" : rawLine.slice(separator + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") data.push(value);
      else if (field === "event") event = value;
      else if (field === "id") id = value;
    }
    if (data.length === 0) return null;
    return { ...(event ? { event } : {}), ...(id ? { id } : {}), data: data.join("\n") };
  };
  try {
    for (;;) {
      if (signal?.aborted) throw signal.reason ?? new Error("The event stream was cancelled.");
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done }).replaceAll("\r\n", "\n").replaceAll("\r", "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const parsed = parseBlock(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (parsed) yield parsed;
        boundary = buffer.indexOf("\n\n");
      }
      if (done) {
        const parsed = buffer.trim() ? parseBlock(buffer) : null;
        if (parsed) yield parsed;
        return;
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorFromBody(status: number, body: string): AgentsApiError {
  let code: string | undefined;
  let message: string | undefined;
  try {
    const decoded: unknown = JSON.parse(body);
    if (isObject(decoded) && isObject(decoded.error)) {
      if (typeof decoded.error.code === "string") code = decoded.error.code;
      if (typeof decoded.error.message === "string") message = decoded.error.message;
    }
  } catch { /* the status alone is the diagnosis */ }
  return new AgentsApiError(
    `OpenAI Agents API request failed with status ${status}${message ? `: ${message.slice(0, 400)}` : ""}`,
    status,
    code,
  );
}

export type OpenAiAgentsApiClientOptions = Readonly<{
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  /** Bound on a non-streaming request; the event stream is bounded by its signal. */
  requestTimeoutMs?: number;
}>;

export class OpenAiAgentsApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(private readonly options: OpenAiAgentsApiClientOptions) {
    if (!options.apiKey.trim()) throw new Error("The OpenAI Agents API key is missing.");
    this.baseUrl = (options.baseUrl?.trim() || OPENAI_AGENTS_DEFAULT_BASE_URL).replace(/\/+$/u, "");
    this.fetchImpl = options.fetch ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      authorization: `Bearer ${this.options.apiKey}`,
      "openai-beta": OPENAI_AGENTS_BETA_HEADER,
      "content-type": "application/json",
      ...extra,
    };
  }

  private async request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    init?: Readonly<{ body?: unknown; headers?: Record<string, string>; signal?: AbortSignal }>,
  ): Promise<Response> {
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(init?.headers),
        ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal,
        redirect: "error",
      });
    } catch (error) {
      if (init?.signal?.aborted) throw init.signal.reason ?? error;
      throw new AgentsApiError(
        `OpenAI Agents API could not be reached (${error instanceof Error ? error.message : "fetch failed"}).`,
        503,
        "connection_failed",
      );
    }
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw errorFromBody(response.status, body);
    }
    return response;
  }

  private async json<T>(response: Response): Promise<T> {
    const text = await response.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new AgentsApiError("OpenAI Agents API returned a malformed JSON body.", 502, "malformed_response");
    }
  }

  /** Creates a session and returns it without waiting for its first turn. */
  async createSession(body: AgentsApiSessionCreateBody, signal?: AbortSignal): Promise<AgentsApiSession> {
    const response = await this.request("POST", "/agents/sessions", { body: { ...body, stream: false }, signal });
    return this.json<AgentsApiSession>(response);
  }

  /**
   * Creates a session with initial input and streams its events. A
   * conversation-only session (environment `none`) must be created this
   * way: the API refuses an idle one without input.
   */
  async createSessionStream(
    body: AgentsApiSessionCreateBody,
    signal: AbortSignal,
  ): Promise<AsyncGenerator<AgentsApiEvent, void, undefined>> {
    const response = await this.request("POST", "/agents/sessions", {
      body: { ...body, stream: true },
      headers: { accept: "text/event-stream" },
      signal,
    });
    if (!response.body) throw new AgentsApiError("OpenAI Agents API returned no event stream.", 502, "malformed_response");
    return this.events(response.body, signal);
  }

  async retrieveSession(sessionId: string, signal?: AbortSignal): Promise<AgentsApiSession> {
    const response = await this.request("GET", `/agents/sessions/${encodeURIComponent(sessionId)}`, { signal });
    return this.json<AgentsApiSession>(response);
  }

  async deleteSession(sessionId: string, signal?: AbortSignal): Promise<void> {
    await this.request("DELETE", `/agents/sessions/${encodeURIComponent(sessionId)}`, { signal });
  }

  /** A turn's current status and usage (usage is attached shortly after completion). */
  async retrieveTurn(sessionId: string, turnId: string, signal?: AbortSignal): Promise<AgentsApiTurn> {
    const response = await this.request(
      "GET",
      `/agents/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}`,
      { signal },
    );
    return this.json<AgentsApiTurn>(response);
  }

  /** Lists the root agent's items in creation order, following pagination. */
  async listItems(sessionId: string, signal?: AbortSignal): Promise<AgentsApiItem[]> {
    const items: AgentsApiItem[] = [];
    let after: string | undefined;
    for (let page = 0; page < 20; page += 1) {
      const query = new URLSearchParams({ order: "asc", limit: "100", ...(after ? { after } : {}) });
      const response = await this.request("GET", `/agents/sessions/${encodeURIComponent(sessionId)}/items?${query}`, { signal });
      const payload = await this.json<{ data?: AgentsApiItem[]; has_more?: boolean; last_id?: string | null }>(response);
      items.push(...(payload.data ?? []));
      if (!payload.has_more || !payload.last_id) break;
      after = payload.last_id;
    }
    return items;
  }

  /** Submits input events; the idempotency key makes retries of a submission safe. */
  async submitEvents(
    sessionId: string,
    events: readonly AgentsApiInputEvent[],
    options?: Readonly<{ idempotencyKey?: string; signal?: AbortSignal }>,
  ): Promise<void> {
    await this.request("POST", `/agents/sessions/${encodeURIComponent(sessionId)}/events`, {
      body: { events },
      headers: options?.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {},
      signal: options?.signal,
    });
  }

  /** Subscribes to a session's live events. Subscribe before sending input so nothing is missed. */
  async streamEvents(sessionId: string, signal: AbortSignal): Promise<AsyncGenerator<AgentsApiEvent, void, undefined>> {
    const response = await this.request("GET", `/agents/sessions/${encodeURIComponent(sessionId)}/events`, {
      headers: { accept: "text/event-stream" },
      signal,
    });
    if (!response.body) throw new AgentsApiError("OpenAI Agents API returned no event stream.", 502, "malformed_response");
    return this.events(response.body, signal);
  }

  private async *events(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<AgentsApiEvent, void, undefined> {
    for await (const frame of parseServerSentEvents(body, signal)) {
      if (frame.data === "[DONE]") return;
      let decoded: unknown;
      try { decoded = JSON.parse(frame.data); } catch { continue; }
      if (!isObject(decoded) || typeof decoded.type !== "string") continue;
      yield decoded as AgentsApiEvent;
    }
  }
}
