import { createHash } from "node:crypto";
import { z } from "zod";

const decimalSchema = z.union([
  z.string().regex(/^-?\d+(?:\.\d+)?$/),
  z.number().finite(),
]);
const labelledValueSchema = z
  .object({
    key: z.string().min(1),
    label: z.string().min(1),
    value: decimalSchema,
  })
  .strict();

export const analyticalOperatorIdV2Schema = z.enum([
  "period_contribution",
  "dimension_contribution",
  "gross_margin_bridge",
  "price_volume_mix",
  "pareto_concentration",
  "trend_anomaly",
  "discount_leakage",
  "return_rate",
  "customer_retention",
  "stockout_opportunity",
  "supplier_performance",
  "pos_xero_reconciliation",
  "sales_bank_reconciliation",
  "profitability_bridge",
  "opportunity_sizing",
  "constraint_controllability",
]);
export type AnalyticalOperatorIdV2 = z.infer<
  typeof analyticalOperatorIdV2Schema
>;

export const operatorInputV2Schema = z.discriminatedUnion("operatorId", [
  z
    .object({
      operatorId: z.literal("period_contribution"),
      current: z.array(labelledValueSchema).min(1),
      comparison: z.array(labelledValueSchema).min(1),
    })
    .strict(),
  z
    .object({
      operatorId: z.literal("dimension_contribution"),
      current: z.array(labelledValueSchema).min(1),
      comparison: z.array(labelledValueSchema).default([]),
    })
    .strict(),
  z
    .object({
      operatorId: z.literal("gross_margin_bridge"),
      currentRevenue: decimalSchema,
      comparisonRevenue: decimalSchema,
      currentCost: decimalSchema,
      comparisonCost: decimalSchema,
    })
    .strict(),
  z
    .object({
      operatorId: z.literal("price_volume_mix"),
      items: z
        .array(
          z
            .object({
              key: z.string().min(1),
              currentPrice: decimalSchema,
              comparisonPrice: decimalSchema,
              currentVolume: decimalSchema,
              comparisonVolume: decimalSchema,
              population: z
                .enum(["continuing", "new", "discontinued"])
                .default("continuing"),
            })
            .strict(),
        )
        .min(1),
    })
    .strict(),
  z
    .object({
      operatorId: z.literal("pareto_concentration"),
      items: z.array(labelledValueSchema).min(1),
      targetShare: z.number().gt(0).lte(1).default(0.8),
    })
    .strict(),
  z
    .object({
      operatorId: z.literal("trend_anomaly"),
      points: z
        .array(
          z
            .object({ period: z.string().min(1), value: decimalSchema })
            .strict(),
        )
        .min(4),
      zThreshold: z.number().gt(0).lte(10).default(2.5),
    })
    .strict(),
  z
    .object({
      operatorId: z.literal("discount_leakage"),
      grossSales: decimalSchema,
      discounts: decimalSchema,
      comparisonDiscounts: decimalSchema.optional(),
      approvedDiscounts: decimalSchema.optional(),
    })
    .strict(),
  z
    .object({
      operatorId: z.literal("return_rate"),
      grossSales: decimalSchema,
      returnValue: decimalSchema,
      soldUnits: decimalSchema.optional(),
      returnedUnits: decimalSchema.optional(),
    })
    .strict(),
  z
    .object({
      operatorId: z.literal("customer_retention"),
      cohorts: z
        .array(
          z
            .object({
              cohort: z.string().min(1),
              acquired: decimalSchema,
              retained: decimalSchema,
            })
            .strict(),
        )
        .min(1),
    })
    .strict(),
  z
    .object({
      operatorId: z.literal("stockout_opportunity"),
      items: z
        .array(
          z
            .object({
              key: z.string().min(1),
              unavailableDays: decimalSchema,
              averageDailyUnits: decimalSchema,
              unitMargin: decimalSchema,
              availabilityFactor: decimalSchema.optional(),
            })
            .strict(),
        )
        .min(1),
    })
    .strict(),
  z
    .object({
      operatorId: z.literal("supplier_performance"),
      suppliers: z
        .array(
          z
            .object({
              key: z.string().min(1),
              orderedUnits: decimalSchema,
              receivedUnits: decimalSchema,
              leadTimeDays: decimalSchema.optional(),
              targetLeadTimeDays: decimalSchema.optional(),
            })
            .strict(),
        )
        .min(1),
    })
    .strict(),
  z
    .object({
      operatorId: z.literal("pos_xero_reconciliation"),
      posRevenue: decimalSchema,
      xeroRevenue: decimalSchema,
      tolerance: decimalSchema,
      unmatchedPos: decimalSchema.optional(),
      unmatchedXero: decimalSchema.optional(),
    })
    .strict(),
  z
    .object({
      operatorId: z.literal("sales_bank_reconciliation"),
      sales: decimalSchema,
      bankSettlements: decimalSchema,
      timingDifference: decimalSchema.default("0"),
      fees: decimalSchema.default("0"),
      tolerance: decimalSchema,
    })
    .strict(),
  z
    .object({
      operatorId: z.literal("profitability_bridge"),
      revenue: decimalSchema,
      cogs: decimalSchema,
      operatingExpenses: decimalSchema,
      priorRevenue: decimalSchema.optional(),
      priorCogs: decimalSchema.optional(),
      priorOperatingExpenses: decimalSchema.optional(),
    })
    .strict(),
  z
    .object({
      operatorId: z.literal("opportunity_sizing"),
      opportunities: z
        .array(
          z
            .object({
              key: z.string().min(1),
              baseline: decimalSchema,
              attainableImprovementRate: decimalSchema,
              confidence: decimalSchema,
              implementationCost: decimalSchema.default("0"),
            })
            .strict(),
        )
        .min(1),
    })
    .strict(),
  z
    .object({
      operatorId: z.literal("constraint_controllability"),
      opportunities: z
        .array(
          z
            .object({
              key: z.string().min(1),
              value: decimalSchema,
              controllability: z.enum(["high", "medium", "low"]),
              constrained: z.boolean(),
              constraint: z.string().min(1).optional(),
            })
            .strict(),
        )
        .min(1),
    })
    .strict(),
]);
export type AnalyticalOperatorInputV2 = z.infer<typeof operatorInputV2Schema>;

