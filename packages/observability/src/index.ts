export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogMetadata = Readonly<Record<string, unknown>>;

export type StructuredLog = Readonly<{
  timestamp: string;
  level: LogLevel;
  service: string;
  event: string;
  serviceVersion: string;
  deploymentId?: string;
  correlationId?: string;
  metadata?: Readonly<Record<string, unknown>>;
}>;

type LogSink = (line: string, level: LogLevel) => void;

const SAFE_NAME = /^[a-z][a-z0-9_.-]{0,119}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const SENSITIVE_KEY = /(?:authorization|cookie|credential|password|payload|private.?key|raw.?body|refresh.?token|secret|session|token|wrapped.?key)/i;

function cleanText(value: string, length = 500): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, length);
}

function safeValue(value: unknown, depth: number): unknown {
  if (depth > 4) return "[truncated]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "string") return cleanText(value);
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.slice(0, 40).map((item) => safeValue(item, depth + 1));
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 60);
    return Object.freeze(Object.fromEntries(entries.map(([key, item]) => [
      cleanText(key, 100),
      SENSITIVE_KEY.test(key) ? "[redacted]" : safeValue(item, depth + 1),
    ])));
  }
  return String(value);
}

export function sanitizeLogMetadata(metadata: LogMetadata): Readonly<Record<string, unknown>> {
  return safeValue(metadata, 0) as Readonly<Record<string, unknown>>;
}

export function safeErrorEvidence(error: unknown): Readonly<{ errorClass: string; code: string }> {
  const errorClass = error instanceof Error && SAFE_ID.test(error.name) ? error.name : "UnknownError";
  const candidate = error instanceof Error ? error.message.split(":", 1)[0]?.trim() : "unknown_error";
  const code = candidate && SAFE_NAME.test(candidate) ? candidate : "unknown_error";
  return Object.freeze({ errorClass, code });
}

export function correlationIdFromHeader(value: string | null | undefined): string {
  const candidate = value?.trim();
  return candidate && SAFE_ID.test(candidate) ? candidate : crypto.randomUUID();
}

function defaultSink(line: string, level: LogLevel): void {
  if (level === "error") console.error(line);
  else console.log(line);
}

export function createServiceLogger(
  service: string,
  options: Readonly<{
    serviceVersion?: string;
    deploymentId?: string;
    now?: () => Date;
    sink?: LogSink;
  }> = {},
) {
  if (!SAFE_NAME.test(service)) throw new Error("Structured logger service name is invalid.");
  const serviceVersion = cleanText(options.serviceVersion?.trim() || process.env.ALBERT_SERVICE_VERSION?.trim() || "development", 120);
  const deploymentId = options.deploymentId?.trim() || process.env.ALBERT_DEPLOYMENT_ID?.trim();
  if (deploymentId && !SAFE_ID.test(deploymentId)) throw new Error("Structured logger deployment ID is invalid.");
  const now = options.now ?? (() => new Date());
  const sink = options.sink ?? defaultSink;

  const write = (
    level: LogLevel,
    event: string,
    metadata: LogMetadata = {},
    correlationId?: string,
  ): StructuredLog => {
    if (!SAFE_NAME.test(event)) throw new Error("Structured log event name is invalid.");
    if (correlationId && !SAFE_ID.test(correlationId)) throw new Error("Structured log correlation ID is invalid.");
    const sanitized = sanitizeLogMetadata(metadata);
    const record: StructuredLog = Object.freeze({
      timestamp: now().toISOString(),
      level,
      service,
      event,
      serviceVersion,
      ...(deploymentId ? { deploymentId } : {}),
      ...(correlationId ? { correlationId } : {}),
      ...(Object.keys(sanitized).length ? { metadata: sanitized } : {}),
    });
    sink(JSON.stringify(record), level);
    return record;
  };

  return Object.freeze({
    debug: (event: string, metadata?: LogMetadata, correlationId?: string) => write("debug", event, metadata, correlationId),
    info: (event: string, metadata?: LogMetadata, correlationId?: string) => write("info", event, metadata, correlationId),
    warn: (event: string, metadata?: LogMetadata, correlationId?: string) => write("warn", event, metadata, correlationId),
    error: (event: string, metadata?: LogMetadata, correlationId?: string) => write("error", event, metadata, correlationId),
  });
}
