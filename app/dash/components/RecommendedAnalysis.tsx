"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import Image from "next/image";
import type { RecommendedQuestion } from "@/services/recommended-analysis/src/playbook";
import { CONNECTOR_LOGOS, type TraceConnectorId } from "./connectors";
import styles from "../dash.module.css";

type RecommendedSource = "daily" | "cache" | "playbook" | "empty";

type RecommendedPayload = Readonly<{
  verdict?: string;
  recommendations?: readonly RecommendedQuestion[];
  source?: RecommendedSource;
  generatedAt?: string;
}>;

function isTool(value: unknown): value is TraceConnectorId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(CONNECTOR_LOGOS, value);
}

function isRecommendedQuestion(value: unknown): value is RecommendedQuestion {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string"
    && typeof item.question === "string"
    && typeof item.why === "string"
    && typeof item.move === "string"
    && typeof item.domain === "string"
    && (item.tool === undefined || item.tool === null || typeof item.tool === "string");
}

/**
 * "What to look at next": the daily look's rows (ADR 0133), or the
 * chat-history playbook's until the first look lands. Bare rows only — no
 * heading, verdict, card or border: one sentence per row with the logo of
 * the tool it reads. It sits below the composer, out of the flow, and
 * renders nothing until it has rows, so the composer stays centred and
 * nothing appears and vanishes.
 */
export default function RecommendedAnalysis({
  onAsk,
  reduceMotion,
}: Readonly<{
  onAsk: (question: string) => void;
  reduceMotion: boolean;
}>) {
  const [recommendations, setRecommendations] = useState<readonly RecommendedQuestion[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/recommended-analysis", { cache: "no-store" });
        if (!response.ok) return;
        const payload = await response.json().catch(() => null) as RecommendedPayload | null;
        if (cancelled || !payload) return;
        setRecommendations((payload.recommendations ?? []).filter(isRecommendedQuestion).slice(0, 3));
      } catch {
        // Nothing to show; the composer is the homepage.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (recommendations.length === 0) return null;

  return (
    <motion.section
      className={styles.recommendedAnalysis}
      aria-label="What to look at next"
      initial={reduceMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        duration: reduceMotion ? 0 : 0.32,
        ease: [0.22, 1, 0.36, 1],
      }}
    >
      {recommendations.map((item) => (
        <button
          className={styles.recommendedAnalysisRow}
          key={item.id}
          type="button"
          aria-label={`Ask: ${item.question}`}
          title={item.why || undefined}
          onClick={() => onAsk(item.question)}
        >
          <span className={styles.recommendedAnalysisTool} aria-hidden="true">
            {isTool(item.tool) ? (
              <Image src={CONNECTOR_LOGOS[item.tool]} alt="" width={14} height={14} unoptimized />
            ) : null}
          </span>
          <span className={styles.recommendedAnalysisSentence}>{item.question}</span>
          <svg className={styles.recommendedAnalysisChevron} viewBox="0 0 24 24" aria-hidden="true">
            <path d="m9 5 7 7-7 7" />
          </svg>
        </button>
      ))}
    </motion.section>
  );
}
