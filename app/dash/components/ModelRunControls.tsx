"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  ALBERT_MODELS,
  modelSupportsFastMode,
  normalizeAgentPreferences,
  reasoningEffortsForModel,
  type AgentRunPreferences,
  type AlbertModelId,
  type ReasoningEffort,
} from "@/packages/shared/src";
import styles from "../dash.module.css";

type ModelRunControlsProps = {
  value: AgentRunPreferences;
  onChange: (value: AgentRunPreferences) => void;
  disabled?: boolean;
  runActive?: boolean;
  popoverPlacement?: "above" | "below";
  /** `shell-start` left-aligns to the nearest open user message bubble. */
  popoverAlign?: "trigger-end" | "shell-start";
};

/** Highest effort first, matching OpenAI GPT-5.6 reasoning.effort. */
const EFFORT_OPTIONS = [
  { id: "max", label: "Max" },
  { id: "xhigh", label: "XHigh" },
  { id: "high", label: "High" },
  { id: "medium", label: "Medium" },
  { id: "low", label: "Low" },
  { id: "none", label: "None" },
] as const satisfies ReadonlyArray<{ id: ReasoningEffort; label: string }>;

/** Left-to-right model tabs: efficient → balanced → frontier, then Grok. */
const MODEL_TAB_ORDER = [
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
  "grok-4.6",
] as const satisfies ReadonlyArray<AlbertModelId>;

const EFFORT_LABELS: Record<ReasoningEffort, string> = Object.fromEntries(
  EFFORT_OPTIONS.map(({ id, label }) => [id, label]),
) as Record<ReasoningEffort, string>;

function FastModeIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M13.2 2.1a.9.9 0 0 1 1.62.72L12.9 9.5h5.35a.95.95 0 0 1 .74 1.55l-8.4 10.7a.9.9 0 0 1-1.63-.74L11.1 14.5H5.75a.95.95 0 0 1-.74-1.55l8.19-10.85Z" />
    </svg>
  );
}

const PILL_EASE = [0.22, 1, 0.36, 1] as const;
const POPOVER_WIDTH = 252;

type PopoverCoords = {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
};

