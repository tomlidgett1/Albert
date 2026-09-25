"use client";
import { useLayoutEffect, useRef, useState } from "react";
import styles from "./element-editor.module.css";

export function ElementEditorTabs({
  value,
  onChange,
  id,
}: Readonly<{
  value: "properties" | "format";
  onChange: (value: "properties" | "format") => void;
  id: string;
}>) {
  const track = useRef<HTMLDivElement>(null);
  const [indicator, setIndicator] = useState({ left: 0, width: 0 });
  useLayoutEffect(() => {
    const measure = () => {
      const parent = track.current;
      const active = parent?.querySelector<HTMLElement>(
        '[aria-selected="true"]',
      );
      if (!parent || !active) return;
      const bounds = parent.getBoundingClientRect(),
        child = active.getBoundingClientRect();
      setIndicator({ left: child.left - bounds.left, width: child.width });
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (track.current) observer.observe(track.current);
    return () => observer.disconnect();
  }, [value]);
  return (
    <div
      ref={track}
      className={styles.tabs}
      role="tablist"
      aria-label="Element editor"
    >
      <span
        className={styles.tabIndicator}
        style={indicator}
        aria-hidden="true"
      />
      {(["properties", "format"] as const).map((tab) => (
        <button
          key={tab}
          type="button"
          role="tab"
          id={`${id}-${tab}`}
          aria-controls={`${id}-content`}
          tabIndex={value === tab ? 0 : -1}
          aria-selected={value === tab}
          onClick={() => onChange(tab)}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
              return;
            event.preventDefault();
            const next =
              event.key === "Home"
                ? "properties"
                : event.key === "End"
                  ? "format"
                  : value === "properties"
                    ? "format"
                    : "properties";
            onChange(next);
            track.current
              ?.querySelector<HTMLButtonElement>(
                `#${CSS.escape(`${id}-${next}`)}`,
              )
              ?.focus();
          }}
        >
          {tab === "properties" ? "Properties" : "Format"}
        </button>
      ))}
    </div>
  );
}
