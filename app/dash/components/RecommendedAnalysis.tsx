"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import Image from "next/image";
import { dailyBriefAsk, isActionRecommendation, DAILY_BRIEF_MAX_AGE_MS, DAILY_BRIEF_WINDOW_MS } from "@/services/recommended-analysis/src/daily-brief";
import type { RecommendedQuestion } from "@/services/recommended-analysis/src/playbook";
import { CONNECTOR_LOGOS, type TraceConnectorId } from "./connectors";
import styles from "../dash.module.css";

type RecommendedPayload = Readonly<{
  recommendations: readonly RecommendedQuestion[];
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
  expiresAt: string;
  timezone: string;
}>;

function isTool(value: unknown): value is TraceConnectorId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CONNECTOR_LOGOS, value);
}

function isRecommendedQuestion(value: unknown): value is RecommendedQuestion {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string"
    && isActionRecommendation(item.title, item.why)
    && typeof item.question === "string" && item.question.length >= 12
    && typeof item.why === "string"
    && isTool(item.tool);
}

function parsePayload(value: unknown): RecommendedPayload | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Partial<RecommendedPayload>;
  const start = Date.parse(payload.windowStart ?? "");
  const end = Date.parse(payload.windowEnd ?? "");
  const generated = Date.parse(payload.generatedAt ?? "");
  const expires = Date.parse(payload.expiresAt ?? "");
  const now = Date.now();
  if (end - start !== DAILY_BRIEF_WINDOW_MS || !Number.isFinite(generated) || generated < end || generated > now
    || end > now || expires !== end + DAILY_BRIEF_MAX_AGE_MS || expires <= now
    || typeof payload.timezone !== "string" || !Array.isArray(payload.recommendations)) return null;
  return { ...payload, recommendations: payload.recommendations.filter(isRecommendedQuestion).slice(0, 3) } as RecommendedPayload;
}

/** Concrete investigation prompts stay below the centred composer and carry their evidence window. */
export default function RecommendedAnalysis({ onAsk, reduceMotion }: Readonly<{
  onAsk: (question: string) => void;
  reduceMotion: boolean;
}>) {
  const [brief, setBrief] = useState<RecommendedPayload | null>(null);
  const [checkedAt, setCheckedAt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let active: AbortController | null = null;
    const refresh = async () => {
      if (document.visibilityState === "hidden" || active) return;
      setCheckedAt(Date.now());
      const controller = new AbortController();
      active = controller;
      const timeout = window.setTimeout(() => controller.abort(), 15_000);
      try {
        const response = await fetch("/api/recommended-analysis", { cache: "no-store", signal: controller.signal });
        if (!response.ok) {
          if (!cancelled && (response.status === 401 || response.status === 403)) setBrief(null);
          return;
        }
        const payload = parsePayload(await response.json());
        if (!cancelled) setBrief(payload);
      } catch {
        // A transient failure may retain a still-current look until its exact expiry.
      } finally {
        window.clearTimeout(timeout);
        active = null;
      }
    };
    const refreshVisible = () => { void refresh(); };
    refreshVisible();
    const poll = window.setInterval(refreshVisible, 60_000);
    window.addEventListener("focus", refreshVisible);
    document.addEventListener("visibilitychange", refreshVisible);
    return () => {
      cancelled = true;
      active?.abort();
      window.clearInterval(poll);
      window.removeEventListener("focus", refreshVisible);
      document.removeEventListener("visibilitychange", refreshVisible);
    };
  }, []);

  useEffect(() => {
    if (!brief) return;
    const expires = window.setTimeout(() => setBrief(null), Math.max(0, Date.parse(brief.expiresAt) - Date.now()));
    return () => window.clearTimeout(expires);
  }, [brief]);

  const recommendations = brief?.recommendations ?? [];
  if (recommendations.length === 0 || !brief) return null;
  const minutes = Math.max(0, Math.floor((checkedAt - Date.parse(brief.generatedAt)) / 60_000));
  const updated = minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : "1 day ago";

  return (
    <motion.section
      className={styles.recommendedAnalysis}
      aria-label="What to look at next"
      initial={reduceMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.32, ease: [0.22, 1, 0.36, 1] }}
    >
      <p className={styles.recommendedAnalysisFreshness}>
        Last 7 days <span aria-hidden="true">·</span> <time dateTime={brief.generatedAt}>Updated {updated}</time>
      </p>
      {recommendations.map((item) => (
        <button
          className={styles.recommendedAnalysisRow}
          key={item.id}
          type="button"
          aria-label={`Ask: ${item.title}`}
          onClick={() => onAsk(dailyBriefAsk(item, brief))}
        >
          <span className={styles.recommendedAnalysisTool} aria-hidden="true">
            {isTool(item.tool) ? <Image src={CONNECTOR_LOGOS[item.tool]} alt="" width={14} height={14} unoptimized /> : null}
          </span>
          <span className={styles.recommendedAnalysisSentence}>{item.title}</span>
          <svg className={styles.recommendedAnalysisChevron} viewBox="0 0 24 24" aria-hidden="true">
            <path d="m9 5 7 7-7 7" />
          </svg>
        </button>
      ))}
    </motion.section>
  );
}