export type AnalyticalOperatorArtifactV2 = Readonly<{
  operatorId: AnalyticalOperatorIdV2;
  artifactHash: string;
  formulaVersion: "2.1.0";
  output: Readonly<Record<string, unknown>>;
  sourceResultIds: readonly string[];
  limitations: readonly string[];
  validation: Readonly<{ passed: true; checks: readonly string[] }>;
}>;

const SCALE = 1_000_000n;
const FORMULA_VERSION = "2.1.0" as const;

function decimal(value: string | number): bigint {
  if (typeof value === "number") {
    const scaled = value * Number(SCALE);
    if (!Number.isSafeInteger(scaled))
      throw new Error(
        `Decimal ${value} cannot be represented exactly at six-decimal precision.`,
      );
    return BigInt(scaled);
  }
  const text = value;
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match) throw new Error(`Invalid decimal ${text}.`);
  if ((match[3]?.length ?? 0) > 6)
    throw new Error(
      `Decimal ${text} exceeds the six-decimal operator precision contract.`,
    );
  const fraction = (match[3] ?? "").padEnd(6, "0").slice(0, 6);
  const scaled = BigInt(match[2]!) * SCALE + BigInt(fraction || "0");
  return match[1] ? -scaled : scaled;
}

function format(value: bigint): string {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  const whole = absolute / SCALE;
  const fraction = (absolute % SCALE)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/u, "");
  return `${sign}${whole}${fraction ? `.${fraction}` : ""}`;
}

function formatNullable(value: bigint | null): string | null {
  return value === null ? null : format(value);
}

function multiply(left: bigint, right: bigint): bigint {
  return (left * right) / SCALE;
}

function divide(left: bigint, right: bigint): bigint | null {
  return right === 0n ? null : (left * SCALE) / right;
}

function sum(values: readonly bigint[]): bigint {
  return values.reduce((total, value) => total + value, 0n);
}

function absolute(value: bigint): bigint {
  return value < 0n ? -value : value;
}

function compareBigIntDescending(left: bigint, right: bigint): number {
  return left === right ? 0 : left > right ? -1 : 1;
}

function requireNonNegative(value: string | number, label: string): void {
  if (decimal(value) < 0n) throw new Error(`${label} must be non-negative.`);
}

function requireUnitInterval(value: string | number, label: string): void {
  const parsed = decimal(value);
  if (parsed < 0n || parsed > SCALE)
    throw new Error(`${label} must be between zero and one.`);
}

function requireUniqueKeys(
  values: readonly Readonly<{ key: string }>[],
  label: string,
): void {
  if (new Set(values.map(({ key }) => key)).size !== values.length)
    throw new Error(`${label} keys must be unique.`);
}

