"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import SemanticMeasureBuilder, {
  createMeasureDraft,
  measureDraftChanges,
  type MeasureAuthoringContext,
  type MeasureDraft,
} from "./SemanticMeasureBuilder";
import SemanticTopicBuilder, {
  createTopicDraft,
  topicDraftChanges,
  type TopicAuthoringContext,
  type TopicDraft,
} from "./SemanticTopicBuilder";
import SemanticRelationshipGraph, {
  type RelationshipGraphPayload,
} from "./SemanticRelationshipGraph";
import styles from "./semantic-admin.module.css";

const SECTIONS = [
  ["overview", "Overview"],
  ["sources", "Sources"],
  ["relationships", "Relationships"],
  ["views", "Views"],
  ["measures", "Measures"],
  ["topics", "Topics"],
  ["context", "Business context"],
  ["test_lab", "Test lab"],
  ["publications", "Publications"],
  ["inbox", "Semantic inbox"],
  ["health", "Health"],
] as const;
type Section = (typeof SECTIONS)[number][0];

type SemanticHealthPayload =
  | Readonly<{ available: false; reason: string }>
  | Readonly<{
      available: true;
      summary: {
        schemaVersion: 1;
        windowStart: string;
        generatedAt: string;
        turnCount: number;
        answerStates: Record<string, number>;
        rates: {
          answerability: number | null;
          clarification: number | null;
          unavailable: number | null;
        };
        eventKinds: Record<string, number>;
        eventReasons: Array<{
          reasonCode: string;
          eventKind: string;
          count: number;
        }>;
        topicUsage: Array<{ id: string; count: number }>;
        objectUsage: Array<{ id: string; count: number }>;
        latency: {
          queryCount: number;
          p50Ms: number | null;
          p95Ms: number | null;
        };
      };
    }>;

type EvaluationCorpusPayload = Readonly<{
  total: number;
  visible: number;
  hidden: number;
  allocations: {
    source: Record<string, number>;
    difficulty: Record<string, number>;
    questionClass: Record<string, number>;
    terminalState: Record<string, number>;
  };
  runtimePolicy: {
    model: "gpt-5.6-luna";
    reasoningEffort: "max";
    fastMode: false;
    proMode: false;
    maximumExecutions: 200;
    deputyAllowed: false;
  };
  matchingVisibleCount: number;
  cases: Array<{
    id: string;
    ask: string;
    source: string;
    difficulty: string;
    questionClass: string;
    expectedTerminalState: string;
    expectedOperator: string | null;
    tags: string[];
    thread: string | null;
    followUpOf: string | null;
  }>;
}>;

type SemanticAdminPayload = Readonly<{
  section: Section;
  overview: {
    publicationHash: string;
    registryVersion: string;
    objectCounts: Record<string, number>;
    semanticStateCounts: Record<string, number>;
    fieldDispositionCounts: Record<string, number>;
    physicalMapping: {
      materialized: number;
      unsupported: number;
      aliased: number;
    };
    sourceConnectorCounts: Record<string, { objects: number; fields: number }>;
    unresolvedRelationships: number;
    topicLayers: Record<string, number>;
  };
  persistence: {
    available: boolean;
    drafts: Array<{
      draft_id: string;
      name: string;
      revision: number;
      status: string;
      manifest_hash: string;
      updated_at: string;
    }>;
    validations: Array<{
      validation_id: string;
      draft_id: string;
      draft_revision: number;
      manifest_hash: string;
      status: string;
      issues: unknown[];
      created_at: string;
    }>;
    reviews: Array<{
      draft_id: string;
      draft_revision: number;
      object_id: string;
      risk_tier: string;
      disposition: string;
      reviewer_id: string;
      created_at: string;
    }>;
    profileReceipts: Array<{
      profile_receipt_hash: string;
      publication_hash: string;
      tenant_digest: string;
      status: string;
      created_at: string;
    }>;
    publications: Array<{
      publication_hash: string;
      registry_version: string;
      object_counts: Record<string, number>;
      source_draft_id: string;
      source_draft_revision: number;
      created_at: string;
    }>;
    qualifications: Array<{
      publication_hash: string;
      commit_sha: string;
      status: string;
      created_at: string;
    }>;
    contextValues: Array<{
      context_id: string;
      context_key: string;
      version: number;
      value: unknown;
      source: string;
      evidence: unknown[];
      valid_from: string;
    }>;
    runtimeEvents: Array<{
      event_id: string;
      event_kind: string;
      reason_code: string;
      created_at: string;
    }>;
    active: {
      publication_hash: string;
      previous_publication_hash: string | null;
      activated_at: string;
    } | null;
  };
  items?: AdminItem[];
  total?: number;
  offset?: number;
  limit?: number;
  catalogue?: {
    mode: "draft" | "generated";
    draftId: string | null;
    revision: number | null;
  };
  authoringContext?: MeasureAuthoringContext | null;
  topicAuthoringContext?: TopicAuthoringContext | null;
  relationshipGraph?: RelationshipGraphPayload | null;
  semanticHealth?: SemanticHealthPayload | null;
  evaluationCorpus?: EvaluationCorpusPayload | null;
  draftDiff?: {
    baseManifestHash: string;
    candidateManifestHash: string;
    diffHash: string;
    summary: {
      added: number;
      removed: number;
      changed: number;
      high: number;
      medium: number;
      low: number;
      byObjectType: Record<string, number>;
    };
    changes: Array<{
      objectType: string;
      objectId: string;
      parentId: string | null;
      operation: "added" | "removed" | "changed";
      changedFields: string[];
      severity: "high" | "medium" | "low";
      requiredReviewTier: "tier_1" | "tier_2" | "tier_3";
      reason: string;
    }>;
  } | null;
  error?: string;
}>;

type AdminItem = Record<string, unknown> & {
  id?: string;
  label?: string;
  description?: string;
  semanticState?: string;
  fields?: AdminItem[];
};
type DraftRef = Readonly<{ id: string; revision: number; name: string }>;
type RelationshipProfileResolution = Readonly<{
  status: string;
  reason: string;
  profileReceiptHash: string;
  profiledAt: string;
  proposal?: Readonly<{
    targetViewId: string;
    targetFieldId: string;
    cardinality: "many_to_one";
    optional: boolean;
    temporalBehavior: "not_applicable";
    topicIds: readonly string[];
    notes: string;
  }>;
  targets: readonly Readonly<{
    targetViewId: string;
    targetFieldId: string;
    sampledForeignKeys: number;
    orphanRows: number;
    maximumTargetMatches: number;
    ambiguousRows: number;
    duplicateTargetKeyGroups: number;
    safeManyToOne: boolean;
  }>[];
}>;

const EDITABLE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  sourceObject: [
    "label",
    "description",
    "grain",
    "additivity",
    "additivityAxis",
    "semanticState",
  ],
  field: [
    "description",
    "disposition",
    "semanticState",
    "nullable",
    "pii",
    "unsupportedReason",
  ],
  view: [
    "label",
    "description",
    "grain",
    "primaryKey",
    "temporalAvailability",
    "snapshotPolicy",
    "dimensionIds",
    "measureIds",
    "relationshipIds",
    "timeRoleIds",
    "semanticState",
  ],
  dimension: [
    "label",
    "description",
    "synonyms",
    "dataType",
    "timeRole",
    "semanticState",
  ],
  measure: [
    "label",
    "description",
    "synonyms",
    "grain",
    "unit",
    "aggregation",
    "additivity",
    "currencyFieldId",
    "expression",
    "semanticState",
    "authority",
    "riskTier",
    "testIds",
  ],
  relationship: [
    "fromViewId",
    "toViewId",
    "fromFieldId",
    "toFieldId",
    "cardinality",
    "optional",
    "supportedDirections",
    "temporalBehavior",
    "semanticState",
    "evidence",
    "unsupportedReason",
  ],
  relationshipCandidate: [
    "targets",
    "candidateViewIds",
    "disposition",
    "reason",
    "evidence",
  ],
  topic: [
    "label",
    "description",
    "aiContext",
    "defaultRootViewId",
    "viewIds",
    "relationshipIds",
    "dimensionIds",
    "measureIds",
    "defaultFilters",
    "freshnessMinutes",
    "sampleQuestions",
    "ambiguityNotes",
    "unsupportedQuestions",
    "alignOnDimensionIds",
    "semanticState",
  ],
  businessContext: [
    "label",
    "description",
    "valueType",
    "source",
    "semanticState",
  ],
};

