"use client";

import { useCallback, useEffect, useState } from "react";
import { albertModelById, isAlbertModelId } from "@/packages/shared/src";
import styles from "../dash.module.css";

type UsageEntry = Readonly<{
  usageLedgerId: string;
  conversationId: string;
  turnId: string;
  recordedAt: string;
  model: string;
  fastMode: boolean;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  estimatedCostUsdMicros: number;
  query: string;
  conversationTitle: string | null;
}>;

type UsagePayload = Readonly<{
  entries: readonly UsageEntry[];
  totals: Readonly<{
    queries: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsdMicros: number;
  }>;
}>;

function formatTokens(value: number) {
  return new Intl.NumberFormat("en-AU").format(value);
}

function formatUsd(micros: number) {
  const usd = micros / 1_000_000;
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatWhen(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function modelLabel(model: string, fastMode: boolean) {
  const name = isAlbertModelId(model) ? albertModelById(model).label : model;
  return fastMode ? `${name} Fast` : name;
}

export default function UsageWorkspace({
  refreshToken,
}: Readonly<{ refreshToken: number }>) {
  const [payload, setPayload] = useState<UsagePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/usage?limit=100", { cache: "no-store" });
      const body = await response.json().catch(() => null) as (UsagePayload & { error?: string }) | null;
      if (!response.ok) throw new Error(body?.error || "Usage could not be loaded.");
      if (!body || !Array.isArray(body.entries) || !body.totals) {
        throw new Error("Usage returned an empty response.");
      }
      setPayload(body);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Usage could not be loaded.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load, refreshToken]);

  const totals = payload?.totals;
  const entries = payload?.entries ?? [];

  return (
    <div className={styles.organizationSettingsStack} aria-busy={loading}>
      {error ? (
        <div className={styles.organizationSettingsAlert} data-kind="error" role="alert">
          <strong>Usage unavailable</strong>
          <span>{error}</span>
        </div>
      ) : null}

      {totals ? (
        <p className={styles.usageSummary}>
          {formatTokens(totals.queries)} {totals.queries === 1 ? "query" : "queries"}
          <span aria-hidden="true"> · </span>
          {formatTokens(totals.inputTokens)} in
          <span aria-hidden="true"> · </span>
          {formatTokens(totals.outputTokens)} out
          <span aria-hidden="true"> · </span>
          {formatUsd(totals.estimatedCostUsdMicros)}
        </p>
      ) : null}

      <section className={styles.organizationSettingsGroup} aria-label="Query usage">
        <div className={styles.usageTableCard}>
          {loading && !payload ? (
            <p className={styles.usageEmptyCopy}>Loading usage…</p>
          ) : error ? (
            <p className={styles.usageEmptyCopy}>Usage could not be shown.</p>
          ) : entries.length === 0 ? (
            <div className={styles.usageEmpty}>
              <strong>No queries yet</strong>
              <span>Token counts and API cost appear here after each chat turn, newest first.</span>
            </div>
          ) : (
            <div className={styles.usageTableScroll}>
              <table className={styles.usageTable}>
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Query</th>
                    <th scope="col">Model</th>
                    <th scope="col" className={styles.usageNumeric}>Input</th>
                    <th scope="col" className={styles.usageNumeric}>Output</th>
                    <th scope="col" className={styles.usageNumeric}>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <tr key={entry.usageLedgerId}>
                      <td className={styles.usageDate}>{formatWhen(entry.recordedAt)}</td>
                      <td className={styles.usageQuery} title={entry.query}>
                        {entry.query || entry.conversationTitle || "Untitled query"}
                      </td>
                      <td className={styles.usageModel}>{modelLabel(entry.model, entry.fastMode)}</td>
                      <td className={styles.usageNumeric}>{formatTokens(entry.inputTokens)}</td>
                      <td className={styles.usageNumeric}>{formatTokens(entry.outputTokens)}</td>
                      <td className={styles.usageCost}>{formatUsd(entry.estimatedCostUsdMicros)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <p className={styles.usageFootnote}>
          Estimated from the published OpenAI and xAI rate cards, including Fast / Priority and
          Australian OpenAI residency where they apply. Provider invoices remain the source of truth.
        </p>
      </section>
    </div>
  );
}
