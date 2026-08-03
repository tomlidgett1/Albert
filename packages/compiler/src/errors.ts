export type CompilerErrorCode =
  | "INVALID_IR"
  | "UNKNOWN_TOPIC"
  | "UNKNOWN_METRIC"
  | "METRIC_NOT_IN_TOPIC"
  | "FORBIDDEN_ROLE"
  | "MISSING_CAPABILITY"
  | "ILLEGAL_DIMENSION"
  | "ILLEGAL_JOIN"
  | "CROSS_FACT_QUERY"
  | "COMPOSITE_REQUIRED"
  | "INVALID_ALIGNMENT"
  | "SNAPSHOT_SUM_FORBIDDEN"
  | "INVALID_TIME_FIELD"
  | "INVALID_PARAMETER"
  | "QUERY_BUDGET_EXCEEDED";

export class SemanticCompilerError extends Error {
  readonly code: CompilerErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: CompilerErrorCode, message: string, details: Readonly<Record<string, unknown>> = {}) {
    super(message);
    this.name = "SemanticCompilerError";
    this.code = code;
    this.details = details;
  }

  toJSON(): Readonly<{ code: CompilerErrorCode; message: string; details: Readonly<Record<string, unknown>> }> {
    return { code: this.code, message: this.message, details: this.details };
  }
}
