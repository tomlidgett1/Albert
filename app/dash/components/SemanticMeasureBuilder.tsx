"use client";

import { useMemo, useState } from "react";
import styles from "./semantic-admin.module.css";

type Scalar = string | number | boolean | null;

export type MeasureExpressionDraft =
  | { op: "field"; fieldId: string }
  | { op: "literal"; value: string }
  | { op: "metric"; measureId: string }
  | {
      op: "aggregate";
      fn:
        | "sum"
        | "avg"
        | "count"
        | "count_distinct"
        | "min"
        | "max"
        | "last_value"
        | "percentile";
      fieldId?: string;
      percentile?: number;
      filter?: {
        fieldId: string;
        comparator: PredicateComparator;
        values: Scalar[];
      };
    }
  | {
      op: "binary";
      fn: "add" | "subtract" | "multiply" | "divide";
      left: MeasureExpressionDraft;
      right: MeasureExpressionDraft;
    }
  | { op: "coalesce"; values: MeasureExpressionDraft[] }
  | {
      op: "conditional";
      fieldId: string;
      comparator: PredicateComparator;
      values?: Scalar[];
      then: MeasureExpressionDraft;
      otherwise: MeasureExpressionDraft;
    }
  | {
      op: "weighted_average";
      valueFieldId: string;
      weightFieldId: string;
    };

type PredicateComparator =
  | "eq"
  | "neq"
  | "in"
  | "not_in"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "is_null"
  | "is_not_null";

export type MeasureAuthoringContext = Readonly<{
  measureId: string;
  view: Readonly<{
    id: string;
    label: string;
    grain: string;
    temporalAvailability: string;
  }>;
  fields: readonly Readonly<{
    id: string;
    label: string;
    dataType: string;
    semanticState: string;
    disposition: string;
  }>[];
  measures: readonly Readonly<{
    id: string;
    label: string;
    unit: string;
    aggregation: string;
    semanticState: string;
    selected: boolean;
  }>[];
  dependencies: Readonly<{
    fieldIds: readonly string[];
    measureIds: readonly string[];
  }>;
  dependents: readonly Readonly<{
    id: string;
    label: string;
    viewId: string;
  }>[];
  topics: readonly Readonly<{
    id: string;
    label: string;
    layer: string;
  }>[];
  limits: Readonly<{ maximumNodes: number; maximumDepth: number }>;
}>;

export type MeasureDraft = Readonly<{
  label: string;
  description: string;
  synonyms: readonly string[];
  grain: string;
  unit:
    | "currency"
    | "units"
    | "count"
    | "ratio"
    | "percent"
    | "hours"
    | "days"
    | "currency_per_unit";
  aggregation:
    | "sum"
    | "count"
    | "count_distinct"
    | "average"
    | "ratio"
    | "last_value"
    | "derived";
  additivity: "additive" | "semi_additive" | "non_additive";
  currencyFieldId?: string;
  expression: MeasureExpressionDraft;
  semanticState:
    | "verified"
    | "derived"
    | "exploratory"
    | "unsupported"
    | "deprecated";
  authority: string;
  riskTier: "tier_1" | "tier_2" | "tier_3";
  testIds: readonly string[];
}>;

const OPERATIONS = [
  "field",
  "literal",
  "metric",
  "aggregate",
  "binary",
  "coalesce",
  "conditional",
  "weighted_average",
] as const;
const LEAF_OPERATIONS = [
  "field",
  "literal",
  "metric",
  "aggregate",
  "weighted_average",
] as const;
const COMPARATORS: readonly PredicateComparator[] = [
  "eq",
  "neq",
  "in",
  "not_in",
  "gt",
  "gte",
  "lt",
  "lte",
  "is_null",
  "is_not_null",
];

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export function createMeasureDraft(
  measure: Readonly<Record<string, unknown>>,
): MeasureDraft {
  return {
    label: String(measure.label ?? ""),
    description: String(measure.description ?? ""),
    synonyms: stringArray(measure.synonyms),
    grain: String(measure.grain ?? ""),
    unit: measure.unit as MeasureDraft["unit"],
    aggregation: measure.aggregation as MeasureDraft["aggregation"],
    additivity: measure.additivity as MeasureDraft["additivity"],
    ...(typeof measure.currencyFieldId === "string"
      ? { currencyFieldId: measure.currencyFieldId }
      : {}),
    expression: measure.expression as MeasureExpressionDraft,
    semanticState: measure.semanticState as MeasureDraft["semanticState"],
    authority: String(measure.authority ?? ""),
    riskTier: measure.riskTier as MeasureDraft["riskTier"],
    testIds: stringArray(measure.testIds),
  };
}

