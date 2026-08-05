"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { RawDebugEntry, RawDebugTurn } from "../lib/raw-debug";
import {
  readableTerm,
  summarizeGovernedTurn,
  type GovernedTurnSummary,
} from "../lib/governed-summary";
import styles from "./raw-debugger.module.css";

type RawDebuggerProps = {
  turns: readonly RawDebugTurn[];
  onClose: () => void;
  onClear: () => void;
};

const kindLabels: Record<RawDebugEntry["kind"], string> = {
  request: "REQ",
  response: "RES",
  frame: "SSE",
  event: "EVT",
  dropped: "DROP",
  note: "NOTE",
  error: "ERR",
  done: "END",
};

function formatMs(value: number): string {
  if (value < 1_000) return `${value}ms`;
  return `${(value / 1_000).toFixed(2)}s`;
}

function formatDelta(value: number): string {
  return value <= 0 ? "—" : `+${formatMs(value)}`;
}

/** Server-side gap between this trace event and the previous one. */
function serverGaps(entries: readonly RawDebugEntry[]): Map<number, number> {
  const gaps = new Map<number, number>();
  let previous: number | undefined;
  for (const entry of entries) {
    if (!entry.serverAt) continue;
    const at = Date.parse(entry.serverAt);
    if (!Number.isFinite(at)) continue;
    if (previous !== undefined) gaps.set(entry.seq, at - previous);
    previous = at;
  }
  return gaps;
}

function EntryRow({
  entry,
  serverGapMs,
}: {
  entry: RawDebugEntry;
  serverGapMs?: number;
}) {
  const [open, setOpen] = useState(false);
  const payload = entry.data !== undefined
    ? JSON.stringify(entry.data, null, 2)
    : entry.raw;
  const expandable = Boolean(payload);

  return (
    <div className={styles.entry} data-kind={entry.kind}>
      <button
        type="button"
        className={styles.entryHead}
        onClick={() => expandable && setOpen((current) => !current)}
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
      >
        <span className={styles.entryAt}>{formatMs(entry.atMs)}</span>
        <span className={styles.entryDelta}>{formatDelta(entry.deltaMs)}</span>
        <span className={styles.entryKind} data-kind={entry.kind}>{kindLabels[entry.kind]}</span>
        <span className={styles.entryLabel}>{entry.label}</span>
        {serverGapMs !== undefined ? (
          <span className={styles.entryServerGap} title="Server-side gap since the previous trace event">
            srv {formatDelta(serverGapMs)}
          </span>
        ) : null}
        {entry.bytes !== undefined ? <span className={styles.entryBytes}>{entry.bytes}B</span> : null}
      </button>
      {open && payload ? <pre className={styles.entryPayload}>{payload}</pre> : null}
    </div>
  );
}

function Chips({ values, empty = "none" }: { values: readonly string[]; empty?: string }) {
  if (values.length === 0) return <span className={styles.simpleEmptyValue}>{empty}</span>;
  return (
    <span className={styles.chips}>
      {values.map((value) => <span key={value} className={styles.chip}>{value}</span>)}
    </span>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={styles.simpleField}>
      <span className={styles.simpleFieldLabel}>{label}</span>
      <span className={styles.simpleFieldValue}>{children}</span>
    </div>
  );
}

