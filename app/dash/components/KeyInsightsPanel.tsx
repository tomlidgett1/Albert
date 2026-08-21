"use client";

import Image from "next/image";
import styles from "../dash.module.css";
import { CONNECTOR_LOGOS, CONNECTOR_NAMES } from "./connectors";
import { formatKeyInsightValue, type KeyInsight } from "./key-insights";

type KeyInsightsPanelProps = Readonly<{
  insights: readonly KeyInsight[];
  streaming: boolean;
  activity?: string;
}>;

function readableTimeRange(label: string): string | null {
  const trimmed = label.trim();
  if (!trimmed || /^(requested period|unknown)$/iu.test(trimmed)) return null;
  return trimmed;
}

function sentenceLabel(label: string): string {
  const cleaned = label.replace(/\s*%\s*$/u, "").replace(/\s+/gu, " ").trim();
  return cleaned ? cleaned.toLocaleLowerCase("en-AU") : "value";
}

export default function KeyInsightsPanel({
  insights,
  streaming,
  activity,
}: KeyInsightsPanelProps) {
  if (insights.length === 0) {
    if (!streaming) return null;
    return (
      <div className={styles.takeawaysEmptyState} aria-live="polite" aria-busy="true">
        <strong>Looking for useful signals</strong>
        <p>{activity || "Supporting evidence will appear here as Albert investigates."}</p>
      </div>
    );
  }

  return (
    <div className={styles.keyInsightsFeed} aria-busy={streaming}>
      {streaming ? (
        <div className={styles.keyInsightsLive} role="status">
          {activity || "Still looking for useful signals…"}
        </div>
      ) : null}

      <ol className={styles.keyInsightsTextList}>
        {insights.map((insight) => {
          const timeRange = readableTimeRange(insight.timeRangeLabel);
          const lead = insight.rows[0];
          const primary = lead?.values[0];
          const secondary = lead?.values[1];
          if (!lead || !primary) return null;
          return (
            <li className={styles.keyInsightTextItem} key={insight.id}>
              <p className={styles.keyInsightSentence}>
                <strong>{insight.title}:</strong>{" "}
                {lead.label ? <><strong>{lead.label}</strong>{" shows "}</> : null}
                <strong>{formatKeyInsightValue(primary.value, primary.column)}</strong>{" "}
                {sentenceLabel(primary.column.label)}
                {secondary ? (
                  <>{", and "}<strong>{formatKeyInsightValue(secondary.value, secondary.column)}</strong>{" "}{sentenceLabel(secondary.column.label)}</>
                ) : null}
                {"."}
              </p>

              <div className={styles.keyInsightMeta}>
                {insight.sources.map((source) => (
                  <span className={styles.keyInsightSourceText} key={`${insight.id}:${source.connector}`}>
                    <Image
                      src={CONNECTOR_LOGOS[source.connector]}
                      alt=""
                      width={14}
                      height={14}
                      unoptimized
                    />
                    <span>{CONNECTOR_NAMES[source.connector]}</span>
                  </span>
                ))}
                {timeRange ? <><span aria-hidden="true">·</span><span>{timeRange}</span></> : null}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