export function measureDraftChanges(draft: MeasureDraft) {
  return {
    ...draft,
    synonyms: [...draft.synonyms],
    testIds: [...draft.testIds],
    ...(draft.currencyFieldId
      ? { currencyFieldId: draft.currencyFieldId }
      : { currencyFieldId: null }),
  };
}

function humanize(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function firstField(context: MeasureAuthoringContext): string {
  return context.fields[0]?.id ?? "";
}

function firstDependency(context: MeasureAuthoringContext): string {
  return context.measures.find(({ selected }) => !selected)?.id ?? "";
}

function defaultExpression(
  operation: (typeof OPERATIONS)[number],
  context: MeasureAuthoringContext,
): MeasureExpressionDraft {
  const fieldId = firstField(context);
  if (operation === "field") return { op: "field", fieldId };
  if (operation === "literal") return { op: "literal", value: "0" };
  if (operation === "metric")
    return { op: "metric", measureId: firstDependency(context) };
  if (operation === "aggregate")
    return { op: "aggregate", fn: "sum", fieldId };
  if (operation === "binary")
    return {
      op: "binary",
      fn: "add",
      left: { op: "aggregate", fn: "sum", fieldId },
      right: { op: "literal", value: "0" },
    };
  if (operation === "coalesce")
    return {
      op: "coalesce",
      values: [
        { op: "aggregate", fn: "sum", fieldId },
        { op: "literal", value: "0" },
      ],
    };
  if (operation === "conditional")
    return {
      op: "conditional",
      fieldId,
      comparator: "eq",
      values: [""],
      then: { op: "literal", value: "1" },
      otherwise: { op: "literal", value: "0" },
    };
  return {
    op: "weighted_average",
    valueFieldId: fieldId,
    weightFieldId: fieldId,
  };
}

function SelectField({
  value,
  onChange,
  context,
  allowEmpty = false,
  label,
}: {
  value: string;
  onChange: (value: string) => void;
  context: MeasureAuthoringContext;
  allowEmpty?: boolean;
  label: string;
}) {
  const known = context.fields.some(({ id }) => id === value);
  return (
    <label>
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {allowEmpty ? <option value="">No field</option> : null}
        {!known && value ? <option value={value}>{value}</option> : null}
        {context.fields.map((field) => (
          <option value={field.id} key={field.id}>
            {field.label} · {field.dataType}
          </option>
        ))}
      </select>
    </label>
  );
}

function ScalarArrayEditor({
  label,
  value,
  onChange,
  disabled,
}: {
  label: string;
  value: readonly Scalar[];
  onChange: (value: Scalar[]) => void;
  disabled?: boolean;
}) {
  const canonical = JSON.stringify(value);
  const [draft, setDraft] = useState(canonical);
  const [invalid, setInvalid] = useState(false);
  const commit = () => {
    try {
      const parsed = JSON.parse(draft) as unknown;
      if (
        !Array.isArray(parsed) ||
        parsed.length > 100 ||
        parsed.some(
          (item) =>
            item !== null &&
            !["string", "number", "boolean"].includes(typeof item),
        )
      )
        throw new Error("invalid scalars");
      setInvalid(false);
      onChange(parsed as Scalar[]);
    } catch {
      setInvalid(true);
    }
  };
  return (
    <label>
      <span>{label}</span>
      <input
        value={draft}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
        }}
      />
      {invalid ? (
        <small role="alert">Use a JSON array containing only scalar values.</small>
      ) : null}
    </label>
  );
}

