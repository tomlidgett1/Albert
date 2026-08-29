"use client";

import { useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import styles from "../dash.module.css";

export type ConversationRuntimeTab = "albert" | "codex" | "omni" | "compare";

const options = [
  { value: "albert", label: "Albert" },
  { value: "codex", label: "Codex" },
  { value: "omni", label: "Omni" },
  { value: "compare", label: "Compare" },
] as const;

export function ConversationRuntimeTabs(props: Readonly<{
  value: ConversationRuntimeTab;
  onChange: (value: ConversationRuntimeTab) => void;
}>): React.ReactNode {
  const reduceMotion = useReducedMotion() === true;
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef(new Map<ConversationRuntimeTab, HTMLButtonElement>());
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === props.value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => {
      itemRefs.current.get(props.value)?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, props.value]);

  const moveFocus = (direction: 1 | -1) => {
    const currentIndex = options.findIndex((option) => (
      itemRefs.current.get(option.value) === document.activeElement
    ));
    const from = currentIndex >= 0 ? currentIndex : options.findIndex((option) => option.value === props.value);
    const next = options[(from + direction + options.length) % options.length]!.value;
    itemRefs.current.get(next)?.focus();
  };

  return (
    <div className={styles.chatRuntimeMenu} ref={rootRef}>
      <button
        ref={triggerRef}
        className={styles.chatRuntimeMenuTrigger}
        type="button"
        aria-label={`Analysis runtime: ${selected.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        data-testid="conversation-runtime-trigger"
        onClick={() => setOpen((current) => !current)}
      >
        <span>{selected.label}</span>
        <svg
          className={`${styles.chatRuntimeMenuChevron} ${open ? styles.chatRuntimeMenuChevronOpen : ""}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      <AnimatePresence>
        {open ? (
          <motion.div
            id={menuId}
            className={styles.chatRuntimeMenuPanel}
            role="menu"
            aria-label="Analysis runtime"
            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduceMotion ? undefined : { height: 0, opacity: 0 }}
            transition={{
              duration: reduceMotion ? 0 : 0.4,
              ease: [0.04, 0.62, 0.23, 0.98],
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                moveFocus(1);
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                moveFocus(-1);
                return;
              }
              if (event.key === "Home") {
                event.preventDefault();
                itemRefs.current.get(options[0].value)?.focus();
                return;
              }
              if (event.key === "End") {
                event.preventDefault();
                itemRefs.current.get(options[options.length - 1]!.value)?.focus();
              }
            }}
          >
            {options.map((option) => (
              <button
                key={option.value}
                ref={(node) => {
                  if (node) itemRefs.current.set(option.value, node);
                  else itemRefs.current.delete(option.value);
                }}
                className={styles.chatRuntimeMenuItem}
                type="button"
                role="menuitemradio"
                aria-checked={props.value === option.value}
                onClick={() => {
                  props.onChange(option.value);
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
              >
                <span>{option.label}</span>
              </button>
            ))}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
