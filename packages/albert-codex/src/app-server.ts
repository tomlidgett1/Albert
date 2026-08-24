import { spawn, execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import {
  ALBERT_CODEX_PINNED_CLI_VERSION,
  ALBERT_CODEX_ANALYSIS_TIMEOUT_MS,
  CODEX_DYNAMIC_TOOL_SPECS,
  CODEX_FINAL_OUTPUT_JSON_SCHEMA,
} from "./contracts.js";
import { startCodexProModeProxy, type CodexProModeProxy } from "./pro-mode-proxy.js";

const execFileAsync = promisify(execFile);
const REQUEST_TIMEOUT_MS = 30_000;
const ANALYSIS_TIMEOUT_MS = ALBERT_CODEX_ANALYSIS_TIMEOUT_MS;
const MIN_REPAIR_WINDOW_MS = 60_000;
const STDERR_LIMIT = 12_000;

type JsonObject = Record<string, unknown>;

export type CodexDynamicToolCall = Readonly<{
  threadId: string;
  turnId: string;
  callId: string;
  namespace: string | null;
  tool: string;
  arguments: unknown;
}>;

export type CodexAppServerTurnResult = Readonly<{
  threadId: string;
  turnId: string;
  finalMessage: string;
  durationMs: number | null;
}>;

/**
 * The model identity is explicit so a local ChatGPT-subscription run cannot
 * silently fall back to API billing (or vice versa). ChatGPT credentials stay
 * owned by Codex in its existing state directory; Albert never reads or copies
 * the stored OAuth material.
 */
export type CodexAppServerAuthentication = Readonly<
  | { mode: "api"; apiKey: string; baseUrl: string }
  | {
      mode: "chatgpt";
      codexHome: string;
      /** Exact local instruction files reviewed for this evaluation identity. */
      reviewedInstructionSources?: readonly Readonly<{ path: string; sha256: string }>[];
    }
>;

export type CodexAppServerTurnOptions = Readonly<{
  authentication: CodexAppServerAuthentication;
  model: string;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  /** GPT-5.6 Responses reasoning mode; independent of `effort`. */
  proMode?: boolean;
  /** Optional shorter deadline for bounded preflight turns. */
  timeoutMs?: number;
  /**
   * Effort for validator-driven repair turns on the same thread. Repairs
   * rebind citations over evidence that already exists, so a lighter effort
   * shortens the tail without weakening the investigation itself.
   */
  repairEffort?: "low" | "medium" | "high" | "xhigh" | "max";
  fastMode: boolean;
  input: string;
  baseInstructions: string;
  developerInstructions: string;
  /** Defaults to Albert's governed analytical tools; graders may pass []. */
  dynamicTools?: readonly Readonly<Record<string, unknown>>[];
  /** Defaults to Albert's final-answer schema; bounded eval graders may override it. */
  outputSchema?: Readonly<Record<string, unknown>>;
  binaryPath?: string;
  signal?: AbortSignal;
  onNotification?: (method: string, params: unknown) => void | Promise<void>;
  /**
   * Return null when the candidate is safe to publish. A non-empty string is
   * host-owned validation feedback that starts another turn on the same
   * ephemeral thread, preserving its tool results and reasoning context.
   */
  validateFinalCandidate?: (
    finalMessage: string,
    repairAttempt: number,
  ) => Promise<string | null> | string | null;
  onToolCall: (call: CodexDynamicToolCall) => Promise<Readonly<{
    success: boolean;
    text: string;
  }>>;
}>;

const versionChecks = new Map<string, Promise<string>>();
const chatGPTLoginChecks = new Map<string, Promise<void>>();

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function codexAppServerArguments(
  authentication: CodexAppServerAuthentication,
  fastMode = false,
  runtimeStateHome?: string,
  openaiBaseUrlOverride?: string,
): readonly string[] {
  const openaiBaseUrl = openaiBaseUrlOverride
    ?? (authentication.mode === "api" ? authentication.baseUrl : undefined);
  return Object.freeze([
    "app-server",
    "--listen", "stdio://",
    "--strict-config",
    "--disable", "shell_tool",
    "--disable", "unified_exec",
    "--disable", "multi_agent",
    "--disable", "multi_agent_v2",
    "--disable", "apps",
    "--disable", "plugins",
    "--disable", "remote_plugin",
    "--disable", "browser_use",
    "--disable", "browser_use_external",
    "--disable", "computer_use",
    "--disable", "in_app_browser",
    "--disable", "image_generation",
    "--disable", "goals",
    "--disable", "hooks",
    "--disable", "tool_suggest",
    "--disable", "workspace_dependencies",
    "--disable", "code_mode",
    "--disable", "code_mode_only",
    "-c", "analytics.enabled=false",
    "-c", "history.persistence=\"none\"",
    ...(runtimeStateHome ? [
      "-c", `sqlite_home=${JSON.stringify(runtimeStateHome)}`,
      "-c", `log_dir=${JSON.stringify(join(runtimeStateHome, "logs"))}`,
    ] : []),
    "-c", "web_search=\"disabled\"",
    "-c", "approval_policy=\"never\"",
    "-c", "sandbox_mode=\"read-only\"",
    "-c", `forced_login_method=${JSON.stringify(authentication.mode)}`,
    ...(fastMode ? ["-c", "features.fast_mode=true"] : []),
    ...(fastMode && authentication.mode === "chatgpt" ? ["-c", "service_tier=\"fast\""] : []),
    "-c", "tools.update_plan.enabled=true",
    "-c", "agents.enabled=false",
    "-c", "project_doc_max_bytes=0",
    "-c", "project_doc_fallback_filenames=[]",
    "-c", "mcp_servers={}",
    // The desktop-managed ChatGPT home contributes these built-in MCP entries
    // above the ordinary user mcp_servers table. Disable them explicitly for
    // subscription evaluation. A fresh API-mode home has no such entries;
    // declaring only `enabled=false` there is an incomplete MCP transport and
    // makes the real Linux app-server exit during startup.
    ...(authentication.mode === "chatgpt" ? [
      "-c", "mcp_servers.openaiDeveloperDocs.enabled=false",
      "-c", "mcp_servers.node_repl.enabled=false",
    ] : []),
    ...(openaiBaseUrl ? ["-c", `openai_base_url=${JSON.stringify(openaiBaseUrl)}`] : []),
  ]);
}

/**
 * Deliberately does not inherit the host process environment. In particular,
 * the child never receives Cube, Supabase, connector, signing, or database
 * credentials. The OpenAI identity is the only secret the harness needs; the
 * Codex state path is a fresh private directory deleted after this turn.
 */
export function codexChildEnvironment(input: Readonly<{
  baseUrl?: string;
  codexHome?: string;
}>): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    ...(input.baseUrl ? { OPENAI_BASE_URL: input.baseUrl } : {}),
    ...(input.codexHome ? { CODEX_HOME: input.codexHome } : {}),
  };
  for (const key of ["PATH", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR"] as const) {
    const value = process.env[key];
    if (value) environment[key] = value;
  }
  return environment;
}