function ExpressionEditor({
  value,
  onChange,
  context,
  depth = 1,
  label = "Expression",
}: {
  value: MeasureExpressionDraft;
  onChange: (value: MeasureExpressionDraft) => void;
  context: MeasureAuthoringContext;
  depth?: number;
  label?: string;
}) {
  const operations =
    depth >= context.limits.maximumDepth ? LEAF_OPERATIONS : OPERATIONS;
  return (
    <fieldset className={styles.expressionNode} data-depth={depth}>
      <legend>{label}</legend>
      <label>
        <span>Operation</span>
        <select
          value={value.op}
          onChange={(event) =>
            onChange(
              defaultExpression(
                event.target.value as (typeof OPERATIONS)[number],
                context,
              ),
            )
          }
        >
          {operations.map((operation) => (
            <option value={operation} key={operation}>
              {humanize(operation)}
            </option>
          ))}
        </select>
      </label>
      {value.op === "field" ? (
        <SelectField
          label="Field"
          value={value.fieldId}
          context={context}
          onChange={(fieldId) => onChange({ ...value, fieldId })}
        />
      ) : null}
      {value.op === "literal" ? (
        <label>
          <span>Exact decimal or scalar literal</span>
          <input
            value={value.value}
            onChange={(event) =>
              onChange({ ...value, value: event.target.value })
            }
          />
        </label>
      ) : null}
      {value.op === "metric" ? (
        <label>
          <span>Measure dependency</span>
          <select
            value={value.measureId}
            onChange={(event) =>
              onChange({ ...value, measureId: event.target.value })
            }
          >
            {!context.measures.some(({ id }) => id === value.measureId) &&
            value.measureId ? (
              <option value={value.measureId}>{value.measureId}</option>
            ) : null}
            {context.measures
              .filter(({ selected }) => !selected)
              .map((measure) => (
                <option value={measure.id} key={measure.id}>
                  {measure.label} · {measure.unit}
                </option>
              ))}
          </select>
        </label>
      ) : null}
      {value.op === "aggregate" ? (
        <>
          <label>
            <span>Aggregate</span>
            <select
              value={value.fn}
              onChange={(event) => {
                const fn = event.target.value as typeof value.fn;
                onChange({
                  ...value,
                  fn,
                  ...(fn === "count" ? {} : { fieldId: value.fieldId || firstField(context) }),
                  ...(fn === "percentile"
                    ? { percentile: value.percentile ?? 0.5 }
                    : { percentile: undefined }),
                });
              }}
            >
              {[
                "sum",
                "avg",
                "count",
                "count_distinct",
                "min",
                "max",
                "last_value",
                "percentile",
              ].map((fn) => (
                <option value={fn} key={fn}>
                  {humanize(fn)}
                </option>
              ))}
            </select>
          </label>
          <SelectField
            label="Aggregate field"
            value={value.fieldId ?? ""}
            context={context}
            allowEmpty={value.fn === "count"}
            onChange={(fieldId) =>
              onChange({
                ...value,
                ...(fieldId ? { fieldId } : { fieldId: undefined }),
              })
            }
          />
          {value.fn === "percentile" ? (
            <label>
              <span>Percentile, greater than 0 and less than 1</span>
              <input
                type="number"
                min="0.001"
                max="0.999"
                step="0.001"
                value={value.percentile ?? 0.5}
                onChange={(event) =>
                  onChange({ ...value, percentile: event.target.valueAsNumber })
                }
              />
            </label>
          ) : null}
          <label className={styles.inlineToggle}>
            <input
              type="checkbox"
              checked={Boolean(value.filter)}
              onChange={(event) =>
                onChange({
                  ...value,
                  filter: event.target.checked
                    ? {
                        fieldId: firstField(context),
                        comparator: "eq",
                        values: [""],
                      }
                    : undefined,
                })
              }
            />
            <span>Apply a row filter before aggregation</span>
          </label>
          {value.filter ? (
            <div className={styles.predicateGrid}>
              <SelectField
                label="Filter field"
                value={value.filter.fieldId}
                context={context}
                onChange={(fieldId) =>
                  onChange({
                    ...value,
                    filter: { ...value.filter!, fieldId },
                  })
                }
              />
              <label>
                <span>Comparator</span>
                <select
                  value={value.filter.comparator}
                  onChange={(event) => {
                    const comparator = event.target
                      .value as PredicateComparator;
                    onChange({
                      ...value,
                      filter: {
                        ...value.filter!,
                        comparator,
                        values: ["is_null", "is_not_null"].includes(comparator)
                          ? []
                          : value.filter!.values.length
                            ? value.filter!.values
                            : [""],
                      },
                    });
                  }}
                >
                  {COMPARATORS.map((comparator) => (
                    <option value={comparator} key={comparator}>
                      {humanize(comparator)}
                    </option>
                  ))}
                </select>
              </label>
              <ScalarArrayEditor
                key={`${value.filter.comparator}:${JSON.stringify(value.filter.values)}`}
                label="Filter values"
                value={value.filter.values}
                disabled={["is_null", "is_not_null"].includes(
                  value.filter.comparator,
                )}
                onChange={(values) =>
                  onChange({
                    ...value,
                    filter: { ...value.filter!, values },
                  })
                }
              />
            </div>
          ) : null}
        </>
      ) : null}
      {value.op === "binary" ? (
        <>
          <label>
            <span>Arithmetic</span>
            <select
              value={value.fn}
              onChange={(event) =>
                onChange({
                  ...value,
                  fn: event.target.value as typeof value.fn,
                })
              }
            >
              {(["add", "subtract", "multiply", "divide"] as const).map(
                (fn) => (
                  <option value={fn} key={fn}>
                    {humanize(fn)}
                  </option>
                ),
              )}
            </select>
          </label>
          <div className={styles.expressionChildren}>
            <ExpressionEditor
              label="Left operand"
              value={value.left}
              context={context}
              depth={depth + 1}
              onChange={(left) => onChange({ ...value, left })}
            />
            <ExpressionEditor
              label="Right operand"
              value={value.right}
              context={context}
              depth={depth + 1}
              onChange={(right) => onChange({ ...value, right })}
            />
          </div>
        </>
      ) : null}
      {value.op === "coalesce" ? (
        <div className={styles.expressionChildren}>
          {value.values.map((entry, index) => (
            <div className={styles.expressionEntry} key={index}>
              <ExpressionEditor
                label={`Fallback ${index + 1}`}
                value={entry}
                context={context}
                depth={depth + 1}
                onChange={(next) =>
                  onChange({
                    ...value,
                    values: value.values.map((item, itemIndex) =>
                      itemIndex === index ? next : item,
                    ),
                  })
                }
              />
              <button
                type="button"
                disabled={value.values.length <= 1}
                onClick={() =>
                  onChange({
                    ...value,
                    values: value.values.filter(
                      (_item, itemIndex) => itemIndex !== index,
                    ),
                  })
                }
              >
                Remove fallback
              </button>
            </div>
          ))}
          <button
            type="button"
            disabled={value.values.length >= 8}
            onClick={() =>
              onChange({
                ...value,
                values: [
                  ...value.values,
                  { op: "literal", value: "0" },
                ],
              })
            }
          >
            Add fallback
          </button>
        </div>
      ) : null}
      {value.op === "conditional" ? (
        <>
          <div className={styles.predicateGrid}>
            <SelectField
              label="Condition field"
              value={value.fieldId}
              context={context}
              onChange={(fieldId) => onChange({ ...value, fieldId })}
            />
            <label>
              <span>Comparator</span>
              <select
                value={value.comparator}
                onChange={(event) => {
                  const comparator = event.target.value as PredicateComparator;
                  onChange({
                    ...value,
                    comparator,
                    values: ["is_null", "is_not_null"].includes(comparator)
                      ? []
                      : value.values?.length
                        ? value.values
                        : [""],
                  });
                }}
              >
                {COMPARATORS.map((comparator) => (
                  <option value={comparator} key={comparator}>
                    {humanize(comparator)}
                  </option>
                ))}
              </select>
            </label>
            <ScalarArrayEditor
              key={`${value.comparator}:${JSON.stringify(value.values ?? [])}`}
              label="Condition values"
              value={value.values ?? []}
              disabled={["is_null", "is_not_null"].includes(value.comparator)}
              onChange={(values) => onChange({ ...value, values })}
            />
          </div>
          <div className={styles.expressionChildren}>
            <ExpressionEditor
              label="Then"
              value={value.then}
              context={context}
              depth={depth + 1}
              onChange={(then) => onChange({ ...value, then })}
            />
            <ExpressionEditor
              label="Otherwise"
              value={value.otherwise}
              context={context}
              depth={depth + 1}
              onChange={(otherwise) => onChange({ ...value, otherwise })}
            />
          </div>
        </>
      ) : null}
      {value.op === "weighted_average" ? (
        <div className={styles.predicateGrid}>
          <SelectField
            label="Value field"
            value={value.valueFieldId}
            context={context}
            onChange={(valueFieldId) => onChange({ ...value, valueFieldId })}
          />
          <SelectField
            label="Weight field"
            value={value.weightFieldId}
            context={context}
            onChange={(weightFieldId) => onChange({ ...value, weightFieldId })}
          />
        </div>
      ) : null}
    </fieldset>
  );
}

