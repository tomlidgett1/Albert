"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { motion } from "framer-motion";
import {
  describeSchedule,
  formatPhoneForDisplay,
  isValidTimezone,
  SCHEDULE_DAY_LABELS,
  SCHEDULE_DAY_SHORT,
  SCHEDULE_DAYS,
  normaliseScheduleDays,
  type ScheduleDay,
  type ScheduledRun,
  type ScheduledTask,
} from "@/services/scheduled/src/contracts";
import { formatInZone } from "@/services/scheduled/src/next-run";
import styles from "./scheduled.module.css";

type EnrolledNumber = Readonly<{ phone: string; displayName: string | null; isOwner: boolean }>;

type Payload = Readonly<{
  tasks?: unknown[];
  numbers?: unknown[];
  defaults?: Readonly<{ timezone?: string; phone?: string | null }>;
  botNumberDisplay?: string;
  canManage?: boolean;
  error?: string;
}>;

type Status = "loading" | "ready" | "error";

const EASE = [0.22, 1, 0.36, 1] as const;
const POLL_MS = 4_000;
const EXAMPLES = [
  "Send me a message every morning at 9am with an overview of yesterday's sales performance",
  "Every Monday at 8am, last week's sales against the week before, by category",
  "Weekdays at 5:30pm, today's takings and wages so far",
] as const;

/** A short list for browsers without Intl.supportedValuesOf; the real list is used when available. */
const FALLBACK_ZONES = [
  "Australia/Melbourne", "Australia/Sydney", "Australia/Brisbane", "Australia/Adelaide", "Australia/Perth",
  "Australia/Darwin", "Australia/Hobart", "Pacific/Auckland", "Asia/Singapore", "Asia/Tokyo", "Asia/Hong_Kong",
  "Europe/London", "Europe/Paris", "Europe/Berlin", "America/New_York", "America/Chicago", "America/Denver",
  "America/Los_Angeles", "America/Toronto", "UTC",
] as const;

function isRun(value: unknown): value is ScheduledRun {
  if (!value || typeof value !== "object") return false;
  const run = value as Record<string, unknown>;
  return typeof run.runId === "string" && typeof run.status === "string" && typeof run.trigger === "string";
}

function isTask(value: unknown): value is ScheduledTask {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const task = value as Record<string, unknown>;
  return typeof task.taskId === "string"
    && typeof task.title === "string"
    && typeof task.prompt === "string"
    && typeof task.timeOfDay === "string"
    && Array.isArray(task.days)
    && typeof task.timezone === "string"
    && typeof task.phone === "string"
    && typeof task.enabled === "boolean";
}

function isNumber(value: unknown): value is EnrolledNumber {
  if (!value || typeof value !== "object") return false;
  const number = value as Record<string, unknown>;
  return typeof number.phone === "string" && typeof number.isOwner === "boolean";
}

function normaliseTask(task: ScheduledTask): ScheduledTask {
  return {
    ...task,
    days: normaliseScheduleDays(task.days),
    lastRun: isRun(task.lastRun) ? task.lastRun : null,
    recentRuns: Array.isArray(task.recentRuns) ? task.recentRuns.filter(isRun) : [],
  };
}

function timezoneOptions(...pinned: readonly (string | null | undefined)[]): readonly string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  let zones: readonly string[];
  try {
    zones = intl.supportedValuesOf?.("timeZone") ?? FALLBACK_ZONES;
  } catch {
    zones = FALLBACK_ZONES;
  }
  const set = new Set<string>(zones);
  for (const zone of pinned) if (zone && isValidTimezone(zone)) set.add(zone);
  return [...set].sort((a, b) => a.localeCompare(b));
}

function browserTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
  } catch {
    return null;
  }
}

function zoneLabel(zone: string): string {
  return zone.replace(/_/gu, " ");
}

function runOpen(run: ScheduledRun | null): boolean {
  return run?.status === "queued" || run?.status === "running";
}