async function authenticateCodexApiKey(input: Readonly<{
  binaryPath: string;
  apiKey: string;
  baseUrl: string;
  environment: NodeJS.ProcessEnv;
  cwd: string;
}>): Promise<void> {
  await new Promise<void>((resolveLogin, rejectLogin) => {
    const child = spawn(input.binaryPath, [
      "login",
      "--with-api-key",
      "-c", `openai_base_url=${JSON.stringify(input.baseUrl)}`,
      "-c", "forced_login_method=\"api\"",
    ], {
      cwd: input.cwd,
      env: input.environment,
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectLogin(new Error("Codex API authentication timed out."));
    }, 15_000);
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr = `${stderr}${String(chunk)}`.slice(-2_000);
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      rejectLogin(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolveLogin();
      else rejectLogin(new Error(`Codex API authentication failed${stderr.trim() ? `: ${stderr.trim().slice(0, 500)}` : ""}.`));
    });
    child.stdin?.end(`${input.apiKey}\n`);
  });
}

/** Verify the Codex-owned OAuth session without reading its credential files. */
export async function assertCodexChatGPTLogin(input: Readonly<{
  binaryPath: string;
  codexHome: string;
  environment: NodeJS.ProcessEnv;
  cwd: string;
}>): Promise<void> {
  const key = `${input.binaryPath}\u0000${input.codexHome}`;
  let check = chatGPTLoginChecks.get(key);
  if (!check) {
    check = execFileAsync(input.binaryPath, [
      "login",
      "status",
      "-c", "forced_login_method=\"chatgpt\"",
    ], {
      cwd: input.cwd,
      env: input.environment,
      timeout: 10_000,
      maxBuffer: 4_096,
    }).then(({ stdout, stderr }) => {
      if (!/Logged in using ChatGPT/iu.test(`${stdout}\n${stderr}`)) {
        throw new Error("Codex is not signed in with ChatGPT for subscription access.");
      }
    });
    chatGPTLoginChecks.set(key, check);
  }
  try {
    await check;
  } catch (error) {
    chatGPTLoginChecks.delete(key);
    throw error;
  }
}

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function resolveCodexBinary(explicit?: string): Promise<string> {
  const candidates = [
    explicit?.trim(),
    process.env.ALBERT_CODEX_BINARY_PATH?.trim(),
    resolve(process.cwd(), "node_modules/.bin/codex"),
    // Local web emulators can report a non-darwin platform even though their
    // Node host is macOS. The executable check keeps this harmless on Linux.
    "/Applications/ChatGPT.app/Contents/Resources/codex",
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    if (await executable(candidate)) return candidate;
  }
  throw new Error(
    "The pinned Codex runtime is unavailable. Install @openai/codex or set ALBERT_CODEX_BINARY_PATH.",
  );
}

