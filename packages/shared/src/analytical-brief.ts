export type AnalyticalBrief = Readonly<{
  id: string;
  version: number;
  digest: string;
  ownerGoal: string;
  answerMustCover: readonly string[];
  requiredViews: readonly Readonly<{ view: string; reason: string }>[];
  requiredCalculations: readonly string[];
  commonPeriodEnd: string | null;
}>;
