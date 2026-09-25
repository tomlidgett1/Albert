"use client";

import { AnimatePresence, motion } from "framer-motion";
import dynamic from "next/dynamic";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  flintPlanFromResult,
  parseTestChartResult,
  TEST_CHART_SUITE,
  testChartLabel,
  type TestChartAppearance,
  type TestChartResult,
  type TestChartSuiteCase,
} from "../lib/test-chart";
import styles from "./test-chart-workspace.module.css";

const FlintChartView = dynamic(() => import("./FlintChartView"), {
  ssr: false,
});

type WorkspaceState =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "loading"; question: string }>
  | Readonly<{ kind: "error"; message: string }>
  | Readonly<{ kind: "ready"; result: TestChartResult }>;

type SuiteRow = Readonly<{
  case: TestChartSuiteCase;
  status: "pending" | "running" | "ready" | "error";
  result?: TestChartResult;
  message?: string;
}>;

function resolveAppearance(preference: "light" | "dark" | "system"): TestChartAppearance {
  if (preference === "dark") return "dark";
  if (preference === "light") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function verdictLabel(result: TestChartResult): string {
  if (result.verdict === "pass") return "Suite pass";
  if (result.verdict === "miss") return `Expected ${result.expectedChartTypes.join(" or ")}`;
  return "Open question";
}

export default function TestChartWorkspace({
  appearance = "system",
}: Readonly<{ appearance?: "light" | "dark" | "system" }>) {
  const [question, setQuestion] = useState("");
  const [state, setState] = useState<WorkspaceState>({ kind: "idle" });
  const [specOpen, setSpecOpen] = useState(false);
  const [dataOpen, setDataOpen] = useState(false);
  const [suiteRows, setSuiteRows] = useState<readonly SuiteRow[]>([]);
  const [suiteRunning, setSuiteRunning] = useState(false);
  const requestIdRef = useRef(0);
  const suiteTokenRef = useRef(0);

  const canSubmit = question.trim().length > 0 && state.kind !== "loading" && !suiteRunning;
  const families = useMemo(() => {
    const groups = new Map<string, TestChartSuiteCase[]>();
    for (const item of TEST_CHART_SUITE) {
      const list = groups.get(item.family) ?? [];
      list.push(item);
      groups.set(item.family, list);
    }
    return [...groups.entries()];
  }, []);

  const requestChart = useCallback(async (raw: string): Promise<TestChartResult> => {
    const response = await fetch("/api/test-chart", {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        question: raw,
        appearance: resolveAppearance(appearance),
      }),
    });
    const payload = await response.json().catch(() => null) as { error?: string } | null;
    if (!response.ok) {
      throw new Error(payload && typeof payload.error === "string" ? payload.error : "The test chart could not be drawn.");
    }
    const result = parseTestChartResult(payload);
    if (!result) throw new Error("The chart response was not valid.");
    return result;
  }, [appearance]);

  const ask = useCallback(async (raw: string) => {
    const nextQuestion = raw.trim();
    if (!nextQuestion || suiteRunning) return;
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setQuestion(nextQuestion);
    setSpecOpen(false);
    setDataOpen(false);
    setState({ kind: "loading", question: nextQuestion });
    try {
      const result = await requestChart(nextQuestion);
      if (requestId !== requestIdRef.current) return;
      setState({ kind: "ready", result });
    } catch (error) {
      if (requestId !== requestIdRef.current) return;
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : "The test chart could not be drawn.",
      });
    }
  }, [requestChart, suiteRunning]);

  const runSuite = useCallback(async () => {
    const token = suiteTokenRef.current + 1;
    suiteTokenRef.current = token;
    requestIdRef.current += 1;
    setSuiteRunning(true);
    setSpecOpen(false);
    setDataOpen(false);
    const rows: SuiteRow[] = TEST_CHART_SUITE.map((item) => ({ case: item, status: "pending" }));
    setSuiteRows(rows);
    setState({ kind: "idle" });
    for (const [index, item] of TEST_CHART_SUITE.entries()) {
      if (suiteTokenRef.current !== token) return;
      rows[index] = { case: item, status: "running" };
      setSuiteRows([...rows]);
      setQuestion(item.question);
      setState({ kind: "loading", question: item.question });
      try {
        const result = await requestChart(item.question);
        if (suiteTokenRef.current !== token) return;
        rows[index] = { case: item, status: "ready", result };
        setSuiteRows([...rows]);
        setState({ kind: "ready", result });
      } catch (error) {
        if (suiteTokenRef.current !== token) return;
        const message = error instanceof Error ? error.message : "The test chart could not be drawn.";
        rows[index] = { case: item, status: "error", message };
        setSuiteRows([...rows]);
        setState({ kind: "error", message });
        break;
      }
    }
    if (suiteTokenRef.current === token) setSuiteRunning(false);
  }, [requestChart]);

  const specPreview = useMemo(() => {
    if (state.kind !== "ready") return "";
    return JSON.stringify({
      semantic_types: state.result.flint.semantic_types,
      ...(state.result.flint.field_display_names
        ? { field_display_names: state.result.flint.field_display_names }
        : {}),
      chart_spec: state.result.flint.chart_spec,
    }, null, 2);
  }, [state]);

  const dataPreview = useMemo(() => {
    if (state.kind !== "ready") return "";
    return JSON.stringify(state.result.data, null, 2);
  }, [state]);

  const suiteSummary = useMemo(() => {
    const ready = suiteRows.filter((row) => row.status === "ready");
    const passed = ready.filter((row) => row.result?.verdict === "pass").length;
    if (ready.length === 0) return "";
    return `${passed} of ${ready.length} suite cases picked an accepted Flint form`;
  }, [suiteRows]);

  return (
    <section className={styles.workspace} aria-label="Test chart">
      <header className={styles.header}>
        <p>
          Luna Max Fast invents a small table, writes a Flint spec (semantic types,
          chart type, encodings), and Albert compiles it. Use the suite to check that
          the agent picks the form that fits the claim.
        </p>
      </header>

      <div className={styles.body}>
        <div className={styles.suiteToolbar}>
          <p className={styles.suiteLead}>Chart-choice suite</p>
          <button
            className={styles.suiteRun}
            type="button"
            disabled={suiteRunning || state.kind === "loading"}
            onClick={() => void runSuite()}
          >
            {suiteRunning ? "Running suite" : "Run suite"}
          </button>
        </div>

        {families.map(([family, items]) => (
          <div className={styles.suiteFamily} key={family}>
            <p className={styles.familyLabel}>{family}</p>
            <div className={styles.examples} role="group" aria-label={`${family} suite cases`}>
              {items.map((item) => (
                <button
                  key={item.id}
                  className={styles.example}
                  type="button"
                  disabled={suiteRunning || state.kind === "loading"}
                  title={item.intent}
                  onClick={() => void ask(item.question)}
                >
                  {item.question}
                </button>
              ))}
            </div>
          </div>
        ))}

        <form
          className={styles.composer}
          onSubmit={(event) => {
            event.preventDefault();
            void ask(question);
          }}
        >
          <input
            className={styles.field}
            type="text"
            value={question}
            maxLength={500}
            placeholder="Ask a made-up question…"
            aria-label="Test chart question"
            disabled={suiteRunning || state.kind === "loading"}
            onChange={(event) => setQuestion(event.target.value)}
          />
          <button className={styles.submit} type="submit" disabled={!canSubmit}>
            {state.kind === "loading" ? "Drawing" : "Draw chart"}
          </button>
        </form>

        <p className={styles.notice}>
          Every number on this tab is invented. Flint decides scales, labels and layout
          from the spec. This is not live tenant data.
        </p>

        {suiteRows.length > 0 ? (
          <div className={styles.suiteBoard} aria-label="Suite results">
            {suiteSummary ? <p className={styles.suiteSummary}>{suiteSummary}</p> : null}
            <ol className={styles.suiteList}>
              {suiteRows.map((row) => (
                <li key={row.case.id} className={styles.suiteItem} data-status={row.status}>
                  <span className={styles.suiteFamilyChip}>{row.case.family}</span>
                  <span className={styles.suiteQuestion}>{row.case.question}</span>
                  <span className={styles.suiteResult}>
                    {row.status === "pending" ? "Waiting" : null}
                    {row.status === "running" ? "Drawing" : null}
                    {row.status === "error" ? row.message : null}
                    {row.status === "ready" && row.result
                      ? `${row.result.chartType} · ${verdictLabel(row.result)}`
                      : null}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        ) : null}

        {state.kind === "error" ? <p className={styles.error}>{state.message}</p> : null}

        {state.kind === "loading" ? (
          <div className={styles.card}>
            <div className={styles.figure}>
              <p className={styles.pending} role="status">
                Luna Max Fast is choosing a Flint form and inventing the rows…
              </p>
            </div>
          </div>
        ) : null}

        {state.kind === "ready" ? (
          <article className={styles.card}>
            <div className={styles.cardHeader}>
              <div className={styles.cardCopy}>
                <h2>{state.result.title}</h2>
                {state.result.subtitle ? <p>{state.result.subtitle}</p> : null}
                <p>{state.result.rationale}</p>
              </div>
              <div className={styles.badges}>
                <span className={styles.badge}>{testChartLabel(state.result.chartType)}</span>
                <span className={styles.badge}>
                  {state.result.source === "luna" ? "Luna Max Fast" : "Fallback"}
                </span>
                <span className={styles.badge} data-verdict={state.result.verdict}>
                  {verdictLabel(state.result)}
                </span>
              </div>
            </div>
            <figure className={styles.figure}>
              <FlintChartView
                plan={flintPlanFromResult(state.result)}
                appearance={state.result.appearance}
                title={state.result.title}
              />
            </figure>
            {state.result.warnings.length > 0 ? (
              <p className={styles.warning}>{state.result.warnings.join(" ")}</p>
            ) : null}
            <button
              className={styles.dataToggle}
              type="button"
              aria-expanded={specOpen}
              onClick={() => setSpecOpen((open) => !open)}
            >
              Flint spec
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
            <AnimatePresence>
              {specOpen ? (
                <motion.div
                  className={styles.dataPanel}
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.4, ease: [0.04, 0.62, 0.23, 0.98] }}
                >
                  <div className={styles.dataInner}>
                    <pre>{specPreview}</pre>
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>
            <button
              className={styles.dataToggle}
              type="button"
              aria-expanded={dataOpen}
              onClick={() => setDataOpen((open) => !open)}
            >
              Invented data
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <path d="m6 9 6 6 6-6" />
              </svg>
            </button>
            <AnimatePresence>
              {dataOpen ? (
                <motion.div
                  className={styles.dataPanel}
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.4, ease: [0.04, 0.62, 0.23, 0.98] }}
                >
                  <div className={styles.dataInner}>
                    <pre>{dataPreview}</pre>
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </article>
        ) : null}
      </div>
    </section>
  );
}