export async function assertPinnedCodexVersion(
  binaryPath: string,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  let check = versionChecks.get(binaryPath);
  if (!check) {
    check = execFileAsync(binaryPath, ["--version"], {
      env: environment,
      timeout: 10_000,
      maxBuffer: 4_096,
    }).then(({ stdout }) => stdout.trim());
    versionChecks.set(binaryPath, check);
  }
  const version = await check;
  if (!version.startsWith(`codex-cli ${ALBERT_CODEX_PINNED_CLI_VERSION}`)) {
    versionChecks.delete(binaryPath);
    throw new Error(
      `The Codex runtime version is ${version || "unknown"}; ${ALBERT_CODEX_PINNED_CLI_VERSION} is required.`,
    );
  }
  return version;
}

class CodexJsonRpcSession {
  private nextRequestId = 1;
  private readonly pending = new Map<number, Readonly<{
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>>();
  private readonly completedTurns = new Map<string, JsonObject>();
  private readonly turnWaiters = new Map<string, Readonly<{
    resolve: (turn: JsonObject) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>>();
  private readonly toolCalls = new Map<string, Promise<Readonly<{ success: boolean; text: string }>>>();
  private readonly finalMessages = new Map<string, string[]>();
  private stderr = "";
  private closed = false;
  private expectedThreadId: string | undefined;
  private expectedTurnId: string | undefined;

  constructor(
    private readonly child: ReturnType<typeof spawn>,
    private readonly options: Pick<CodexAppServerTurnOptions, "onNotification" | "onToolCall">,
  ) {
    const lines = createInterface({ input: child.stdout!, crlfDelay: Infinity });
    lines.on("line", (line) => {
      if (!line.trim()) return;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        this.failAll(new Error("Codex app-server emitted malformed JSON."));
        return;
      }
      void this.receive(message).catch((error) => {
        this.failAll(error instanceof Error ? error : new Error("Codex app-server protocol failed."));
      });
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      this.stderr = `${this.stderr}${String(chunk)}`.slice(-STDERR_LIMIT);
    });
    child.once("error", (error) => this.failAll(error));
    child.once("exit", (code, signal) => {
      if (this.closed) return;
      const detail = this.stderr.trim().split("\n").slice(-4).join(" ").slice(0, 1_000);
      this.failAll(new Error(
        `Codex app-server exited before the turn completed (${signal ?? code ?? "unknown"})${detail ? `: ${detail}` : ""}.`,
      ));
    });
  }

  setExpectedThread(threadId: string): void {
    this.expectedThreadId = threadId;
  }

  setExpectedTurn(turnId: string): void {
    this.expectedTurnId = turnId;
  }

  async request(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    if (this.closed) throw new Error("Codex app-server is closed.");
    const id = this.nextRequestId++;
    const response = new Promise<unknown>((resolveRequest, rejectRequest) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`Codex app-server ${method} timed out.`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timeout });
    });
    this.write({ method, id, params });
    return response;
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  async waitForTurn(turnId: string, timeoutMs: number = ANALYSIS_TIMEOUT_MS): Promise<JsonObject> {
    const completed = this.completedTurns.get(turnId);
    if (completed) return completed;
    return new Promise<JsonObject>((resolveTurn, rejectTurn) => {
      const timeout = setTimeout(() => {
        this.turnWaiters.delete(turnId);
        rejectTurn(new Error("The Codex analytical turn timed out."));
      }, timeoutMs);
      this.turnWaiters.set(turnId, { resolve: resolveTurn, reject: rejectTurn, timeout });
    });
  }

  finalMessage(turnId: string): string {
    return this.finalMessages.get(turnId)?.at(-1)?.trim() ?? "";
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    await this.request("turn/interrupt", { threadId, turnId }, 5_000).catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Codex app-server closed."));
    }
    this.pending.clear();
    for (const waiter of this.turnWaiters.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error("Codex app-server closed."));
    }
    this.turnWaiters.clear();
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill("SIGTERM");
      await new Promise<void>((resolveClose) => {
        const timeout = setTimeout(() => {
          if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
          resolveClose();
        }, 1_000);
        this.child.once("exit", () => {
          clearTimeout(timeout);
          resolveClose();
        });
      });
    }
  }

  private write(message: JsonObject): void {
    if (!this.child.stdin?.writable) throw new Error("Codex app-server input is closed.");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private async receive(value: unknown): Promise<void> {
    if (!isObject(value)) return;
    const id = typeof value.id === "number" ? value.id : undefined;
    const method = asString(value.method);
    if (id !== undefined && method) {
      await this.handleServerRequest(id, method, value.params);
      return;
    }
    if (id !== undefined) {
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      clearTimeout(pending.timeout);
      if (isObject(value.error)) {
        pending.reject(new Error(asString(value.error.message) ?? "Codex app-server rejected the request."));
      } else {
        pending.resolve(value.result);
      }
      return;
    }
    if (!method) return;
    this.captureNotification(method, value.params);
    await this.options.onNotification?.(method, value.params);
  }

  private captureNotification(method: string, params: unknown): void {
    if (!isObject(params)) return;
    const turnId = asString(params.turnId)
      ?? (isObject(params.turn) ? asString(params.turn.id) : undefined);
    if (
      method === "item/completed"
      && turnId
      && isObject(params.item)
      && params.item.type === "agentMessage"
      && params.item.phase !== "commentary"
    ) {
      const text = asString(params.item.text);
      if (text) this.finalMessages.set(turnId, [...(this.finalMessages.get(turnId) ?? []), text]);
    }
    if (method !== "turn/completed" || !turnId || !isObject(params.turn)) return;
    const waiter = this.turnWaiters.get(turnId);
    if (waiter) {
      this.turnWaiters.delete(turnId);
      clearTimeout(waiter.timeout);
      waiter.resolve(params.turn);
    } else {
      this.completedTurns.set(turnId, params.turn);
    }
  }

  private async handleServerRequest(id: number, method: string, params: unknown): Promise<void> {
    if (method !== "item/tool/call" || !isObject(params)) {
      // Denying the request is the isolation boundary: approvals, user-input
      // prompts and utility reads (currentTime/read and friends) all fail
      // closed through this error reply. Killing the whole analysis on benign
      // protocol chatter previously turned long turns into hard failures.
      this.write({ id, error: { code: -32_601, message: "Albert does not expose this Codex capability." } });
      return;
    }
    const call: CodexDynamicToolCall = {
      threadId: asString(params.threadId) ?? "",
      turnId: asString(params.turnId) ?? "",
      callId: asString(params.callId) ?? "",
      namespace: params.namespace === null ? null : asString(params.namespace) ?? null,
      tool: asString(params.tool) ?? "",
      arguments: params.arguments,
    };
    if (
      !call.callId
      || call.namespace !== "albert"
      || (this.expectedThreadId && call.threadId !== this.expectedThreadId)
      || (this.expectedTurnId && call.turnId !== this.expectedTurnId)
    ) {
      this.write({ id, result: { contentItems: [{ type: "inputText", text: "Tool scope rejected." }], success: false } });
      return;
    }
    let pendingOutput = this.toolCalls.get(call.callId);
    if (!pendingOutput) {
      pendingOutput = this.options.onToolCall(call).catch((error) => ({
        success: false,
        text: error instanceof Error ? error.message.slice(0, 1_000) : "The governed tool failed.",
      }));
      this.toolCalls.set(call.callId, pendingOutput);
    }
    const output = await pendingOutput;
    this.write({
      id,
      result: {
        contentItems: [{ type: "inputText", text: output.text.slice(0, 120_000) }],
        success: output.success,
      },
    });
  }

  private failAll(error: Error): void {
    if (this.closed) return;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.turnWaiters.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.turnWaiters.clear();
  }
}

