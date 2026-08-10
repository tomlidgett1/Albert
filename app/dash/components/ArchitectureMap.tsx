"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import PlanPreviewChat from "./PlanPreviewChat";
import styles from "../dash.module.css";

export type ArchitectureMetric = Readonly<{
  id: string;
  domain: string;
  domain_label: string;
  label: string;
  synonyms: readonly string[];
  description: string;
  ai_context: string;
  base_fact: string;
  grain: string;
  expression: string;
  default_time: string;
  unit: string;
  unit_label: string;
  authority: string;
  aggregation: string;
  refund_handling: string;
  allowed_dimensions: readonly string[];
  required_capabilities: readonly string[];
  tenant_parameters: readonly string[];
  version: number;
}>;

export type ArchitectureTopic = Readonly<{
  id: string;
  label: string;
  description: string;
  ai_context: string;
  composite: boolean;
  base_facts: readonly string[];
  approved_dimensions: readonly string[];
  metrics: readonly string[];
  metric_count: number;
  sample_questions: readonly string[];
  sample_question: string | null;
  roles: readonly string[];
  freshness_minutes: number;
  required_capabilities: readonly string[];
  align_on: readonly string[];
  version: number;
}>;

export type ArchitectureFact = Readonly<{
  id: string;
  table: string;
  fields: readonly string[];
  time_fields: readonly string[];
  join_count: number;
  joins: readonly Readonly<{
    dimension: string;
    table: string;
    cardinality: string;
    identity_type: string | null;
  }>[];
  snapshot_fields: readonly string[];
  snapshot_entity_keys: readonly string[];
}>;

export type ArchitectureDimension = Readonly<{
  id: string;
  label: string;
  topic_count: number;
  topics: readonly string[];
}>;

export type ArchitectureOverview = Readonly<{
  generated_at: string;
  packs: readonly Readonly<{
    key: string;
    label: string;
    role: string;
  }>[];
  semantic: Readonly<{
    version: string;
    metric_count: number;
    topic_count: number;
    fact_count: number;
    dimension_count: number;
    domains: readonly Readonly<{ id: string; label: string; metric_count: number }>[];
    topics: readonly ArchitectureTopic[];
    metrics: readonly ArchitectureMetric[];
    facts: readonly ArchitectureFact[];
    dimensions: readonly ArchitectureDimension[];
  }>;
  live: Readonly<{
    generated_at: string;
    connections: number;
    blocked: number;
    degraded: number;
    healthy: number;
    workers_healthy: number;
    workers_total: number;
    queue_depth: number;
    quarantine: number;
    connectors: readonly Readonly<{
      key: string;
      label: string;
      role: string;
      connected: number;
      healthy: number;
      degraded: number;
      blocked: number;
    }>[];
  }> | null;
  live_error: string | null;
}>;

type JourneyStep = "connect" | "sync" | "vault" | "truth" | "dictionary" | "answer";
type DictionaryView = "topics" | "metrics" | "facts" | "dimensions";
type DictionaryJump = Readonly<{ view: DictionaryView; id: string }>;

const MODEL_PIECES = Object.freeze([
  {
    key: "topics" as const,
    title: "Topic",
    plain: "A governed subject area Albert is allowed to discuss, such as sales or workforce.",
    detail: "A Topic bundles the metrics, facts and dimensions that belong together for one kind of question.",
  },
  {
    key: "metrics" as const,
    title: "Metric",
    plain: "One exact number with a fixed meaning, such as Net sales or Units sold.",
    detail: "Metrics carry synonyms, units, refund rules and which dimensions you may slice by. Albert never invents a metric on the fly.",
  },
  {
    key: "facts" as const,
    title: "Fact",
    plain: "The business-event table behind the metric: one row per real sale, payment, hour or journal line.",
    detail: "Facts come from cleaned Lightspeed, Xero and Deputy data. Metrics aggregate facts; they never invent rows.",
  },
  {
    key: "dimensions" as const,
    title: "Dimension",
    plain: "A safe way to slice the answer: shop, product category, staff member, day, channel.",
    detail: "Dimensions are shared labels. Albert can break Net sales down by location because the fact joins to that dimension.",
  },
] as const);

const BIKE_STORE_EXAMPLE = Object.freeze({
  question: "How are sales going this month across my bike shops?",
  topicId: "sales_performance",
  metricId: "commerce.net_sales_ex_gst",
  factId: "commerce_sales_event",
  dimensions: ["location", "product.category", "business_date"] as const,
  steps: [
    {
      piece: "Topic",
      name: "Sales performance",
      plain: "Albert opens the sales subject area, not inventory or payroll.",
    },
    {
      piece: "Metric",
      name: "Net sales",
      plain: "Completed sales excluding GST, with refunds subtracted when they happen. Also known as revenue, sales or turnover.",
    },
    {
      piece: "Fact",
      name: "Commerce sales event",
      plain: "Each Lightspeed till sale or refund becomes one cleaned business event in the shared model.",
    },
    {
      piece: "Dimensions",
      name: "Shop, category, day",
      plain: "Slice by bike shop (location), bikes vs accessories (product category), and this month (business date).",
    },
  ],
});

