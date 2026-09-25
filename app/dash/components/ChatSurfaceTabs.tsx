"use client";

import { useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import styles from "../dash.module.css";

export type ChatSurface = "chat" | "discover" | "scheduled" | "alerts";

const OPTIONS = [
  { value: "chat", label: "Chat" },
  { value: "discover", label: "Discover" },
  { value: "scheduled", label: "Scheduled" },
  { value: "alerts", label: "Alerts" },
] as const satisfies ReadonlyArray<{ value: ChatSurface; label: string }>;

/**
 * The Chat / Discover / Scheduled / Alerts slider in the chat top bar: the dash
 * segmented pill control (36px track, 30px sliding thumb) measured against the active tab.
 */
export function ChatSurfaceTabs(props: Readonly<{
  value: ChatSurface;
  onChange: (value: ChatSurface) => void;
  /**
   * ids of the panels each tab controls. Only panels that render as a single
   * element are listed (the conversation body is a set of siblings, so Chat
   * has none); aria-controls is emitted only for the active tab's panel.
   */
  panelIds: Readonly<Partial<Record<ChatSurface, string>>>;
}>): React.ReactNode {
  const trackRef = useRef<HTMLDivElement>(null);
  const buttonRefs = useRef(new Map<ChatSurface, HTMLButtonElement>());
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    const measure = () => {
      const track = trackRef.current;
      const button = buttonRefs.current.get(props.value);
      if (!track || !button) return;
      const trackBox = track.getBoundingClientRect();
      const buttonBox = button.getBoundingClientRect();
      const next = { left: buttonBox.left - trackBox.left, width: buttonBox.width };
      setIndicator((current) => (
        current && Math.abs(current.left - next.left) < 0.5 && Math.abs(current.width - next.width) < 0.5
          ? current
          : next
      ));
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (trackRef.current) observer.observe(trackRef.current);
    // Geist may finish loading after first paint and change label widths.
    document.fonts?.ready.then(measure).catch(() => undefined);
    return () => observer.disconnect();
  }, [props.value]);

  const moveFocus = (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
    let nextIndex = index;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") nextIndex = (index + 1) % OPTIONS.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") nextIndex = (index - 1 + OPTIONS.length) % OPTIONS.length;
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = OPTIONS.length - 1;
    else return;
    event.preventDefault();
    const next = OPTIONS[nextIndex]!.value;
    props.onChange(next);
    window.requestAnimationFrame(() => buttonRefs.current.get(next)?.focus());
  };

  return (
    <div className={styles.chatSurfaceTabs} role="tablist" aria-label="Chat surface" ref={trackRef}>
      <span
        className={styles.chatSurfaceTabsIndicator}
        style={indicator ? { left: indicator.left, width: indicator.width } : { opacity: 0 }}
        aria-hidden="true"
      />
      {OPTIONS.map((option, index) => {
        const active = option.value === props.value;
        return (
          <button
            key={option.value}
            ref={(node) => {
              if (node) buttonRefs.current.set(option.value, node);
              else buttonRefs.current.delete(option.value);
            }}
            className={`${styles.chatSurfaceTab} ${active ? styles.chatSurfaceTabActive : ""}`}
            type="button"
            role="tab"
            id={`chat-surface-tab-${option.value}`}
            aria-selected={active}
            // Only the visible panel is in the DOM, so only the active tab may point at one.
            aria-controls={active ? props.panelIds[option.value] : undefined}
            tabIndex={active ? 0 : -1}
            data-testid={`chat-surface-${option.value}`}
            onClick={() => props.onChange(option.value)}
            onKeyDown={(event) => moveFocus(event, index)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