function threadIdFromResponse(value: unknown, allowedInstructionSources: ReadonlySet<string>): string {
  if (!isObject(value) || !isObject(value.thread)) throw new Error("Codex returned no thread.");
  const instructionSources = Array.isArray(value.instructionSources)
    ? value.instructionSources.filter((source): source is string => typeof source === "string")
    : [];
  const unexpectedInstructionSources = instructionSources.filter((source) => !allowedInstructionSources.has(source));
  if (unexpectedInstructionSources.length > 0) {
    throw new Error("Codex loaded an external instruction source; the analytical thread was rejected.");
  }
  if (Array.isArray(value.runtimeWorkspaceRoots) && value.runtimeWorkspaceRoots.length > 0) {
    throw new Error("Codex attached an external workspace root; the analytical thread was rejected.");
  }
  const threadId = asString(value.thread.id);
  if (!threadId) throw new Error("Codex returned an invalid thread id.");
  return threadId;
}

function turnIdFromResponse(value: unknown): string {
  if (!isObject(value) || !isObject(value.turn)) throw new Error("Codex returned no turn.");
  const turnId = asString(value.turn.id);
  if (!turnId) throw new Error("Codex returned an invalid turn id.");
  return turnId;
}

function appServerErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return "";
}

function isTransientModelTurnFailure(error: unknown): boolean {
  return /(?:response_closed|response closed|stream (?:closed|ended|disconnected|error)|connection (?:closed|reset)|ECONNRESET|temporarily unavailable|server_error|rate limit)/iu
    .test(appServerErrorMessage(error));
}