const JOURNEY = Object.freeze([
  {
    key: "connect" as const,
    number: "01",
    title: "Connect the tools",
    plain: "The owner signs in to Lightspeed, Xero and Deputy. Albert only ever reads.",
    detail: "OAuth tokens live in the control plane under envelope encryption. Workers can refresh them; the chat and the model never see credentials.",
  },
  {
    key: "sync" as const,
    number: "02",
    title: "Sync workers copy data",
    plain: "Always-on workers quietly pull sales, stock, hours and books on a schedule, and when a webhook arrives.",
    detail: "Three job types keep everything moving: first backfill, ongoing incremental sync, and a nightly reconciliation sweep. If a worker restarts, it resumes from its cursors.",
  },
  {
    key: "vault" as const,
    number: "03",
    title: "Keep an immutable vault",
    plain: "Every batch is stored as a compressed original. Albert can replay history without asking the vendor again.",
    detail: "Raw payloads sit in encrypted storage. Each batch has a manifest: when it was pulled, how many rows, and a content hash for lineage.",
  },
  {
    key: "truth" as const,
    number: "04",
    title: "Turn copies into business truth",
    plain: "Typed staging tables become one shared model of orders, people, products, places, money and hours.",
    detail: "The pipeline runs left to right: staging → canonical facts and bridges → query-ready marts → quality checks → readiness per domain. Overlapping observations are linked, not mashed together.",
  },
  {
    key: "dictionary" as const,
    number: "05",
    title: "The semantic dictionary",
    plain: "Albert's dictionary defines what \"sales\", \"margin\" and \"best employee\" mean, so answers stay consistent.",
    detail: "Metrics and Topics live as versioned contracts. The AI may only ask this layer; it never invents SQL against raw tables.",
  },
  {
    key: "answer" as const,
    number: "06",
    title: "Chat answers with proof",
    plain: "A plain-language question becomes a typed plan, then a governed query, then an answer with provenance.",
    detail: "If the governed Topics cannot support the question, Albert says so clearly, or offers a disclosed exploratory reading of a documented source field.",
  },
] satisfies readonly Readonly<{
  key: JourneyStep;
  number: string;
  title: string;
  plain: string;
  detail: string;
}>[]);

const SYSTEM_ROOMS = Object.freeze([
  {
    key: "control",
    eyebrow: "CONTROL PLANE",
    title: "Control room",
    place: "Supabase · Sydney",
    plain: "Login, tenants, connections, job queue, readiness, dossiers, audit log and the semantic catalogue.",
    items: ["Auth and memberships", "OAuth token references", "Sync ledger and cursors", "Semantic publications"],
  },
  {
    key: "workers",
    eyebrow: "SYNC FLEET",
    title: "Always-on workers",
    place: "Node services",
    plain: "Connector packs talk to vendors, land raw batches, and transform them into the shared model.",
    items: ["Initial backfill", "Incremental sync", "Nightly reconciliation", "Vendor rate budgets"],
  },
  {
    key: "analytical",
    eyebrow: "ANALYTICAL CELL",
    title: "Business database",
    place: "Separate Postgres · Sydney",
    plain: "Source staging, canonical facts, marts and quality live here so chat and login never fight ingestion.",
    items: ["source_* staging", "core facts and bridges", "mart aggregates", "quality projections"],
  },
] as const);

const RESOLUTION_LAYERS = Object.freeze([
  { title: "Canonical core", plain: "Shared business meaning for every tenant." },
  { title: "Connector pack", plain: "How Lightspeed, Xero and Deputy map in." },
  { title: "Retail industry pack", plain: "Retail defaults that apply across shops." },
  { title: "Tenant overlay", plain: "Approved choices: GST lens, trading day, staff matches." },
  { title: "This conversation", plain: "Temporary choices for one answer, not stored forever." },
] as const);

const DICTIONARY_VIEWS = Object.freeze([
  { key: "topics" as const, label: "Topics" },
  { key: "metrics" as const, label: "Metrics" },
  { key: "facts" as const, label: "Facts" },
  { key: "dimensions" as const, label: "Dimensions" },
]);

function formatTime(value: string | null | undefined) {
  if (!value || !Number.isFinite(Date.parse(value))) return "Just now";
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-AU").format(value);
}

