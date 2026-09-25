"use client";

import styles from "../dash.module.css";

/** The chat's analysis harness: one of the two agent loops, or both side by side. */
export type HarnessChoice = "omni" | "oai_codex" | "compare";

const OPTIONS = [
  { value: "omni", label: "Omni", title: "Omni · Albert's in-process agent loop" },
  { value: "oai_codex", label: "OAI Codex", title: "OAI Codex · OpenAI's managed Codex harness (Agents API)" },
  { value: "compare", label: "Compare", title: "Run both harnesses on the same question, side by side" },
] as const satisfies ReadonlyArray<{ value: HarnessChoice; label: string; title: string }>;

/**
 * A quiet segmented control for choosing which harness answers (ADR 0141).
 * Switching starts a fresh analysis on the chosen harness: conversations are
 * runtime-locked, so an existing thread never changes harness mid-way.
 */
export function HarnessSelector(props: Readonly<{
  value: HarnessChoice;
  onChange: (value: HarnessChoice) => void;
  disabled?: boolean;
}>): React.ReactNode {
  return (
    <div className={styles.harnessSelector} role="group" aria-label="Analysis harness">
      {OPTIONS.map((option) => {
        const active = option.value === props.value;
        return (
          <button
            key={option.value}
            className={`${styles.harnessOption} ${active ? styles.harnessOptionActive : ""}`}
            type="button"
            aria-pressed={active}
            title={option.title}
            data-testid={`harness-select-${option.value}`}
            disabled={props.disabled}
            onClick={() => {
              if (!active) props.onChange(option.value);
            }}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
