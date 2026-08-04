"use client";

import { useState } from "react";
import styles from "../dash.module.css";

type PlanPreview = Readonly<{
  question: string;
  route: "governed" | "exploratory" | "clarification" | "unavailable";
  summary: string;
  catalogue: Readonly<{
    topics: readonly Readonly<{ id: string; label: string; description: string; answerable: boolean }>[];
    metrics: readonly Readonly<{ id: string; label: string; description: string; unit: string; base_fact: string | null }>[];
    dimensions: readonly Readonly<{ id: string; label: string; topics: readonly string[] }>[];
    source_fields: readonly Readonly<{
      id: string;
      connectorId: string;
      connectionId: string;
      sourceTable: string;
      field: string;
      definition: string;
      fieldType: string;
    }>[];
  }>;
  governed_plans: readonly Readonly<{
    topic: string;
    metrics: readonly string[];
    dimensions: readonly string[];
    facts: readonly string[];
    time: unknown;
    filters: readonly unknown[];
  }>[];
  exploratory_plans: readonly Readonly<{
    connectionId: string;
    sourceTable: string;
    fields: readonly string[];
    aggregates: readonly unknown[];
    groupBy: readonly string[];
    requestedMetricConcept?: string;
  }>[];
  capabilities_checked: readonly string[];
  missing_capabilities: readonly string[];
  used_live_semantic_service: boolean;
  generated_at: string;
}>;

const EXAMPLE_QUESTIONS = Object.freeze([
  "How are sales going this month across my bike shops?",
  "Which staff member worked the most overtime last week?",
  "How many sales used the discount reason staff purchase?",
  "What was net profit last month?",
]);

