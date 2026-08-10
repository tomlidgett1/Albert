import type { InternalCompletion } from "../../../packages/anthropic-analytics/src/index.js";

type Outcome = InternalCompletion["answerState"];

/** Process-local metrics snapshot. The deployment collector scrapes this
 * private service endpoint; labels never include tenant or user values. */
export class AnthropicAnalyticsMetrics {
  private readonly outcomes: Record<Outcome, number> = {
    verified: 0,
    qualified: 0,
    exploratory: 0,
    clarification: 0,
    unavailable: 0,
  };
  private acceptedTurns = 0;
  private completedTurns = 0;
  private abortedTurns = 0;
  private runtimeFailures = 0;
  private sqlAttempts = 0;
  private sqlSuccesses = 0;
  private sqlFailures = 0;
  private groundingRejections = 0;
  private providerFallbacks = 0;
  private sessionMirrorErrors = 0;
  private totalLatencyMs = 0;
  private estimatedCostUsdMicros = 0;

  recordAccepted(): void { this.acceptedTurns += 1; }
  recordAbort(): void { this.abortedTurns += 1; }
  recordRuntimeFailure(): void { this.runtimeFailures += 1; }

  recordCompletion(completion: InternalCompletion): void {
    this.completedTurns += 1;
    this.outcomes[completion.answerState] += 1;
    this.sqlAttempts += completion.telemetry.sqlAttempts;
    this.sqlSuccesses += completion.telemetry.sqlSuccesses;
    this.sqlFailures += completion.telemetry.sqlFailures;
    this.groundingRejections += completion.telemetry.groundingRejections;
    this.providerFallbacks += Number(completion.telemetry.providerFallback);
    this.sessionMirrorErrors += completion.telemetry.sessionMirrorErrors;
    this.totalLatencyMs += completion.telemetry.durationMs;
    this.estimatedCostUsdMicros += completion.metering.estimatedCostUsdMicros;
  }

  snapshot(): Readonly<Record<string, unknown>> {
    return Object.freeze({
      acceptedTurns: this.acceptedTurns,
      completedTurns: this.completedTurns,
      terminalOutcomeRate: this.acceptedTurns === 0 ? 1 : this.completedTurns / this.acceptedTurns,
      outcomes: Object.freeze({ ...this.outcomes }),
      sql: Object.freeze({ attempts: this.sqlAttempts, successes: this.sqlSuccesses, failures: this.sqlFailures }),
      groundingRejections: this.groundingRejections,
      providerFallbacks: this.providerFallbacks,
      sessionMirrorErrors: this.sessionMirrorErrors,
      abortedTurns: this.abortedTurns,
      runtimeFailures: this.runtimeFailures,
      totalLatencyMs: this.totalLatencyMs,
      estimatedCostUsdMicros: this.estimatedCostUsdMicros,
    });
  }
}
