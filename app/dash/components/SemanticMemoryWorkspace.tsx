"use client";

/**
 * "Albert's memory" — the owner-facing view of the deterministic vocabulary
 * rules Albert has learned from conversations (ADR 0115). Every rule is shown
 * with its meaning, governed binding, provenance and usage; the owner can
 * confirm proposals, retire or restore rules, add a rule by hand, and (owner/
 * manager) delete one outright.
 */
import { useCallback, useEffect, useState } from "react";
import styles from "../dash.module.css";
import local from "./semantic-memory.module.css";

type Binding = { view: string; dimension?: string; value?: string };

type Rule = {
  ruleId: string;
  kind: "term_binding" | "preference";
  term: string;
  meaning: string;
  counterMeaning?: string | null;
  binding?: Binding | null;
  status: "proposed" | "confirmed" | "retired";
  source: "albert" | "owner";
  useCount: number;
  lastUsedAt?: string | null;
  createdAt: string;
  updatedAt: string;
};

type Payload = { rules: Rule[]; canDelete: boolean };

async function jsonRequest<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, { cache: "no-store", ...init });
  const payload = await response.json().catch(() => null) as ({ error?: string } & T) | null;
  if (!response.ok) throw new Error(payload?.error || "The learned-rules request could not be completed.");
  if (!payload) throw new Error("The learned-rules service returned an empty response.");
  return payload;
}

function when(value: string | null | undefined): string {
  if (!value) return "never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function bindingLabel(binding: Binding): string {
  const member = binding.dimension ?? binding.view;
  return binding.value ? `${member} = ${binding.value}` : member;
}

