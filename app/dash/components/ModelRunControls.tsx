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
  CLAUDE_HAIKU_4_5_MODEL_ID,
  CLAUDE_SONNET_5_MODEL_ID,
  isAnthropicModel,
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
  allowedModelIds?: readonly AlbertModelId[];
  allowedReasoningEfforts?: readonly ReasoningEffort[];
  /** Codex-only planning preflight. Omit for Albert/V3 and comparison controls. */
  solPlannerEnabled?: boolean;
  onSolPlannerChange?: (enabled: boolean) => void;
  /** Codex-only GPT-5.6 Responses Pro mode. Omit outside Codex. */
  proModeEnabled?: boolean;
  onProModeChange?: (enabled: boolean) => void;
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

/** Left-to-right model tabs: GPT family, then the additional providers. */
const MODEL_TAB_ORDER = [
  "gpt-5.6-luna",
  "gpt-5.6-terra",
  "gpt-5.6-sol",
  "grok-4.6",
  CLAUDE_SONNET_5_MODEL_ID,
  CLAUDE_HAIKU_4_5_MODEL_ID,
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
  maxHeight: number;
  top?: number;
  bottom?: number;
};

export function ModelRunControls({
  value,
  onChange,
  allowedModelIds,
  allowedReasoningEfforts,
  solPlannerEnabled = false,
  onSolPlannerChange,
  proModeEnabled = false,
  onProModeChange,
  disabled = false,
  popoverPlacement = "above",
  popoverAlign = "trigger-end",
}: ModelRunControlsProps) {
  const [open, setOpen] = useState(false);
  const [popoverEntered, setPopoverEntered] = useState(false);
  const [triggerWidth, setTriggerWidth] = useState<number | null>(null);
  const [popoverCoords, setPopoverCoords] = useState<PopoverCoords | null>(null);
  const [flipPopoverBelow, setFlipPopoverBelow] = useState(false);
  const reduceMotion = useReducedMotion();
  const popoverId = useId().replaceAll(":", "");
  const areaRef = useRef<HTMLDivElement>(null);
  const modelTabsRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
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
    setFlipPopoverBelow(false);
    closeTimerRef.current = window.setTimeout(() => {
      setOpen(false);
      setPopoverCoords(null);
      closeTimerRef.current = null;
    }, reduceMotion ? 0 : 180);
  }, [clearCloseTimer, reduceMotion]);

  const openPopover = useCallback(() => {
    clearCloseTimer();
    setPopoverEntered(false);
    setFlipPopoverBelow(false);
    setOpen(true);
  }, [clearCloseTimer]);

  const modelTabs = useMemo(
    () => {
      const allowed = allowedModelIds ? new Set<AlbertModelId>(allowedModelIds) : null;
      return MODEL_TAB_ORDER
        .filter((id) => !allowed || allowed.has(id))
        .map((id) => ALBERT_MODELS.find((model) => model.id === id)!);
    },
    [allowedModelIds],
  );

  const selectedModel = useMemo(
    () => modelTabs.find((model) => model.id === value.model) ?? modelTabs[0] ?? ALBERT_MODELS[0],
    [modelTabs, value.model],
  );

  const selectedModelIndex = useMemo(
    () => Math.max(0, modelTabs.findIndex((model) => model.id === value.model)),
    [modelTabs, value.model],
  );

  const effortOptions = useMemo(
    () => {
      const allowed = new Set(reasoningEffortsForModel(value.model));
      const configured = allowedReasoningEfforts ? new Set(allowedReasoningEfforts) : null;
      return EFFORT_OPTIONS.filter((effort) => allowed.has(effort.id) && (!configured || configured.has(effort.id)));
    },
    [allowedReasoningEfforts, value.model],
  );
  const showFastMode = modelSupportsFastMode(value.model);

  const effortLabel = EFFORT_LABELS[value.reasoningEffort] ?? value.reasoningEffort;

  const triggerSummary = [
    selectedModel.label,
    effortLabel,
    value.fastMode ? "Fast mode" : null,
    onProModeChange && proModeEnabled ? "Pro reasoning" : null,
    onSolPlannerChange && solPlannerEnabled ? "Sol planner" : null,
  ].filter(Boolean).join(" · ");

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
  }, [effortLabel, onProModeChange, onSolPlannerChange, proModeEnabled, selectedModel.label, solPlannerEnabled, value.fastMode]);

  useLayoutEffect(() => {
    if (!open) return;

    const updatePosition = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const width = Math.min(POPOVER_WIDTH, window.innerWidth - 24);
      const popoverHeight = popoverRef.current?.scrollHeight ?? 0;
      const aboveSpace = Math.max(0, rect.top - 22);
      const belowSpace = Math.max(0, window.innerHeight - rect.bottom - 22);
      const shouldFlipBelow = popoverPlacement === "above"
        && popoverHeight > aboveSpace
        && belowSpace > aboveSpace;
      setFlipPopoverBelow((current) => (current === shouldFlipBelow ? current : shouldFlipBelow));
      const shell =
        popoverAlign === "shell-start"
          ? trigger.closest<HTMLElement>('[data-edit-open="true"]')
          : null;
      const shellRect = shell?.getBoundingClientRect();
      const left = shellRect
        ? Math.max(12, Math.min(shellRect.left, window.innerWidth - width - 12))
        : Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12));
      if (popoverPlacement === "below" || shouldFlipBelow) {
        setPopoverCoords({ top: rect.bottom + 10, left, width, maxHeight: Math.max(120, belowSpace) });
      } else {
        setPopoverCoords({
          bottom: Math.max(12, window.innerHeight - rect.top + 10),
          left,
          width,
          maxHeight: Math.max(120, aboveSpace),
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
    flipPopoverBelow,
    triggerWidth,
    effortLabel,
    proModeEnabled,
    selectedModel.label,
    solPlannerEnabled,
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
    // Haiku's manual thinking budgets make Max minutes-slow, so it starts at
    // Low. Sonnet's adaptive thinking self-regulates and keeps the selection.
    const switchingToHaiku = model === CLAUDE_HAIKU_4_5_MODEL_ID && value.model !== CLAUDE_HAIKU_4_5_MODEL_ID;
    onChange(normalizeAgentPreferences({
      ...value,
      model,
      ...(switchingToHaiku ? { reasoningEffort: "low", fastMode: false } : {}),
    }));
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
        aria-label={`Run settings: ${selectedModel.label}, ${value.fastMode ? "Fast mode" : "Standard speed"}, ${value.reasoningEffort} reasoning${onProModeChange ? `, Pro reasoning ${proModeEnabled ? "on" : "off"}` : ""}${onSolPlannerChange ? `, Sol planner ${solPlannerEnabled ? "on" : "off"}` : ""}`}
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
        ref={popoverRef}
        id={popoverId}
        className={[
          styles.modelControlsPopover,
          popoverPlacement === "below" || flipPopoverBelow ? styles.modelControlsPopoverBelow : "",
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
                maxHeight: popoverCoords.maxHeight,
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

        {showFastMode || onProModeChange || onSolPlannerChange ? (
        <section className={styles.modelControlsMenuSection} aria-labelledby={`${popoverId}-options`}>
          <p className={styles.modelControlsSectionTitle} id={`${popoverId}-options`}>
            Options
          </p>
          <div className={styles.modelControlsMenuList}>
            {showFastMode ? (
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
            ) : null}
            {onProModeChange ? (
              <button
                className={styles.modelControlsMenuRow}
                type="button"
                role="switch"
                aria-checked={proModeEnabled}
                aria-label="Pro reasoning"
                title="Use GPT-5.6 reasoning.mode pro independently of the selected effort"
                data-pro-reasoning={proModeEnabled ? "on" : "off"}
                onClick={() => onProModeChange(!proModeEnabled)}
              >
                <span>Pro reasoning</span>
                <span
                  className={`${styles.modelControlsToggle} ${proModeEnabled ? styles.modelControlsToggleOn : ""}`}
                  aria-hidden="true"
                >
                  <i />
                </span>
              </button>
            ) : null}
            {onSolPlannerChange ? (
              <button
                className={styles.modelControlsMenuRow}
                type="button"
                role="switch"
                aria-checked={solPlannerEnabled}
                aria-label="Sol planner"
                title="Use GPT-5.6 Sol at Max to outline each Codex analysis before the selected model answers"
                data-sol-planner={solPlannerEnabled ? "on" : "off"}
                onClick={() => onSolPlannerChange(!solPlannerEnabled)}
              >
                <span>Sol · Max planner</span>
                <span
                  className={`${styles.modelControlsToggle} ${solPlannerEnabled ? styles.modelControlsToggleOn : ""}`}
                  aria-hidden="true"
                >
                  <i />
                </span>
              </button>
            ) : null}
            {onProModeChange ? (
              <p className={styles.modelControlsDisclosure} role="note">
                Pro performs more model work for higher reliability. It is independent of effort and can add substantial latency and token usage.
              </p>
            ) : null}
            {onSolPlannerChange ? (
              <p className={styles.modelControlsDisclosure} role="note">
                Uses GPT-5.6 Sol at Max for a short checklist, then hands the question to the selected model.
              </p>
            ) : null}
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
            {isAnthropicModel(value.model) ? (
              <p className={styles.modelControlsDisclosure} role="note">
                Data is processed globally by Anthropic, not in Australia. Haiku starts at Low;
                High and Max can take minutes. Fast mode is unavailable.
              </p>
            ) : null}
          </div>
        </section>
      </div>
    </div>
  );
}
