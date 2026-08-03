import type { ModelUsageOutcome } from "../../../packages/shared/src/index.js";
import type {
  MeteredModelUsage,
  ProviderRunUsage,
} from "../../../packages/usage-metering/src/index.js";

export type DurableProviderUsage = Readonly<{
  providerResponseId: string | null;
  providerUsage: ProviderRunUsage;
  metering: MeteredModelUsage;
}>;

type TerminalUsageOutcome = Exclude<ModelUsageOutcome, "provider_completed">;
type UsageRecorder = (
  usage: DurableProviderUsage,
  outcome: ModelUsageOutcome,
) => Promise<void>;

/**
 * Small retry-safe state machine used by the request orchestrator. The
 * provider checkpoint is attempted before answer construction/finalization;
 * terminal outcomes reuse the immutable same usage payload.
 */
export class DurableModelUsageLifecycle {
  private usage?: DurableProviderUsage;
  private providerDurable = false;
  private terminalOutcome?: TerminalUsageOutcome;
  private terminalDurable = false;

  constructor(private readonly record: UsageRecorder) {}

  get checkpoint(): DurableProviderUsage | undefined {
    return this.usage;
  }

  async providerCompleted(usage: DurableProviderUsage): Promise<void> {
    if (this.usage && JSON.stringify(this.usage) !== JSON.stringify(usage)) {
      throw new Error("Provider usage changed after it was observed for this turn.");
    }
    this.usage ??= Object.freeze({
      providerResponseId: usage.providerResponseId,
      providerUsage: Object.freeze({ ...usage.providerUsage }),
      metering: Object.freeze({ ...usage.metering }),
    });
    if (this.providerDurable) return;
    await this.record(this.usage, "provider_completed");
    this.providerDurable = true;
  }

  async terminal(outcome: TerminalUsageOutcome): Promise<boolean> {
    if (!this.usage) return false;
    if (this.terminalOutcome && this.terminalOutcome !== outcome) {
      throw new Error(`Model usage already has terminal outcome ${this.terminalOutcome}.`);
    }
    this.terminalOutcome ??= outcome;
    if (this.terminalDurable) return true;
    await this.record(this.usage, outcome);
    this.terminalDurable = true;
    return true;
  }
}