function humanize(value: string) {
  return value
    .replaceAll("_", " ")
    .replaceAll(".", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function routeLabel(route: PlanPreview["route"]) {
  if (route === "governed") return "Governed Topic path";
  if (route === "exploratory") return "Exploratory source-field path";
  if (route === "clarification") return "Would ask a clarification";
  return "Unavailable";
}

function isPlanPreview(value: unknown): value is PlanPreview {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.question === "string"
    && typeof record.route === "string"
    && typeof record.summary === "string"
    && Boolean(record.catalogue)
    && Array.isArray(record.governed_plans)
    && Array.isArray(record.exploratory_plans);
}

export default function PlanPreviewChat({
  onOpenDictionary,
}: Readonly<{
  onOpenDictionary?: (view: "topics" | "metrics" | "facts" | "dimensions", id: string) => void;
}>) {
  const [question, setQuestion] = useState(EXAMPLE_QUESTIONS[0]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<PlanPreview | null>(null);

  const runPreview = async (nextQuestion = question) => {
    const trimmed = nextQuestion.trim();
    if (!trimmed) return;
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/admin/plan-preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: trimmed }),
        cache: "no-store",
      });
      const payload = await response.json() as { preview?: unknown; error?: string };
      if (!response.ok) throw new Error(payload.error || "Plan preview could not be generated.");
      if (!isPlanPreview(payload.preview)) throw new Error("Plan preview returned an invalid response.");
      setPreview(payload.preview);
      setQuestion(trimmed);
    } catch (loadError) {
      setPreview(null);
      setError(loadError instanceof Error ? loadError.message : "Plan preview could not be generated.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className={styles.archPlanPreview} aria-labelledby="arch-plan-preview-title">
      <header>
        <div>
          <span>PLAN PREVIEW CHAT</span>
          <h3 id="arch-plan-preview-title">Ask a question. See the routing, not the answer.</h3>
          <p>
            This uses the same OpenAI agent architecture as Chat: catalogue search, definitions,
            capabilities, then a planned governed or exploratory query. Query tools are intercepted,
            so no business figures or SQL results are returned.
          </p>
        </div>
      </header>

      <div className={styles.archPlanExamples} aria-label="Example questions">
        {EXAMPLE_QUESTIONS.map((example) => (
          <button
            type="button"
            key={example}
            disabled={loading}
            onClick={() => {
              setQuestion(example);
              void runPreview(example);
            }}
          >
            {example}
          </button>
        ))}
      </div>

      <form
        className={styles.archPlanForm}
        onSubmit={(event) => {
          event.preventDefault();
          void runPreview();
        }}
      >
        <label>
          <span>Your question</span>
          <textarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            rows={3}
            maxLength={2000}
            placeholder="Ask anything you would ask Albert…"
            disabled={loading}
          />
        </label>
        <button type="submit" disabled={loading || !question.trim()}>
          {loading ? "Planning…" : "Show what Albert would use"}
        </button>
      </form>

      {error ? (
        <div className={styles.opsError} role="alert">
          <strong>Plan preview unavailable</strong>
          <span>{error}</span>
        </div>
      ) : null}

      {preview ? (
        <div className={styles.archPlanResult} aria-live="polite">
          <div className={styles.archPlanRoute} data-route={preview.route}>
            <span>ROUTE</span>
            <strong>{routeLabel(preview.route)}</strong>
            <p>{preview.summary}</p>
            <small>
              {preview.used_live_semantic_service
                ? "Catalogue/capabilities used the live semantic service where available."
                : "Catalogue used the bundled registry and connector field coverage (semantic service offline or unused)."}
              {" · "}
              Planned {new Date(preview.generated_at).toLocaleString("en-AU")}
            </small>
          </div>

          <div className={styles.archPlanGrid}>
            <article>
              <span>CATALOGUE CANDIDATES</span>
              <h4>What search_catalogue returned</h4>
              <div className={styles.archPlanBlock}>
                <strong>Topics</strong>
                {preview.catalogue.topics.length ? preview.catalogue.topics.map((topic) => (
                  <button
                    type="button"
                    key={topic.id}
                    className={styles.archDictChipButton}
                    onClick={() => onOpenDictionary?.("topics", topic.id)}
                  >
                    {topic.label}
                  </button>
                )) : <em>None</em>}
              </div>
              <div className={styles.archPlanBlock}>
                <strong>Metrics</strong>
                {preview.catalogue.metrics.length ? preview.catalogue.metrics.map((metric) => (
                  <button
                    type="button"
                    key={metric.id}
                    className={styles.archDictChipButton}
                    onClick={() => onOpenDictionary?.("metrics", metric.id)}
                  >
                    {metric.label}
                  </button>
                )) : <em>None</em>}
              </div>
              <div className={styles.archPlanBlock}>
                <strong>Dimensions</strong>
                {preview.catalogue.dimensions.length ? preview.catalogue.dimensions.map((dimension) => (
                  <button
                    type="button"
                    key={dimension.id}
                    className={styles.archDictChipButton}
                    onClick={() => onOpenDictionary?.("dimensions", dimension.id)}
                  >
                    {dimension.label}
                  </button>
                )) : <em>None</em>}
              </div>
              <div className={styles.archPlanBlock}>
                <strong>Exploratory source fields</strong>
                {preview.catalogue.source_fields.length ? preview.catalogue.source_fields.map((field) => (
                  <span className={styles.archDictChip} key={field.id}>
                    {field.connectorId} · {field.sourceTable}.{field.field}
                  </span>
                )) : <em>None</em>}
              </div>
            </article>

            <article>
              <span>PLANNED EXECUTION</span>
              <h4>What Albert would actually call</h4>
              {preview.governed_plans.length ? preview.governed_plans.map((plan, index) => (
                <div className={styles.archPlanCall} data-route="governed" key={`governed-${plan.topic}-${index}`}>
                  <em>Governed · run_semantic_query</em>
                  <strong>Topic: {humanize(plan.topic)}</strong>
                  <p>
                    Metrics: {plan.metrics.length ? plan.metrics.join(", ") : "none"}
                  </p>
                  <p>
                    Facts: {plan.facts.length ? plan.facts.join(", ") : "none"}
                  </p>
                  <p>
                    Dimensions: {plan.dimensions.length ? plan.dimensions.map(humanize).join(", ") : "none"}
                  </p>
                  <div className={styles.archPlanBlock}>
                    {plan.metrics.map((metricId) => (
                      <button
                        type="button"
                        key={metricId}
                        className={styles.archDictChipButton}
                        onClick={() => onOpenDictionary?.("metrics", metricId)}
                      >
                        {metricId}
                      </button>
                    ))}
                    {plan.facts.map((factId) => (
                      <button
                        type="button"
                        key={factId}
                        className={styles.archDictChipButton}
                        onClick={() => onOpenDictionary?.("facts", factId)}
                      >
                        {factId}
                      </button>
                    ))}
                  </div>
                </div>
              )) : null}

              {preview.exploratory_plans.length ? preview.exploratory_plans.map((plan, index) => (
                <div className={styles.archPlanCall} data-route="exploratory" key={`exploratory-${plan.sourceTable}-${index}`}>
                  <em>Ungoverned · run_source_query</em>
                  <strong>Source table: {plan.sourceTable}</strong>
                  <p>Connection: {plan.connectionId}</p>
                  <p>Fields: {plan.fields.length ? plan.fields.join(", ") : "none"}</p>
                  <p>Group by: {plan.groupBy.length ? plan.groupBy.join(", ") : "none"}</p>
                  {plan.requestedMetricConcept ? <p>Concept hint: {plan.requestedMetricConcept}</p> : null}
                </div>
              )) : null}

              {!preview.governed_plans.length && !preview.exploratory_plans.length ? (
                <p className={styles.archPlanEmpty}>
                  No query tool was planned. Albert would clarify or return unavailable instead of querying.
                </p>
              ) : null}

              {preview.missing_capabilities.length ? (
                <div className={styles.archPlanBlock}>
                  <strong>Missing capabilities</strong>
                  {preview.missing_capabilities.map((item) => (
                    <span className={styles.archDictChip} key={item}>{item}</span>
                  ))}
                </div>
              ) : null}
            </article>
          </div>
        </div>
      ) : null}
    </section>
  );
}
