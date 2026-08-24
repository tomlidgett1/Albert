"use client";

import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import type { RecommendedQuestion } from "@/services/recommended-analysis/src/playbook";
import styles from "../dash.module.css";

type RecommendedSource = "cache" | "playbook" | "model" | "empty";

type RecommendedPayload = Readonly<{
  verdict?: string;
  recommendations?: readonly RecommendedQuestion[];
  sourceCount?: number;
  source?: RecommendedSource;
}>;

function isRecommendedQuestion(value: unknown): value is RecommendedQuestion {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.id === "string"
    && typeof item.question === "string"
    && typeof item.why === "string"
    && typeof item.move === "string"
    && typeof item.domain === "string";
}

export default function RecommendedAnalysis({
  onAsk,
  reduceMotion,
}: Readonly<{
  onAsk: (question: string) => void;
  reduceMotion: boolean;
}>) {
  const [verdict, setVerdict] = useState("");
  const [recommendations, setRecommendations] = useState<readonly RecommendedQuestion[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const apply = (payload: RecommendedPayload | null) => {
      if (cancelled || !payload) return;
      const next = (payload.recommendations ?? []).filter(isRecommendedQuestion).slice(0, 3);
      setRecommendations(next);
      setVerdict(typeof payload.verdict === "string" ? payload.verdict.trim() : "");
    };

    void (async () => {
      try {
        const response = await fetch("/api/recommended-analysis", { cache: "no-store" });
        const payload = await response.json().catch(() => null) as RecommendedPayload | null;
        if (!response.ok) {
          if (!cancelled) setLoading(false);
          return;
        }
        apply(payload);
        if (!cancelled) setLoading(false);
        if (payload?.source === "playbook" && (payload.recommendations?.length ?? 0) > 0) {
          const refined = await fetch("/api/recommended-analysis", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          });
          if (!refined.ok) return;
          apply(await refined.json().catch(() => null) as RecommendedPayload | null);
        }
      } catch {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  if (!loading && recommendations.length === 0) return null;

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
      <div className={styles.recommendedAnalysisPanel}>
        <div className={styles.recommendedAnalysisHeader}>
          <h3 className={styles.recommendedAnalysisTitle}>What to look at next</h3>
          {loading && recommendations.length === 0 ? (
            <p className={styles.recommendedAnalysisVerdict}>Reading your analyses…</p>
          ) : verdict ? (
            <p className={styles.recommendedAnalysisVerdict}>{verdict}</p>
          ) : null}
        </div>
        <div className={styles.recommendedAnalysisList}>
          {loading && recommendations.length === 0
            ? [0, 1, 2].map((key) => (
                <div className={styles.recommendedAnalysisSkeleton} key={key} aria-hidden="true">
                  <span className={styles.recommendedAnalysisIndex}>0{key + 1}</span>
                  <span className={styles.recommendedAnalysisCopy}>
                    <span className={styles.recommendedAnalysisSkeletonBar} />
                    <span className={styles.recommendedAnalysisSkeletonBar} />
                  </span>
                </div>
              ))
            : recommendations.map((item, index) => (
                <button
                  className={styles.recommendedAnalysisRow}
                  key={item.id}
                  type="button"
                  aria-label={`Ask: ${item.question}`}
                  onClick={() => onAsk(item.question)}
                >
                  <span className={styles.recommendedAnalysisIndex} aria-hidden="true">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className={styles.recommendedAnalysisCopy}>
                    <span className={styles.recommendedAnalysisCardQuestion}>{item.question}</span>
                    <span className={styles.recommendedAnalysisCardWhy}>{item.why}</span>
                  </span>
                  <svg className={styles.recommendedAnalysisChevron} viewBox="0 0 24 24" aria-hidden="true">
                    <path d="m9 5 7 7-7 7" />
                  </svg>
                </button>
              ))}
        </div>
      </div>
    </motion.section>
  );
}