function SimpleView({ summary }: { summary: GovernedTurnSummary }) {
  const hasAnything = summary.steps.length > 0
    || summary.queries.length > 0
    || summary.tables.length > 0
    || summary.answer
    || summary.clarification
    || summary.errors.length > 0;

  if (!hasAnything) {
    return <p className={styles.empty}>No governed decisions recorded for this turn yet.</p>;
  }

  return (
    <div className={styles.simple}>
      {summary.steps.length > 0 ? (
        <section className={styles.simpleSection}>
          <h3 className={styles.simpleHeading}>Pipeline</h3>
          <ol className={styles.pipeline}>
            {summary.steps.map((step) => (
              <li key={step.id} className={styles.pipelineStep} data-status={step.status}>
                <span className={styles.pipelineStage}>{step.stage}</span>
                <span className={styles.pipelineBody}>
                  <span className={styles.pipelineLabel}>{step.label}</span>
                  {step.detail ? <span className={styles.pipelineDetail}>{step.detail}</span> : null}
                </span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {summary.queries.length > 0 ? (
        <section className={styles.simpleSection}>
          <h3 className={styles.simpleHeading}>Topics queried ({summary.queries.length})</h3>
          {summary.queries.map((query) => (
            <div key={query.id} className={styles.card}>
              <p className={styles.cardTitle}>{readableTerm(query.topic)}</p>
              <Field label="Topic id"><code className={styles.code}>{query.topic}</code></Field>
              <Field label="Metrics"><Chips values={query.metrics.map(readableTerm)} /></Field>
              <Field label="Dimensions"><Chips values={query.dimensions.map(readableTerm)} empty="no group-by" /></Field>
              <Field label="Lens">{query.lens || "—"}</Field>
              <Field label="Period">
                {query.timeRange.label}
                <span className={styles.subtle}>
                  {" "}{query.timeRange.start} → {query.timeRange.end} ({query.timeRange.timezone})
                </span>
              </Field>
            </div>
          ))}
        </section>
      ) : null}

      {summary.tables.length > 0 ? (
        <section className={styles.simpleSection}>
          <h3 className={styles.simpleHeading}>Tables returned ({summary.tables.length})</h3>
          {summary.tables.map((table) => (
            <div key={table.id} className={styles.card}>
              <p className={styles.cardTitle}>{table.caption}</p>
              <Field label="Result">
                <code className={styles.code}>{table.resultId}</code>
                <span className={styles.subtle}> · {table.rowCount} row{table.rowCount === 1 ? "" : "s"} × {table.columns.length} column{table.columns.length === 1 ? "" : "s"}</span>
              </Field>
              <Field label="Columns">
                <Chips values={table.columns.map((column) => `${column.label} (${column.type}${column.currency ? ` ${column.currency}` : ""})`)} />
              </Field>
              {table.categories.map((category) => (
                <Field key={category.key} label={category.label}>
                  <Chips values={category.values} empty="no values" />
                  {category.distinctCount > category.values.length ? (
                    <span className={styles.subtle}> +{category.distinctCount - category.values.length} more</span>
                  ) : null}
                  <span className={styles.subtle}> · {category.distinctCount} distinct</span>
                </Field>
              ))}
              <Field label="Sources">
                <Chips values={table.provenance.sources.map((source) => `${source.label} → ${source.dataThrough}`)} />
              </Field>
              {table.provenance.definitions.length > 0 ? (
                <Field label="Definitions">
                  <span className={styles.definitions}>
                    {table.provenance.definitions.map((definition) => (
                      <span key={definition.metric} className={styles.definition}>
                        <b>{definition.label}</b> — {definition.definition}
                      </span>
                    ))}
                  </span>
                </Field>
              ) : null}
              {table.provenance.coverage?.length ? (
                <Field label="Coverage">
                  <Chips values={table.provenance.coverage.map((item) => `${item.label} ${item.value}${item.unit === "percent" ? "%" : " records"}`)} />
                </Field>
              ) : null}
              <Field label="Bundle">
                <code className={styles.code}>{table.provenance.semanticBundleHash.slice(0, 16)}…</code>
                <span className={styles.subtle}> · identity graph v{table.provenance.identityGraph.version}</span>
              </Field>
            </div>
          ))}
        </section>
      ) : null}

      {summary.charts.length > 0 ? (
        <section className={styles.simpleSection}>
          <h3 className={styles.simpleHeading}>Charts</h3>
          {summary.charts.map((chart) => (
            <div key={chart.id} className={styles.card}>
              <p className={styles.cardTitle}>{chart.caption}</p>
              <Field label="Shape">{chart.chartType} · {chart.xKey} → {chart.yKey}</Field>
              <Field label="From result"><code className={styles.code}>{chart.dataRef}</code></Field>
            </div>
          ))}
        </section>
      ) : null}

      {summary.validations.length > 0 ? (
        <section className={styles.simpleSection}>
          <h3 className={styles.simpleHeading}>Validations ({summary.validations.length})</h3>
          <ul className={styles.validations}>
            {summary.validations.map((validation) => (
              <li key={validation.id} className={styles.validation} data-outcome={validation.outcome}>
                <span className={styles.validationOutcome}>{validation.outcome}</span>
                <span className={styles.validationBody}>
                  <code className={styles.code}>{validation.name}</code>
                  <span className={styles.pipelineDetail}>{validation.detail}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {summary.clarification ? (
        <section className={styles.simpleSection}>
          <h3 className={styles.simpleHeading}>Clarification asked</h3>
          <div className={styles.card}>
            <p className={styles.cardTitle}>{summary.clarification.question}</p>
            <Field label="Options">
              <Chips values={summary.clarification.options.map((option) => `${option.label} (${option.id})`)} />
            </Field>
          </div>
        </section>
      ) : null}

      {summary.answer ? (
        <section className={styles.simpleSection}>
          <h3 className={styles.simpleHeading}>Answer</h3>
          <div className={styles.card}>
            <Field label="State"><span className={styles.state}>{summary.answer.state}</span></Field>
            <Field label="Claims">
              {summary.answer.claims.length === 0 ? (
                <span className={styles.simpleEmptyValue}>none</span>
              ) : (
                <span className={styles.definitions}>
                  {summary.answer.claims.map((claim, index) => (
                    <span key={`${claim.statement}_${index}`} className={styles.definition}>
                      <b>{claim.assertion}</b> — {claim.statement}
                      <span className={styles.subtle}>
                        {" "}[{claim.refs.map((ref) => `${ref.resultId}#${ref.rowIndex}.${ref.columnKey}`).join(", ")}]
                      </span>
                    </span>
                  ))}
                </span>
              )}
            </Field>
            <Field label="Follow-ups"><Chips values={summary.answer.followUps} empty="none" /></Field>
          </div>
        </section>
      ) : null}

      {summary.narratives.length > 0 ? (
        <section className={styles.simpleSection}>
          <h3 className={styles.simpleHeading}>Narrative</h3>
          <ul className={styles.narratives}>
            {summary.narratives.map((narrative, index) => (
              <li key={`${index}_${narrative.slice(0, 24)}`}>{narrative}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {summary.errors.length > 0 ? (
        <section className={styles.simpleSection}>
          <h3 className={styles.simpleHeading}>Errors</h3>
          <ul className={styles.narratives}>
            {summary.errors.map((message, index) => (
              <li key={`${index}_${message.slice(0, 24)}`} className={styles.errorText}>{message}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

export default function RawDebugger({ turns, onClose, onClear }: RawDebuggerProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<"simple" | "raw">("simple");
  const [filter, setFilter] = useState("");
  const [copied, setCopied] = useState(false);
  const entriesRef = useRef<HTMLDivElement | null>(null);

  const turn = turns.find((item) => item.id === selectedId) ?? turns[0];
  const summary = useMemo(
    () => summarizeGovernedTurn(turn?.events ?? []),
    [turn],
  );
  const gaps = useMemo(() => (turn ? serverGaps(turn.entries) : new Map<number, number>()), [turn]);
  const entries = useMemo(() => {
    if (!turn) return [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return turn.entries;
    return turn.entries.filter((entry) => (
      entry.label.toLowerCase().includes(needle)
      || entry.kind.includes(needle)
      || (entry.raw?.toLowerCase().includes(needle) ?? false)
      || (entry.data !== undefined && JSON.stringify(entry.data).toLowerCase().includes(needle))
    ));
  }, [turn, filter]);

  // Follow the tail only while the turn is live, the way a network panel does.
  const liveEntryCount = turn?.status === "streaming" && view === "raw" ? turn.entries.length : 0;
  useEffect(() => {
    if (liveEntryCount === 0) return;
    const host = entriesRef.current;
    if (host) host.scrollTop = host.scrollHeight;
  }, [liveEntryCount]);

  const copyTurn = async () => {
    if (!turn) return;
    try {
      await navigator.clipboard.writeText(
        JSON.stringify(view === "simple" ? summary : turn, null, 2),
      );
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_400);
    } catch {
      // Clipboard permission is not guaranteed; the payload stays expandable inline.
    }
  };

  return (
    <aside className={styles.panel} aria-label="Raw debugger">
      <header className={styles.header}>
        <span className={styles.title}>Raw debugger</span>
        <span className={styles.tabs} role="tablist" aria-label="Debugger view">
          {(["simple", "raw"] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="tab"
              aria-selected={view === option}
              className={`${styles.tab} ${view === option ? styles.tabActive : ""}`}
              onClick={() => setView(option)}
            >
              {option === "simple" ? "Simple" : "Raw"}
            </button>
          ))}
        </span>
        <span className={styles.headerSpacer} />
        <button type="button" className={styles.headerButton} onClick={copyTurn} disabled={!turn}>
          {copied ? "Copied" : "Copy JSON"}
        </button>
        <button type="button" className={styles.headerButton} onClick={onClear} disabled={turns.length === 0}>
          Clear
        </button>
        <button type="button" className={styles.headerButton} onClick={onClose} aria-label="Close raw debugger">
          ✕
        </button>
      </header>

      {turns.length === 0 || !turn ? (
        <p className={styles.empty}>Send a question. Every request, response header, SSE frame, and trace event will be recorded here.</p>
      ) : (
        <>
          <div className={styles.turnBar}>
            <label className={styles.turnPickerLabel}>
              Turn
              <select
                className={styles.turnPicker}
                value={turn.id}
                onChange={(changeEvent) => setSelectedId(changeEvent.target.value)}
              >
                {turns.map((item, index) => (
                  <option key={item.id} value={item.id}>
                    {index === 0 ? "latest" : `−${index}`} · {item.prompt.slice(0, 42) || "(no prompt)"}
                  </option>
                ))}
              </select>
            </label>
            <span className={styles.turnStatus} data-status={turn.status}>{turn.status}</span>
          </div>

          <dl className={styles.summary}>
            <div><dt>runtime</dt><dd>{turn.runtime ?? "—"}</dd></div>
            <div><dt>http</dt><dd>{turn.httpStatus ?? "—"}</dd></div>
            <div><dt>ttfb</dt><dd>{turn.ttfbMs === undefined ? "—" : formatMs(turn.ttfbMs)}</dd></div>
            <div><dt>total</dt><dd>{turn.durationMs === undefined ? "live" : formatMs(turn.durationMs)}</dd></div>
            <div><dt>frames</dt><dd>{turn.entries.filter((entry) => entry.kind === "frame").length}</dd></div>
            <div><dt>events</dt><dd>{turn.entries.filter((entry) => entry.kind === "event").length}</dd></div>
            <div className={styles.summaryWide}><dt>conversation</dt><dd>{turn.conversationId ?? "—"}</dd></div>
            <div className={styles.summaryWide}><dt>turn</dt><dd>{turn.turnId ?? "—"}</dd></div>
          </dl>

          {Object.keys(turn.eventCounts).length > 0 ? (
            <div className={styles.counts}>
              {Object.entries(turn.eventCounts).map(([type, count]) => (
                <span key={type} className={styles.count}>{type} <b>{count}</b></span>
              ))}
            </div>
          ) : null}

          {view === "simple" ? (
            <div className={styles.entries}>
              <SimpleView summary={summary} />
            </div>
          ) : (
            <>
              <input
                className={styles.filter}
                type="search"
                value={filter}
                placeholder="Filter entries…"
                onChange={(changeEvent) => setFilter(changeEvent.target.value)}
                aria-label="Filter debugger entries"
              />

              <div className={styles.entries} ref={entriesRef}>
                {entries.length === 0 ? (
                  <p className={styles.empty}>No entries match this filter.</p>
                ) : entries.map((entry) => (
                  <EntryRow key={entry.seq} entry={entry} serverGapMs={gaps.get(entry.seq)} />
                ))}
              </div>
            </>
          )}
        </>
      )}
    </aside>
  );
}