export async function runCodexAppServerTurn(
  options: CodexAppServerTurnOptions,
): Promise<CodexAppServerTurnResult> {
  const { authentication } = options;
  if (options.proMode && authentication.mode !== "api") {
    throw new Error("Codex Pro reasoning mode requires API authentication.");
  }
  if (authentication.mode === "api") {
    if (!authentication.apiKey.trim()) throw new Error("The Codex runtime requires an OpenAI API key.");
    if (!authentication.baseUrl.trim()) throw new Error("The Codex runtime requires an OpenAI API base URL.");
  } else {
    if (process.env.NODE_ENV === "production") {
      throw new Error("ChatGPT subscription authentication is local-evaluation only.");
    }
    if (!authentication.codexHome.trim() || !isAbsolute(authentication.codexHome)) {
      throw new Error("The ChatGPT-authenticated Codex home must be an absolute path.");
    }
  }
  const workspace = await mkdtemp(join(tmpdir(), "albert-codex-turn-"));
  const runtimeStateHome = join(workspace, "runtime-state");
  await mkdir(runtimeStateHome, { mode: 0o700 });
  const codexHome = authentication.mode === "api"
    ? join(workspace, "codex-home")
    : authentication.codexHome;
  if (authentication.mode === "api") await mkdir(codexHome, { mode: 0o700 });
  const authenticationEnvironment = codexChildEnvironment({
    ...(authentication.mode === "api" ? { baseUrl: authentication.baseUrl } : {}),
    codexHome,
  });
  const binaryPath = await resolveCodexBinary(options.binaryPath);
  await assertPinnedCodexVersion(binaryPath, authenticationEnvironment);
  const allowedInstructionSources = new Set<string>();
  if (authentication.mode === "api") {
    await authenticateCodexApiKey({
      binaryPath,
      apiKey: authentication.apiKey,
      baseUrl: authentication.baseUrl,
      environment: authenticationEnvironment,
      cwd: workspace,
    });
  } else {
    for (const reviewed of authentication.reviewedInstructionSources ?? []) {
      if (!isAbsolute(reviewed.path) || resolve(reviewed.path) !== resolve(authentication.codexHome, "AGENTS.md")) {
        throw new Error("A reviewed Codex instruction source must be the authenticated home AGENTS.md file.");
      }
      if (!/^[a-f0-9]{64}$/u.test(reviewed.sha256)) {
        throw new Error("A reviewed Codex instruction source requires a SHA-256 digest.");
      }
      const digest = createHash("sha256").update(await readFile(reviewed.path)).digest("hex");
      if (digest !== reviewed.sha256) {
        throw new Error("The reviewed Codex instruction source changed; subscription evaluation was rejected.");
      }
      allowedInstructionSources.add(reviewed.path);
    }
    await assertCodexChatGPTLogin({
      binaryPath,
      codexHome,
      environment: authenticationEnvironment,
      cwd: workspace,
    });
  }
  let proModeProxy: CodexProModeProxy | undefined;
  if (options.proMode && authentication.mode === "api") {
    proModeProxy = await startCodexProModeProxy(authentication.baseUrl, authentication.apiKey);
  }
  const providerBaseUrl = proModeProxy?.baseUrl
    ?? (authentication.mode === "api" ? authentication.baseUrl : undefined);
  const environment = proModeProxy
    ? codexChildEnvironment({ baseUrl: proModeProxy.baseUrl, codexHome })
    : authenticationEnvironment;
  const child = spawn(binaryPath, [
    ...codexAppServerArguments(authentication, options.fastMode, runtimeStateHome, providerBaseUrl),
  ], {
    cwd: workspace,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const session = new CodexJsonRpcSession(child, options);
  let threadId: string | undefined;
  let turnId: string | undefined;
  const abort = () => {
    if (threadId && turnId) void session.interrupt(threadId, turnId);
  };
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    await session.request("initialize", {
      clientInfo: { name: "albert_codex_tab", title: "Albert Codex", version: "0.1.0" },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        // Product progress is emitted only through Albert's evidence-bound
        // host tool. Raw model commentary deltas are neither rendered nor
        // retained by the isolated analytical runtime.
        optOutNotificationMethods: ["item/agentMessage/delta"],
      },
    }, 90_000);
    session.notify("initialized");
    if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
    const thread = await session.request("thread/start", {
      model: options.model,
      modelProvider: "openai",
      allowProviderModelFallback: false,
      cwd: workspace,
      ephemeral: true,
      approvalPolicy: "never",
      sandbox: "read-only",
      environments: [],
      runtimeWorkspaceRoots: [],
      selectedCapabilityRoots: [],
      baseInstructions: options.baseInstructions,
      developerInstructions: options.developerInstructions,
      dynamicTools: options.dynamicTools ?? CODEX_DYNAMIC_TOOL_SPECS,
    }, 60_000);
    threadId = threadIdFromResponse(thread, allowedInstructionSources);
    session.setExpectedThread(threadId);
    const timeoutMs = Number.isFinite(options.timeoutMs)
      ? Math.max(1_000, Math.min(ANALYSIS_TIMEOUT_MS, Math.floor(options.timeoutMs!)))
      : ANALYSIS_TIMEOUT_MS;
    const deadlineAt = Date.now() + timeoutMs;
    let nextInput = options.input;
    let totalDurationMs = 0;
    // A transient stream resume continues the investigation at full effort;
    // only validator-driven repair turns run at the lighter repair effort.
    let repairingCandidate = false;
    for (let repairAttempt = 0; ; repairAttempt += 1) {
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) throw new Error("The Codex analytical turn timed out.");
      try {
        const started = await session.request("turn/start", {
          threadId,
          input: [{ type: "text", text: nextInput, text_elements: [] }],
          environments: [],
          runtimeWorkspaceRoots: [],
          approvalPolicy: "never",
          sandboxPolicy: { type: "readOnly", networkAccess: false },
          model: options.model,
          effort: repairingCandidate ? options.repairEffort ?? options.effort : options.effort,
          summary: "concise",
          // The codex model catalog's fast tier id is "priority" ("Fast" is
          // its display name); "fast" is not a tier id and codex silently
          // drops it, leaving the request on the default tier. Verified by
          // capturing the binary's /v1/responses payloads (2026-08-23).
          serviceTier: options.fastMode ? "priority" : null,
          outputSchema: options.outputSchema ?? CODEX_FINAL_OUTPUT_JSON_SCHEMA,
        });
        turnId = turnIdFromResponse(started);
        session.setExpectedTurn(turnId);
        let rejectAbort: (() => void) | undefined;
        const abortPromise = new Promise<never>((_, reject) => {
          if (!options.signal) return;
          rejectAbort = () => reject(options.signal?.reason ?? new DOMException("Aborted", "AbortError"));
          if (options.signal.aborted) rejectAbort();
          else options.signal.addEventListener("abort", rejectAbort, { once: true });
        });
        const completed = await Promise.race([
          session.waitForTurn(turnId, remainingMs),
          abortPromise,
        ]).finally(() => {
          if (rejectAbort) options.signal?.removeEventListener("abort", rejectAbort);
        });
        const durationMs = typeof completed.durationMs === "number" ? completed.durationMs : null;
        if (durationMs !== null) totalDurationMs += durationMs;
        const status = asString(completed.status);
        if (status !== "completed") {
          const error = isObject(completed.error) ? asString(completed.error.message) : undefined;
          throw new Error(error ?? `Codex turn ended with status ${status ?? "unknown"}.`);
        }
        const finalMessage = session.finalMessage(turnId);
        if (!finalMessage) throw new Error("Codex completed without a final structured answer.");
        const validationFeedback = await options.validateFinalCandidate?.(finalMessage, repairAttempt) ?? null;
        if (!validationFeedback || deadlineAt - Date.now() < MIN_REPAIR_WINDOW_MS) {
          return {
            threadId,
            turnId,
            finalMessage,
            durationMs: totalDurationMs || null,
          };
        }
        repairingCandidate = true;
        nextInput = `Albert's independent evidence validator rejected the previous candidate answer.

Validation feedback:
${validationFeedback.slice(0, 2_000)}

Continue working in this same thread. Reuse the governed tool results already returned. Correct the structured claims using exact resultId, rowIndex and columnKey values from those results. Run additional governed queries only when the feedback identifies genuinely missing evidence. Do not repeat an equivalent successful query. Return a complete corrected answer satisfying the output schema; do not discuss this repair instruction in the answer.`;
      } catch (error) {
        if (
          options.signal?.aborted
          || !isTransientModelTurnFailure(error)
          || deadlineAt - Date.now() < MIN_REPAIR_WINDOW_MS
        ) {
          throw error;
        }
        repairingCandidate = false;
        nextInput = `The previous model response stream closed before the analytical turn completed.

Continue working in this same thread. Preserve and reuse every governed tool result already returned, continue the existing plan from its current state, and run only materially missing checks. Do not restart the investigation or repeat an equivalent successful query. Return the complete structured answer when the evidence is sufficient.`;
      }
    }
  } finally {
    options.signal?.removeEventListener("abort", abort);
    await session.close().catch(() => undefined);
    await proModeProxy?.close().catch(() => undefined);
    const safeRoot = `${tmpdir().replace(/\/+$/u, "")}/albert-codex-turn-`;
    if (workspace.startsWith(safeRoot)) await rm(workspace, { recursive: true, force: true });
  }
}
