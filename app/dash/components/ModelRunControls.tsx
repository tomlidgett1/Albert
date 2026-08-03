"use client";

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  ALBERT_MODELS,
  REASONING_EFFORTS,
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
  compact?: boolean;
};

const effortLabels: Record<ReasoningEffort, string> = {
  none: "None",
  low: "Low",
  medium: "Med",
  high: "High",
  xhigh: "XH",
  max: "Max",
};

export function ModelRunControls({
  value,
  onChange,
  disabled = false,
  runActive = false,
  compact = false,
}: ModelRunControlsProps) {
  const [open, setOpen] = useState(false);
  const popoverId = useId().replaceAll(":", "");
  const areaRef = useRef<HTMLDivElement>(null);
  const modelListRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const selectedModelRef = useRef<HTMLButtonElement>(null);

  const selectedModel = useMemo(
    () => ALBERT_MODELS.find((model) => model.id === value.model) ?? ALBERT_MODELS[0],
    [value.model],
  );

  useEffect(() => {
    if (!open) return;

    const closeOnOutsidePress = (event: PointerEvent) => {
      if (!areaRef.current?.contains(event.target as Node)) {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    const focusTimer = window.requestAnimationFrame(() => selectedModelRef.current?.focus());

    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
      window.cancelAnimationFrame(focusTimer);
    };
  }, [open]);

  const updateModel = (model: AlbertModelId) => {
    onChange({ ...value, model });
  };

  const updateReasoning = (reasoningEffort: ReasoningEffort) => {
    onChange({ ...value, reasoningEffort });
  };

  const moveModelFocus = (event: ReactKeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
    let nextIndex = currentIndex;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % ALBERT_MODELS.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + ALBERT_MODELS.length) % ALBERT_MODELS.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = ALBERT_MODELS.length - 1;
    } else {
      return;
    }

    event.preventDefault();
    const nextModel = ALBERT_MODELS[nextIndex] ?? ALBERT_MODELS[0];
    updateModel(nextModel.id);
    window.requestAnimationFrame(() => {
      modelListRef.current
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
        onClick={() => setOpen((current) => !current)}
      >
        <span className={styles.modelControlsSpark} aria-hidden="true">✦</span>
        <span className={styles.modelControlsSummary}>
          <strong>{selectedModel.label}</strong>
          {!compact ? (
            <small>
              {value.fastMode ? "Fast" : "Standard"} · {effortLabels[value.reasoningEffort]}
            </small>
          ) : null}
        </span>
        <span className={`${styles.modelControlsChevron} ${open ? styles.modelControlsChevronOpen : ""}`} aria-hidden="true">⌄</span>
      </button>

      <div
        id={popoverId}
        className={`${styles.modelControlsPopover} ${open ? styles.modelControlsPopoverOpen : ""}`}
        role="dialog"
        aria-label="Model and run settings"
        aria-hidden={!open}
        inert={!open || undefined}
      >
        <div className={styles.modelControlsHeader}>
          <div>
            <p>RUN SETTINGS</p>
            <h3>Choose how Albert works</h3>
          </div>
          {runActive ? <span>Applies next turn</span> : null}
        </div>

        <fieldset className={styles.modelControlsFieldset}>
          <legend>Model</legend>
          <div ref={modelListRef} className={styles.modelControlsModelList} role="radiogroup" aria-label="OpenAI model">
            {ALBERT_MODELS.map((model, index) => {
              const selected = model.id === value.model;
              return (
                <button
                  ref={selected ? selectedModelRef : undefined}
                  className={`${styles.modelControlsModelRow} ${selected ? styles.modelControlsModelRowActive : ""}`}
                  key={model.id}
                  type="button"
                  role="radio"
                  tabIndex={selected ? 0 : -1}
                  aria-checked={selected}
                  data-model-id={model.id}
                  onClick={() => updateModel(model.id)}
                  onKeyDown={(event) => moveModelFocus(event, index)}
                >
                  <span className={styles.modelControlsModelMark} aria-hidden="true">
                    {model.label.slice(0, 1)}
                  </span>
                  <span className={styles.modelControlsModelCopy}>
                    <strong>{model.label}</strong>
                    <small>{model.description}</small>
                  </span>
                  <span className={styles.modelControlsCheck} aria-hidden="true">
                    {selected ? "✓" : ""}
                  </span>
                </button>
              );
            })}
          </div>
        </fieldset>

        <fieldset className={styles.modelControlsFieldset}>
          <legend>Speed</legend>
          <div className={styles.modelControlsSegment} role="group" aria-label="Processing speed">
            <span
              className={styles.modelControlsSegmentIndicator}
              style={{ left: value.fastMode ? "50%" : "3px", width: "calc(50% - 3px)" }}
              aria-hidden="true"
            />
            <button
              className={!value.fastMode ? styles.modelControlsSegmentActive : ""}
              type="button"
              aria-pressed={!value.fastMode}
              data-processing-speed="standard"
              onClick={() => onChange({ ...value, fastMode: false })}
            >
              Standard
            </button>
            <button
              className={value.fastMode ? styles.modelControlsSegmentActive : ""}
              type="button"
              aria-pressed={value.fastMode}
              data-processing-speed="fast"
              onClick={() => onChange({ ...value, fastMode: true })}
            >
              Fast
            </button>
          </div>
          <p className={styles.modelControlsHint}>
            Fast uses OpenAI&apos;s Fast processing tier without changing the model or reasoning level.
          </p>
        </fieldset>

        <fieldset className={styles.modelControlsFieldset}>
          <legend>Reasoning</legend>
          <div className={styles.modelControlsEffort} role="group" aria-label="Reasoning effort">
            {REASONING_EFFORTS.map((effort) => (
              <button
                className={effort === value.reasoningEffort ? styles.modelControlsEffortActive : ""}
                key={effort}
                type="button"
                aria-pressed={effort === value.reasoningEffort}
                data-reasoning-effort={effort}
                title={`${effort} reasoning`}
                onClick={() => updateReasoning(effort)}
              >
                {effortLabels[effort]}
              </button>
            ))}
          </div>
          <p className={styles.modelControlsHint}>
            Medium is the balanced default. Use Max only for the hardest quality-first analysis.
          </p>
        </fieldset>
      </div>
    </div>
  );
}