function editableContract(
  section: Section,
  item: AdminItem,
): Record<string, unknown> {
  const type = String(item._objectType ?? itemType(section, item));
  return Object.fromEntries(
    (EDITABLE_FIELDS[type] ?? []).flatMap((key) =>
      item[key] === undefined ? [] : [[key, item[key]]],
    ),
  );
}

function humanize(value: unknown): string {
  if (typeof value !== "string") return "—";
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function compactHash(value: string): string {
  return value.length > 18 ? `${value.slice(0, 9)}…${value.slice(-7)}` : value;
}

function percentage(value: number | null): string {
  return value === null ? "No runtime data" : `${(value * 100).toFixed(1)}%`;
}

function itemType(
  section: Section,
  item?: AdminItem | null,
):
  | "sourceObject"
  | "field"
  | "view"
  | "dimension"
  | "measure"
  | "topic"
  | "businessContext"
  | "relationship"
  | "relationshipCandidate"
  | null {
  if (
    ["field", "dimension", "measure", "relationship"].includes(
      String(item?._objectType),
    )
  )
    return item?._objectType as
      "field" | "dimension" | "measure" | "relationship";
  if (section === "sources") return "sourceObject";
  if (section === "views") return "view";
  if (section === "measures") return "measure";
  if (section === "topics" || section === "test_lab") return "topic";
  if (section === "context") return "businessContext";
  if (section === "relationships" || section === "inbox")
    return item?.disposition ? "relationshipCandidate" : "relationship";
  return null;
}

function itemMeta(item: AdminItem, section: Section): string {
  if (section === "sources")
    return `${humanize(item.connector)} · ${humanize(item.domain)} · ${item.fieldCount ?? 0} fields`;
  if (section === "views")
    return `${String(item.physicalTable ?? "") || "semantic view"} · ${String(item.grain ?? "")}`;
  if (section === "measures")
    return `${humanize(item.unit)} · ${humanize(item.aggregation)} · ${humanize(item.riskTier)}`;
  if (section === "topics" || section === "test_lab")
    return `${humanize(item.layer)} · ${item.measureCount ?? 0} measures · ${item.dimensionCount ?? 0} dimensions`;
  if (section === "relationships" || section === "inbox")
    return `${humanize(item.disposition ?? item.cardinality)} · ${String(item.fromViewId ?? "")}`;
  return humanize(item.source ?? item.valueType);
}

function Overview({ payload }: { payload: SemanticAdminPayload }) {
  const counts = payload.overview.objectCounts;
  return (
    <>
      <dl className={styles.summaryGrid}>
        <div>
          <dt>Source objects</dt>
          <dd>{counts.sourceObjects}</dd>
          <small>90 Lightspeed · 197 Xero</small>
        </div>
        <div>
          <dt>Source fields</dt>
          <dd>{counts.fields}</dd>
          <small>
            {payload.overview.physicalMapping.materialized} physical ·{" "}
            {payload.overview.physicalMapping.unsupported} unsupported ·{" "}
            {payload.overview.physicalMapping.aliased} aliases
          </small>
        </div>
        <div>
          <dt>Views</dt>
          <dd>{counts.views}</dd>
          <small>Source, canonical and mart grains</small>
        </div>
        <div>
          <dt>Measures</dt>
          <dd>{counts.measures}</dd>
          <small>Governed plus source row counts</small>
        </div>
        <div>
          <dt>Topics</dt>
          <dd>{counts.topics}</dd>
          <small>
            {payload.overview.topicLayers.business} business ·{" "}
            {payload.overview.topicLayers.composite} composite
          </small>
        </div>
        <div
          data-tone={
            payload.overview.unresolvedRelationships ? "warning" : "healthy"
          }
        >
          <dt>Unresolved joins</dt>
          <dd>{payload.overview.unresolvedRelationships}</dd>
          <small>Never available to compilation</small>
        </div>
      </dl>
      <div className={styles.overviewColumns}>
        <section>
          <header>
            <div>
              <span>SEMANTIC CONFIDENCE</span>
              <h3>Objects by evidence state</h3>
            </div>
          </header>
          <div className={styles.statRows}>
            {Object.entries(payload.overview.semanticStateCounts).map(
              ([key, value]) => (
                <div key={key}>
                  <span className={styles.stateDot} data-state={key} />{" "}
                  <strong>{humanize(key)}</strong>
                  <b>{value}</b>
                </div>
              ),
            )}
          </div>
        </section>
        <section>
          <header>
            <div>
              <span>FIELD DISPOSITION</span>
              <h3>Complete source classification</h3>
            </div>
          </header>
          <div className={styles.statRows}>
            {Object.entries(payload.overview.fieldDispositionCounts)
              .sort(([, left], [, right]) => right - left)
              .map(([key, value]) => (
                <div key={key}>
                  <strong>{humanize(key)}</strong>
                  <b>{value}</b>
                </div>
              ))}
          </div>
        </section>
        <section>
          <header>
            <div>
              <span>AUTHORING CONTROL</span>
              <h3>Publication state</h3>
            </div>
          </header>
          <div className={styles.publicationCard}>
            <span
              className={styles.badge}
              data-state={payload.persistence.available ? "derived" : "warning"}
            >
              {payload.persistence.available
                ? "Control plane ready"
                : "Migration not deployed"}
            </span>
            <code title={payload.overview.publicationHash}>
              {compactHash(payload.overview.publicationHash)}
            </code>
            <p>
              Registry {payload.overview.registryVersion}. Customer traffic
              remains unchanged until the final turn-level cutover.
            </p>
          </div>
        </section>
      </div>
    </>
  );
}

function SemanticHealth({ payload }: { payload: SemanticAdminPayload }) {
  const health = payload.semanticHealth;
  const summary = health?.available ? health.summary : null;
  const states = summary?.answerStates ?? {};
  return (
    <div className={styles.healthPanel}>
      <h3>Semantic health</h3>
      <p>
        Thirty-day, privacy-preserving V2 telemetry. Counts contain no question
        text, tenant identifiers, result rows, claims, or evidence payloads.
      </p>
      {!health?.available ? (
        <div className={styles.notice} role="status">
          {health?.reason ?? "Runtime health is unavailable."}
        </div>
      ) : null}
      <dl>
        <div>
          <dt>V2 answerability</dt>
          <dd>{percentage(summary?.rates.answerability ?? null)}</dd>
        </div>
        <div>
          <dt>Clarification rate</dt>
          <dd>{percentage(summary?.rates.clarification ?? null)}</dd>
        </div>
        <div>
          <dt>Unavailable rate</dt>
          <dd>{percentage(summary?.rates.unavailable ?? null)}</dd>
        </div>
        <div>
          <dt>V2 turns</dt>
          <dd>{summary?.turnCount ?? 0}</dd>
        </div>
        <div>
          <dt>Query latency p50</dt>
          <dd>
            {summary?.latency.p50Ms === null ||
            summary?.latency.p50Ms === undefined
              ? "No data"
              : `${summary.latency.p50Ms} ms`}
          </dd>
        </div>
        <div>
          <dt>Query latency p95</dt>
          <dd>
            {summary?.latency.p95Ms === null ||
            summary?.latency.p95Ms === undefined
              ? "No data"
              : `${summary.latency.p95Ms} ms`}
          </dd>
        </div>
        {[
          "verified",
          "derived",
          "exploratory",
          "clarification",
          "no_data",
          "unavailable",
        ].map((state) => (
          <div key={state}>
            <dt>{humanize(state)}</dt>
            <dd>{states[state] ?? 0}</dd>
          </div>
        ))}
        <div>
          <dt>Unresolved join candidates</dt>
          <dd>{payload.overview.unresolvedRelationships}</dd>
        </div>
        <div>
          <dt>Active publication drift</dt>
          <dd>
            {!payload.persistence.active
              ? "Not activated"
              : payload.persistence.active.publication_hash ===
                  payload.overview.publicationHash
                ? "Current"
                : "Drift detected"}
          </dd>
        </div>
      </dl>
      <div className={styles.healthDetails}>
        <section>
          <h4>Top unavailable and failure reasons</h4>
          {summary?.eventReasons.length ? (
            <ol>
              {summary.eventReasons.slice(0, 10).map((reason) => (
                <li key={`${reason.eventKind}:${reason.reasonCode}`}>
                  <span>{humanize(reason.reasonCode)}</span>
                  <em>{reason.count}</em>
                </li>
              ))}
            </ol>
          ) : (
            <p>No V2 misses or failures recorded in this window.</p>
          )}
        </section>
        <section>
          <h4>Most-used Topics</h4>
          {summary?.topicUsage.length ? (
            <ol>
              {summary.topicUsage.slice(0, 10).map((item) => (
                <li key={item.id}>
                  <span>{item.id}</span>
                  <em>{item.count}</em>
                </li>
              ))}
            </ol>
          ) : (
            <p>No V2 Topic usage recorded in this window.</p>
          )}
        </section>
        <section>
          <h4>Most-used semantic objects</h4>
          {summary?.objectUsage.length ? (
            <ol>
              {summary.objectUsage.slice(0, 10).map((item) => (
                <li key={item.id}>
                  <span>{item.id}</span>
                  <em>{item.count}</em>
                </li>
              ))}
            </ol>
          ) : (
            <p>No V2 object usage recorded in this window.</p>
          )}
        </section>
      </div>
    </div>
  );
}

function EvaluationCorpus({ payload }: { payload: SemanticAdminPayload }) {
  const corpus = payload.evaluationCorpus;
  if (!corpus) return null;
  return (
    <section className={styles.evaluationCorpus} aria-label="V2 evaluation corpus">
      <header>
        <div>
          <span>SEALED EVALUATION CONTRACT</span>
          <h3>200-case Luna Max corpus</h3>
          <p>
            Browse visible cases and expected outcomes. This view never starts a
            model execution; hidden prompts remain sealed.
          </p>
        </div>
        <dl>
          <div>
            <dt>Total</dt>
            <dd>{corpus.total}</dd>
          </div>
          <div>
            <dt>Visible</dt>
            <dd>{corpus.visible}</dd>
          </div>
          <div>
            <dt>Hidden</dt>
            <dd>{corpus.hidden}</dd>
          </div>
          <div>
            <dt>Runtime</dt>
            <dd>Luna · Max</dd>
          </div>
        </dl>
      </header>
      <div className={styles.corpusPolicy}>
        <span>Fast off</span>
        <span>Pro off</span>
        <span>Deputy prohibited</span>
        <span>Hard ceiling {corpus.runtimePolicy.maximumExecutions}</span>
        <span>{corpus.matchingVisibleCount} visible matches</span>
      </div>
      <div className={styles.corpusCases} role="list">
        {corpus.cases.map((item) => (
          <article key={item.id} role="listitem">
            <header>
              <strong>{item.id}</strong>
              <span data-state={item.expectedTerminalState}>
                {humanize(item.expectedTerminalState)}
              </span>
            </header>
            <p>{item.ask}</p>
            <small>
              {humanize(item.source)} · {humanize(item.difficulty)} ·{" "}
              {humanize(item.questionClass)}
              {item.expectedOperator
                ? ` · ${humanize(item.expectedOperator)}`
                : ""}
            </small>
          </article>
        ))}
      </div>
    </section>
  );
}

function Catalogue({
  section,
  items,
  selected,
  onSelect,
  contextValues,
}: {
  section: Section;
  items: AdminItem[];
  selected: AdminItem | null;
  onSelect: (item: AdminItem) => void;
  contextValues: SemanticAdminPayload["persistence"]["contextValues"];
}) {
  const rowHeight = 58;
  const [scrollTop, setScrollTop] = useState(0);
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - 5);
  const end = Math.min(
    items.length,
    Math.ceil((scrollTop + 760) / rowHeight) + 5,
  );
  const visibleItems = items.slice(start, end);
  const contextValue = selected?.id
    ? contextValues.find(({ context_key }) => context_key === selected.id)
    : undefined;
  const profileResolution =
    selected?.profileResolution &&
    typeof selected.profileResolution === "object" &&
    !Array.isArray(selected.profileResolution)
      ? (selected.profileResolution as RelationshipProfileResolution)
      : null;
  return (
    <div className={styles.catalogueLayout}>
      <div
        className={styles.catalogueList}
        role="list"
        aria-label={`${humanize(section)} catalogue`}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
      >
        <div
          className={styles.virtualRows}
          style={{ height: items.length * rowHeight }}
        >
          {visibleItems.map((item, index) => (
            <button
              type="button"
              role="listitem"
              key={String(item.id)}
              style={{ top: (start + index) * rowHeight }}
              aria-current={selected?.id === item.id ? "true" : undefined}
              onClick={() => onSelect(item)}
            >
              <span
                className={styles.stateDot}
                data-state={String(
                  item.semanticState ?? item.disposition ?? "unresolved",
                )}
              />
              <span>
                <strong>{String(item.label ?? item.id)}</strong>
                <small>{itemMeta(item, section)}</small>
              </span>
              <code>{String(item.id)}</code>
            </button>
          ))}
        </div>
      </div>
      <aside className={styles.inspector} aria-live="polite">
        {selected ? (
          <>
            <span>{humanize(section)}</span>
            <h3>{String(selected.label ?? selected.id)}</h3>
            <code>{String(selected.id)}</code>
            <p>
              {String(
                selected.description ??
                  selected.reason ??
                  "No description has been authored.",
              )}
            </p>
            {profileResolution ? (
              <div className={styles.contextValue}>
                <strong>Latest authenticated live profile</strong>
                <code>
                  {humanize(profileResolution.status)} ·{" "}
                  {compactHash(profileResolution.profileReceiptHash)}
                </code>
                <p>{profileResolution.reason}</p>
                {profileResolution.targets.slice(0, 8).map((target) => (
                  <dl key={`${target.targetViewId}:${target.targetFieldId}`}>
                    <div>
                      <dt>Target</dt>
                      <dd>{target.targetViewId}</dd>
                    </div>
                    <div>
                      <dt>Sampled keys</dt>
                      <dd>{target.sampledForeignKeys}</dd>
                    </div>
                    <div>
                      <dt>Orphans</dt>
                      <dd>{target.orphanRows}</dd>
                    </div>
                    <div>
                      <dt>Maximum matches</dt>
                      <dd>{target.maximumTargetMatches}</dd>
                    </div>
                    <div>
                      <dt>Decision</dt>
                      <dd>
                        {target.safeManyToOne
                          ? "Structurally safe"
                          : "Not safe"}
                      </dd>
                    </div>
                  </dl>
                ))}
              </div>
            ) : null}
            {section === "context" ? (
              <div className={styles.contextValue}>
                <strong>Current tenant value</strong>
                {contextValue ? (
                  <>
                    <code>
                      Version {contextValue.version} ·{" "}
                      {humanize(contextValue.source)}
                    </code>
                    <pre>{JSON.stringify(contextValue.value, null, 2)}</pre>
                  </>
                ) : (
                  <p>
                    No tenant override has been recorded. System and connector
                    defaults remain in effect.
                  </p>
                )}
              </div>
            ) : null}
            <dl>
              {Object.entries(selected)
                .filter(
                  ([key, value]) =>
                    ![
                      "id",
                      "label",
                      "description",
                      "fields",
                      "sampleQuestions",
                      "reason",
                    ].includes(key) &&
                    ["string", "number", "boolean"].includes(typeof value),
                )
                .slice(0, 10)
                .map(([key, value]) => (
                  <div key={key}>
                    <dt>{humanize(key)}</dt>
                    <dd>{humanize(String(value))}</dd>
                  </div>
                ))}
            </dl>
            {Array.isArray(selected.sampleQuestions) ? (
              <div className={styles.examples}>
                <strong>Sample questions</strong>
                {selected.sampleQuestions.map((question) => (
                  <p key={String(question)}>{String(question)}</p>
                ))}
              </div>
            ) : null}
            {Array.isArray(selected.fields) ? (
              <div className={styles.fieldList}>
                <strong>Fields</strong>
                {selected.fields.slice(0, 200).map((field) => (
                  <button
                    type="button"
                    key={String(field.id)}
                    onClick={() =>
                      onSelect({
                        ...field,
                        label: String(field.name ?? field.id),
                        _objectType: "field",
                        _parentId: String(selected.id),
                      })
                    }
                  >
                    <span>
                      <b>{String(field.name)}</b>
                      <small>{String(field.dataType)}</small>
                    </span>
                    <em>{humanize(field.disposition)}</em>
                  </button>
                ))}
              </div>
            ) : null}
            {(["dimensions", "measures", "relationships"] as const).map(
              (collection) =>
                Array.isArray(selected[collection]) &&
                selected[collection].length ? (
                  <div className={styles.fieldList} key={collection}>
                    <strong>{humanize(collection)}</strong>
                    {(selected[collection] as AdminItem[])
                      .slice(0, 200)
                      .map((item) => (
                        <button
                          type="button"
                          key={String(item.id)}
                          onClick={() => onSelect(item)}
                        >
                          <span>
                            <b>{String(item.label ?? item.id)}</b>
                            <small>
                              {String(
                                item.description ??
                                  item.cardinality ??
                                  "Governed semantic object",
                              )}
                            </small>
                          </span>
                          <em>{humanize(item.semanticState)}</em>
                        </button>
                      ))}
                  </div>
                ) : null,
            )}
          </>
        ) : (
          <div className={styles.inspectorEmpty}>
            <strong>Choose an object</strong>
            <p>
              Inspect its grain, evidence, dependencies and authoring state.
            </p>
          </div>
        )}
      </aside>
    </div>
  );
}