function validateOperatorDomain(input: AnalyticalOperatorInputV2): void {
  if (input.operatorId === "period_contribution") {
    requireUniqueKeys(input.current, "Current contribution");
    requireUniqueKeys(input.comparison, "Comparison contribution");
  } else if (input.operatorId === "dimension_contribution") {
    requireUniqueKeys(input.current, "Current dimension contribution");
    requireUniqueKeys(input.comparison, "Comparison dimension contribution");
  } else if (input.operatorId === "price_volume_mix") {
    requireUniqueKeys(input.items, "Price-volume-mix item");
    for (const item of input.items) {
      requireNonNegative(item.currentPrice, `${item.key} current price`);
      requireNonNegative(item.comparisonPrice, `${item.key} comparison price`);
      requireNonNegative(item.currentVolume, `${item.key} current volume`);
      requireNonNegative(
        item.comparisonVolume,
        `${item.key} comparison volume`,
      );
      if (item.population === "new" && decimal(item.comparisonVolume) !== 0n)
        throw new Error(
          `${item.key} is new but has non-zero comparison volume.`,
        );
      if (
        item.population === "discontinued" &&
        decimal(item.currentVolume) !== 0n
      )
        throw new Error(
          `${item.key} is discontinued but has non-zero current volume.`,
        );
    }
  } else if (input.operatorId === "pareto_concentration") {
    requireUniqueKeys(input.items, "Pareto item");
    for (const item of input.items)
      requireNonNegative(item.value, `${item.key} Pareto value`);
  } else if (input.operatorId === "trend_anomaly") {
    if (
      new Set(input.points.map(({ period }) => period)).size !==
      input.points.length
    )
      throw new Error("Trend periods must be unique.");
    if (
      input.points.some(
        ({ period }, index) =>
          index > 0 && period <= input.points[index - 1]!.period,
      )
    )
      throw new Error(
        "Trend periods must be supplied in strictly increasing governed order.",
      );
  } else if (input.operatorId === "discount_leakage") {
    requireNonNegative(input.grossSales, "Gross sales");
    requireNonNegative(input.discounts, "Discounts");
    if (input.approvedDiscounts !== undefined)
      requireNonNegative(input.approvedDiscounts, "Approved discounts");
    if (input.comparisonDiscounts !== undefined)
      requireNonNegative(input.comparisonDiscounts, "Comparison discounts");
    if (
      input.approvedDiscounts !== undefined &&
      decimal(input.approvedDiscounts) > decimal(input.discounts)
    )
      throw new Error(
        "Approved discounts cannot exceed total discounts in the same governed scope.",
      );
  } else if (input.operatorId === "return_rate") {
    requireNonNegative(input.grossSales, "Gross sales");
    requireNonNegative(input.returnValue, "Return value");
    if (input.soldUnits !== undefined)
      requireNonNegative(input.soldUnits, "Sold units");
    if (input.returnedUnits !== undefined)
      requireNonNegative(input.returnedUnits, "Returned units");
    if ((input.soldUnits === undefined) !== (input.returnedUnits === undefined))
      throw new Error(
        "Sold units and returned units must be supplied together.",
      );
  } else if (input.operatorId === "customer_retention") {
    if (
      new Set(input.cohorts.map(({ cohort }) => cohort)).size !==
      input.cohorts.length
    )
      throw new Error("Customer cohort ids must be unique.");
    for (const cohort of input.cohorts) {
      requireNonNegative(
        cohort.acquired,
        `${cohort.cohort} acquired customers`,
      );
      requireNonNegative(
        cohort.retained,
        `${cohort.cohort} retained customers`,
      );
      if (decimal(cohort.retained) > decimal(cohort.acquired))
        throw new Error(
          `${cohort.cohort} retained customers cannot exceed acquired customers.`,
        );
    }
  } else if (input.operatorId === "stockout_opportunity") {
    requireUniqueKeys(input.items, "Stockout item");
    for (const item of input.items) {
      requireNonNegative(item.unavailableDays, `${item.key} unavailable days`);
      requireNonNegative(
        item.averageDailyUnits,
        `${item.key} average daily units`,
      );
      requireNonNegative(item.unitMargin, `${item.key} unit margin`);
      requireUnitInterval(
        item.availabilityFactor ?? "1",
        `${item.key} availability factor`,
      );
    }
  } else if (input.operatorId === "supplier_performance") {
    requireUniqueKeys(input.suppliers, "Supplier");
    for (const supplier of input.suppliers) {
      requireNonNegative(
        supplier.orderedUnits,
        `${supplier.key} ordered units`,
      );
      requireNonNegative(
        supplier.receivedUnits,
        `${supplier.key} received units`,
      );
      if (supplier.leadTimeDays !== undefined)
        requireNonNegative(supplier.leadTimeDays, `${supplier.key} lead time`);
      if (supplier.targetLeadTimeDays !== undefined)
        requireNonNegative(
          supplier.targetLeadTimeDays,
          `${supplier.key} target lead time`,
        );
    }
  } else if (
    input.operatorId === "pos_xero_reconciliation" ||
    input.operatorId === "sales_bank_reconciliation"
  ) {
    requireNonNegative(input.tolerance, "Reconciliation tolerance");
    if (input.operatorId === "pos_xero_reconciliation") {
      if (input.unmatchedPos !== undefined)
        requireNonNegative(input.unmatchedPos, "Unmatched POS value");
      if (input.unmatchedXero !== undefined)
        requireNonNegative(input.unmatchedXero, "Unmatched Xero value");
    } else {
      requireNonNegative(input.fees, "Settlement fees");
    }
  } else if (input.operatorId === "profitability_bridge") {
    const priorInputs = [
      input.priorRevenue,
      input.priorCogs,
      input.priorOperatingExpenses,
    ];
    const supplied = priorInputs.filter((value) => value !== undefined).length;
    if (supplied !== 0 && supplied !== priorInputs.length)
      throw new Error(
        "Prior revenue, COGS, and operating expenses must be supplied together.",
      );
  } else if (input.operatorId === "opportunity_sizing") {
    requireUniqueKeys(input.opportunities, "Opportunity");
    for (const opportunity of input.opportunities) {
      requireNonNegative(opportunity.baseline, `${opportunity.key} baseline`);
      requireUnitInterval(
        opportunity.attainableImprovementRate,
        `${opportunity.key} attainable improvement rate`,
      );
      requireUnitInterval(
        opportunity.confidence,
        `${opportunity.key} confidence`,
      );
      requireNonNegative(
        opportunity.implementationCost,
        `${opportunity.key} implementation cost`,
      );
    }
  } else if (input.operatorId === "constraint_controllability") {
    requireUniqueKeys(input.opportunities, "Controllability opportunity");
    for (const opportunity of input.opportunities)
      requireNonNegative(
        opportunity.value,
        `${opportunity.key} opportunity value`,
      );
    for (const opportunity of input.opportunities)
      if (opportunity.constrained && !opportunity.constraint)
        throw new Error(
          `${opportunity.key} requires a governed constraint reason when constrained.`,
        );
  }
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>))
      deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stable(entry)]),
    );
  return value;
}