export function ModelRunControls({
  value,
  onChange,
  disabled = false,
  popoverPlacement = "above",
  popoverAlign = "trigger-end",
}: ModelRunControlsProps) {
  const [open, setOpen] = useState(false);
  const [popoverEntered, setPopoverEntered] = useState(false);
  const [triggerWidth, setTriggerWidth] = useState<number | null>(null);
  const [popoverCoords, setPopoverCoords] = useState<PopoverCoords | null>(null);
  const reduceMotion = useReducedMotion();
  const popoverId = useId().replaceAll(":", "");
  const areaRef = useRef<HTMLDivElement>(null);
  const modelTabsRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const summaryMeasureRef = useRef<HTMLSpanElement>(null);
  const selectedEffortRef = useRef<HTMLButtonElement>(null);
  const closeTimerRef = useRef<number | null>(null);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const closePopover = useCallback(() => {
    clearCloseTimer();
    setPopoverEntered(false);
    closeTimerRef.current = window.setTimeout(() => {
      setOpen(false);
      setPopoverCoords(null);
      closeTimerRef.current = null;
    }, reduceMotion ? 0 : 180);
  }, [clearCloseTimer, reduceMotion]);

  const openPopover = useCallback(() => {
    clearCloseTimer();
    setPopoverEntered(false);
    setOpen(true);
  }, [clearCloseTimer]);

  const modelTabs = useMemo(
    () => MODEL_TAB_ORDER.map((id) => ALBERT_MODELS.find((model) => model.id === id)!),
    [],
  );

  const selectedModel = useMemo(
    () => ALBERT_MODELS.find((model) => model.id === value.model) ?? ALBERT_MODELS[0],
    [value.model],
  );

  const selectedModelIndex = useMemo(
    () => Math.max(0, modelTabs.findIndex((model) => model.id === value.model)),
    [modelTabs, value.model],
  );

  const effortOptions = useMemo(
    () => {
      const allowed = new Set(reasoningEffortsForModel(value.model));
      return EFFORT_OPTIONS.filter((effort) => allowed.has(effort.id));
    },
    [value.model],
  );
  const showFastMode = modelSupportsFastMode(value.model);

  const effortLabel = EFFORT_LABELS[value.reasoningEffort] ?? value.reasoningEffort;

  const triggerSummary = value.fastMode
    ? `${selectedModel.label} · ${effortLabel} · Fast mode`
    : `${selectedModel.label} · ${effortLabel}`;

  useLayoutEffect(() => {
    const summary = summaryMeasureRef.current;
    const trigger = triggerRef.current;
    if (!summary || !trigger) return;

    const measure = () => {
      const padLeft = Number.parseFloat(getComputedStyle(trigger).paddingLeft) || 0;
      const padRight = Number.parseFloat(getComputedStyle(trigger).paddingRight) || 0;
      // +2px buffer avoids sub-pixel clipping during the width transition.
      const nextWidth = Math.ceil(summary.scrollWidth + padLeft + padRight + 2);
      setTriggerWidth((current) => (current === nextWidth ? current : nextWidth));
    };

    measure();
    const frame = window.requestAnimationFrame(measure);
    return () => window.cancelAnimationFrame(frame);
  }, [effortLabel, selectedModel.label, value.fastMode]);

  useLayoutEffect(() => {
    if (!open) return;

    const updatePosition = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const width = Math.min(POPOVER_WIDTH, window.innerWidth - 24);
      const shell =
        popoverAlign === "shell-start"
          ? trigger.closest<HTMLElement>('[data-edit-open="true"]')
          : null;
      const shellRect = shell?.getBoundingClientRect();
      const left = shellRect
        ? Math.max(12, Math.min(shellRect.left, window.innerWidth - width - 12))
        : Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12));
      if (popoverPlacement === "below") {
        setPopoverCoords({ top: rect.bottom + 10, left, width });
      } else {
        setPopoverCoords({
          bottom: Math.max(12, window.innerHeight - rect.top + 10),
          left,
          width,
        });
      }
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    document.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      document.removeEventListener("scroll", updatePosition, true);
    };
  }, [
    open,
    popoverAlign,
    popoverPlacement,
    triggerWidth,
    effortLabel,
    selectedModel.label,
    value.fastMode,
  ]);

  useLayoutEffect(() => {
    if (!open) return;

    // Paint the closed fixed position first, then enter so the slide transition runs.
    let enterFrame = 0;
    const prepFrame = window.requestAnimationFrame(() => {
      enterFrame = window.requestAnimationFrame(() => setPopoverEntered(true));
    });
    return () => {
      window.cancelAnimationFrame(prepFrame);
      window.cancelAnimationFrame(enterFrame);
    };
  }, [open]);

  useEffect(() => () => clearCloseTimer(), [clearCloseTimer]);

  useEffect(() => {
    if (!open || !popoverEntered) return;
    const focusFrame = window.requestAnimationFrame(() => selectedEffortRef.current?.focus());
    return () => window.cancelAnimationFrame(focusFrame);
  }, [open, popoverEntered]);

  useEffect(() => {
    if (!open) return;

    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!areaRef.current?.contains(event.target as Node)) {
        closePopover();
        triggerRef.current?.focus();
      }
    };

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      closePopover();
      triggerRef.current?.focus();
    };

    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);

    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [closePopover, open]);

  const updateModel = (model: AlbertModelId) => {
    onChange(normalizeAgentPreferences({ ...value, model }));
  };

  const updateReasoning = (reasoningEffort: ReasoningEffort) => {
    onChange(normalizeAgentPreferences({ ...value, reasoningEffort }));
  };

  const moveModelFocus = (event: ReactKeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
    let nextIndex = currentIndex;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % modelTabs.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + modelTabs.length) % modelTabs.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = modelTabs.length - 1;
    } else {
      return;
    }

    event.preventDefault();
    const nextModel = modelTabs[nextIndex] ?? modelTabs[0];
    updateModel(nextModel.id);
    window.requestAnimationFrame(() => {
      modelTabsRef.current
        ?.querySelector<HTMLButtonElement>(`[data-model-id="${nextModel.id}"]`)
        ?.focus();
    });
  };

  return (
    <div className={styles.modelControls} ref={areaRef}>
      <button
        ref={triggerRef}
        className={styles.modelControlsTrigger}
        type="button"
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={popoverId}
        aria-label={`Run settings: ${selectedModel.label}, ${value.fastMode ? "Fast mode" : "Standard speed"}, ${value.reasoningEffort} reasoning`}
        data-testid="model-run-controls-trigger"
        title={triggerSummary}
        style={triggerWidth ? { width: triggerWidth } : undefined}
        data-width-ready={triggerWidth ? "true" : undefined}
        onClick={() => {
          if (open) closePopover();
          else openPopover();
        }}
      >
        <span className={styles.modelControlsSummaryMeasure} ref={summaryMeasureRef} aria-hidden="true">
          <span className={styles.modelControlsModelName}>{selectedModel.label}</span>
          <span className={styles.modelControlsSummaryMeta}>{effortLabel}</span>
          {value.fastMode ? (
            <span className={styles.modelControlsFastSlot}>
              <FastModeIcon className={styles.modelControlsFastIcon} />
            </span>
          ) : null}
        </span>
        <span className={styles.modelControlsSummary}>
          <span className={styles.modelControlsModelName}>{selectedModel.label}</span>
          <span className={styles.modelControlsSummaryMeta}>{effortLabel}</span>
          <AnimatePresence initial={false}>
            {value.fastMode ? (
              <motion.span
                className={styles.modelControlsFastSlot}
                key="fast-mode"
                initial={reduceMotion ? false : { opacity: 0, scale: 0.86 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={reduceMotion ? undefined : { opacity: 0, scale: 0.86 }}
                transition={{ duration: reduceMotion ? 0 : 0.22, ease: PILL_EASE }}
                aria-hidden="true"
              >
                <FastModeIcon className={styles.modelControlsFastIcon} />
              </motion.span>
            ) : null}
          </AnimatePresence>
        </span>
      </button>

      <div
        id={popoverId}
        className={[
          styles.modelControlsPopover,
          popoverPlacement === "below" ? styles.modelControlsPopoverBelow : "",
          popoverAlign === "shell-start" ? styles.modelControlsPopoverShellStart : "",
          popoverEntered ? styles.modelControlsPopoverOpen : "",
          open && popoverCoords ? styles.modelControlsPopoverFixed : "",
        ].filter(Boolean).join(" ")}
        role="dialog"
        aria-label="Model and run settings"
        aria-hidden={!open || !popoverEntered}
        inert={!open || !popoverEntered || undefined}
        style={
          open && popoverCoords
            ? {
                top: popoverCoords.top ?? "auto",
                bottom: popoverCoords.bottom ?? "auto",
                left: popoverCoords.left,
                right: "auto",
                width: popoverCoords.width,
              }
            : undefined
        }
      >
        <section className={styles.modelControlsMenuSection} aria-labelledby={`${popoverId}-effort`}>
          <p className={styles.modelControlsSectionTitle} id={`${popoverId}-effort`}>
            Effort
          </p>
          <div className={styles.modelControlsMenuList} role="group" aria-label="Reasoning effort">
            {effortOptions.map((effort) => {
              const selected = effort.id === value.reasoningEffort;
              return (
                <button
                  ref={selected ? selectedEffortRef : undefined}
                  className={`${styles.modelControlsMenuRow} ${selected ? styles.modelControlsMenuRowActive : ""}`}
                  key={effort.id}
                  type="button"
                  aria-pressed={selected}
                  data-reasoning-effort={effort.id}
                  title={`${effort.label} reasoning`}
                  onClick={() => updateReasoning(effort.id)}
                >
                  <span>{effort.label}</span>
                  {selected ? (
                    <span className={styles.modelControlsCheck} aria-hidden="true">
                      ✓
                    </span>
                  ) : (
                    <span className={styles.modelControlsRowSpacer} aria-hidden="true" />
                  )}
                </button>
              );
            })}
          </div>
        </section>

        {showFastMode ? (
        <section className={styles.modelControlsMenuSection} aria-labelledby={`${popoverId}-options`}>
          <p className={styles.modelControlsSectionTitle} id={`${popoverId}-options`}>
            Options
          </p>
          <div className={styles.modelControlsMenuList}>
            <button
              className={styles.modelControlsMenuRow}
              type="button"
              role="switch"
              aria-checked={value.fastMode}
              aria-label="Fast mode"
              title="Fast mode"
              data-processing-speed={value.fastMode ? "fast" : "standard"}
              onClick={() => onChange(normalizeAgentPreferences({ ...value, fastMode: !value.fastMode }))}
            >
              <span>Fast</span>
              <span
                className={`${styles.modelControlsToggle} ${value.fastMode ? styles.modelControlsToggleOn : ""}`}
                aria-hidden="true"
              >
                <i />
              </span>
            </button>
          </div>
        </section>
        ) : null}

        <section className={styles.modelControlsMenuSection} aria-labelledby={`${popoverId}-model`}>
          <p className={styles.modelControlsSectionTitle} id={`${popoverId}-model`}>
            Model
          </p>
          <div className={styles.modelControlsModelTabsWrap}>
            <div
              ref={modelTabsRef}
              className={styles.modelControlsModelTabs}
              role="radiogroup"
              aria-label="Model"
              style={{ gridTemplateColumns: `repeat(${modelTabs.length}, minmax(0, 1fr))` }}
            >
              <span
                className={styles.modelControlsModelTabIndicator}
                style={{
                  left: `calc(${selectedModelIndex} * 100% / ${modelTabs.length} + 2px)`,
                  width: `calc(100% / ${modelTabs.length} - 4px)`,
                }}
                aria-hidden="true"
              />
              {modelTabs.map((model, index) => {
                const selected = model.id === value.model;
                return (
                  <button
                    className={selected ? styles.modelControlsModelTabActive : ""}
                    key={model.id}
                    type="button"
                    role="radio"
                    tabIndex={selected ? 0 : -1}
                    aria-checked={selected}
                    aria-label={model.label}
                    data-model-id={model.id}
                    data-model-provider={model.provider}
                    onClick={() => updateModel(model.id)}
                    onKeyDown={(event) => moveModelFocus(event, index)}
                  >
                    {model.shortLabel}
                  </button>
                );
              })}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