export default function SemanticAdminWorkspace({
  refreshToken = 0,
}: {
  refreshToken?: number;
}) {
  const initialSection =
    typeof window === "undefined"
      ? "overview"
      : ((new URL(window.location.href).searchParams.get(
          "semanticSection",
        ) as Section | null) ?? "overview");
  const [section, setSection] = useState<Section>(
    SECTIONS.some(([key]) => key === initialSection)
      ? initialSection
      : "overview",
  );
  const [query, setQuery] = useState(() =>
    typeof window === "undefined"
      ? ""
      : (new URL(window.location.href).searchParams.get("semanticQ") ?? ""),
  );
  const [offset, setOffset] = useState(() =>
    typeof window === "undefined"
      ? 0
      : Math.max(
          0,
          Number.parseInt(
            new URL(window.location.href).searchParams.get("semanticOffset") ??
              "0",
            10,
          ) || 0,
        ),
  );
  const [payload, setPayload] = useState<SemanticAdminPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<AdminItem | null>(null);
  const [draft, setDraft] = useState<DraftRef | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [draftName, setDraftName] = useState("Semantic model update");
  const [editing, setEditing] = useState(false);
  const [editContract, setEditContract] = useState("{}");
  const [editingMeasure, setEditingMeasure] = useState(false);
  const [measureDraft, setMeasureDraft] = useState<MeasureDraft | null>(null);
  const [editingTopic, setEditingTopic] = useState(false);
  const [topicDraft, setTopicDraft] = useState<TopicDraft | null>(null);
  const [promotingRelationship, setPromotingRelationship] = useState(false);
  const [relationshipPromotionJson, setRelationshipPromotionJson] =
    useState("{}");
  const [rejectingRelationship, setRejectingRelationship] = useState(false);
  const [relationshipRejectionJson, setRelationshipRejectionJson] =
    useState("{}");
  const [registeringProfile, setRegisteringProfile] = useState(false);
  const [profileReceiptJson, setProfileReceiptJson] = useState("{}");
  const [batchReviewingRelationships, setBatchReviewingRelationships] =
    useState(false);
  const [relationshipBatchJson, setRelationshipBatchJson] = useState(
    JSON.stringify({ decisions: [] }, null, 2),
  );
  const [showContextValue, setShowContextValue] = useState(false);
  const [contextValueJson, setContextValueJson] = useState("null");
  const [contextSource, setContextSource] = useState<
    "operator" | "tenant_confirmation"
  >("operator");
  const [testQuestion, setTestQuestion] = useState("");
  const [testPreview, setTestPreview] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [saving, setSaving] = useState(false);
  const tabRow = useRef<HTMLDivElement | null>(null);
  const tabRefs = useRef<Partial<Record<Section, HTMLButtonElement | null>>>(
    {},
  );
  const [indicator, setIndicator] = useState({ left: 0, width: 0 });
  const draftId = draft?.id;
  const draftRevision = draft?.revision;
  const selectedId = typeof selected?.id === "string" ? selected.id : null;

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const parameters = new URLSearchParams({
        section,
        q: query,
        offset: String(offset),
        limit: "100",
      });
      if (draftId && draftRevision) {
        parameters.set("draftId", draftId);
        parameters.set("draftRevision", String(draftRevision));
      }
      if (["measures", "topics"].includes(section) && selectedId)
        parameters.set("objectId", selectedId);
      const response = await fetch(`/api/admin/semantic?${parameters}`, {
        cache: "no-store",
      });
      const next = (await response.json()) as SemanticAdminPayload;
      if (!response.ok)
        throw new Error(
          next.error || "Semantic administration could not be loaded.",
        );
      setPayload(next);
      setSelected(
        (current) => next.items?.find(({ id }) => id === current?.id) ?? null,
      );
      if (draftId) {
        const current = next.persistence.drafts.find(
          ({ draft_id }) => draftId === draft_id,
        );
        if (current)
          setDraft({
            id: current.draft_id,
            revision: current.revision,
            name: current.name,
          });
      }
    } catch (loadError) {
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Semantic administration could not be loaded.",
      );
    } finally {
      setLoading(false);
    }
  }, [section, query, offset, draftId, draftRevision, selectedId]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 180);
    return () => window.clearTimeout(timer);
  }, [load, refreshToken]);
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("semanticSection", section);
    if (query) url.searchParams.set("semanticQ", query);
    else url.searchParams.delete("semanticQ");
    if (offset) url.searchParams.set("semanticOffset", String(offset));
    else url.searchParams.delete("semanticOffset");
    window.history.replaceState(window.history.state, "", url);
  }, [section, query, offset]);
  useLayoutEffect(() => {
    const row = tabRow.current;
    const button = tabRefs.current[section];
    if (!row || !button) return;
    const rowBox = row.getBoundingClientRect();
    const buttonBox = button.getBoundingClientRect();
    setIndicator({
      left: buttonBox.left - rowBox.left + row.scrollLeft,
      width: buttonBox.width,
    });
  }, [section, payload]);

  const items = useMemo(() => payload?.items ?? [], [payload]);
  const createDraft = async () => {
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/admin/semantic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create_draft", name: draftName }),
      });
      const result = (await response.json()) as {
        draft?: { draftId: string; revision: number };
        error?: string;
      };
      if (!response.ok || !result.draft)
        throw new Error(
          result.error || "The semantic draft could not be created.",
        );
      setDraft({
        id: result.draft.draftId,
        revision: result.draft.revision,
        name: draftName,
      });
      setShowCreate(false);
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "The semantic draft could not be created.",
      );
    } finally {
      setSaving(false);
    }
  };
  const saveEdit = async () => {
    const type = itemType(section, selected);
    if (!selected?.id || !draft || !type) return;
    setSaving(true);
    setError("");
    try {
      const parsedContract = JSON.parse(editContract) as unknown;
      if (
        !parsedContract ||
        typeof parsedContract !== "object" ||
        Array.isArray(parsedContract)
      )
        throw new Error("The editable contract must be a JSON object.");
      const response = await fetch("/api/admin/semantic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_object",
          draftId: draft.id,
          expectedRevision: draft.revision,
          objectType: type,
          objectId: selected.id,
          ...(selected._parentId ? { parentId: selected._parentId } : {}),
          changes: parsedContract,
          changeSummary: `Updated ${selected.id} from the semantic admin.`,
        }),
      });
      const result = (await response.json()) as {
        draft?: { revision: number };
        error?: string;
      };
      if (!response.ok || !result.draft)
        throw new Error(
          result.error || "The semantic edit could not be saved.",
        );
      setDraft({ ...draft, revision: result.draft.revision });
      setEditing(false);
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "The semantic edit could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  };
  const saveMeasure = async () => {
    if (!selected?.id || !draft || !measureDraft) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/admin/semantic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_object",
          draftId: draft.id,
          expectedRevision: draft.revision,
          objectType: "measure",
          objectId: selected.id,
          changes: measureDraftChanges(measureDraft),
          changeSummary: `Updated ${selected.id} with the governed measure builder.`,
        }),
      });
      const result = (await response.json()) as {
        draft?: { revision: number };
        error?: string;
      };
      if (!response.ok || !result.draft)
        throw new Error(
          result.error || "The governed measure revision could not be saved.",
        );
      setDraft({ ...draft, revision: result.draft.revision });
      setEditingMeasure(false);
      setMeasureDraft(null);
      setError(
        `${String(selected.id)} saved in draft revision ${result.draft.revision}. Publication validation and risk-tier review remain required.`,
      );
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "The governed measure revision could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  };
  const saveTopic = async () => {
    if (!selected?.id || !draft || !topicDraft) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/admin/semantic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "update_object",
          draftId: draft.id,
          expectedRevision: draft.revision,
          objectType: "topic",
          objectId: selected.id,
          changes: topicDraftChanges(topicDraft),
          changeSummary: `Updated ${selected.id} with the governed Topic builder.`,
        }),
      });
      const result = (await response.json()) as {
        draft?: { revision: number };
        error?: string;
      };
      if (!response.ok || !result.draft)
        throw new Error(
          result.error || "The governed Topic revision could not be saved.",
        );
      setDraft({ ...draft, revision: result.draft.revision });
      setEditingTopic(false);
      setTopicDraft(null);
      setError(
        `${String(selected.id)} saved in draft revision ${result.draft.revision}. Publication validation and review remain required.`,
      );
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "The governed Topic revision could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  };
  const promoteRelationship = async () => {
    if (!selected?.id || !draft) return;
    setSaving(true);
    setError("");
    try {
      const contract = JSON.parse(relationshipPromotionJson) as unknown;
      if (!contract || typeof contract !== "object" || Array.isArray(contract))
        throw new Error("The promotion contract must be a JSON object.");
      const response = await fetch("/api/admin/semantic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "promote_relationship_candidate",
          draftId: draft.id,
          expectedRevision: draft.revision,
          candidateId: selected.id,
          ...contract,
        }),
      });
      const result = (await response.json()) as {
        draft?: { revision: number };
        relationshipId?: string;
        error?: string;
      };
      if (!response.ok || !result.draft)
        throw new Error(
          result.error || "The relationship candidate could not be promoted.",
        );
      setDraft({ ...draft, revision: result.draft.revision });
      setPromotingRelationship(false);
      setError(
        `${result.relationshipId ?? selected.id} added to the draft as Exploratory pending review.`,
      );
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "The relationship candidate could not be promoted.",
      );
    } finally {
      setSaving(false);
    }
  };
  const rejectRelationship = async () => {
    if (!selected?.id || !draft) return;
    setSaving(true);
    setError("");
    try {
      const contract = JSON.parse(relationshipRejectionJson) as unknown;
      if (!contract || typeof contract !== "object" || Array.isArray(contract))
        throw new Error("The rejection contract must be a JSON object.");
      const response = await fetch("/api/admin/semantic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "reject_relationship_candidate",
          draftId: draft.id,
          expectedRevision: draft.revision,
          candidateId: selected.id,
          ...contract,
        }),
      });
      const result = (await response.json()) as {
        draft?: { revision: number };
        candidateId?: string;
        error?: string;
      };
      if (!response.ok || !result.draft)
        throw new Error(
          result.error || "The relationship candidate could not be rejected.",
        );
      setDraft({ ...draft, revision: result.draft.revision });
      setRejectingRelationship(false);
      setError(
        `${result.candidateId ?? selected.id} was rejected with an immutable operator-review reference.`,
      );
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "The relationship candidate could not be rejected.",
      );
    } finally {
      setSaving(false);
    }
  };
  const registerProfileReceipt = async () => {
    setSaving(true);
    setError("");
    try {
      const receipt = JSON.parse(profileReceiptJson) as unknown;
      const response = await fetch("/api/admin/semantic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "register_profile_receipt", receipt }),
      });
      const result = (await response.json()) as {
        profileReceipt?: { profileReceiptHash: string; status: string };
        error?: string;
      };
      if (!response.ok || !result.profileReceipt)
        throw new Error(
          result.error || "The profiling receipt could not be registered.",
        );
      setRegisteringProfile(false);
      setError(
        `Immutable profile ${compactHash(result.profileReceipt.profileReceiptHash)} registered with status ${result.profileReceipt.status}.`,
      );
      await load();
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "The profiling receipt could not be registered.",
      );
    } finally {
      setSaving(false);
    }
  };
  const applyRelationshipDecisionBatch = async () => {
    if (!draft) return;
    setSaving(true);
    setError("");
    try {
      const contract = JSON.parse(relationshipBatchJson) as unknown;
      if (!contract || typeof contract !== "object" || Array.isArray(contract))
        throw new Error("The batch contract must be a JSON object.");
      const decisions = (contract as { decisions?: unknown }).decisions;
      if (!Array.isArray(decisions) || decisions.length < 1)
        throw new Error("Add at least one relationship decision.");
      const response = await fetch("/api/admin/semantic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "batch_relationship_decisions",
          draftId: draft.id,
          expectedRevision: draft.revision,
          decisions,
        }),
      });
      const result = (await response.json()) as {
        draft?: { revision: number };
        batch?: {
          promoted: Array<{ candidateId: string; relationshipId: string }>;
          rejected: string[];
          count: number;
        };
        error?: string;
      };
      if (!response.ok || !result.draft || !result.batch)
        throw new Error(
          result.error || "The relationship review batch could not be applied.",
        );
      setDraft({ ...draft, revision: result.draft.revision });
      setBatchReviewingRelationships(false);
      setError(
        `Applied ${result.batch.count} relationship decisions in one revision: ${result.batch.promoted.length} promoted and ${result.batch.rejected.length} rejected.`,
      );
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "The relationship review batch could not be applied.",
      );
    } finally {
      setSaving(false);
    }
  };
  const saveContextValue = async () => {
    if (!selected?.id || section !== "context" || !payload) return;
    setSaving(true);
    setError("");
    try {
      const current = payload.persistence.contextValues.find(
        ({ context_key }) => context_key === selected.id,
      );
      const value = JSON.parse(contextValueJson) as unknown;
      const response = await fetch("/api/admin/semantic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "set_business_context_value",
          contextKey: selected.id,
          expectedVersion: current?.version ?? 0,
          value,
          source: contextSource,
          evidence: [{ kind: "admin_edit", definitionId: selected.id }],
        }),
      });
      const result = (await response.json()) as {
        businessContext?: { version: number };
        error?: string;
      };
      if (!response.ok || !result.businessContext)
        throw new Error(
          result.error || "The business-context value could not be saved.",
        );
      setShowContextValue(false);
      setError(
        `${selected.id} saved as version ${result.businessContext.version}. New workspaces will pin the resulting context snapshot.`,
      );
      await load();
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "The business-context value could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  };
  const previewTopic = async () => {
    if (!selected?.id || section !== "test_lab" || !testQuestion.trim()) return;
    setSaving(true);
    setError("");
    setTestPreview(null);
    try {
      const response = await fetch("/api/admin/semantic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "preview_topic_context",
          topicId: selected.id,
          question: testQuestion,
          ...(draft
            ? { draftId: draft.id, expectedRevision: draft.revision }
            : {}),
        }),
      });
      const result = (await response.json()) as {
        preview?: Record<string, unknown>;
        error?: string;
      };
      if (!response.ok || !result.preview)
        throw new Error(
          result.error || "The Topic context could not be previewed.",
        );
      setTestPreview(result.preview);
    } catch (previewError) {
      setError(
        previewError instanceof Error
          ? previewError.message
          : "The Topic context could not be previewed.",
      );
    } finally {
      setSaving(false);
    }
  };
  const validateDraft = async () => {
    if (!draft) return;
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/admin/semantic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "validate_draft",
          draftId: draft.id,
          expectedRevision: draft.revision,
        }),
      });
      const result = (await response.json()) as {
        validation?: {
          status: string;
          issues: unknown[];
          publicationHash: string | null;
        };
        error?: string;
      };
      if (!response.ok || !result.validation)
        throw new Error(
          result.error || "The semantic draft could not be validated.",
        );
      setError(
        result.validation.status === "passed"
          ? `Validation passed. Candidate publication ${compactHash(result.validation.publicationHash ?? "")}. Deterministic qualification and review are still required.`
          : `Validation found ${result.validation.issues.length} blocking issues.`,
      );
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "The semantic draft could not be validated.",
      );
    } finally {
      setSaving(false);
    }
  };
  const reviewSelected = async () => {
    const type = itemType(section, selected);
    const isSensitiveField =
      type === "field" &&
      (selected?.pii === true ||
        selected?.disposition === "sensitive_metadata");
    const hasCertifiableState = ["verified", "derived"].includes(
      String(selected?.semanticState),
    );
    const isGovernedMeasureOrRelationship =
      ["measure", "relationship"].includes(String(type)) && hasCertifiableState;
    const isCompositeTopic =
      type === "topic" &&
      selected?.layer === "composite" &&
      hasCertifiableState;
    if (
      !draft ||
      !selected?.id ||
      !(isGovernedMeasureOrRelationship || isSensitiveField || isCompositeTopic)
    )
      return;
    setSaving(true);
    setError("");
    try {
      const riskTier =
        type === "relationship" || isSensitiveField || isCompositeTopic
          ? "tier_1"
          : ["tier_1", "tier_2", "tier_3"].includes(String(selected.riskTier))
            ? selected.riskTier
            : "tier_3";
      const response = await fetch("/api/admin/semantic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "review_object",
          draftId: draft.id,
          expectedRevision: draft.revision,
          objectId: selected.id,
          riskTier,
          disposition: riskTier === "tier_3" ? "sampled" : "approved",
          notes: "Reviewed in the semantic admin.",
        }),
      });
      const result = (await response.json()) as {
        review?: unknown;
        error?: string;
      };
      if (!response.ok || !result.review)
        throw new Error(
          result.error || "The semantic review could not be recorded.",
        );
      setError(
        `${String(selected.id)} review recorded. Tier 1 objects still require a second independent reviewer.`,
      );
      await load();
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "The semantic review could not be recorded.",
      );
    } finally {
      setSaving(false);
    }
  };
  const publishDraft = async () => {
    if (!draft || !payload) return;
    const validation = payload.persistence.validations.find(
      (item) =>
        item.draft_id === draft.id &&
        item.draft_revision === draft.revision &&
        item.status === "passed",
    );
    if (!validation) {
      setError("Validate this exact draft revision before publishing.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/admin/semantic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "publish_draft",
          draftId: draft.id,
          expectedRevision: draft.revision,
          validationId: validation.validation_id,
        }),
      });
      const result = (await response.json()) as {
        publication?: { publicationHash: string };
        error?: string;
      };
      if (!response.ok || !result.publication)
        throw new Error(
          result.error || "The semantic publication could not be created.",
        );
      setError(
        `Immutable publication ${compactHash(result.publication.publicationHash)} created. Activation remains blocked until release qualification passes.`,
      );
      await load();
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "The semantic publication could not be created.",
      );
    } finally {
      setSaving(false);
    }
  };
  const publicationAction = async (
    action: "activate_publication" | "rollback_publication",
    publicationHash?: string,
  ) => {
    setSaving(true);
    setError("");
    try {
      const response = await fetch("/api/admin/semantic", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          ...(publicationHash ? { publicationHash } : {}),
        }),
      });
      const result = (await response.json()) as {
        activation?: { publicationHash: string };
        error?: string;
      };
      if (!response.ok || !result.activation)
        throw new Error(
          result.error || "The publication pointer could not be changed.",
        );
      setError(
        `${action === "rollback_publication" ? "Rolled back" : "Activated"} publication ${compactHash(result.activation.publicationHash)}.`,
      );
      await load();
    } catch (saveError) {
      setError(
        saveError instanceof Error
          ? saveError.message
          : "The publication pointer could not be changed.",
      );
    } finally {
      setSaving(false);
    }
  };

  const selectedType = itemType(section, selected);
  const selectedRequiresReview =
    (["measure", "relationship"].includes(String(selectedType)) &&
      ["verified", "derived"].includes(String(selected?.semanticState))) ||
    (selectedType === "field" &&
      (selected?.pii === true ||
        selected?.disposition === "sensitive_metadata")) ||
    (selectedType === "topic" &&
      selected?.layer === "composite" &&
      ["verified", "derived"].includes(String(selected?.semanticState)));
  const selectedProfileResolution =
    selected?.profileResolution &&
    typeof selected.profileResolution === "object" &&
    !Array.isArray(selected.profileResolution)
      ? (selected.profileResolution as RelationshipProfileResolution)
      : null;
  const relationshipProposal = selectedProfileResolution?.proposal;

  return (
    <section
      className={styles.workspace}
      aria-label="Semantic layer administration"
    >
      <div className={styles.actionBar}>
        <div>
          <strong>Semantic Registry V2</strong>
          <code>
            {payload
              ? compactHash(payload.overview.publicationHash)
              : "Loading…"}
          </code>
        </div>
        <div>
          {payload?.persistence.drafts.length ? (
            <select
              aria-label="Active semantic draft"
              value={draft?.id ?? ""}
              onChange={(event) => {
                const item = payload.persistence.drafts.find(
                  ({ draft_id }) => draft_id === event.target.value,
                );
                setDraft(
                  item
                    ? {
                        id: item.draft_id,
                        revision: item.revision,
                        name: item.name,
                      }
                    : null,
                );
              }}
            >
              <option value="">Published view</option>
              {payload.persistence.drafts.map((item) => (
                <option value={item.draft_id} key={item.draft_id}>
                  {item.name} · r{item.revision}
                </option>
              ))}
            </select>
          ) : null}
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            disabled={!payload?.persistence.available || saving}
          >
            Create draft
          </button>
          <button
            type="button"
            className={styles.primaryAction}
            onClick={() => void validateDraft()}
            disabled={!draft || saving}
          >
            {saving ? "Working…" : "Validate draft"}
          </button>
          <button
            type="button"
            onClick={() => void publishDraft()}
            disabled={!draft || saving}
          >
            Publish
          </button>
        </div>
      </div>
      <nav className={styles.tabs} aria-label="Semantic administration views">
        <div ref={tabRow}>
          {SECTIONS.map(([key, label]) => (
            <button
              type="button"
              key={key}
              ref={(node) => {
                tabRefs.current[key] = node;
              }}
              aria-current={section === key ? "page" : undefined}
              onClick={() => {
                setSection(key);
                setOffset(0);
                setSelected(null);
                setTestPreview(null);
              }}
            >
              {label}
            </button>
          ))}
          <span
            style={{ left: indicator.left, width: indicator.width }}
            aria-hidden="true"
          />
        </div>
      </nav>
      {!["overview", "health", "publications"].includes(section) ? (
        <div className={styles.filters}>
          <label>
            <span className="sr-only">Search semantic objects</span>
            <input
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setOffset(0);
              }}
              placeholder={`Search ${humanize(section).toLowerCase()}…`}
            />
          </label>
          <small>
            {payload?.total ?? 0} objects · filters are kept in the URL
          </small>
          {["relationships", "inbox"].includes(section) &&
          payload?.persistence.available ? (
            <button
              type="button"
              onClick={() => {
                setProfileReceiptJson("{}");
                setRegisteringProfile(true);
              }}
            >
              Register profile receipt
            </button>
          ) : null}
          {["relationships", "inbox"].includes(section) && draft ? (
            <button
              type="button"
              onClick={() => {
                setRelationshipBatchJson(
                  JSON.stringify({ decisions: [] }, null, 2),
                );
                setBatchReviewingRelationships(true);
              }}
            >
              Apply reviewed decisions
            </button>
          ) : null}
          {selected &&
          draft &&
          selectedType &&
          selectedType !== "relationshipCandidate" &&
          !(section === "measures" && selectedType === "measure") &&
          !(section === "topics" && selectedType === "topic") ? (
            <button
              type="button"
              onClick={() => {
                setEditContract(
                  JSON.stringify(editableContract(section, selected), null, 2),
                );
                setEditing(true);
              }}
            >
              Edit contract
            </button>
          ) : null}
          {selected &&
          draft &&
          section === "topics" &&
          selectedType === "topic" ? (
            <button
              type="button"
              disabled={
                saving ||
                payload?.topicAuthoringContext?.topicId !== selected.id
              }
              onClick={() => {
                setTopicDraft(createTopicDraft(selected));
                setEditingTopic(true);
              }}
            >
              {payload?.topicAuthoringContext?.topicId === selected.id
                ? "Open Topic builder"
                : "Loading Topic context…"}
            </button>
          ) : null}
          {selected &&
          draft &&
          section === "measures" &&
          selectedType === "measure" ? (
            <button
              type="button"
              disabled={
                saving || payload?.authoringContext?.measureId !== selected.id
              }
              onClick={() => {
                setMeasureDraft(createMeasureDraft(selected));
                setEditingMeasure(true);
              }}
            >
              {payload?.authoringContext?.measureId === selected.id
                ? "Open measure builder"
                : "Loading measure context…"}
            </button>
          ) : null}
          {selected &&
          draft &&
          selectedType === "relationshipCandidate" &&
          selected.disposition === "unresolved" ? (
            <button
              type="button"
              onClick={() => {
                setRelationshipRejectionJson(
                  JSON.stringify(
                    {
                      reason:
                        "Domain review determined that this field does not reference a governed target at a safe, reusable analytical grain.",
                      evidence: [
                        "Reviewed the governed source contract and candidate target semantics.",
                      ],
                    },
                    null,
                    2,
                  ),
                );
                setRejectingRelationship(true);
              }}
            >
              Reject candidate
            </button>
          ) : null}
          {selected &&
          draft &&
          selectedType === "relationshipCandidate" &&
          selected.disposition === "unresolved" &&
          selectedProfileResolution?.status === "promote_review_candidate" &&
          relationshipProposal ? (
            <button
              type="button"
              onClick={() => {
                setRelationshipPromotionJson(
                  JSON.stringify(
                    {
                      ...relationshipProposal,
                      profileReceiptHash:
                        selectedProfileResolution.profileReceiptHash,
                    },
                    null,
                    2,
                  ),
                );
                setPromotingRelationship(true);
              }}
            >
              Promote profiled join
            </button>
          ) : null}
          {selected && section === "context" ? (
            <button
              type="button"
              onClick={() => {
                const current = payload?.persistence.contextValues.find(
                  ({ context_key }) => context_key === selected.id,
                );
                setContextValueJson(
                  JSON.stringify(current?.value ?? null, null, 2),
                );
                setShowContextValue(true);
              }}
            >
              Set tenant value
            </button>
          ) : null}
          {selected && draft && selectedRequiresReview ? (
            <button
              type="button"
              onClick={() => void reviewSelected()}
              disabled={saving}
            >
              Record review
            </button>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <div className={styles.notice} role="status">
          {error}
        </div>
      ) : null}
      {loading && !payload ? (
        <div className={styles.loading} role="status">
          <span />
          Loading the semantic graph…
        </div>
      ) : null}
      {payload && section === "overview" ? (
        <Overview payload={payload} />
      ) : null}
      {payload && section === "health" ? (
        <SemanticHealth payload={payload} />
      ) : null}
      {payload && section === "publications" ? (
        <div className={styles.healthPanel}>
          <h3>Publications and rollback</h3>
          <p>
            Publications are immutable content-addressed artifacts. Activation
            changes one pointer and requires an exact release-qualification
            receipt; rollback restores the prior pointer.
          </p>
          <dl>
            <div>
              <dt>Generated candidate</dt>
              <dd>
                <code>{compactHash(payload.overview.publicationHash)}</code>
              </dd>
            </div>
            <div>
              <dt>Active artifact</dt>
              <dd>
                {payload.persistence.active ? (
                  <code>
                    {compactHash(payload.persistence.active.publication_hash)}
                  </code>
                ) : (
                  "Not activated"
                )}
              </dd>
            </div>
            <div>
              <dt>Immutable publications</dt>
              <dd>{payload.persistence.publications.length}</dd>
            </div>
          </dl>
          {draft && payload.draftDiff ? (
            <section
              className={styles.diffPanel}
              aria-label="Object-aware semantic draft diff"
            >
              <header>
                <span>
                  <b>Draft r{draft.revision}</b>
                  <small>
                    Object-aware diff ·{" "}
                    {compactHash(payload.draftDiff.diffHash)}
                  </small>
                </span>
                <code>
                  {compactHash(payload.draftDiff.baseManifestHash)} →{" "}
                  {compactHash(payload.draftDiff.candidateManifestHash)}
                </code>
              </header>
              <dl className={styles.diffSummary}>
                <div>
                  <dt>Added</dt>
                  <dd>{payload.draftDiff.summary.added}</dd>
                </div>
                <div>
                  <dt>Removed</dt>
                  <dd>{payload.draftDiff.summary.removed}</dd>
                </div>
                <div>
                  <dt>Changed</dt>
                  <dd>{payload.draftDiff.summary.changed}</dd>
                </div>
                <div data-severity="high">
                  <dt>Tier 1 impact</dt>
                  <dd>{payload.draftDiff.summary.high}</dd>
                </div>
                <div data-severity="medium">
                  <dt>Tier 2 impact</dt>
                  <dd>{payload.draftDiff.summary.medium}</dd>
                </div>
                <div data-severity="low">
                  <dt>Tier 3 impact</dt>
                  <dd>{payload.draftDiff.summary.low}</dd>
                </div>
              </dl>
              <div className={styles.diffRows} role="list">
                {payload.draftDiff.changes.length === 0 ? (
                  <p>This draft is identical to its immutable base.</p>
                ) : (
                  payload.draftDiff.changes.slice(0, 300).map((change) => (
                    <article
                      key={`${change.objectType}:${change.objectId}`}
                      role="listitem"
                      data-severity={change.severity}
                    >
                      <span
                        className={styles.stateDot}
                        data-state={
                          change.severity === "high"
                            ? "unsupported"
                            : change.severity === "medium"
                              ? "exploratory"
                              : "derived"
                        }
                      />
                      <span>
                        <b>{change.objectId}</b>
                        <small>
                          {humanize(change.objectType)} ·{" "}
                          {humanize(change.operation)}
                          {change.changedFields.length
                            ? ` · ${change.changedFields.join(", ")}`
                            : ""}
                        </small>
                      </span>
                      <em>{humanize(change.requiredReviewTier)}</em>
                      <p>{change.reason}</p>
                    </article>
                  ))
                )}
              </div>
            </section>
          ) : null}
          <div className={styles.publicationRows}>
            {payload.persistence.publications.map((item) => {
              const qualified = payload.persistence.qualifications.some(
                (qualification) =>
                  qualification.publication_hash === item.publication_hash &&
                  qualification.status === "passed",
              );
              const active =
                payload.persistence.active?.publication_hash ===
                item.publication_hash;
              return (
                <div key={item.publication_hash}>
                  <span>
                    <code>{compactHash(item.publication_hash)}</code>
                    <small>
                      {item.registry_version} · draft r
                      {item.source_draft_revision}
                    </small>
                  </span>
                  <span
                    className={styles.badge}
                    data-state={qualified ? "derived" : "warning"}
                  >
                    {qualified ? "Qualified" : "Qualification required"}
                  </span>
                  <button
                    type="button"
                    disabled={saving || active || !qualified}
                    onClick={() =>
                      void publicationAction(
                        "activate_publication",
                        item.publication_hash,
                      )
                    }
                  >
                    {active ? "Active" : "Activate"}
                  </button>
                </div>
              );
            })}
            {payload.persistence.active?.previous_publication_hash ? (
              <button
                type="button"
                className={styles.rollbackAction}
                disabled={saving}
                onClick={() => void publicationAction("rollback_publication")}
              >
                Roll back to{" "}
                {compactHash(
                  payload.persistence.active.previous_publication_hash,
                )}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      {payload && section === "test_lab" ? (
        <section className={styles.testLab} aria-label="Topic context test lab">
          <div>
            <span>DETERMINISTIC PREVIEW</span>
            <h3>Inspect model context and compiled plan</h3>
            <p>
              This checks Topic routing, a server-generated candidate block,
              and sanitized deterministic compiler output without invoking Luna
              or consuming the 200-question evaluation budget.
            </p>
          </div>
          <label>
            <span>Question</span>
            <textarea
              value={testQuestion}
              onChange={(event) => setTestQuestion(event.target.value)}
              placeholder="For example: What caused gross profit to fall last month?"
              rows={3}
            />
          </label>
          <button
            type="button"
            disabled={!selected || !testQuestion.trim() || saving}
            onClick={() => void previewTopic()}
          >
            {saving
              ? "Preparing…"
              : selected
                ? `Preview ${String(selected.label ?? selected.id)}`
                : "Choose a Topic below"}
          </button>
          {testPreview ? (
            <pre>{JSON.stringify(testPreview, null, 2)}</pre>
          ) : null}
        </section>
      ) : null}
      {payload && section === "test_lab" ? (
        <EvaluationCorpus payload={payload} />
      ) : null}
      {payload && section === "relationships" && payload.relationshipGraph ? (
        <SemanticRelationshipGraph
          graph={payload.relationshipGraph}
          selectedObjectId={typeof selected?.id === "string" ? selected.id : null}
          onSelectObject={setSelected}
        />
      ) : null}
      {payload && !["overview", "health", "publications"].includes(section) ? (
        <>
          <Catalogue
            section={section}
            items={items}
            selected={selected}
            onSelect={setSelected}
            contextValues={payload.persistence.contextValues}
          />
          {(payload.total ?? 0) > (payload.limit ?? 100) ? (
            <nav
              className={styles.pagination}
              aria-label={`${humanize(section)} pages`}
            >
              <button
                type="button"
                disabled={offset === 0}
                onClick={() =>
                  setOffset(Math.max(0, offset - (payload.limit ?? 100)))
                }
              >
                Previous
              </button>
              <span>
                {offset + 1}–
                {Math.min(offset + items.length, payload.total ?? 0)} of{" "}
                {payload.total}
              </span>
              <button
                type="button"
                disabled={offset + items.length >= (payload.total ?? 0)}
                onClick={() => setOffset(offset + (payload.limit ?? 100))}
              >
                Next
              </button>
            </nav>
          ) : null}
        </>
      ) : null}
      {showCreate ? (
        <div
          className={styles.modalBackdrop}
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setShowCreate(false);
          }}
        >
          <section
            className={styles.modal}
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-semantic-draft"
          >
            <span>DRAFT WORKFLOW</span>
            <h3 id="create-semantic-draft">Create from active publication</h3>
            <p>
              Edits autosave into immutable revisions. Nothing changes the
              active semantic model until validation, review, publication and
              activation all succeed.
            </p>
            <label>
              Draft name
              <input
                autoFocus
                value={draftName}
                onChange={(event) => setDraftName(event.target.value)}
              />
            </label>
            <div>
              <button type="button" onClick={() => setShowCreate(false)}>
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void createDraft()}
                disabled={saving || !draftName.trim()}
              >
                {saving ? "Creating…" : "Create draft"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {editing && selected ? (
        <div
          className={styles.modalBackdrop}
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setEditing(false);
          }}
        >
          <section
            className={`${styles.modal} ${styles.contractModal}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-semantic-object"
          >
            <span>REVISION {draft?.revision} · GOVERNED CONTRACT</span>
            <h3 id="edit-semantic-object">Edit {String(selected.id)}</h3>
            <p>
              Edit only the allowlisted semantic properties shown here. The full
              registry schema and graph validators run before this revision can
              be published.
            </p>
            <label>
              Semantic contract JSON
              <textarea
                autoFocus
                spellCheck={false}
                value={editContract}
                onChange={(event) => setEditContract(event.target.value)}
                rows={18}
              />
            </label>
            <div>
              <button type="button" onClick={() => setEditing(false)}>
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void saveEdit()}
                disabled={saving}
              >
                {saving ? "Saving…" : "Save revision"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {editingMeasure &&
      selected?.id &&
      measureDraft &&
      payload?.authoringContext?.measureId === selected.id ? (
        <SemanticMeasureBuilder
          measureId={selected.id}
          initialDraft={measureDraft}
          context={payload.authoringContext}
          saving={saving}
          onChange={setMeasureDraft}
          onCancel={() => {
            setEditingMeasure(false);
            setMeasureDraft(null);
          }}
          onSave={() => void saveMeasure()}
        />
      ) : null}
      {editingTopic &&
      selected?.id &&
      topicDraft &&
      payload?.topicAuthoringContext?.topicId === selected.id ? (
        <SemanticTopicBuilder
          topicId={selected.id}
          initialDraft={topicDraft}
          context={payload.topicAuthoringContext}
          saving={saving}
          onChange={setTopicDraft}
          onCancel={() => {
            setEditingTopic(false);
            setTopicDraft(null);
          }}
          onSave={() => void saveTopic()}
        />
      ) : null}
      {registeringProfile ? (
        <div
          className={styles.modalBackdrop}
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget)
              setRegisteringProfile(false);
          }}
        >
          <section
            className={`${styles.modal} ${styles.contractModal}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="register-semantic-profile"
          >
            <span>IMMUTABLE PROFILING EVIDENCE</span>
            <h3 id="register-semantic-profile">Register profiler receipt</h3>
            <p>
              Paste the complete JSON artifact produced by the read-only
              semantic profiler. The server computes its canonical hash and
              stores the receipt immutably; incomplete receipts cannot authorize
              a join.
            </p>
            <label>
              Profile receipt JSON
              <textarea
                autoFocus
                spellCheck={false}
                value={profileReceiptJson}
                onChange={(event) => setProfileReceiptJson(event.target.value)}
                rows={18}
              />
            </label>
            <div>
              <button
                type="button"
                onClick={() => setRegisteringProfile(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void registerProfileReceipt()}
                disabled={saving}
              >
                {saving ? "Registering…" : "Register immutable receipt"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {batchReviewingRelationships ? (
        <div
          className={styles.modalBackdrop}
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget)
              setBatchReviewingRelationships(false);
          }}
        >
          <section
            className={`${styles.modal} ${styles.contractModal}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="batch-review-semantic-relationships"
          >
            <span>ATOMIC RELATIONSHIP REVIEW</span>
            <h3 id="batch-review-semantic-relationships">
              Apply reviewed decisions
            </h3>
            <p>
              Apply up to 100 explicit promotions or rejections in one draft
              revision. The entire batch fails together. Every promotion still
              requires a registered, signed profile for this exact base
              publication; every rejection requires a reason and evidence.
            </p>
            <label>
              Relationship decisions JSON
              <textarea
                autoFocus
                spellCheck={false}
                value={relationshipBatchJson}
                onChange={(event) =>
                  setRelationshipBatchJson(event.target.value)
                }
                rows={18}
              />
            </label>
            <div>
              <button
                type="button"
                onClick={() => setBatchReviewingRelationships(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void applyRelationshipDecisionBatch()}
                disabled={saving}
              >
                {saving ? "Applying…" : "Apply one revision"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {promotingRelationship && selected ? (
        <div
          className={styles.modalBackdrop}
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget)
              setPromotingRelationship(false);
          }}
        >
          <section
            className={`${styles.modal} ${styles.contractModal}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="promote-semantic-relationship"
          >
            <span>LIVE PROFILE REQUIRED</span>
            <h3 id="promote-semantic-relationship">
              Promote {String(selected.id)}
            </h3>
            <p>
              Register the profiler’s complete JSON receipt first, then paste
              its returned hash here. Albert verifies the exact base
              publication, candidate, target multiplicity and orphan evidence
              before adding the join as Exploratory.
            </p>
            <label>
              Promotion contract JSON
              <textarea
                autoFocus
                spellCheck={false}
                value={relationshipPromotionJson}
                onChange={(event) =>
                  setRelationshipPromotionJson(event.target.value)
                }
                rows={16}
              />
            </label>
            <div>
              <button
                type="button"
                onClick={() => setPromotingRelationship(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void promoteRelationship()}
                disabled={saving}
              >
                {saving ? "Promoting…" : "Promote into draft"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {rejectingRelationship && selected ? (
        <div
          className={styles.modalBackdrop}
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget)
              setRejectingRelationship(false);
          }}
        >
          <section
            className={`${styles.modal} ${styles.contractModal}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="reject-semantic-relationship"
          >
            <span>EXPLICIT UNSUPPORTED JOIN</span>
            <h3 id="reject-semantic-relationship">
              Reject {String(selected.id)}
            </h3>
            <p>
              Rejection keeps this join unavailable. Record the specific domain
              reason and evidence reviewed; the server adds a privacy-preserving
              reviewer reference and preserves the decision in draft history.
            </p>
            <label>
              Rejection contract JSON
              <textarea
                autoFocus
                spellCheck={false}
                value={relationshipRejectionJson}
                onChange={(event) =>
                  setRelationshipRejectionJson(event.target.value)
                }
                rows={14}
              />
            </label>
            <div>
              <button
                type="button"
                onClick={() => setRejectingRelationship(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void rejectRelationship()}
                disabled={saving}
              >
                {saving ? "Rejecting…" : "Reject candidate"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
      {showContextValue && selected ? (
        <div
          className={styles.modalBackdrop}
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget)
              setShowContextValue(false);
          }}
        >
          <section
            className={styles.modal}
            role="dialog"
            aria-modal="true"
            aria-labelledby="edit-context-value"
          >
            <span>VERSIONED TENANT CONTEXT</span>
            <h3 id="edit-context-value">
              Set {String(selected.label ?? selected.id)}
            </h3>
            <p>
              Existing executed workspaces retain their immutable context
              snapshot. Only new workspaces use this value.
            </p>
            <label>
              Source
              <select
                value={contextSource}
                onChange={(event) =>
                  setContextSource(
                    event.target.value as "operator" | "tenant_confirmation",
                  )
                }
              >
                <option value="operator">Internal operator</option>
                <option value="tenant_confirmation">Tenant confirmation</option>
              </select>
            </label>
            <label>
              JSON value
              <textarea
                autoFocus
                spellCheck={false}
                value={contextValueJson}
                onChange={(event) => setContextValueJson(event.target.value)}
                rows={9}
              />
            </label>
            <div>
              <button type="button" onClick={() => setShowContextValue(false)}>
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void saveContextValue()}
                disabled={saving}
              >
                {saving ? "Saving…" : "Save new version"}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}
