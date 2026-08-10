"use client";

import { useMemo, useState } from "react";
import styles from "./semantic-admin.module.css";

type Scalar = string | number | boolean;
type TopicFilterOperator =
  | "eq"
  | "neq"
  | "in"
  | "not_in"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "contains"
  | "is_null"
  | "is_not_null";

export type TopicFilterDraft = Readonly<{
  fieldId: string;
  op: TopicFilterOperator;
  values: readonly Scalar[];
}>;

export type TopicDraft = Readonly<{
  label: string;
  description: string;
  aiContext: string;
  defaultRootViewId: string;
  viewIds: readonly string[];
  relationshipIds: readonly string[];
  dimensionIds: readonly string[];
  measureIds: readonly string[];
  defaultFilters: readonly TopicFilterDraft[];
  freshnessMinutes: number;
  sampleQuestions: readonly string[];
  ambiguityNotes: readonly string[];
  unsupportedQuestions: readonly string[];
  alignOnDimensionIds: readonly string[];
  semanticState:
    | "verified"
    | "derived"
    | "exploratory"
    | "unsupported"
    | "deprecated";
}>;

export type TopicAuthoringContext = Readonly<{
  topicId: string;
  layer: "source_domain" | "business" | "composite";
  views: readonly Readonly<{
    id: string;
    label: string;
    grain: string;
    temporalAvailability: string;
    semanticState: string;
    selected: boolean;
    root: boolean;
  }>[];
  dimensions: readonly Readonly<{
    id: string;
    label: string;
    viewId: string;
    viewLabel: string;
    dataType: string;
    timeRole: string | null;
    conformedKey: string | null;
    semanticState: string;
    selected: boolean;
    aligned: boolean;
  }>[];
  measures: readonly Readonly<{
    id: string;
    label: string;
    viewId: string;
    viewLabel: string;
    unit: string;
    aggregation: string;
    semanticState: string;
    selected: boolean;
  }>[];
  relationships: readonly Readonly<{
    id: string;
    fromViewId: string;
    fromViewLabel: string;
    toViewId: string;
    toViewLabel: string;
    cardinality: string;
    semanticState: string;
    selected: boolean;
  }>[];
  impact: Readonly<{
    defaultFilters: number;
    sampleQuestions: number;
    ambiguityNotes: number;
    unsupportedQuestions: number;
    reviewTier: "tier_1" | "tier_3";
  }>;
}>;

const FILTER_OPERATORS: readonly TopicFilterOperator[] = [
  "eq",
  "neq",
  "in",
  "not_in",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "is_null",
  "is_not_null",
];

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function scalars(value: unknown): Scalar[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is Scalar =>
          typeof item === "string" ||
          typeof item === "number" ||
          typeof item === "boolean",
      )
    : [];
}

export function createTopicDraft(
  topic: Readonly<Record<string, unknown>>,
): TopicDraft {
  return {
    label: String(topic.label ?? ""),
    description: String(topic.description ?? ""),
    aiContext: String(topic.aiContext ?? ""),
    defaultRootViewId: String(topic.defaultRootViewId ?? ""),
    viewIds: strings(topic.viewIds),
    relationshipIds: strings(topic.relationshipIds),
    dimensionIds: strings(topic.dimensionIds),
    measureIds: strings(topic.measureIds),
    defaultFilters: Array.isArray(topic.defaultFilters)
      ? topic.defaultFilters.flatMap((candidate) => {
          if (!candidate || typeof candidate !== "object") return [];
          const filter = candidate as Record<string, unknown>;
          return typeof filter.fieldId === "string" &&
            FILTER_OPERATORS.includes(filter.op as TopicFilterOperator)
            ? [
                {
                  fieldId: filter.fieldId,
                  op: filter.op as TopicFilterOperator,
                  values: scalars(filter.values),
                },
              ]
            : [];
        })
      : [],
    freshnessMinutes: Number(topic.freshnessMinutes ?? 60),
    sampleQuestions: strings(topic.sampleQuestions),
    ambiguityNotes: strings(topic.ambiguityNotes),
    unsupportedQuestions: strings(topic.unsupportedQuestions),
    alignOnDimensionIds: strings(topic.alignOnDimensionIds),
    semanticState: topic.semanticState as TopicDraft["semanticState"],
  };
}