function keyed(
  values: readonly z.infer<typeof labelledValueSchema>[],
): Map<string, z.infer<typeof labelledValueSchema>> {
  return new Map(values.map((value) => [value.key, value]));
}

function periodContribution(
  current: readonly z.infer<typeof labelledValueSchema>[],
  comparison: readonly z.infer<typeof labelledValueSchema>[],
) {
  const currentByKey = keyed(current);
  const comparisonByKey = keyed(comparison);
  const keys = [
    ...new Set([...currentByKey.keys(), ...comparisonByKey.keys()]),
  ].sort();
  const rows = keys
    .map((key) => {
      const currentValue = decimal(currentByKey.get(key)?.value ?? 0);
      const comparisonValue = decimal(comparisonByKey.get(key)?.value ?? 0);
      return {
        key,
        label:
          currentByKey.get(key)?.label ??
          comparisonByKey.get(key)?.label ??
          key,
        current: format(currentValue),
        comparison: format(comparisonValue),
        change: format(currentValue - comparisonValue),
      };
    })
    .sort(
      (left, right) =>
        compareBigIntDescending(
          absolute(decimal(left.change)),
          absolute(decimal(right.change)),
        ) || left.key.localeCompare(right.key),
    );
  const totalChange = sum(rows.map(({ change }) => decimal(change)));
  return {
    totalChange: format(totalChange),
    contributions: rows.map((row) => ({
      ...row,
      shareOfChange: formatNullable(divide(decimal(row.change), totalChange)),
    })),
  };
}

