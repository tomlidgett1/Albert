"use client";

import { useLayoutEffect, useRef, useState } from "react";
import styles from "../dash.module.css";

export type ConversationRuntimeTab = "albert" | "codex" | "compare";

const options = [
  { value: "albert", label: "Albert" },
  { value: "codex", label: "Codex" },
  { value: "compare", label: "Compare" },
] as const;

export function ConversationRuntimeTabs(props: Readonly<{
  value: ConversationRuntimeTab;
  onChange: (value: ConversationRuntimeTab) => void;
}>): React.ReactNode {
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonsRef = useRef(new Map<ConversationRuntimeTab, HTMLButtonElement>());
  const [indicator, setIndicator] = useState({ left: 0, width: 0 });

  useLayoutEffect(() => {
    const update = () => {
      const root = rootRef.current;
      const button = buttonsRef.current.get(props.value);
      if (!root || !button) return;
      const rootBox = root.getBoundingClientRect();
      const buttonBox = button.getBoundingClientRect();
      setIndicator({ left: buttonBox.left - rootBox.left, width: buttonBox.width });
    };
    update();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    if (rootRef.current) observer?.observe(rootRef.current);
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [props.value]);

  return (
    <div
      ref={rootRef}
      className={styles.chatRuntimeTabs}
      role="tablist"
      aria-label="Analysis runtime"
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const currentIndex = options.findIndex((option) => option.value === props.value);
        const direction = event.key === "ArrowRight" ? 1 : -1;
        const next = options[(currentIndex + direction + options.length) % options.length]!.value;
        props.onChange(next);
        window.requestAnimationFrame(() => {
          const active = document.querySelector<HTMLButtonElement>(
            '[role="tablist"][aria-label="Analysis runtime"] [role="tab"][aria-selected="true"]',
          );
          active?.focus();
        });
      }}
    >
      {options.map((option) => (
        <button
          key={option.value}
          ref={(node) => {
            if (node) buttonsRef.current.set(option.value, node);
            else buttonsRef.current.delete(option.value);
          }}
          className={`${styles.chatRuntimeTab} ${props.value === option.value ? styles.chatRuntimeTabActive : ""}`}
          type="button"
          role="tab"
          aria-selected={props.value === option.value}
          tabIndex={props.value === option.value ? 0 : -1}
          onClick={() => props.onChange(option.value)}
        >
          {option.label}
          {option.value === "codex" ? <span className={styles.chatRuntimeExperimental}>Experimental</span> : null}
        </button>
      ))}
      <span
        className={styles.chatRuntimeTabIndicator}
        aria-hidden="true"
        style={{ left: indicator.left, width: indicator.width }}
      />
    </div>
  );
}
