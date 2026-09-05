export type ConnectorErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "CAPABILITY_UNAVAILABLE"
  | "CONFIGURATION_INVALID"
  | "CREDENTIAL_CONFLICT"
  | "CURSOR_INVALID"
  | "OAUTH_EXCHANGE_FAILED"
  | "RATE_LIMITED"
  | "REMOTE_RESPONSE_INVALID"
  | "REMOTE_UNAVAILABLE"
  | "WEBHOOK_SIGNATURE_INVALID";

export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;

  constructor(
    code: ConnectorErrorCode,
    message: string,
    options: Readonly<{
      retryable?: boolean;
      retryAfterMs?: number;
      details?: Readonly<Record<string, string | number | boolean | null>>;
      cause?: unknown;
    }> = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ConnectorError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
    this.details = options.details;
  }
}

export class ConnectorHttpError extends ConnectorError {
  readonly status: number;
  readonly requestId?: string;

  constructor(
    status: number,
    message: string,
    options: Readonly<{
      retryable?: boolean;
      retryAfterMs?: number;
      requestId?: string;
      details?: Readonly<Record<string, string | number | boolean | null>>;
      cause?: unknown;
    }> = {},
  ) {
    super(status === 429 ? "RATE_LIMITED" : "REMOTE_UNAVAILABLE", message, options);
    this.name = "ConnectorHttpError";
    this.status = status;
    this.requestId = options.requestId;
  }
}
