/** Keep discovery subordinate to evidence gathering, with time left to answer. */
export class ManagedDiscoveryBudget {
  private total = 0;
  private sinceQuery = 0;
  private lastQueries = 0;

  admit(completedQueries: number): string | undefined {
    if (completedQueries > this.lastQueries) {
      this.sinceQuery = 0;
      this.lastQueries = completedQueries;
    }
    if (this.total >= 12) return "The field-discovery allowance is spent. Use the definitions already returned and finish the requested analysis.";
    if (this.sinceQuery >= 3) return "Field discovery is paused until a data query succeeds. You already have field definitions. Run the essential headline or driver query using them before inspecting another topic.";
    this.total += 1;
    this.sinceQuery += 1;
    return undefined;
  }
}

export class ManagedInvestigationBudget {
  private readonly synthesizeAt: number;
  constructor(startedAt: number, deadlineAt: number = startedAt + 720_000) {
    const remaining = Math.max(0, deadlineAt - startedAt);
    const reserve = Math.min(120_000, remaining * 0.3);
    this.synthesizeAt = Math.min(startedAt + 180_000, deadlineAt - reserve);
  }

  guidance(now: number, toolCalls: number, hasEvidence: boolean): string | undefined {
    if (now < this.synthesizeAt && toolCalls < 24) return undefined;
    return hasEvidence
      ? "Finish this response now using the recorded evidence. No further source queries or field discovery are available for this response. Batch any essential calculations, then return the complete final answer JSON. Explain any genuinely unresolved part; do not invent missing findings."
      : "Finish with a precise explanation of why the requested evidence could not be obtained. No further source queries or field discovery are available for this response. Do not invent figures or claim that a failed query proved there was no data.";
  }
}

export const MANAGED_GATHERING_TOOLS = new Set(["SearchSemanticModel", "FetchFieldValues", "GenerateSemanticQuery"]);
