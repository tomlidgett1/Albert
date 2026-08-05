"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { RawDebugEntry, RawDebugTurn } from "../lib/raw-debug";
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

export default function RawDebugger({ turns, onClose, onClear }: RawDebuggerProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [copied, setCopied] = useState(false);
  const entriesRef = useRef<HTMLDivElement | null>(null);

  const turn = turns.find((item) => item.id === selectedId) ?? turns[0];
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
  const liveEntryCount = turn?.status === "streaming" ? turn.entries.length : 0;
  useEffect(() => {
    if (liveEntryCount === 0) return;
    const host = entriesRef.current;
    if (host) host.scrollTop = host.scrollHeight;
  }, [liveEntryCount]);

  const copyTurn = async () => {
    if (!turn) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(turn, null, 2));
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
    </aside>
  );
}