function runWhen(run: ScheduledRun, timezone: string): string {
  const stamp = run.finishedAt ?? run.startedAt ?? run.requestedAt;
  const date = new Date(stamp);
  return Number.isNaN(date.getTime()) ? "" : formatInZone(date, timezone);
}

function describeRun(run: ScheduledRun, timezone: string): string {
  const when = runWhen(run, timezone);
  switch (run.status) {
    case "queued":
      return "Queued to send…";
    case "running":
      return "Sending… Albert is running the analysis";
    case "sent":
      return `Sent ${when}${run.bubbles && run.bubbles > 1 ? ` · ${run.bubbles} bubbles` : ""}`;
    case "failed":
      return `Failed ${when}${run.error ? `: ${run.error}` : ""}`;
    case "missed":
      return `Missed ${when}${run.error ? `: ${run.error}` : ""}`;
    default:
      return when;
  }
}

async function post(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch("/api/scheduled", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(typeof payload.error === "string" ? payload.error : "The change could not be saved.");
  }
  return payload;
}

function ClockGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  );
}

export default function ScheduledWorkspace({
  organisationName,
  onOpenConversation,
  reduceMotion,
  panelId,
  labelledBy,
}: Readonly<{
  organisationName: string;
  onOpenConversation: (conversationId: string) => void;
  reduceMotion: boolean;
  panelId: string;
  labelledBy: string;
}>) {
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState("");
  const [tasks, setTasks] = useState<readonly ScheduledTask[]>([]);
  const [numbers, setNumbers] = useState<readonly EnrolledNumber[]>([]);
  const [defaultTimezone, setDefaultTimezone] = useState<string | null>(null);
  const [canManage, setCanManage] = useState(true);
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<Readonly<{ taskId: string; note: string }> | null>(null);
  const [busy, setBusy] = useState<Readonly<Record<string, "saving" | "running" | "deleting">>>({});
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [promptDrafts, setPromptDrafts] = useState<Readonly<Record<string, string>>>({});
  const abortRef = useRef<AbortController | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const showNotice = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(""), 6_000);
  }, []);

  const applyPayload = useCallback((payload: Payload | null) => {
    if (!payload) return;
    setTasks((payload.tasks ?? []).filter(isTask).map(normaliseTask));
    setNumbers((payload.numbers ?? []).filter(isNumber));
    if (typeof payload.defaults?.timezone === "string") setDefaultTimezone(payload.defaults.timezone);
    if (typeof payload.canManage === "boolean") setCanManage(payload.canManage);
  }, []);

  const load = useCallback(async (options?: Readonly<{ quiet?: boolean }>) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    if (!options?.quiet) {
      setStatus("loading");
      setError("");
    }
    try {
      const response = await fetch("/api/scheduled", { cache: "no-store", signal: controller.signal });
      const payload = (await response.json().catch(() => null)) as Payload | null;
      if (controller.signal.aborted) return;
      if (!response.ok) {
        if (!options?.quiet) {
          setStatus("error");
          setError(payload?.error || "Schedules could not be loaded.");
        }
        return;
      }
      applyPayload(payload);
      setStatus("ready");
    } catch (loadError) {
      if (controller.signal.aborted || options?.quiet) return;
      setStatus("error");
      setError(loadError instanceof Error ? loadError.message : "Schedules could not be loaded.");
    }
  }, [applyPayload]);

  useEffect(() => {
    // Deferred so the first paint is the skeleton, not a synchronous state cascade.
    queueMicrotask(() => void load());
    return () => {
      abortRef.current?.abort();
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    };
  }, [load]);

  const anyRunOpen = tasks.some((task) => runOpen(task.lastRun));
  useEffect(() => {
    if (!anyRunOpen) return;
    const timer = setInterval(() => void load({ quiet: true }), POLL_MS);
    return () => clearInterval(timer);
  }, [anyRunOpen, load]);

  const replaceTask = useCallback((next: ScheduledTask) => {
    setTasks((current) => current.map((task) => (task.taskId === next.taskId ? normaliseTask(next) : task)));
  }, []);

  const markBusy = useCallback((taskId: string, state: "saving" | "running" | "deleting" | null) => {
    setBusy((current) => {
      const next = { ...current };
      if (state) next[taskId] = state;
      else delete next[taskId];
      return next;
    });
  }, []);

  const create = async (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (!text || creating) return;
    setCreating(true);
    setCreated(null);
    try {
      const zone = browserTimezone();
      const payload = await post({ action: "create", text, ...(zone && isValidTimezone(zone) ? { timezone: zone } : {}) });
      if (isTask(payload.task)) {
        const task = normaliseTask(payload.task);
        setTasks((current) => [...current.filter((item) => item.taskId !== task.taskId), task]);
        setCreated({ taskId: task.taskId, note: typeof payload.note === "string" ? payload.note : "" });
        setDraft("");
      } else {
        await load({ quiet: true });
      }
    } catch (createError) {
      showNotice(createError instanceof Error ? createError.message : "The schedule could not be created.");
    } finally {
      setCreating(false);
    }
  };

  const patch = async (task: ScheduledTask, changes: Record<string, unknown>, optimistic: Partial<ScheduledTask>) => {
    if (!canManage) return;
    const previous = task;
    replaceTask({ ...task, ...optimistic });
    markBusy(task.taskId, "saving");
    try {
      const payload = await post({ action: "update", taskId: task.taskId, ...changes });
      if (isTask(payload.task)) replaceTask(payload.task);
    } catch (patchError) {
      replaceTask(previous);
      showNotice(patchError instanceof Error ? patchError.message : "The schedule could not be updated.");
    } finally {
      markBusy(task.taskId, null);
    }
  };

  const runNow = async (task: ScheduledTask) => {
    if (busy[task.taskId] || runOpen(task.lastRun)) return;
    markBusy(task.taskId, "running");
    try {
      const payload = await post({ action: "run", taskId: task.taskId });
      if (isRun(payload.run)) {
        replaceTask({ ...task, lastRun: payload.run, recentRuns: [payload.run, ...task.recentRuns].slice(0, 5) });
      } else {
        await load({ quiet: true });
      }
    } catch (runError) {
      showNotice(runError instanceof Error ? runError.message : "The run could not be started.");
    } finally {
      markBusy(task.taskId, null);
    }
  };

  const remove = async (task: ScheduledTask) => {
    if (confirmingDelete !== task.taskId) {
      setConfirmingDelete(task.taskId);
      setTimeout(() => setConfirmingDelete((current) => (current === task.taskId ? null : current)), 3_500);
      return;
    }
    setConfirmingDelete(null);
    markBusy(task.taskId, "deleting");
    try {
      await post({ action: "delete", taskId: task.taskId });
      setTasks((current) => current.filter((item) => item.taskId !== task.taskId));
      showNotice(`Removed "${task.title}".`);
    } catch (removeError) {
      markBusy(task.taskId, null);
      showNotice(removeError instanceof Error ? removeError.message : "The schedule could not be removed.");
    }
  };

  const toggleDay = (task: ScheduledTask, day: ScheduleDay) => {
    const has = task.days.includes(day);
    const days = normaliseScheduleDays(has ? task.days.filter((item) => item !== day) : [...task.days, day]);
    if (days.length === 0) {
      showNotice("Keep at least one day.");
      return;
    }
    void patch(task, { days }, { days });
  };

  const commitPrompt = (task: ScheduledTask) => {
    const next = (promptDrafts[task.taskId] ?? task.prompt).replace(/\s+/gu, " ").trim();
    setPromptDrafts((current) => {
      const copy = { ...current };
      delete copy[task.taskId];
      return copy;
    });
    if (!next || next === task.prompt) return;
    void patch(task, { prompt: next }, { prompt: next });
  };

  const zoneChoices = useMemo(
    () => timezoneOptions(defaultTimezone, browserTimezone(), ...tasks.map((task) => task.timezone)),
    [defaultTimezone, tasks],
  );

  const numberLabel = (phone: string): string => {
    const match = numbers.find((number) => number.phone === phone);
    const display = formatPhoneForDisplay(phone);
    if (!match) return display;
    return match.displayName ? `${match.displayName} · ${display}` : match.isOwner ? `You · ${display}` : display;
  };

  const empty = status === "ready" && tasks.length === 0;

  return (
    <section
      className={styles.scheduled}
      id={panelId}
      role="tabpanel"
      aria-labelledby={labelledBy}
      data-testid="scheduled-workspace"
      data-status={status}
    >
      <div className={styles.inner}>
        <header className={styles.header}>
          <p className={styles.eyebrow}>Scheduled</p>
          <h2 className={styles.title}>Reports on your schedule</h2>
          <p className={styles.lede}>
            Describe what you want and when. Albert runs the analysis for {organisationName} at that time and texts it to you over iMessage.
          </p>
        </header>

        {canManage ? (
          <form className={styles.composer} onSubmit={(event) => void create(event)} data-testid="scheduled-composer">
            <label className={styles.composerLabel} htmlFor="scheduled-request">Describe a report and when to send it</label>
            <textarea
              id="scheduled-request"
              ref={textareaRef}
              className={styles.composerInput}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void create();
              }}
              placeholder="Send me a message every morning at 9am with an overview of yesterday's sales performance"
              rows={2}
              maxLength={2_000}
              disabled={creating}
            />
            <div className={styles.composerBar}>
              <p className={styles.composerHint}>
                {numbers.length > 0
                  ? "Goes to your enrolled number; change it per schedule below."
                  : "Enrol a number on the iMessage page first."}
              </p>
              <button className={styles.composerSubmit} type="submit" disabled={creating || !draft.trim() || numbers.length === 0}>
                {creating ? (
                  <>
                    <span className={styles.spinner} aria-hidden="true" />
                    Setting it up…
                  </>
                ) : "Create schedule"}
              </button>
            </div>
          </form>
        ) : null}

        {created ? (
          <p className={styles.created} role="status" data-testid="scheduled-created">
            <span className={styles.createdMark} aria-hidden="true">
              <svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
            </span>
            <span>
              Scheduled.{created.note ? ` ${created.note}` : " Adjust the time, days or number below if needed."}
            </span>
          </p>
        ) : null}

        {notice ? <p className={styles.notice} role="status">{notice}</p> : null}

        {status === "error" ? (
          <div className={styles.error} role="alert">
            <p>{error}</p>
            <button className={styles.retry} type="button" onClick={() => void load()}>Try again</button>
          </div>
        ) : null}

        {status === "loading" ? (
          <div className={styles.list} aria-busy="true">
            <div className={styles.skeleton} aria-hidden="true">
              <span className={styles.skeletonBar} data-width="title" />
              <span className={styles.skeletonBar} data-width="line" />
              <span className={styles.skeletonBar} data-width="short" />
            </div>
          </div>
        ) : null}

        {empty ? (
          <div className={styles.empty} data-testid="scheduled-empty">
            <span className={styles.emptyGlyph} aria-hidden="true"><ClockGlyph /></span>
            <h3 className={styles.emptyTitle}>No schedules yet</h3>
            <p className={styles.emptyBody}>
              Try one of these, or write your own above.
            </p>
            <div className={styles.examples}>
              {EXAMPLES.map((example) => (
                <button
                  key={example}
                  className={styles.example}
                  type="button"
                  onClick={() => {
                    setDraft(example);
                    textareaRef.current?.focus();
                  }}
                >
                  {example}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {status === "ready" && tasks.length > 0 ? (
          <div className={styles.list} data-testid="scheduled-list">
            {tasks.map((task, index) => {
              const state = busy[task.taskId];
              const open = runOpen(task.lastRun);
              const nextRun = task.enabled && task.nextRunAt ? new Date(task.nextRunAt) : null;
              const lastRun = task.lastRun;
              return (
                <motion.article
                  key={task.taskId}
                  className={styles.task}
                  data-testid="scheduled-task"
                  data-enabled={task.enabled}
                  data-highlight={created?.taskId === task.taskId}
                  aria-busy={state === "saving" || state === "deleting"}
                  layout={!reduceMotion}
                  initial={reduceMotion ? false : { opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{
                    duration: reduceMotion ? 0 : 0.36,
                    ease: EASE,
                    delay: reduceMotion ? 0 : Math.min(index * 0.04, 0.3),
                    layout: { duration: reduceMotion ? 0 : 0.28, ease: EASE },
                  }}
                >
                  <header className={styles.taskHead}>
                    <div className={styles.taskTitleWrap}>
                      <span className={styles.taskGlyph} aria-hidden="true"><ClockGlyph /></span>
                      <div className={styles.taskTitleText}>
                        <h3 className={styles.taskTitle}>{task.title}</h3>
                        <p className={styles.taskWhen}>
                          {describeSchedule(task)} · {zoneLabel(task.timezone)} · to {numberLabel(task.phone)}
                        </p>
                      </div>
                    </div>
                    <div className={styles.taskHeadActions}>
                      {canManage ? (
                        <>
                          <button
                            type="button"
                            className={styles.switch}
                            role="switch"
                            aria-checked={task.enabled}
                            aria-label={`${task.title} schedule ${task.enabled ? "on" : "off"}`}
                            data-on={task.enabled}
                            disabled={state === "deleting"}
                            onClick={() => void patch(task, { enabled: !task.enabled }, { enabled: !task.enabled, nextRunAt: task.enabled ? null : task.nextRunAt })}
                          >
                            <span className={styles.knob} />
                          </button>
                          <button
                            type="button"
                            className={styles.remove}
                            data-confirming={confirmingDelete === task.taskId}
                            aria-label={confirmingDelete === task.taskId ? `Confirm removing ${task.title}` : `Remove ${task.title}`}
                            disabled={state === "deleting"}
                            onClick={() => void remove(task)}
                          >
                            {confirmingDelete === task.taskId ? "Remove?" : "×"}
                          </button>
                        </>
                      ) : (
                        <span className={styles.stateChip}>{task.enabled ? "On" : "Off"}</span>
                      )}
                    </div>
                  </header>

                  <label className={styles.promptLabel}>
                    <span className={styles.fieldLabel}>Albert answers</span>
                    <textarea
                      className={styles.prompt}
                      value={promptDrafts[task.taskId] ?? task.prompt}
                      rows={2}
                      maxLength={600}
                      readOnly={!canManage}
                      aria-label={`Question for ${task.title}`}
                      onChange={(event) => setPromptDrafts((current) => ({ ...current, [task.taskId]: event.target.value }))}
                      onBlur={() => commitPrompt(task)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault();
                          event.currentTarget.blur();
                        }
                      }}
                    />
                  </label>

                  <div className={styles.controls}>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Time</span>
                      <input
                        className={styles.input}
                        type="time"
                        value={task.timeOfDay}
                        disabled={!canManage}
                        aria-label={`Time for ${task.title}`}
                        onChange={(event) => {
                          const value = event.target.value;
                          if (/^([01][0-9]|2[0-3]):[0-5][0-9]$/u.test(value)) void patch(task, { timeOfDay: value }, { timeOfDay: value });
                        }}
                      />
                    </label>
                    <fieldset className={`${styles.field} ${styles.daysField}`}>
                      <legend className={styles.fieldLabel}>Days</legend>
                      <div className={styles.days}>
                        {SCHEDULE_DAYS.map((day) => (
                          <button
                            key={day}
                            type="button"
                            className={styles.day}
                            aria-pressed={task.days.includes(day)}
                            aria-label={SCHEDULE_DAY_LABELS[day]}
                            disabled={!canManage}
                            onClick={() => toggleDay(task, day)}
                          >
                            {SCHEDULE_DAY_SHORT[day].slice(0, 1)}
                          </button>
                        ))}
                      </div>
                    </fieldset>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Time zone</span>
                      <select
                        className={styles.select}
                        value={task.timezone}
                        disabled={!canManage}
                        aria-label={`Time zone for ${task.title}`}
                        onChange={(event) => void patch(task, { timezone: event.target.value }, { timezone: event.target.value })}
                      >
                        {zoneChoices.map((zone) => <option key={zone} value={zone}>{zoneLabel(zone)}</option>)}
                      </select>
                    </label>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Send to</span>
                      <select
                        className={styles.select}
                        value={task.phone}
                        disabled={!canManage}
                        aria-label={`Send ${task.title} to`}
                        onChange={(event) => void patch(task, { phone: event.target.value }, { phone: event.target.value })}
                      >
                        {!numbers.some((number) => number.phone === task.phone) ? (
                          <option value={task.phone}>{formatPhoneForDisplay(task.phone)} (not enrolled)</option>
                        ) : null}
                        {numbers.map((number) => (
                          <option key={number.phone} value={number.phone}>{numberLabel(number.phone)}</option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <footer className={styles.taskFoot}>
                    <div className={styles.taskStatus}>
                      <span
                        className={styles.statusDot}
                        data-state={open ? "live" : lastRun?.status ?? (task.enabled ? "idle" : "off")}
                        aria-hidden="true"
                      />
                      <span className={styles.statusText} data-testid="scheduled-next">
                        {task.enabled
                          ? nextRun && !Number.isNaN(nextRun.getTime())
                            ? `Next ${formatInZone(nextRun, task.timezone)}`
                            : "Scheduled"
                          : "Paused"}
                      </span>
                      {lastRun ? (
                        <span className={styles.lastRun} data-testid="scheduled-last-run" data-state={lastRun.status}>
                          <span aria-hidden="true">·</span>
                          <span>{describeRun(lastRun, task.timezone)}</span>
                          {lastRun.conversationId ? (
                            <button
                              type="button"
                              className={styles.link}
                              onClick={() => onOpenConversation(lastRun.conversationId!)}
                            >
                              View analysis
                            </button>
                          ) : null}
                        </span>
                      ) : null}
                    </div>
                    {canManage ? (
                      <button
                        type="button"
                        className={styles.runNow}
                        disabled={open || Boolean(state)}
                        aria-busy={open}
                        onClick={() => void runNow(task)}
                      >
                        {open ? (
                          <>
                            <span className={styles.spinner} aria-hidden="true" />
                            Sending…
                          </>
                        ) : "Run now"}
                      </button>
                    ) : null}
                  </footer>

                  {task.recentRuns.length > 1 ? (
                    <details className={styles.history}>
                      <summary className={styles.historySummary}>Recent runs</summary>
                      <ul className={styles.historyList}>
                        {task.recentRuns.map((run) => (
                          <li key={run.runId} className={styles.historyItem} data-state={run.status}>
                            <span className={styles.historyTrigger}>{run.trigger === "manual" ? "Manual" : "Scheduled"}</span>
                            <span className={styles.historyText}>{describeRun(run, task.timezone)}</span>
                            {run.conversationId ? (
                              <button type="button" className={styles.link} onClick={() => onOpenConversation(run.conversationId!)}>
                                View
                              </button>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </motion.article>
              );
            })}
          </div>
        ) : null}
      </div>
    </section>
  );
}