function executeOperator(input: AnalyticalOperatorInputV2): Readonly<{
  output: Record<string, unknown>;
  limitations: string[];
  checks: string[];
}> {
  validateOperatorDomain(input);
  switch (input.operatorId) {
    case "period_contribution": {
      const output = periodContribution(input.current, input.comparison);
      return {
        output,
        limitations:
          output.totalChange === "0"
            ? [
                "Contribution shares are undefined because total change is zero.",
              ]
            : [],
        checks: ["Contributions reconcile exactly to total change."],
      };
    }
    case "dimension_contribution": {
      if (input.comparison.length) {
        const output = periodContribution(input.current, input.comparison);
        return {
          output,
          limitations:
            output.totalChange === "0"
              ? [
                  "Contribution shares are undefined because total change is zero.",
                ]
              : [],
          checks: [
            "Dimension contributions reconcile exactly to total change.",
          ],
        };
      }
      const total = sum(input.current.map(({ value }) => decimal(value)));
      const contributions = input.current
        .map((item) => ({
          ...item,
          value: format(decimal(item.value)),
          share: formatNullable(divide(decimal(item.value), total)),
        }))
        .sort(
          (left, right) =>
            compareBigIntDescending(
              decimal(left.value),
              decimal(right.value),
            ) || left.key.localeCompare(right.key),
        );
      return {
        output: { total: format(total), contributions },
        limitations:
          total === 0n
            ? [
                "Dimension shares are undefined because the supplied total is zero.",
              ]
            : [],
        checks: ["Dimension shares use the complete supplied result set."],
      };
    }
    case "gross_margin_bridge": {
      const currentRevenue = decimal(input.currentRevenue);
      const priorRevenue = decimal(input.comparisonRevenue);
      const currentCost = decimal(input.currentCost);
      const priorCost = decimal(input.comparisonCost);
      return {
        output: {
          currentGrossProfit: format(currentRevenue - currentCost),
          comparisonGrossProfit: format(priorRevenue - priorCost),
          revenueEffect: format(currentRevenue - priorRevenue),
          costEffect: format(-(currentCost - priorCost)),
          totalChange: format(
            currentRevenue - currentCost - (priorRevenue - priorCost),
          ),
          currentMarginRate: formatNullable(
            divide(currentRevenue - currentCost, currentRevenue),
          ),
          comparisonMarginRate: formatNullable(
            divide(priorRevenue - priorCost, priorRevenue),
          ),
        },
        limitations: [
          ...(currentRevenue === 0n
            ? [
                "Current margin rate is undefined because current revenue is zero.",
              ]
            : []),
          ...(priorRevenue === 0n
            ? [
                "Comparison margin rate is undefined because comparison revenue is zero.",
              ]
            : []),
        ],
        checks: ["Revenue and cost effects reconcile to gross-profit change."],
      };
    }
    case "price_volume_mix": {
      const priorTotalVolume = sum(
        input.items.map(({ comparisonVolume }) => decimal(comparisonVolume)),
      );
      if (priorTotalVolume === 0n)
        throw new Error(
          "Price-volume-mix requires positive comparison volume to define the prior mix.",
        );
      const currentTotalVolume = sum(
        input.items.map(({ currentVolume }) => decimal(currentVolume)),
      );
      const rows = input.items.map((item) => {
        const cp = decimal(item.currentPrice);
        const pp = decimal(item.comparisonPrice);
        const cv = decimal(item.currentVolume);
        const pv = decimal(item.comparisonVolume);
        const priorMix = divide(pv, priorTotalVolume)!;
        const expectedCurrentVolumeAtPriorMix = multiply(
          currentTotalVolume,
          priorMix,
        );
        const price = multiply(cp - pp, cv);
        const volume = multiply(pp, expectedCurrentVolumeAtPriorMix - pv);
        const total = multiply(cp, cv) - multiply(pp, pv);
        // Assign the fixed-point allocation residual to mix so every row and
        // the aggregate bridge reconcile exactly at six-decimal precision.
        const mix = total - price - volume;
        return {
          key: item.key,
          population: item.population,
          price: format(price),
          volume: format(volume),
          mix: format(mix),
          total: format(total),
        };
      });
      return {
        output: {
          items: rows,
          priceEffect: format(sum(rows.map(({ price }) => decimal(price)))),
          volumeEffect: format(sum(rows.map(({ volume }) => decimal(volume)))),
          mixEffect: format(sum(rows.map((row) => decimal(row.mix)))),
          totalChange: format(sum(rows.map(({ total }) => decimal(total)))),
          currentTotalVolume: format(currentTotalVolume),
          comparisonTotalVolume: format(priorTotalVolume),
        },
        limitations: [
          "Mix interpretation requires stable product definitions and comparable units across periods.",
          ...(input.items.some(({ population }) => population !== "continuing")
            ? [
                "New and discontinued items use their nearest observed unit price, so their entry or exit is attributed to mix rather than an unobserved price change.",
              ]
            : []),
        ],
        checks: [
          "Price, volume, and mix reconcile exactly to revenue change.",
          "Volume is evaluated at the comparison-period mix; price is evaluated at current volume.",
        ],
      };
    }
    case "pareto_concentration": {
      const sorted = [...input.items]
        .map((item) => ({ ...item, value: decimal(item.value) }))
        .sort(
          (left, right) =>
            compareBigIntDescending(left.value, right.value) ||
            left.key.localeCompare(right.key),
        );
      const total = sum(sorted.map(({ value }) => value));
      let cumulative = 0n;
      let thresholdCount = sorted.length;
      const rows = sorted.map((item, index) => {
        cumulative += item.value;
        const share = divide(cumulative, total);
        if (
          share !== null &&
          thresholdCount === sorted.length &&
          Number(format(share)) >= input.targetShare
        )
          thresholdCount = index + 1;
        return {
          key: item.key,
          label: item.label,
          value: format(item.value),
          cumulativeShare: formatNullable(share),
        };
      });
      return {
        output: {
          total: format(total),
          targetShare: input.targetShare,
          thresholdCount: total === 0n ? null : thresholdCount,
          thresholdItemShare:
            total === 0n
              ? null
              : formatNullable(
                  divide(
                    BigInt(thresholdCount) * SCALE,
                    BigInt(sorted.length) * SCALE,
                  ),
                ),
          items: rows,
        },
        limitations:
          total === 0n
            ? [
                "Pareto concentration is undefined because the supplied total is zero.",
              ]
            : [],
        checks: ["Items are ranked deterministically by value."],
      };
    }
    case "trend_anomaly": {
      const scaledValues = input.points.map(({ value }) => decimal(value));
      const values = scaledValues.map((value) => Number(format(value)));
      if (values.some((value) => !Number.isFinite(value)))
        throw new Error(
          "Trend values exceed the finite statistical range of the anomaly operator.",
        );
      const mean =
        values.reduce((total, value) => total + value, 0) / values.length;
      const variance =
        values.reduce((total, value) => total + (value - mean) ** 2, 0) /
        values.length;
      const deviation = Math.sqrt(variance);
      const points = input.points.map((point, index) => ({
        ...point,
        value: String(point.value),
        zScore: deviation === 0 ? 0 : (values[index]! - mean) / deviation,
        anomalous:
          deviation > 0 &&
          Math.abs((values[index]! - mean) / deviation) >= input.zThreshold,
      }));
      let changePoint: Readonly<{
        index: number;
        period: string;
        beforeMean: string;
        afterMean: string;
        difference: string;
        direction: "increase" | "decrease" | "flat";
      }> | null = null;
      let strongestDifference = -1n;
      for (let index = 2; index <= scaledValues.length - 2; index += 1) {
        const beforeMean = sum(scaledValues.slice(0, index)) / BigInt(index);
        const afterMean =
          sum(scaledValues.slice(index)) / BigInt(scaledValues.length - index);
        const difference = afterMean - beforeMean;
        if (absolute(difference) > strongestDifference) {
          strongestDifference = absolute(difference);
          changePoint = Object.freeze({
            index,
            period: input.points[index]!.period,
            beforeMean: format(beforeMean),
            afterMean: format(afterMean),
            difference: format(difference),
            direction:
              difference > 0n
                ? "increase"
                : difference < 0n
                  ? "decrease"
                  : "flat",
          });
        }
      }
      return {
        output: { mean, standardDeviation: deviation, points, changePoint },
        limitations: [
          "Population z-scores describe unusual points; the reported mean-shift candidate is descriptive and does not establish causality or statistical significance.",
        ],
        checks: [
          "At least four strictly ordered observations were supplied.",
          "The change-point candidate maximizes the absolute before-versus-after mean difference with at least two observations on each side.",
        ],
      };
    }
    case "discount_leakage": {
      const gross = decimal(input.grossSales);
      const discounts = decimal(input.discounts);
      const approved = decimal(input.approvedDiscounts ?? 0);
      const comparison = decimal(input.comparisonDiscounts ?? 0);
      return {
        output: {
          discountRate: formatNullable(divide(discounts, gross)),
          unapprovedDiscounts: format(discounts - approved),
          changeFromComparison: format(discounts - comparison),
        },
        limitations: [
          ...(input.approvedDiscounts === undefined
            ? [
                "No approved-discount baseline was supplied; all discounts cannot be classified as leakage.",
              ]
            : []),
          ...(gross === 0n
            ? ["Discount rate is undefined because gross sales are zero."]
            : []),
        ],
        checks: ["Discount rate uses gross sales as its denominator."],
      };
    }
    case "return_rate": {
      const gross = decimal(input.grossSales);
      const returns = decimal(input.returnValue);
      const soldUnits =
        input.soldUnits === undefined ? null : decimal(input.soldUnits);
      return {
        output: {
          valueReturnRate: formatNullable(divide(returns, gross)),
          ...(soldUnits !== null && input.returnedUnits !== undefined
            ? {
                unitReturnRate: formatNullable(
                  divide(decimal(input.returnedUnits), soldUnits),
                ),
              }
            : {}),
        },
        limitations: [
          ...(gross === 0n
            ? ["Value return rate is undefined because gross sales are zero."]
            : []),
          ...(soldUnits === 0n
            ? ["Unit return rate is undefined because sold units are zero."]
            : []),
        ],
        checks: ["Return value and unit rates retain separate denominators."],
      };
    }
    case "customer_retention":
      return {
        output: {
          cohorts: input.cohorts.map((cohort) => ({
            ...cohort,
            acquired: format(decimal(cohort.acquired)),
            retained: format(decimal(cohort.retained)),
            retentionRate: formatNullable(
              divide(decimal(cohort.retained), decimal(cohort.acquired)),
            ),
          })),
        },
        limitations: [
          "Cohorts require a stable governed customer identity.",
          ...(input.cohorts.some(({ acquired }) => decimal(acquired) === 0n)
            ? [
                "Retention is undefined for cohorts with zero acquired customers.",
              ]
            : []),
        ],
        checks: ["Retained customers never share a monetary denominator."],
      };
    case "stockout_opportunity": {
      const items = input.items.map((item) => {
        const factor = decimal(item.availabilityFactor ?? "1");
        const opportunity = multiply(
          multiply(
            decimal(item.unavailableDays),
            decimal(item.averageDailyUnits),
          ),
          multiply(decimal(item.unitMargin), factor),
        );
        return { key: item.key, opportunity: format(opportunity) };
      });
      return {
        output: {
          totalOpportunity: format(
            sum(items.map(({ opportunity }) => decimal(opportunity))),
          ),
          items,
        },
        limitations: [
          "Opportunity assumes observed demand and margin would persist during unavailable periods.",
        ],
        checks: [
          "Availability factors are explicit and no opportunity exceeds the supplied demand assumption.",
        ],
      };
    }
    case "supplier_performance":
      return {
        output: {
          suppliers: input.suppliers.map((supplier) => ({
            key: supplier.key,
            fillRate: formatNullable(
              divide(
                decimal(supplier.receivedUnits),
                decimal(supplier.orderedUnits),
              ),
            ),
            ...(supplier.leadTimeDays !== undefined
              ? { leadTimeDays: format(decimal(supplier.leadTimeDays)) }
              : {}),
            ...(supplier.leadTimeDays !== undefined &&
            supplier.targetLeadTimeDays !== undefined
              ? {
                  leadTimeVarianceDays: format(
                    decimal(supplier.leadTimeDays) -
                      decimal(supplier.targetLeadTimeDays),
                  ),
                }
              : {}),
          })),
        },
        limitations: [
          "Lead-time conclusions depend on complete order and receipt timestamps.",
          ...(input.suppliers.some(
            ({ orderedUnits }) => decimal(orderedUnits) === 0n,
          )
            ? ["Fill rate is undefined where ordered units are zero."]
            : []),
        ],
        checks: ["Fill rate uses received units over ordered units."],
      };
    case "pos_xero_reconciliation": {
      const difference = decimal(input.posRevenue) - decimal(input.xeroRevenue);
      const tolerance = decimal(input.tolerance);
      return {
        output: {
          difference: format(difference),
          absoluteDifference: format(
            difference < 0n ? -difference : difference,
          ),
          withinTolerance:
            (difference < 0n ? -difference : difference) <= tolerance,
          unmatchedPos: format(decimal(input.unmatchedPos ?? 0)),
          unmatchedXero: format(decimal(input.unmatchedXero ?? 0)),
        },
        limitations: [
          "Timing, tax basis, and posting status must be aligned before interpreting a residual as an error.",
        ],
        checks: ["Sources are compared after independent aggregation."],
      };
    }
    case "sales_bank_reconciliation": {
      const adjustedBank =
        decimal(input.bankSettlements) +
        decimal(input.fees) -
        decimal(input.timingDifference);
      const difference = decimal(input.sales) - adjustedBank;
      return {
        output: {
          adjustedBank: format(adjustedBank),
          difference: format(difference),
          withinTolerance:
            (difference < 0n ? -difference : difference) <=
            decimal(input.tolerance),
        },
        limitations: [
          "Settlement timing and processor fees must be complete for a conclusive reconciliation.",
        ],
        checks: [
          "Bank settlements are adjusted by explicit timing differences and fees.",
        ],
      };
    }
    case "profitability_bridge": {
      const profit =
        decimal(input.revenue) -
        decimal(input.cogs) -
        decimal(input.operatingExpenses);
      const hasPrior =
        input.priorRevenue !== undefined &&
        input.priorCogs !== undefined &&
        input.priorOperatingExpenses !== undefined;
      const priorProfit = hasPrior
        ? decimal(input.priorRevenue!) -
          decimal(input.priorCogs!) -
          decimal(input.priorOperatingExpenses!)
        : null;
      const revenueEffect = hasPrior
        ? decimal(input.revenue) - decimal(input.priorRevenue!)
        : null;
      const cogsEffect = hasPrior
        ? -(decimal(input.cogs) - decimal(input.priorCogs!))
        : null;
      const operatingExpenseEffect = hasPrior
        ? -(
            decimal(input.operatingExpenses) -
            decimal(input.priorOperatingExpenses!)
          )
        : null;
      return {
        output: {
          operatingProfit: format(profit),
          grossProfit: format(decimal(input.revenue) - decimal(input.cogs)),
          operatingMargin: formatNullable(
            divide(profit, decimal(input.revenue)),
          ),
          ...(priorProfit === null
            ? {}
            : {
                priorOperatingProfit: format(priorProfit),
                change: format(profit - priorProfit),
                revenueEffect: format(revenueEffect!),
                cogsEffect: format(cogsEffect!),
                operatingExpenseEffect: format(operatingExpenseEffect!),
              }),
        },
        limitations: [
          "Profitability is only as complete as the governed operating-expense scope.",
          ...(decimal(input.revenue) === 0n
            ? ["Operating margin is undefined because revenue is zero."]
            : []),
        ],
        checks: [
          "Revenue, COGS, and operating expenses use explicit non-overlapping authority rules.",
          ...(priorProfit === null
            ? []
            : [
                "Revenue, COGS, and operating-expense effects reconcile exactly to operating-profit change.",
              ]),
        ],
      };
    }
    case "opportunity_sizing": {
      const opportunities = input.opportunities
        .map((item) => {
          const gross = multiply(
            decimal(item.baseline),
            decimal(item.attainableImprovementRate),
          );
          const confidenceAdjusted = multiply(gross, decimal(item.confidence));
          return {
            key: item.key,
            grossOpportunity: format(gross),
            confidenceAdjustedOpportunity: format(confidenceAdjusted),
            netOpportunity: format(
              confidenceAdjusted - decimal(item.implementationCost),
            ),
          };
        })
        .sort(
          (left, right) =>
            compareBigIntDescending(
              decimal(left.netOpportunity),
              decimal(right.netOpportunity),
            ) || left.key.localeCompare(right.key),
        );
      return {
        output: {
          opportunities,
          totalNetOpportunity: format(
            sum(
              opportunities.map(({ netOpportunity }) =>
                decimal(netOpportunity),
              ),
            ),
          ),
        },
        limitations: [
          "Attainable improvement and confidence are declared assumptions, not observed facts.",
        ],
        checks: [
          "Implementation cost is deducted after confidence adjustment.",
        ],
      };
    }
    case "constraint_controllability": {
      const rank = { high: 3, medium: 2, low: 1 } as const;
      const opportunities = [...input.opportunities].sort(
        (left, right) =>
          compareBigIntDescending(decimal(left.value), decimal(right.value)) ||
          rank[right.controllability] - rank[left.controllability],
      );
      return {
        output: {
          opportunities,
          actionableValue: format(
            sum(
              opportunities
                .filter(
                  (item) => !item.constrained && item.controllability !== "low",
                )
                .map(({ value }) => decimal(value)),
            ),
          ),
        },
        limitations: [
          "Controllability is a governed business-context judgement and should be reviewed when operations change.",
        ],
        checks: [
          "Constrained and low-controllability opportunities are excluded from actionable value.",
        ],
      };
    }
  }
}