export default function SemanticMemoryWorkspace() {
  const [payload, setPayload] = useState<Payload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [newTerm, setNewTerm] = useState("");
  const [newMeaning, setNewMeaning] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      setPayload(await jsonRequest<Payload>("/api/semantic-memory"));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Albert's learned rules could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

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

  const act = (rule: Rule, action: "confirm" | "retire" | "restore" | "delete", success: string) =>
    void mutate(`${action}:${rule.ruleId}`, async () => {
      const next = await jsonRequest<{ rule?: Rule; deleted?: boolean }>("/api/semantic-memory", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, ruleId: rule.ruleId }),
      });
      setPayload((current) => {
        if (!current) return current;
        if (next.deleted) return { ...current, rules: current.rules.filter((r) => r.ruleId !== rule.ruleId) };
        return next.rule ? { ...current, rules: current.rules.map((r) => (r.ruleId === rule.ruleId ? next.rule! : r)) } : current;
      });
    }, success);

  const addRule = () => void mutate("add", async () => {
    const next = await jsonRequest<{ rule: Rule }>("/api/semantic-memory", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ term: newTerm.trim(), meaning: newMeaning.trim() }),
    });
    setPayload((current) => current
      ? { ...current, rules: [next.rule, ...current.rules.filter((r) => r.ruleId !== next.rule.ruleId)] }
      : current);
    setNewTerm("");
    setNewMeaning("");
  }, "Saved. Albert applies this rule whenever the term appears in a question.");

  const rules = payload?.rules ?? [];
  const active = rules.filter((r) => r.status !== "retired");
  const retired = rules.filter((r) => r.status === "retired");

  const ruleRow = (rule: Rule) => (
    <div className={`${local.rule} ${rule.status === "retired" ? local.retired : ""}`} key={rule.ruleId}>
      <div className={local.ruleHead}>
        <span className={local.term}>“{rule.term}”</span>
        <span className={`${local.badge} ${rule.status === "confirmed" ? local.badgeConfirmed : rule.status === "proposed" ? local.badgeProposed : local.badgeRetired}`}>
          {rule.status === "confirmed" ? "Confirmed" : rule.status === "proposed" ? "Proposed — please review" : "Retired"}
        </span>
        {rule.binding ? <span className={local.binding}>{bindingLabel(rule.binding)}</span> : null}
        <div className={local.ruleActions}>
          {rule.status === "proposed" ? (
            <button type="button" onClick={() => act(rule, "confirm", "Confirmed. Albert will rely on this rule.")} disabled={busy !== ""}>
              {busy === `confirm:${rule.ruleId}` ? "…" : "Confirm"}
            </button>
          ) : null}
          {rule.status !== "retired" ? (
            <button type="button" onClick={() => act(rule, "retire", "Retired. Albert stops applying this rule.")} disabled={busy !== ""}>
              {busy === `retire:${rule.ruleId}` ? "…" : "Retire"}
            </button>
          ) : (
            <button type="button" onClick={() => act(rule, "restore", "Restored. Albert applies this rule again.")} disabled={busy !== ""}>
              {busy === `restore:${rule.ruleId}` ? "…" : "Restore"}
            </button>
          )}
          {payload?.canDelete ? (
            <button type="button" onClick={() => act(rule, "delete", "Deleted.")} disabled={busy !== ""}>
              {busy === `delete:${rule.ruleId}` ? "…" : "Delete"}
            </button>
          ) : null}
        </div>
      </div>
      <p className={local.meaning}>means {rule.meaning}</p>
      {rule.counterMeaning ? <p className={local.counter}>not {rule.counterMeaning}</p> : null}
      <p className={local.metaLine}>
        {rule.source === "albert" ? "Learned from a conversation" : "Added by hand"}
        {` · added ${when(rule.createdAt)}`}
        {rule.useCount > 0 ? ` · applied ${rule.useCount} ${rule.useCount === 1 ? "time" : "times"}, last ${when(rule.lastUsedAt)}` : " · not applied yet"}
      </p>
    </div>
  );

  return (
    <section className={styles.organizationWorkspace} aria-labelledby="semantic-memory-title" aria-busy={loading}>
      <div className={styles.organizationSettingsHero}>
        <div>
          <p className={styles.contentEyebrow}>ALBERT&apos;S MEMORY</p>
          <h2 id="semantic-memory-title">Rules Albert has learned from you</h2>
          <p className={local.lede}>
            When you correct how Albert read a term — “General Service is an item, not a category” — or ask it to remember a meaning,
            it becomes a deterministic rule listed here. Albert applies matching rules to every later question and says so in the answer.
            Rules only define your vocabulary; every figure still comes from your governed data. Confirm, retire or add rules any time.
          </p>
        </div>
      </div>

      {error ? <p className={local.error} role="alert">{error}</p> : null}
      {notice ? <p className={local.notice} role="status">{notice}</p> : null}

      {loading ? (
        <p className={local.muted}>Loading…</p>
      ) : (
        <div className={styles.organizationSettingsStack}>
          <div className={styles.organizationSettingsGroup} aria-label="Add a rule">
            <h3 className={styles.organizationSettingsGroupLabel}>Teach Albert a term</h3>
            <div className={`${styles.organizationSettingsCard} ${local.form}`}>
              <label className={local.field}>
                <span>The word or phrase you use</span>
                <input value={newTerm} onChange={(e) => setNewTerm(e.target.value)} maxLength={80} placeholder="general service" />
              </label>
              <label className={local.field}>
                <span>What it means</span>
                <input value={newMeaning} onChange={(e) => setNewMeaning(e.target.value)} maxLength={300} placeholder="the item “Service - General Service”, not the Services category" />
              </label>
              <div className={local.actions}>
                <button
                  type="button"
                  className={`${styles.organizationSettingsButton} ${local.primary}`}
                  onClick={addRule}
                  disabled={busy !== "" || newTerm.trim().length < 2 || newMeaning.trim().length < 3}
                >
                  {busy === "add" ? "Saving…" : "Save rule"}
                </button>
                <span className={local.muted}>You can also just tell Albert in chat: “remember that …”.</span>
              </div>
            </div>
          </div>

          <div className={styles.organizationSettingsGroup} aria-label="Active rules">
            <h3 className={styles.organizationSettingsGroupLabel}>
              {active.length === 0 ? "No rules yet" : `Active rules (${active.length})`}
            </h3>
            <div className={styles.organizationSettingsCard}>
              {active.length === 0 ? (
                <p className={`${local.muted} ${local.rule}`}>
                  Nothing learned yet. Correct Albert in a conversation, ask it to remember a term, or add one above.
                </p>
              ) : active.map(ruleRow)}
            </div>
          </div>

          {retired.length > 0 ? (
            <div className={styles.organizationSettingsGroup} aria-label="Retired rules">
              <h3 className={styles.organizationSettingsGroupLabel}>Retired ({retired.length})</h3>
              <div className={styles.organizationSettingsCard}>{retired.map(ruleRow)}</div>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}