function expressionComplexity(expression: MeasureExpressionDraft) {
  const pending = [{ expression, depth: 1 }];
  let nodes = 0;
  let depth = 0;
  while (pending.length) {
    const current = pending.pop()!;
    nodes += 1;
    depth = Math.max(depth, current.depth);
    const node = current.expression;
    if (node.op === "binary")
      pending.push(
        { expression: node.left, depth: current.depth + 1 },
        { expression: node.right, depth: current.depth + 1 },
      );
    else if (node.op === "coalesce")
      for (const entry of node.values)
        pending.push({ expression: entry, depth: current.depth + 1 });
    else if (node.op === "conditional")
      pending.push(
        { expression: node.then, depth: current.depth + 1 },
        { expression: node.otherwise, depth: current.depth + 1 },
      );
  }
  return { nodes, depth };
}

export default function SemanticMeasureBuilder({
  measureId,
  initialDraft,
  context,
  saving,
  onChange,
  onCancel,
  onSave,
}: {
  measureId: string;
  initialDraft: MeasureDraft;
  context: MeasureAuthoringContext;
  saving: boolean;
  onChange: (draft: MeasureDraft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const complexity = useMemo(
    () => expressionComplexity(initialDraft.expression),
    [initialDraft.expression],
  );
  const invalidComplexity =
    complexity.nodes > context.limits.maximumNodes ||
    complexity.depth > context.limits.maximumDepth;
  const update = <Key extends keyof MeasureDraft>(
    key: Key,
    value: MeasureDraft[Key],
  ) => onChange({ ...initialDraft, [key]: value });
  return (
    <div
      className={styles.modalBackdrop}
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <section
        className={`${styles.modal} ${styles.semanticBuilderModal}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="semantic-measure-builder"
      >
        <header className={styles.builderHeader}>
          <span>GOVERNED MEASURE BUILDER</span>
          <h3 id="semantic-measure-builder">Edit {measureId}</h3>
          <p>
            Build only typed semantic operations. Physical SQL and arbitrary
            functions are never accepted. Saving creates one optimistic draft
            revision; publication validation and risk-tier review still apply.
          </p>
        </header>
        <div className={styles.builderBody}>
          <section className={styles.builderMetadata} aria-label="Measure contract">
            <h4>Measure contract</h4>
            <div className={styles.builderGrid}>
              <label>
                <span>Label</span>
                <input
                  value={initialDraft.label}
                  onChange={(event) => update("label", event.target.value)}
                />
              </label>
              <label>
                <span>Grain</span>
                <input
                  value={initialDraft.grain}
                  onChange={(event) => update("grain", event.target.value)}
                />
              </label>
              <label className={styles.fullWidthField}>
                <span>Description</span>
                <textarea
                  rows={3}
                  value={initialDraft.description}
                  onChange={(event) =>
                    update("description", event.target.value)
                  }
                />
              </label>
              <label className={styles.fullWidthField}>
                <span>Synonyms, one per line</span>
                <textarea
                  rows={2}
                  value={initialDraft.synonyms.join("\n")}
                  onChange={(event) =>
                    update(
                      "synonyms",
                      event.target.value
                        .split("\n")
                        .map((item) => item.trim())
                        .filter(Boolean),
                    )
                  }
                />
              </label>
              <label>
                <span>Unit</span>
                <select
                  value={initialDraft.unit}
                  onChange={(event) =>
                    update("unit", event.target.value as MeasureDraft["unit"])
                  }
                >
                  {[
                    "currency",
                    "units",
                    "count",
                    "ratio",
                    "percent",
                    "hours",
                    "days",
                    "currency_per_unit",
                  ].map((unit) => (
                    <option value={unit} key={unit}>
                      {humanize(unit)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Aggregation</span>
                <select
                  value={initialDraft.aggregation}
                  onChange={(event) =>
                    update(
                      "aggregation",
                      event.target.value as MeasureDraft["aggregation"],
                    )
                  }
                >
                  {[
                    "sum",
                    "count",
                    "count_distinct",
                    "average",
                    "ratio",
                    "last_value",
                    "derived",
                  ].map((aggregation) => (
                    <option value={aggregation} key={aggregation}>
                      {humanize(aggregation)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Additivity</span>
                <select
                  value={initialDraft.additivity}
                  onChange={(event) =>
                    update(
                      "additivity",
                      event.target.value as MeasureDraft["additivity"],
                    )
                  }
                >
                  {[
                    "additive",
                    "semi_additive",
                    "non_additive",
                  ].map((additivity) => (
                    <option value={additivity} key={additivity}>
                      {humanize(additivity)}
                    </option>
                  ))}
                </select>
              </label>
              <SelectField
                label="Currency dimension"
                value={initialDraft.currencyFieldId ?? ""}
                context={context}
                allowEmpty
                onChange={(currencyFieldId) =>
                  update("currencyFieldId", currencyFieldId || undefined)
                }
              />
              <label>
                <span>Semantic state</span>
                <select
                  value={initialDraft.semanticState}
                  onChange={(event) =>
                    update(
                      "semanticState",
                      event.target.value as MeasureDraft["semanticState"],
                    )
                  }
                >
                  {[
                    "verified",
                    "derived",
                    "exploratory",
                    "unsupported",
                    "deprecated",
                  ].map((state) => (
                    <option value={state} key={state}>
                      {humanize(state)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Risk tier</span>
                <select
                  value={initialDraft.riskTier}
                  onChange={(event) =>
                    update(
                      "riskTier",
                      event.target.value as MeasureDraft["riskTier"],
                    )
                  }
                >
                  <option value="tier_1">Tier 1</option>
                  <option value="tier_2">Tier 2</option>
                  <option value="tier_3">Tier 3</option>
                </select>
              </label>
              <label className={styles.fullWidthField}>
                <span>Authority and definition basis</span>
                <textarea
                  rows={3}
                  value={initialDraft.authority}
                  onChange={(event) => update("authority", event.target.value)}
                />
              </label>
              <label className={styles.fullWidthField}>
                <span>Golden test IDs, one per line</span>
                <textarea
                  rows={2}
                  value={initialDraft.testIds.join("\n")}
                  onChange={(event) =>
                    update(
                      "testIds",
                      event.target.value
                        .split("\n")
                        .map((item) => item.trim())
                        .filter(Boolean),
                    )
                  }
                />
              </label>
            </div>
          </section>
          <section className={styles.builderFormula} aria-label="Formula builder">
            <div className={styles.builderSectionHeading}>
              <div>
                <h4>Formula</h4>
                <p>
                  {context.view.label} · {context.view.grain} · {humanize(context.view.temporalAvailability)}
                </p>
              </div>
              <span data-invalid={invalidComplexity || undefined}>
                {complexity.nodes}/{context.limits.maximumNodes} nodes · depth {complexity.depth}/{context.limits.maximumDepth}
              </span>
            </div>
            <ExpressionEditor
              value={initialDraft.expression}
              context={context}
              onChange={(expression) => update("expression", expression)}
            />
          </section>
          <aside className={styles.builderDependencies} aria-label="Measure impact">
            <h4>Impact and dependencies</h4>
            <dl>
              <div>
                <dt>Direct fields</dt>
                <dd>{context.dependencies.fieldIds.length}</dd>
              </div>
              <div>
                <dt>Measure dependencies</dt>
                <dd>{context.dependencies.measureIds.length}</dd>
              </div>
              <div>
                <dt>Dependent measures</dt>
                <dd>{context.dependents.length}</dd>
              </div>
              <div>
                <dt>Exposed Topics</dt>
                <dd>{context.topics.length}</dd>
              </div>
            </dl>
            {context.dependencies.measureIds.length ? (
              <div>
                <strong>Uses measures</strong>
                {context.dependencies.measureIds.map((id) => (
                  <code key={id}>{id}</code>
                ))}
              </div>
            ) : null}
            {context.dependents.length ? (
              <div>
                <strong>Downstream measures</strong>
                {context.dependents.map((item) => (
                  <code key={item.id}>{item.id}</code>
                ))}
              </div>
            ) : null}
            {context.topics.length ? (
              <div>
                <strong>Topic exposure</strong>
                {context.topics.map((topic) => (
                  <code key={topic.id}>
                    {topic.label} · {humanize(topic.layer)}
                  </code>
                ))}
              </div>
            ) : null}
          </aside>
        </div>
        <footer className={styles.builderActions}>
          <span>
            Invalid formulas cannot be published. Tier 1 and Tier 2 changes
            still require their configured reviews.
          </span>
          <div>
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={
                saving ||
                invalidComplexity ||
                !initialDraft.label.trim() ||
                !initialDraft.description.trim() ||
                !initialDraft.grain.trim() ||
                !initialDraft.authority.trim()
              }
            >
              {saving ? "Saving…" : "Save governed revision"}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