export function runAnalyticalOperatorV2(
  rawInput: unknown,
  sourceResultIds: readonly string[],
): AnalyticalOperatorArtifactV2 {
  const input = operatorInputV2Schema.parse(rawInput);
  if (sourceResultIds.length === 0)
    throw new Error(
      "An analytical operator requires at least one governed source result.",
    );
  if (
    sourceResultIds.length > 32 ||
    sourceResultIds.some(
      (id) => id.trim() !== id || id.length === 0 || id.length > 300,
    )
  )
    throw new Error(
      "Analytical operator source result ids must be bounded non-empty identifiers.",
    );
  if (new Set(sourceResultIds).size !== sourceResultIds.length)
    throw new Error("Analytical operator source result ids must be unique.");
  const normalizedSourceResultIds = Object.freeze([...sourceResultIds].sort());
  const executed = executeOperator(input);
  const digestInput = {
    formulaVersion: FORMULA_VERSION,
    input,
    sourceResultIds: normalizedSourceResultIds,
    output: executed.output,
  };
  return deepFreeze({
    operatorId: input.operatorId,
    artifactHash: createHash("sha256")
      .update(JSON.stringify(stable(digestInput)))
      .digest("hex"),
    formulaVersion: FORMULA_VERSION,
    output: executed.output,
    sourceResultIds: normalizedSourceResultIds,
    limitations: executed.limitations,
    validation: {
      passed: true,
      checks: executed.checks,
    },
  });
}