export function topicDraftChanges(draft: TopicDraft) {
  return {
    ...draft,
    viewIds: [...draft.viewIds],
    relationshipIds: [...draft.relationshipIds],
    dimensionIds: [...draft.dimensionIds],
    measureIds: [...draft.measureIds],
    defaultFilters: draft.defaultFilters.map((filter) => ({
      ...filter,
      values: [...filter.values],
    })),
    sampleQuestions: [...draft.sampleQuestions],
    ambiguityNotes: [...draft.ambiguityNotes],
    unsupportedQuestions: [...draft.unsupportedQuestions],
    alignOnDimensionIds: [...draft.alignOnDimensionIds],
  };
}

function humanize(value: string): string {
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function textList(value: string): string[] {
  return value
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function toggleId(values: readonly string[], id: string, checked: boolean) {
  if (checked) return values.includes(id) ? [...values] : [...values, id];
  return values.filter((value) => value !== id);
}

type MembershipOption = Readonly<{
  id: string;
  label: string;
  meta: string;
  state: string;
}>;

function MembershipList({
  label,
  description,
  options,
  selectedIds,
  onToggle,
  emptyMessage,
}: {
  label: string;
  description: string;
  options: readonly MembershipOption[];
  selectedIds: readonly string[];
  onToggle: (id: string, checked: boolean) => void;
  emptyMessage: string;
}) {
  const [query, setQuery] = useState("");
  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);
  const matches = useMemo(() => {
    const token = query.trim().toLowerCase();
    const filtered = token
      ? options.filter((option) =>
          `${option.label} ${option.id} ${option.meta}`
            .toLowerCase()
            .includes(token),
        )
      : options;
    const chosen = filtered.filter(({ id }) => selected.has(id));
    const available = filtered.filter(({ id }) => !selected.has(id));
    return [...chosen, ...available.slice(0, Math.max(0, 400 - chosen.length))];
  }, [options, query, selected]);
  return (
    <fieldset className={styles.membershipFieldset}>
      <legend>{label}</legend>
      <p>{description}</p>
      <label className={styles.membershipSearch}>
        <span className="sr-only">Search {label.toLowerCase()}</span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={`Search ${label.toLowerCase()}…`}
        />
      </label>
      <small>
        {selectedIds.length} selected · {options.length} eligible
        {matches.length < options.length ? ` · showing ${matches.length}` : ""}
      </small>
      <div className={styles.membershipList}>
        {matches.length ? (
          matches.map((option) => (
            <label key={option.id}>
              <input
                type="checkbox"
                checked={selected.has(option.id)}
                onChange={(event) => onToggle(option.id, event.target.checked)}
              />
              <span>
                <strong>{option.label}</strong>
                <small>{option.meta}</small>
              </span>
              <i data-state={option.state}>{humanize(option.state)}</i>
            </label>
          ))
        ) : (
          <p>{emptyMessage}</p>
        )}
      </div>
    </fieldset>
  );
}

function ScalarEditor({
  value,
  onChange,
  onRemove,
}: {
  value: Scalar;
  onChange: (value: Scalar) => void;
  onRemove?: () => void;
}) {
  const kind = typeof value;
  return (
    <div className={styles.scalarEditor}>
      <select
        aria-label="Filter value type"
        value={kind}
        onChange={(event) => {
          if (event.target.value === "number") onChange(0);
          else if (event.target.value === "boolean") onChange(true);
          else onChange("");
        }}
      >
        <option value="string">Text</option>
        <option value="number">Number</option>
        <option value="boolean">Boolean</option>
      </select>
      {kind === "boolean" ? (
        <select
          aria-label="Boolean filter value"
          value={String(value)}
          onChange={(event) => onChange(event.target.value === "true")}
        >
          <option value="true">True</option>
          <option value="false">False</option>
        </select>
      ) : (
        <input
          aria-label="Filter value"
          type={kind === "number" ? "number" : "text"}
          value={String(value)}
          onChange={(event) =>
            onChange(
              kind === "number" ? event.target.valueAsNumber : event.target.value,
            )
          }
        />
      )}
      {onRemove ? (
        <button type="button" onClick={onRemove} aria-label="Remove filter value">
          Remove
        </button>
      ) : null}
    </div>
  );
}

function normalizeFilterValues(
  op: TopicFilterOperator,
  values: readonly Scalar[],
): Scalar[] {
  if (["is_null", "is_not_null"].includes(op)) return [];
  if (["in", "not_in"].includes(op)) return values.length ? [...values] : [""];
  return [values[0] ?? ""];
}

function DefaultFilters({
  filters,
  dimensions,
  onChange,
}: {
  filters: readonly TopicFilterDraft[];
  dimensions: readonly TopicAuthoringContext["dimensions"][number][];
  onChange: (filters: TopicFilterDraft[]) => void;
}) {
  return (
    <fieldset className={styles.filterFieldset}>
      <legend>Default filters</legend>
      <p>Filters apply to every query in this Topic and may use exposed dimensions only.</p>
      {filters.map((filter, index) => (
        <div className={styles.filterCard} key={`${filter.fieldId}:${index}`}>
          <label>
            <span>Dimension</span>
            <select
              value={filter.fieldId}
              onChange={(event) =>
                onChange(
                  filters.map((item, itemIndex) =>
                    itemIndex === index
                      ? { ...item, fieldId: event.target.value }
                      : item,
                  ),
                )
              }
            >
              {dimensions.map((dimension) => (
                <option value={dimension.id} key={dimension.id}>
                  {dimension.label} · {dimension.viewLabel}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Operator</span>
            <select
              value={filter.op}
              onChange={(event) => {
                const op = event.target.value as TopicFilterOperator;
                onChange(
                  filters.map((item, itemIndex) =>
                    itemIndex === index
                      ? { ...item, op, values: normalizeFilterValues(op, item.values) }
                      : item,
                  ),
                );
              }}
            >
              {FILTER_OPERATORS.map((operator) => (
                <option value={operator} key={operator}>
                  {humanize(operator)}
                </option>
              ))}
            </select>
          </label>
          {filter.values.map((value, valueIndex) => (
            <ScalarEditor
              key={valueIndex}
              value={value}
              onChange={(nextValue) =>
                onChange(
                  filters.map((item, itemIndex) =>
                    itemIndex === index
                      ? {
                          ...item,
                          values: item.values.map((entry, entryIndex) =>
                            entryIndex === valueIndex ? nextValue : entry,
                          ),
                        }
                      : item,
                  ),
                )
              }
              onRemove={
                ["in", "not_in"].includes(filter.op) && filter.values.length > 1
                  ? () =>
                      onChange(
                        filters.map((item, itemIndex) =>
                          itemIndex === index
                            ? {
                                ...item,
                                values: item.values.filter(
                                  (_entry, entryIndex) => entryIndex !== valueIndex,
                                ),
                              }
                            : item,
                        ),
                      )
                  : undefined
              }
            />
          ))}
          <div className={styles.filterActions}>
            {["in", "not_in"].includes(filter.op) && filter.values.length < 100 ? (
              <button
                type="button"
                onClick={() =>
                  onChange(
                    filters.map((item, itemIndex) =>
                      itemIndex === index
                        ? { ...item, values: [...item.values, ""] }
                        : item,
                    ),
                  )
                }
              >
                Add value
              </button>
            ) : null}
            <button
              type="button"
              onClick={() =>
                onChange(filters.filter((_item, itemIndex) => itemIndex !== index))
              }
            >
              Remove filter
            </button>
          </div>
        </div>
      ))}
      <button
        type="button"
        disabled={!dimensions.length}
        onClick={() =>
          onChange([
            ...filters,
            { fieldId: dimensions[0]?.id ?? "", op: "eq", values: [""] },
          ])
        }
      >
        Add default filter
      </button>
    </fieldset>
  );
}

export default function SemanticTopicBuilder({
  topicId,
  initialDraft,
  context,
  saving,
  onChange,
  onCancel,
  onSave,
}: {
  topicId: string;
  initialDraft: TopicDraft;
  context: TopicAuthoringContext;
  saving: boolean;
  onChange: (draft: TopicDraft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const viewIds = useMemo(() => new Set(initialDraft.viewIds), [initialDraft.viewIds]);
  const dimensionIds = useMemo(
    () => new Set(initialDraft.dimensionIds),
    [initialDraft.dimensionIds],
  );
  const selectedDimensions = context.dimensions.filter(({ id }) =>
    dimensionIds.has(id),
  );
  const eligibleDimensions = context.dimensions.filter(({ viewId }) =>
    viewIds.has(viewId),
  );
  const eligibleMeasures = context.measures.filter(({ viewId }) => viewIds.has(viewId));
  const eligibleRelationships = context.relationships.filter(
    ({ fromViewId, toViewId }) => viewIds.has(fromViewId) && viewIds.has(toViewId),
  );
  const alignmentGroups = new Map<string, Set<string>>();
  for (const id of initialDraft.alignOnDimensionIds) {
    const dimension = context.dimensions.find((candidate) => candidate.id === id);
    if (!dimension?.conformedKey) continue;
    const views = alignmentGroups.get(dimension.conformedKey) ?? new Set<string>();
    views.add(dimension.viewId);
    alignmentGroups.set(dimension.conformedKey, views);
  }
  const issues = [
    ...(!initialDraft.label.trim() ? ["Label is required."] : []),
    ...(!initialDraft.description.trim() ? ["Description is required."] : []),
    ...(!initialDraft.aiContext.trim() ? ["Model context is required."] : []),
    ...(!initialDraft.viewIds.length ? ["Select at least one view."] : []),
    ...(!viewIds.has(initialDraft.defaultRootViewId)
      ? ["The default root must be a selected view."]
      : []),
    ...(!Number.isInteger(initialDraft.freshnessMinutes) ||
    initialDraft.freshnessMinutes <= 0
      ? ["Freshness must be a positive whole number of minutes."]
      : []),
    ...(!initialDraft.sampleQuestions.length
      ? ["Add at least one sample question."]
      : []),
    ...(context.layer === "composite" && initialDraft.viewIds.length < 2
      ? ["Composite Topics require at least two views."]
      : []),
    ...(context.layer === "composite" &&
    ![...alignmentGroups.values()].some((views) => views.size >= 2)
      ? ["Composite Topics need one conformed key aligned across two views."]
      : []),
  ];
  const update = <Key extends keyof TopicDraft>(
    key: Key,
    value: TopicDraft[Key],
  ) => onChange({ ...initialDraft, [key]: value });
  const toggleView = (id: string, checked: boolean) => {
    const nextViewIds = toggleId(initialDraft.viewIds, id, checked);
    const nextViews = new Set(nextViewIds);
    const nextDimensionIds = initialDraft.dimensionIds.filter((dimensionId) => {
      const dimension = context.dimensions.find((item) => item.id === dimensionId);
      return dimension ? nextViews.has(dimension.viewId) : false;
    });
    const nextDimensions = new Set(nextDimensionIds);
    onChange({
      ...initialDraft,
      viewIds: nextViewIds,
      defaultRootViewId: nextViews.has(initialDraft.defaultRootViewId)
        ? initialDraft.defaultRootViewId
        : (nextViewIds[0] ?? ""),
      dimensionIds: nextDimensionIds,
      measureIds: initialDraft.measureIds.filter((measureId) => {
        const measure = context.measures.find((item) => item.id === measureId);
        return measure ? nextViews.has(measure.viewId) : false;
      }),
      relationshipIds: initialDraft.relationshipIds.filter((relationshipId) => {
        const relationship = context.relationships.find(
          (item) => item.id === relationshipId,
        );
        return relationship
          ? nextViews.has(relationship.fromViewId) && nextViews.has(relationship.toViewId)
          : false;
      }),
      alignOnDimensionIds: initialDraft.alignOnDimensionIds.filter((dimensionId) =>
        nextDimensions.has(dimensionId),
      ),
      defaultFilters: initialDraft.defaultFilters.filter(({ fieldId }) =>
        nextDimensions.has(fieldId),
      ),
    });
  };
  const toggleDimension = (id: string, checked: boolean) => {
    const next = toggleId(initialDraft.dimensionIds, id, checked);
    onChange({
      ...initialDraft,
      dimensionIds: next,
      ...(checked
        ? {}
        : {
            alignOnDimensionIds: initialDraft.alignOnDimensionIds.filter(
              (dimensionId) => dimensionId !== id,
            ),
            defaultFilters: initialDraft.defaultFilters.filter(
              ({ fieldId }) => fieldId !== id,
            ),
          }),
    });
  };
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
        aria-labelledby="semantic-topic-builder"
      >
        <header className={styles.builderHeader}>
          <span>GOVERNED TOPIC BUILDER · {humanize(context.layer)}</span>
          <h3 id="semantic-topic-builder">Edit {topicId}</h3>
          <p>
            Curate the model-visible query environment. Removing a view also removes
            its exposed objects, filters, relationships and alignment keys so an
            invalid graph cannot be saved accidentally.
          </p>
        </header>
        <div className={`${styles.builderBody} ${styles.topicBuilderBody}`}>
          <section className={styles.builderMetadata} aria-label="Topic contract">
            <h4>Topic contract</h4>
            <div className={styles.builderGrid}>
              <label className={styles.fullWidthField}>
                <span>Label</span>
                <input
                  value={initialDraft.label}
                  onChange={(event) => update("label", event.target.value)}
                />
              </label>
              <label className={styles.fullWidthField}>
                <span>Description</span>
                <textarea
                  rows={3}
                  value={initialDraft.description}
                  onChange={(event) => update("description", event.target.value)}
                />
              </label>
              <label className={styles.fullWidthField}>
                <span>Model context</span>
                <textarea
                  rows={5}
                  value={initialDraft.aiContext}
                  onChange={(event) => update("aiContext", event.target.value)}
                />
              </label>
              <label>
                <span>Freshness expectation, minutes</span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={initialDraft.freshnessMinutes}
                  onChange={(event) => update("freshnessMinutes", event.target.valueAsNumber)}
                />
              </label>
              <label>
                <span>Semantic state</span>
                <select
                  value={initialDraft.semanticState}
                  onChange={(event) =>
                    update("semanticState", event.target.value as TopicDraft["semanticState"])
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
              <label className={styles.fullWidthField}>
                <span>Sample questions, one per line</span>
                <textarea
                  rows={4}
                  value={initialDraft.sampleQuestions.join("\n")}
                  onChange={(event) => update("sampleQuestions", textList(event.target.value))}
                />
              </label>
              <label className={styles.fullWidthField}>
                <span>Ambiguity notes, one per line</span>
                <textarea
                  rows={3}
                  value={initialDraft.ambiguityNotes.join("\n")}
                  onChange={(event) => update("ambiguityNotes", textList(event.target.value))}
                />
              </label>
              <label className={styles.fullWidthField}>
                <span>Unsupported questions, one per line</span>
                <textarea
                  rows={3}
                  value={initialDraft.unsupportedQuestions.join("\n")}
                  onChange={(event) =>
                    update("unsupportedQuestions", textList(event.target.value))
                  }
                />
              </label>
            </div>
          </section>
          <section className={styles.builderFormula} aria-label="Topic surface">
            <div className={styles.builderSectionHeading}>
              <div>
                <h4>Model-visible surface</h4>
                <p>Select views first, then expose only useful governed objects.</p>
              </div>
              <span>{initialDraft.viewIds.length} views</span>
            </div>
            <MembershipList
              label="Views"
              description="The compiler may resolve objects only inside this view set."
              options={context.views.map((view) => ({
                id: view.id,
                label: view.label,
                meta: `${view.grain} · ${humanize(view.temporalAvailability)}`,
                state: view.semanticState,
              }))}
              selectedIds={initialDraft.viewIds}
              onToggle={toggleView}
              emptyMessage="No views match this search."
            />
            <label className={styles.rootViewSelect}>
              <span>Default root view</span>
              <select
                value={initialDraft.defaultRootViewId}
                onChange={(event) => update("defaultRootViewId", event.target.value)}
              >
                {context.views
                  .filter(({ id }) => viewIds.has(id))
                  .map((view) => (
                    <option value={view.id} key={view.id}>
                      {view.label} · {view.grain}
                    </option>
                  ))}
              </select>
            </label>
            <MembershipList
              label="Measures"
              description="Measures carry governed arithmetic, grain and certification state."
              options={eligibleMeasures.map((measure) => ({
                id: measure.id,
                label: measure.label,
                meta: `${measure.viewLabel} · ${humanize(measure.unit)} · ${humanize(measure.aggregation)}`,
                state: measure.semanticState,
              }))}
              selectedIds={initialDraft.measureIds}
              onToggle={(id, checked) => update("measureIds", toggleId(initialDraft.measureIds, id, checked))}
              emptyMessage="Select a view before exposing its measures."
            />
            <MembershipList
              label="Dimensions"
              description="Dimensions define grouping, filtering and comparison language."
              options={eligibleDimensions.map((dimension) => ({
                id: dimension.id,
                label: dimension.label,
                meta: `${dimension.viewLabel} · ${dimension.dataType}${dimension.timeRole ? ` · ${humanize(dimension.timeRole)}` : ""}`,
                state: dimension.semanticState,
              }))}
              selectedIds={initialDraft.dimensionIds}
              onToggle={toggleDimension}
              emptyMessage="Select a view before exposing its dimensions."
            />
            <MembershipList
              label="Relationships"
              description="Only reviewed relationships whose endpoints are selected are eligible."
              options={eligibleRelationships.map((relationship) => ({
                id: relationship.id,
                label: `${relationship.fromViewLabel} → ${relationship.toViewLabel}`,
                meta: humanize(relationship.cardinality),
                state: relationship.semanticState,
              }))}
              selectedIds={initialDraft.relationshipIds}
              onToggle={(id, checked) =>
                update(
                  "relationshipIds",
                  toggleId(initialDraft.relationshipIds, id, checked),
                )
              }
              emptyMessage="No reviewed relationship connects the selected views."
            />
            {context.layer === "composite" ? (
              <MembershipList
                label="Composite alignment dimensions"
                description="Choose exposed conformed dimensions that share a key across independent views."
                options={selectedDimensions
                  .filter(({ conformedKey }) => Boolean(conformedKey))
                  .map((dimension) => ({
                    id: dimension.id,
                    label: dimension.label,
                    meta: `${dimension.viewLabel} · ${dimension.conformedKey}`,
                    state: dimension.semanticState,
                  }))}
                selectedIds={initialDraft.alignOnDimensionIds}
                onToggle={(id, checked) =>
                  update(
                    "alignOnDimensionIds",
                    toggleId(initialDraft.alignOnDimensionIds, id, checked),
                  )
                }
                emptyMessage="Expose conformed dimensions before configuring alignment."
              />
            ) : null}
            <DefaultFilters
              filters={initialDraft.defaultFilters}
              dimensions={selectedDimensions}
              onChange={(filters) => update("defaultFilters", filters)}
            />
          </section>
          <aside className={styles.builderDependencies} aria-label="Topic validation impact">
            <h4>Validation impact</h4>
            <dl>
              <div><dt>Layer</dt><dd>{humanize(context.layer)}</dd></div>
              <div><dt>Review</dt><dd>{humanize(context.impact.reviewTier)}</dd></div>
              <div><dt>Views</dt><dd>{initialDraft.viewIds.length}</dd></div>
              <div><dt>Measures</dt><dd>{initialDraft.measureIds.length}</dd></div>
              <div><dt>Dimensions</dt><dd>{initialDraft.dimensionIds.length}</dd></div>
              <div><dt>Relationships</dt><dd>{initialDraft.relationshipIds.length}</dd></div>
              <div><dt>Default filters</dt><dd>{initialDraft.defaultFilters.length}</dd></div>
            </dl>
            {context.layer === "composite" ? (
              <div>
                <strong>Alignment coverage</strong>
                {[...alignmentGroups.entries()].length ? (
                  [...alignmentGroups.entries()].map(([key, views]) => (
                    <code key={key}>{key} · {views.size} views</code>
                  ))
                ) : (
                  <p>No conformed alignment key selected.</p>
                )}
              </div>
            ) : null}
            <div>
              <strong>{issues.length ? "Blocking issues" : "Ready to save"}</strong>
              {issues.length ? (
                <ul className={styles.builderIssues}>
                  {issues.map((issue) => <li key={issue}>{issue}</li>)}
                </ul>
              ) : (
                <p>The typed Topic contract is locally coherent. Full graph validation runs on save and publication.</p>
              )}
            </div>
          </aside>
        </div>
        <footer className={styles.builderActions}>
          <span>
            One save creates one optimistic draft revision. No publication is activated.
          </span>
          <div>
            <button type="button" onClick={onCancel}>Cancel</button>
            <button type="button" onClick={onSave} disabled={saving || Boolean(issues.length)}>
              {saving ? "Saving…" : "Save Topic revision"}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
