"use client";

/**
 * "About your business" — the owner-facing surface of the business context
 * layer. Shows the document Albert grounds every answer in, lets owners and
 * managers edit the parts only they can know (goals, vocabulary, how each tool
 * is used, cautions), regenerate it from the connected data, and confirm it.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import styles from "../dash.module.css";
import local from "./business-context.module.css";

type Section = "identity" | "revenue" | "scale" | "goals" | "vocabulary" | "tools" | "cautions";

type Document = {
  version: 1;
  identity: { name: string; summary: string; industry: string; model: string; channels: string[]; locations: Array<{ name: string; role: string | null }> };
  revenue: { basis: string; streams: Array<{ name: string; share: number | null; note: string | null }>; annualBand: string | null; seasonality: string | null };
  scale: { headcount: string | null; customers: string | null; catalogue: string | null; other: string[] };
  goals: { ownerStated: string[]; suggestedFocus: string[]; comparisonPreference: string | null };
  vocabulary: Array<{ term: string; meaning: string; mapsTo: string | null }>;
  tools: Array<{ connector: string; label: string; role: string; sourceOfTruthFor: string[]; dataFrom: string | null; dataThrough: string | null }>;
  cautions: string[];
};

type Stored = {
  document: Document;
  rendered: string;
  status: "draft" | "confirmed";
  ownerLocked: Section[];
  generatorVersion: string | null;
  model: string | null;
  dataThrough: string | null;
  generatedAt: string | null;
  confirmedAt: string | null;
  updatedAt: string;
  connectors: string[];
};

type Payload = { context: Stored | null; canManage: boolean; role: string; activeConnectors: string[]; refreshDue: boolean };

async function jsonRequest<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, { cache: "no-store", ...init });
  const payload = await response.json().catch(() => null) as ({ error?: string } & T) | null;
  if (!response.ok) throw new Error(payload?.error || "The business context request could not be completed.");
  if (!payload) throw new Error("The business context service returned an empty response.");
  return payload;
}

function when(value: string | null | undefined): string {
  if (!value) return "never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

const lines = (values: readonly string[]) => values.join("\n");
const fromLines = (value: string, max: number, maxLength: number) =>
  value.split("\n").map((v) => v.trim()).filter(Boolean).slice(0, max).map((v) => v.slice(0, maxLength));

export default function BusinessContextWorkspace() {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState(false);
  // Editable fields (the parts only the owner can know; everything else regenerates from data).
  const [summary, setSummary] = useState("");
  const [goals, setGoals] = useState("");
  const [focus, setFocus] = useState("");
  const [comparison, setComparison] = useState("");
  const [vocabulary, setVocabulary] = useState("");
  const [toolRoles, setToolRoles] = useState<Record<string, string>>({});
  const [cautions, setCautions] = useState("");

  const context = payload?.context ?? null;

  const seedForm = useCallback((doc: Document) => {
    setSummary(doc.identity.summary);
    setGoals(lines(doc.goals.ownerStated));
    setFocus(lines(doc.goals.suggestedFocus));
    setComparison(doc.goals.comparisonPreference ?? "");
    setVocabulary(lines(doc.vocabulary.map((v) => `${v.term} = ${v.meaning}${v.mapsTo ? ` [${v.mapsTo}]` : ""}`)));
    setToolRoles(Object.fromEntries(doc.tools.map((t) => [t.connector, t.role])));
    setCautions(lines(doc.cautions));
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const next = await jsonRequest<Payload>("/api/business-context");
      setPayload(next);
      if (next.context) seedForm(next.context.document);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "The business context could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, [seedForm]);

  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load]);

  const mutate = useCallback(async (key: string, action: () => Promise<void>, success?: string) => {
    setBusy(key);
    setError("");
    setNotice("");
    try {
      await action();
      if (success) setNotice(success);
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : "The change could not be saved.");
    } finally {
      setBusy("");
    }
  }, []);

  const regenerate = () => void mutate("regenerate", async () => {
    const next = await jsonRequest<{ context: Stored }>("/api/business-context", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "regenerate" }),
    });
    setPayload((current) => current ? { ...current, context: next.context, refreshDue: false } : current);
    seedForm(next.context.document);
    setEditing(false);
  }, "Albert rebuilt the business context from your connected data. Sections you edited were kept.");

  const confirm = () => void mutate("confirm", async () => {
    const next = await jsonRequest<{ context: Stored }>("/api/business-context", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "confirm" }),
    });
    setPayload((current) => current ? { ...current, context: next.context } : current);
  }, "Confirmed. Albert will ground every answer in this description.");

  const save = () => {
    if (!context) return;
    const doc = context.document;
    const nextVocabulary = fromLines(vocabulary, 14, 400).map((line) => {
      const match = /^(.+?)\s*[=:–-]\s*(.+?)(?:\s*\[(.+)\])?$/u.exec(line);
      if (!match) return { term: line.slice(0, 60), meaning: line.slice(0, 160), mapsTo: null };
      return { term: match[1]!.trim().slice(0, 60), meaning: match[2]!.trim().slice(0, 160), mapsTo: match[3]?.trim().slice(0, 120) ?? null };
    });
    const nextTools = doc.tools.map((t) => ({ ...t, role: (toolRoles[t.connector] ?? t.role).trim().slice(0, 180) || t.role }));
    const next: Document = {
      ...doc,
      identity: { ...doc.identity, summary: summary.trim().slice(0, 360) || doc.identity.summary },
      goals: {
        ownerStated: fromLines(goals, 6, 140),
        suggestedFocus: fromLines(focus, 5, 160),
        comparisonPreference: comparison.trim() ? comparison.trim().slice(0, 120) : null,
      },
      vocabulary: nextVocabulary,
      tools: nextTools,
      cautions: fromLines(cautions, 6, 200),
    };
    const locked = new Set<Section>(context.ownerLocked);
    if (next.identity.summary !== doc.identity.summary) locked.add("identity");
    if (JSON.stringify(next.goals) !== JSON.stringify(doc.goals)) locked.add("goals");
    if (JSON.stringify(next.vocabulary) !== JSON.stringify(doc.vocabulary)) locked.add("vocabulary");
    if (JSON.stringify(next.tools) !== JSON.stringify(doc.tools)) locked.add("tools");
    if (JSON.stringify(next.cautions) !== JSON.stringify(doc.cautions)) locked.add("cautions");
    void mutate("save", async () => {
      const saved = await jsonRequest<{ context: Stored }>("/api/business-context", {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ document: next, ownerLocked: [...locked] }),
      });
      setPayload((current) => current ? { ...current, context: saved.context } : current);
      seedForm(saved.context.document);
      setEditing(false);
    }, "Saved. Your edits are kept when Albert refreshes the rest from data.");
  };

  const renderedSections = useMemo(() => {
    if (!context) return [];
    return context.rendered.split("\n").slice(1).filter(Boolean).map((line) => {
      const match = /^\*\*(.+?)\*\*\s*[—:–-]?\s*(.*)$/u.exec(line);
      return match ? { title: match[1]!, body: match[2]! } : { title: "", body: line };
    });
  }, [context]);

  const canManage = payload?.canManage ?? false;

  return (
    <section className={styles.organizationWorkspace} aria-labelledby="business-context-title" aria-busy={loading}>
      <div className={styles.organizationSettingsHero}>
        <div>
          <p className={styles.contentEyebrow}>ABOUT YOUR BUSINESS</p>
          <h2 id="business-context-title">What Albert knows about your business</h2>
          <p className={local.lede}>
            A short description Albert reads before every answer — what the business is, how it makes money, the words you use,
            and which tool is the source of truth for what. Albert builds it from your connected data; you correct and confirm it.
          </p>
        </div>
      </div>

      {error ? <p className={local.error} role="alert">{error}</p> : null}
      {notice ? <p className={local.notice} role="status">{notice}</p> : null}

      {loading ? (
        <p className={local.muted}>Loading…</p>
      ) : !context ? (
        <div className={styles.organizationSettingsStack}>
          <div className={styles.organizationSettingsCard}>
            <div className={styles.organizationSettingsRow}>
              <div className={styles.organizationSettingsRowCopy}>
                <strong>Albert has not described your business yet</strong>
                <p>It will happen on your next question, or you can build it now from {payload?.activeConnectors.length ? payload.activeConnectors.join(", ") : "your connected tools"}.</p>
              </div>
              {canManage ? (
                <button type="button" className={styles.organizationSettingsButton} onClick={regenerate} disabled={busy !== ""}>
                  {busy === "regenerate" ? "Building…" : "Build it now"}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      ) : (
        <div className={styles.organizationSettingsStack}>
          <div className={styles.organizationSettingsGroup} aria-label="Status">
            <div className={styles.organizationSettingsCard}>
              <div className={styles.organizationSettingsRow}>
                <div className={styles.organizationSettingsRowCopy}>
                  <strong>
                    {context.status === "confirmed" ? "Confirmed" : "Draft — please review"}
                    {payload?.refreshDue ? " · refresh from data due" : ""}
                  </strong>
                  <p>
                    Built from data {when(context.generatedAt)}
                    {context.confirmedAt ? ` · confirmed ${when(context.confirmedAt)}` : ""}
                    {context.ownerLocked.length ? ` · your edits: ${context.ownerLocked.join(", ")}` : ""}
                    {context.connectors.length ? ` · tools: ${context.connectors.join(", ")}` : ""}
                  </p>
                </div>
                {canManage ? (
                  <div className={local.actions}>
                    <button type="button" className={styles.organizationSettingsButton} onClick={regenerate} disabled={busy !== ""}>
                      {busy === "regenerate" ? "Rebuilding…" : "Rebuild from data"}
                    </button>
                    <button type="button" className={styles.organizationSettingsButton} onClick={() => setEditing((v) => !v)} disabled={busy !== ""}>
                      {editing ? "Cancel" : "Edit"}
                    </button>
                    {context.status !== "confirmed" || (context.generatedAt && context.confirmedAt && context.generatedAt > context.confirmedAt) ? (
                      <button type="button" className={`${styles.organizationSettingsButton} ${local.primary}`} onClick={confirm} disabled={busy !== ""}>
                        {busy === "confirm" ? "Confirming…" : "Confirm"}
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          {editing ? (
            <div className={styles.organizationSettingsGroup} aria-label="Edit">
              <h3 className={styles.organizationSettingsGroupLabel}>Tell Albert what only you know</h3>
              <div className={`${styles.organizationSettingsCard} ${local.form}`}>
                <label className={local.field}>
                  <span>What the business is (two sentences)</span>
                  <textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={3} maxLength={360} />
                </label>
                <label className={local.field}>
                  <span>Goals and priorities (one per line — growth, margin, labour efficiency, cash flow…)</span>
                  <textarea value={goals} onChange={(e) => setGoals(e.target.value)} rows={4} placeholder={"Grow workshop bookings without adding staff\nKeep wages under 25% of takings"} />
                </label>
                <label className={local.field}>
                  <span>Watch-points Albert suggested from the data (edit or delete)</span>
                  <textarea value={focus} onChange={(e) => setFocus(e.target.value)} rows={3} />
                </label>
                <label className={local.field}>
                  <span>How you like periods compared</span>
                  <input value={comparison} onChange={(e) => setComparison(e.target.value)} maxLength={120} placeholder="same weeks last year" />
                </label>
                <label className={local.field}>
                  <span>Your vocabulary (one per line: term = meaning [where it lives in the data])</span>
                  <textarea value={vocabulary} onChange={(e) => setVocabulary(e.target.value)} rows={6} placeholder={"the floor = retail sales staff\nworkshop = service jobs and labour, not parts [workshop_analytics]"} />
                </label>
                {context.document.tools.map((tool) => (
                  <label className={local.field} key={tool.connector}>
                    <span>{tool.label} ({tool.connector}) — what you use it for</span>
                    <input value={toolRoles[tool.connector] ?? tool.role} onChange={(e) => setToolRoles((current) => ({ ...current, [tool.connector]: e.target.value }))} maxLength={180} />
                  </label>
                ))}
                <label className={local.field}>
                  <span>Things to read with care (one per line)</span>
                  <textarea value={cautions} onChange={(e) => setCautions(e.target.value)} rows={3} />
                </label>
                <div className={local.actions}>
                  <button type="button" className={`${styles.organizationSettingsButton} ${local.primary}`} onClick={save} disabled={busy !== ""}>
                    {busy === "save" ? "Saving…" : "Save"}
                  </button>
                  <button type="button" className={styles.organizationSettingsButton} onClick={() => { seedForm(context.document); setEditing(false); }} disabled={busy !== ""}>
                    Discard
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          <div className={styles.organizationSettingsGroup} aria-label="Document">
            <h3 className={styles.organizationSettingsGroupLabel}>The description Albert reads ({context.rendered.split(/\s+/u).length} words)</h3>
            <div className={`${styles.organizationSettingsCard} ${local.document}`}>
              {renderedSections.map((section, index) => (
                <div className={local.section} key={index}>
                  {section.title ? <strong>{section.title}</strong> : null}
                  <p>{section.body}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