function humanize(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function matchesQuery(query: string, ...parts: readonly (string | null | undefined)[]) {
  if (!query) return true;
  const haystack = parts.filter(Boolean).join(" ").toLowerCase();
  return haystack.includes(query);
}

function liveTone(live: ArchitectureOverview["live"]) {
  if (!live) return "unknown";
  if (live.blocked > 0) return "blocked";
  if (live.degraded > 0 || live.quarantine > 0 || live.queue_depth > 0) return "degraded";
  return "healthy";
}

function connectorTone(connector: NonNullable<ArchitectureOverview["live"]>["connectors"][number]) {
  if (connector.blocked > 0) return "blocked";
  if (connector.degraded > 0) return "degraded";
  if (connector.connected > 0) return "healthy";
  return "idle";
}

function SemanticModelPrimer({
  semantic,
  onExplore,
}: Readonly<{
  semantic: ArchitectureOverview["semantic"];
  onExplore: (jump: DictionaryJump) => void;
}>) {
  const topic = semantic.topics.find((entry) => entry.id === BIKE_STORE_EXAMPLE.topicId) ?? null;
  const metric = semantic.metrics.find((entry) => entry.id === BIKE_STORE_EXAMPLE.metricId) ?? null;
  const fact = semantic.facts.find((entry) => entry.id === BIKE_STORE_EXAMPLE.factId) ?? null;

  return (
    <section className={styles.archModelPrimer} aria-labelledby="arch-model-primer-title">
      <header>
        <div>
          <span>HOW THE DICTIONARY FITS TOGETHER</span>
          <h3 id="arch-model-primer-title">Topics, metrics, facts and dimensions</h3>
          <p>
            Think of it as a filing system. The Topic is the folder, the metric is the number Albert
            calculates, the fact is the stack of cleaned business events, and dimensions are the
            labels used to slice the answer.
          </p>
        </div>
      </header>

      <div className={styles.archModelFlow} aria-hidden="true">
        <span>Question</span>
        <i />
        <span>Topic</span>
        <i />
        <span>Metric</span>
        <i />
        <span>Fact</span>
        <i />
        <span>Dimensions</span>
        <i />
        <span>Answer</span>
      </div>

      <div className={styles.archModelDefs}>
        {MODEL_PIECES.map((piece) => (
          <article key={piece.key}>
            <span>{piece.title.toUpperCase()}</span>
            <h4>{piece.title}</h4>
            <p>{piece.plain}</p>
            <small>{piece.detail}</small>
            <button type="button" onClick={() => onExplore({ view: piece.key, id: "" })}>
              Browse {piece.title.toLowerCase()}s
            </button>
          </article>
        ))}
      </div>

      <article className={styles.archBikeExample} aria-labelledby="arch-bike-example-title">
        <header>
          <span>WORKED EXAMPLE</span>
          <h4 id="arch-bike-example-title">Lightspeed bike store</h4>
          <p>
            A multi-shop bike retailer connected Lightspeed R-Series. The owner asks a plain question;
            Albert answers through the governed chain below.
          </p>
        </header>

        <blockquote>“{BIKE_STORE_EXAMPLE.question}”</blockquote>

        <ol className={styles.archBikeSteps}>
          {BIKE_STORE_EXAMPLE.steps.map((step, index) => (
            <li key={step.piece}>
              <b>{index + 1}</b>
              <div>
                <strong>{step.piece}: {step.name}</strong>
                <span>{step.plain}</span>
              </div>
            </li>
          ))}
        </ol>

        <div className={styles.archBikeChain} aria-label="Registry chain for the bike store example">
          <button
            type="button"
            onClick={() => onExplore({ view: "topics", id: BIKE_STORE_EXAMPLE.topicId })}
            disabled={!topic}
          >
            <em>Topic</em>
            <strong>{topic?.label ?? "Sales performance"}</strong>
            <span>{topic ? `${formatNumber(topic.metric_count)} metrics` : "Open in dictionary"}</span>
          </button>
          <i aria-hidden="true" />
          <button
            type="button"
            onClick={() => onExplore({ view: "metrics", id: BIKE_STORE_EXAMPLE.metricId })}
            disabled={!metric}
          >
            <em>Metric</em>
            <strong>{metric?.label ?? "Net sales"}</strong>
            <span>{metric?.synonyms.slice(0, 3).join(", ") || "Open in dictionary"}</span>
          </button>
          <i aria-hidden="true" />
          <button
            type="button"
            onClick={() => onExplore({ view: "facts", id: BIKE_STORE_EXAMPLE.factId })}
            disabled={!fact}
          >
            <em>Fact</em>
            <strong>{fact ? humanize(fact.id) : "Commerce sales event"}</strong>
            <span>{fact?.table ?? "Open in dictionary"}</span>
          </button>
          <i aria-hidden="true" />
          <button
            type="button"
            onClick={() => onExplore({ view: "dimensions", id: "location" })}
          >
            <em>Dimensions</em>
            <strong>Shop · Category · Day</strong>
            <span>{BIKE_STORE_EXAMPLE.dimensions.map(humanize).join(" · ")}</span>
          </button>
        </div>

        <p className={styles.archBikeFootnote}>
          Lightspeed supplies the till events. Albert maps them into the shared sales fact, applies the
          Net sales contract, then slices by shop and category. The model never joins raw Lightspeed
          tables in chat.
        </p>
      </article>
    </section>
  );
}

function DictionaryBrowser({
  semantic,
  jumpTo,
  onJumpApplied,
}: Readonly<{
  semantic: ArchitectureOverview["semantic"];
  jumpTo: DictionaryJump | null;
  onJumpApplied: () => void;
}>) {
  const [view, setView] = useState<DictionaryView>("topics");
  const [query, setQuery] = useState("");
  const [selectedTopicId, setSelectedTopicId] = useState(semantic.topics[0]?.id ?? "");
  const [selectedMetricId, setSelectedMetricId] = useState(semantic.metrics[0]?.id ?? "");
  const [selectedFactId, setSelectedFactId] = useState(semantic.facts[0]?.id ?? "");
  const [selectedDimensionId, setSelectedDimensionId] = useState(semantic.dimensions[0]?.id ?? "");
  const sectionRef = useRef<HTMLElement | null>(null);
  const normalizedQuery = query.trim().toLowerCase();

  useEffect(() => {
    if (!jumpTo) return;
    setView(jumpTo.view);
    setQuery("");
    if (jumpTo.id) {
      if (jumpTo.view === "topics") setSelectedTopicId(jumpTo.id);
      if (jumpTo.view === "metrics") setSelectedMetricId(jumpTo.id);
      if (jumpTo.view === "facts") setSelectedFactId(jumpTo.id);
      if (jumpTo.view === "dimensions") setSelectedDimensionId(jumpTo.id);
    }
    window.requestAnimationFrame(() => {
      sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    onJumpApplied();
  }, [jumpTo, onJumpApplied]);

  const filteredTopics = useMemo(() => semantic.topics.filter((topic) => matchesQuery(
    normalizedQuery,
    topic.id,
    topic.label,
    topic.description,
    topic.ai_context,
    ...topic.sample_questions,
    ...topic.metrics,
    ...topic.approved_dimensions,
  )), [normalizedQuery, semantic.topics]);

  const filteredMetrics = useMemo(() => semantic.metrics.filter((metric) => matchesQuery(
    normalizedQuery,
    metric.id,
    metric.label,
    metric.domain_label,
    metric.description,
    metric.ai_context,
    metric.expression,
    ...metric.synonyms,
    ...metric.allowed_dimensions,
  )), [normalizedQuery, semantic.metrics]);

  const filteredFacts = useMemo(() => semantic.facts.filter((fact) => matchesQuery(
    normalizedQuery,
    fact.id,
    fact.table,
    ...fact.fields,
    ...fact.time_fields,
  )), [normalizedQuery, semantic.facts]);

  const filteredDimensions = useMemo(() => semantic.dimensions.filter((dimension) => matchesQuery(
    normalizedQuery,
    dimension.id,
    dimension.label,
    ...dimension.topics,
  )), [normalizedQuery, semantic.dimensions]);

  const selectedTopic = filteredTopics.find((topic) => topic.id === selectedTopicId)
    ?? filteredTopics[0]
    ?? null;
  const selectedMetric = filteredMetrics.find((metric) => metric.id === selectedMetricId)
    ?? filteredMetrics[0]
    ?? null;
  const selectedFact = filteredFacts.find((fact) => fact.id === selectedFactId)
    ?? filteredFacts[0]
    ?? null;
  const selectedDimension = filteredDimensions.find((dimension) => dimension.id === selectedDimensionId)
    ?? filteredDimensions[0]
    ?? null;

  const topicMetrics = useMemo(() => {
    if (!selectedTopic) return [];
    return selectedTopic.metrics
      .map((metricId) => semantic.metrics.find((metric) => metric.id === metricId))
      .filter((metric): metric is ArchitectureMetric => Boolean(metric));
  }, [selectedTopic, semantic.metrics]);

  return (
    <section className={styles.archDictionary} aria-labelledby="arch-dictionary-title" ref={sectionRef} id="arch-dictionary">
      <header>
        <div>
          <span>SEMANTIC DICTIONARY</span>
          <h3 id="arch-dictionary-title">Browse the full catalogue</h3>
          <p>
            Search every governed Topic, metric contract, fact model and approved dimension.
            This is the same registry the chat is allowed to use.
          </p>
        </div>
      </header>

      <div className={styles.archDictToolbar}>
        <label className={styles.archDictSearch}>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search names, synonyms, definitions…"
            aria-label="Search the semantic dictionary"
          />
        </label>
        <div className={styles.archDictViewTabs} role="tablist" aria-label="Dictionary views">
          {DICTIONARY_VIEWS.map((tab) => (
            <button
              type="button"
              role="tab"
              key={tab.key}
              aria-selected={view === tab.key}
              className={view === tab.key ? styles.archDictViewTabActive : undefined}
              onClick={() => setView(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.archDictLayout}>
        <div className={styles.archDictList} role="group" aria-label={`${view} catalogue`}>
          {view === "topics" ? filteredTopics.map((topic) => (
            <button
              type="button"
              key={topic.id}
              aria-pressed={selectedTopic?.id === topic.id}
              onClick={() => setSelectedTopicId(topic.id)}
            >
              <strong>{topic.label}</strong>
              <span>{formatNumber(topic.metric_count)} metrics · {topic.composite ? "Composite" : "Single fact"}</span>
              <em>{topic.id}</em>
            </button>
          )) : null}
          {view === "metrics" ? filteredMetrics.map((metric) => (
            <button
              type="button"
              key={metric.id}
              aria-pressed={selectedMetric?.id === metric.id}
              onClick={() => setSelectedMetricId(metric.id)}
            >
              <strong>{metric.label}</strong>
              <span>{metric.domain_label} · {metric.unit_label}</span>
              <em>{metric.id}</em>
            </button>
          )) : null}
          {view === "facts" ? filteredFacts.map((fact) => (
            <button
              type="button"
              key={fact.id}
              aria-pressed={selectedFact?.id === fact.id}
              onClick={() => setSelectedFactId(fact.id)}
            >
              <strong>{humanize(fact.id)}</strong>
              <span>{fact.table} · {formatNumber(fact.fields.length)} fields</span>
              <em>{fact.id}</em>
            </button>
          )) : null}
          {view === "dimensions" ? filteredDimensions.map((dimension) => (
            <button
              type="button"
              key={dimension.id}
              aria-pressed={selectedDimension?.id === dimension.id}
              onClick={() => setSelectedDimensionId(dimension.id)}
            >
              <strong>{dimension.label}</strong>
              <span>{formatNumber(dimension.topic_count)} Topics</span>
              <em>{dimension.id}</em>
            </button>
          )) : null}
        </div>

        {view === "topics" && selectedTopic ? (
          <article className={styles.archDictDetail}>
            <span>TOPIC</span>
            <h4>{selectedTopic.label}</h4>
            <p>{selectedTopic.description}</p>
            <p><small>{selectedTopic.ai_context}</small></p>
            {selectedTopic.sample_questions.length ? (
              <div className={styles.archDictMeta}>
                <div>
                  <dt>Example questions</dt>
                  <dd>
                    {selectedTopic.sample_questions.map((question) => (
                      <blockquote key={question}>“{question}”</blockquote>
                    ))}
                  </dd>
                </div>
              </div>
            ) : null}
            <div className={styles.archDictMeta}>
              <div><dt>Registry id</dt><dd><code>{selectedTopic.id}</code></dd></div>
              <div><dt>Roles</dt><dd>{selectedTopic.roles.join(", ")}</dd></div>
              <div><dt>Freshness</dt><dd>{formatNumber(selectedTopic.freshness_minutes)} minutes</dd></div>
            </div>
            <div>
              <dt className={styles.archDictMeta}>Approved dimensions</dt>
              <div className={styles.archDictChips}>
                {selectedTopic.approved_dimensions.map((dimension) => (
                  <button
                    type="button"
                    className={styles.archDictChipButton}
                    key={dimension}
                    onClick={() => {
                      setView("dimensions");
                      setSelectedDimensionId(dimension);
                    }}
                  >
                    {humanize(dimension)}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <dt className={styles.archDictMeta}>Metrics in this Topic</dt>
              <div className={styles.archDictChips}>
                {topicMetrics.map((metric) => (
                  <button
                    type="button"
                    className={styles.archDictChipButton}
                    key={metric.id}
                    onClick={() => {
                      setView("metrics");
                      setSelectedMetricId(metric.id);
                    }}
                  >
                    {metric.label}
                  </button>
                ))}
              </div>
            </div>
            {selectedTopic.base_facts.length ? (
              <div>
                <dt className={styles.archDictMeta}>Base facts</dt>
                <div className={styles.archDictChips}>
                  {selectedTopic.base_facts.map((factId) => (
                    <button
                      type="button"
                      className={styles.archDictChipButton}
                      key={factId}
                      onClick={() => {
                        setView("facts");
                        setSelectedFactId(factId);
                      }}
                    >
                      {humanize(factId)}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </article>
        ) : null}

        {view === "metrics" && selectedMetric ? (
          <article className={styles.archDictDetail}>
            <span>METRIC</span>
            <h4>{selectedMetric.label}</h4>
            <p>{selectedMetric.description}</p>
            <p><small>{selectedMetric.ai_context}</small></p>
            {selectedMetric.synonyms.length ? (
              <div>
                <dt className={styles.archDictMeta}>Also known as</dt>
                <div className={styles.archDictChips}>
                  {selectedMetric.synonyms.map((synonym) => (
                    <span className={styles.archDictChip} key={synonym}>{synonym}</span>
                  ))}
                </div>
              </div>
            ) : null}
            <dl className={styles.archDictMeta}>
              <div><dt>Registry id</dt><dd><code>{selectedMetric.id}</code></dd></div>
              <div><dt>Domain</dt><dd>{selectedMetric.domain_label}</dd></div>
              <div>
                <dt>Base fact</dt>
                <dd>
                  <button
                    type="button"
                    className={styles.archDictInlineLink}
                    onClick={() => {
                      setView("facts");
                      setSelectedFactId(selectedMetric.base_fact);
                    }}
                  >
                    {selectedMetric.base_fact}
                  </button>
                </dd>
              </div>
              <div><dt>Grain</dt><dd>{humanize(selectedMetric.grain)}</dd></div>
              <div><dt>Expression</dt><dd><code>{selectedMetric.expression}</code></dd></div>
              <div><dt>Default time</dt><dd>{humanize(selectedMetric.default_time)}</dd></div>
              <div><dt>Unit</dt><dd>{selectedMetric.unit_label}</dd></div>
              <div><dt>Aggregation</dt><dd>{humanize(selectedMetric.aggregation)}</dd></div>
              <div><dt>Refund handling</dt><dd>{humanize(selectedMetric.refund_handling)}</dd></div>
              <div><dt>Authority</dt><dd>{humanize(selectedMetric.authority)}</dd></div>
            </dl>
            <div>
              <dt className={styles.archDictMeta}>Allowed dimensions</dt>
              <div className={styles.archDictChips}>
                {selectedMetric.allowed_dimensions.map((dimension) => (
                  <button
                    type="button"
                    className={styles.archDictChipButton}
                    key={dimension}
                    onClick={() => {
                      setView("dimensions");
                      setSelectedDimensionId(dimension);
                    }}
                  >
                    {humanize(dimension)}
                  </button>
                ))}
              </div>
            </div>
          </article>
        ) : null}

        {view === "facts" && selectedFact ? (
          <article className={styles.archDictDetail}>
            <span>FACT MODEL</span>
            <h4>{humanize(selectedFact.id)}</h4>
            <p>The canonical table behind governed metrics. Facts declare fields, time axes and joins to dimensions.</p>
            <dl className={styles.archDictMeta}>
              <div><dt>Registry id</dt><dd><code>{selectedFact.id}</code></dd></div>
              <div><dt>Table</dt><dd><code>{selectedFact.table}</code></dd></div>
              <div><dt>Time fields</dt><dd>{selectedFact.time_fields.join(", ")}</dd></div>
              <div><dt>Joins</dt><dd>{formatNumber(selectedFact.join_count)}</dd></div>
            </dl>
            <div>
              <dt className={styles.archDictMeta}>Fields</dt>
              <div className={styles.archDictChips}>
                {selectedFact.fields.map((field) => (
                  <span className={styles.archDictChip} key={field}>{field}</span>
                ))}
              </div>
            </div>
            {selectedFact.joins.length ? (
              <div>
                <dt className={styles.archDictMeta}>Dimension joins</dt>
                <div className={styles.archDictChips}>
                  {selectedFact.joins.map((join) => (
                    <span className={styles.archDictChip} key={`${join.dimension}-${join.table}`}>
                      {humanize(join.dimension)} → {join.table}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
          </article>
        ) : null}

        {view === "dimensions" && selectedDimension ? (
          <article className={styles.archDictDetail}>
            <span>DIMENSION</span>
            <h4>{selectedDimension.label}</h4>
            <p>An approved way to slice governed answers. Dimensions are shared across Topics where the registry allows them.</p>
            <dl className={styles.archDictMeta}>
              <div><dt>Registry id</dt><dd><code>{selectedDimension.id}</code></dd></div>
              <div><dt>Used in Topics</dt><dd>{formatNumber(selectedDimension.topic_count)}</dd></div>
            </dl>
            <div>
              <dt className={styles.archDictMeta}>Topics</dt>
              <div className={styles.archDictChips}>
                {selectedDimension.topics.map((topicId) => {
                  const topic = semantic.topics.find((entry) => entry.id === topicId);
                  return (
                    <button
                      type="button"
                      className={styles.archDictChipButton}
                      key={topicId}
                      onClick={() => {
                        setView("topics");
                        setSelectedTopicId(topicId);
                      }}
                    >
                      {topic?.label ?? humanize(topicId)}
                    </button>
                  );
                })}
              </div>
            </div>
          </article>
        ) : null}

        {((view === "topics" && !filteredTopics.length)
          || (view === "metrics" && !filteredMetrics.length)
          || (view === "facts" && !filteredFacts.length)
          || (view === "dimensions" && !filteredDimensions.length)) ? (
          <div className={styles.archDictEmpty}>No catalogue entries match your search.</div>
        ) : null}
      </div>
    </section>
  );
}

export default function ArchitectureMap({
  overview,
  onOpenFleet,
}: Readonly<{
  overview: ArchitectureOverview;
  onOpenFleet: () => void;
}>) {
  const [activeStep, setActiveStep] = useState<JourneyStep>("connect");
  const [activeTopic, setActiveTopic] = useState(overview.semantic.topics[0]?.id ?? "");
  const [dictionaryJump, setDictionaryJump] = useState<DictionaryJump | null>(null);
  const clearDictionaryJump = useCallback(() => setDictionaryJump(null), []);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const tabRowRef = useRef<HTMLDivElement | null>(null);
  const [indicator, setIndicator] = useState({ left: 0, width: 0 });
  const currentStep = JOURNEY.find((step) => step.key === activeStep) ?? JOURNEY[0];
  const selectedTopic = overview.semantic.topics.find((topic) => topic.id === activeTopic)
    ?? overview.semantic.topics[0]
    ?? null;
  const live = overview.live;
  const tone = liveTone(live);

  useLayoutEffect(() => {
    const button = tabRefs.current[activeStep];
    const row = tabRowRef.current;
    if (!button || !row) return;
    const rowBox = row.getBoundingClientRect();
    const buttonBox = button.getBoundingClientRect();
    setIndicator({ left: buttonBox.left - rowBox.left, width: buttonBox.width });
  }, [activeStep]);

  useEffect(() => {
    const handleResize = () => {
      const button = tabRefs.current[activeStep];
      const row = tabRowRef.current;
      if (!button || !row) return;
      const rowBox = row.getBoundingClientRect();
      const buttonBox = button.getBoundingClientRect();
      setIndicator({ left: buttonBox.left - rowBox.left, width: buttonBox.width });
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [activeStep]);

  return (
    <div className={styles.archMap}>
      <section className={styles.archHero} aria-labelledby="arch-hero-title">
        <div>
          <span>HOW ALBERT WORKS</span>
          <h3 id="arch-hero-title">From your tools to a trustworthy answer</h3>
          <p>
            Albert is not a dashboard of raw tables. Your stack is connected, copied, cleaned into one
            business model, and only then asked questions through a governed dictionary.
          </p>
        </div>
        <dl className={styles.archPulse} data-tone={tone} aria-label="Live platform pulse">
          <div>
            <dt>Connections</dt>
            <dd>{live ? formatNumber(live.connections) : "—"}</dd>
          </div>
          <div data-severity={live?.blocked ? "blocked" : "healthy"}>
            <dt>Blocked</dt>
            <dd>{live ? formatNumber(live.blocked) : "—"}</dd>
          </div>
          <div data-severity={live?.degraded ? "degraded" : "healthy"}>
            <dt>Needs attention</dt>
            <dd>{live ? formatNumber(live.degraded) : "—"}</dd>
          </div>
          <div>
            <dt>Workers</dt>
            <dd>
              {live ? `${formatNumber(live.workers_healthy)}/${formatNumber(live.workers_total)}` : "—"}
            </dd>
          </div>
          <div data-severity={live?.queue_depth ? "degraded" : "healthy"}>
            <dt>Queue</dt>
            <dd>{live ? formatNumber(live.queue_depth) : "—"}</dd>
          </div>
          <div data-severity={live?.quarantine ? "degraded" : "healthy"}>
            <dt>Quarantine</dt>
            <dd>{live ? formatNumber(live.quarantine) : "—"}</dd>
          </div>
        </dl>
      </section>

      {overview.live_error ? (
        <div className={styles.opsError} role="status">
          <strong>Live sync pulse unavailable</strong>
          <span>{overview.live_error} The architecture map still shows how the system is wired.</span>
        </div>
      ) : null}

      <section className={styles.archJourney} aria-labelledby="arch-journey-title">
        <header>
          <div>
            <span>THE JOURNEY</span>
            <h3 id="arch-journey-title">Six steps, left to right</h3>
            <p>Tap a step to see what happens underneath. This is the same path every tenant follows.</p>
          </div>
          <small>Registry {overview.semantic.version} · Pulse {formatTime(live?.generated_at ?? overview.generated_at)}</small>
        </header>

        <div className={styles.archJourneyTabs} ref={tabRowRef} role="tablist" aria-label="Albert data journey">
          {JOURNEY.map((step) => (
            <button
              type="button"
              role="tab"
              key={step.key}
              ref={(node) => {
                tabRefs.current[step.key] = node;
              }}
              aria-selected={activeStep === step.key}
              className={activeStep === step.key ? styles.archJourneyTabActive : undefined}
              onClick={() => setActiveStep(step.key)}
            >
              <b>{step.number}</b>
              {step.title}
            </button>
          ))}
          <span className={styles.archJourneyIndicator} style={{ left: indicator.left, width: indicator.width }} aria-hidden="true" />
        </div>

        <article className={styles.archJourneyPanel} aria-live="polite">
          <div>
            <span>STEP {currentStep.number}</span>
            <h4>{currentStep.title}</h4>
            <p>{currentStep.plain}</p>
            <p className={styles.archJourneyDetail}>{currentStep.detail}</p>
          </div>
          <div className={styles.archJourneyVisual} data-step={currentStep.key} aria-hidden="true">
            {currentStep.key === "connect" ? (
              <ul className={styles.archPackList}>
                {(live?.connectors ?? overview.packs.map((pack) => ({
                  ...pack,
                  connected: 0,
                  healthy: 0,
                  degraded: 0,
                  blocked: 0,
                }))).map((pack) => (
                  <li key={pack.key} data-tone={"connected" in pack ? connectorTone(pack) : "idle"}>
                    <strong>{pack.label}</strong>
                    <span>{pack.role}</span>
                    {"connected" in pack ? (
                      <em>{pack.connected ? `${pack.connected} linked` : "Not linked yet"}</em>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {currentStep.key === "sync" ? (
              <div className={styles.archFlowStrip}>
                <span>Webhook or schedule</span>
                <i />
                <span>Job queue</span>
                <i />
                <span>Sync worker</span>
                <i />
                <span>Vendor API</span>
              </div>
            ) : null}
            {currentStep.key === "vault" ? (
              <div className={styles.archVaultCard}>
                <strong>raw-payloads</strong>
                <span>tenant → connection → stream → date → batch</span>
                <em>Immutable · compressed · encrypted</em>
              </div>
            ) : null}
            {currentStep.key === "truth" ? (
              <div className={styles.archPipelineStrip}>
                {["Staging", "Canonical", "Marts", "Quality", "Ready"].map((label, index) => (
                  <span key={label}><b>{index + 1}</b>{label}</span>
                ))}
              </div>
            ) : null}
            {currentStep.key === "dictionary" ? (
              <dl className={styles.archDictStats}>
                <div><dt>Topics</dt><dd>{formatNumber(overview.semantic.topic_count)}</dd></div>
                <div><dt>Metrics</dt><dd>{formatNumber(overview.semantic.metric_count)}</dd></div>
                <div><dt>Facts</dt><dd>{formatNumber(overview.semantic.fact_count)}</dd></div>
              </dl>
            ) : null}
            {currentStep.key === "answer" ? (
              <div className={styles.archAnswerPath}>
                <span>Question</span>
                <i />
                <span>Typed plan</span>
                <i />
                <span>Governed query</span>
                <i />
                <span>Answer + proof</span>
              </div>
            ) : null}
          </div>
        </article>
      </section>

      <section className={styles.archRooms} aria-labelledby="arch-rooms-title">
        <header>
          <span>WHERE THINGS LIVE</span>
          <h3 id="arch-rooms-title">Three rooms, one product</h3>
          <p>Browsers and the model never touch the business database. Only trusted server code does.</p>
        </header>
        <div className={styles.archRoomGrid}>
          {SYSTEM_ROOMS.map((room) => (
            <article key={room.key}>
              <span>{room.eyebrow}</span>
              <h4>{room.title}</h4>
              <small>{room.place}</small>
              <p>{room.plain}</p>
              <ul>
                {room.items.map((item) => <li key={item}>{item}</li>)}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <section className={styles.archSemantic} aria-labelledby="arch-semantic-title">
        <header>
          <div>
            <span>SEMANTIC LAYER</span>
            <h3 id="arch-semantic-title">Albert&apos;s dictionary of business meaning</h3>
            <p>
              {formatNumber(overview.semantic.metric_count)} metric contracts across{" "}
              {formatNumber(overview.semantic.topic_count)} Topics and{" "}
              {formatNumber(overview.semantic.dimension_count)} approved dimensions.
              The chat can only ask these; raw SQL is reserved for internal diagnostics.
            </p>
          </div>
          <div className={styles.archDomainStrip} aria-label="Metric domains">
            {overview.semantic.domains.map((domain) => (
              <div key={domain.id}>
                <strong>{formatNumber(domain.metric_count)}</strong>
                <span>{domain.label}</span>
              </div>
            ))}
          </div>
        </header>

        <div className={styles.archTopicLayout}>
          <div className={styles.archTopicList} role="group" aria-label="Governed Topics">
            {overview.semantic.topics.map((topic) => (
              <button
                type="button"
                key={topic.id}
                aria-pressed={selectedTopic?.id === topic.id}
                onClick={() => setActiveTopic(topic.id)}
              >
                <strong>{topic.label}</strong>
                <span>{formatNumber(topic.metric_count)} metrics</span>
              </button>
            ))}
          </div>
          {selectedTopic ? (
            <article className={styles.archTopicDetail}>
              <span>TOPIC</span>
              <h4>{selectedTopic.label}</h4>
              <p>{selectedTopic.description}</p>
              {selectedTopic.sample_question ? (
                <blockquote>“{selectedTopic.sample_question}”</blockquote>
              ) : null}
              <small>{formatNumber(selectedTopic.metric_count)} governed metrics sit behind this Topic.</small>
            </article>
          ) : null}
        </div>

        <div className={styles.archLayers} aria-label="Meaning resolution layers">
          <header>
            <span>HOW MEANING IS RESOLVED</span>
            <p>Five layers, never a per-tenant SQL fork.</p>
          </header>
          <ol>
            {RESOLUTION_LAYERS.map((layer, index) => (
              <li key={layer.title}>
                <b>{index + 1}</b>
                <div>
                  <strong>{layer.title}</strong>
                  <span>{layer.plain}</span>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <PlanPreviewChat
        onOpenDictionary={(view, id) => setDictionaryJump({ view, id })}
      />

      <SemanticModelPrimer
        semantic={overview.semantic}
        onExplore={(jump) => setDictionaryJump(jump)}
      />

      <DictionaryBrowser
        semantic={overview.semantic}
        jumpTo={dictionaryJump}
        onJumpApplied={clearDictionaryJump}
      />

      <section className={styles.archCta} aria-labelledby="arch-cta-title">
        <div>
          <span>LIVE OPERATIONS</span>
          <h3 id="arch-cta-title">See the fleet and each tenant&apos;s pipeline</h3>
          <p>
            The architecture above is the map. Fleet view shows every connection&apos;s health.
            Open a tenant to walk the live pipeline from connection to readiness.
          </p>
        </div>
        <button type="button" onClick={onOpenFleet}>Open fleet view</button>
      </section>
    </div>
  );
}
