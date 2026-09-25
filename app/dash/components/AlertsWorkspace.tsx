"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { motion } from "framer-motion";
import { formatAlertPhone, type AlertEvent } from "@/services/alerts/src/contracts";
import { formatInZone } from "@/services/scheduled/src/next-run";
import { CONNECTOR_LOGOS, CONNECTOR_NAMES, type TraceConnectorId } from "./connectors";
import styles from "./alerts.module.css";

type EnrolledNumber = Readonly<{ phone: string; displayName: string | null; isOwner: boolean }>;

type TriggerState = Readonly<{
  lastEvaluatedAt: string;
  lastFiredAt: string | null;
}>;

type TriggerCard = Readonly<{
  key: string;
  title: string;
  summary?: string;
  rule: string;
  needs?: readonly string[];
  enabled: boolean;
  recipients: readonly string[];
  state: TriggerState | null;
}>;

/** Trigger connector keys → the logo catalogue's ids (Lightspeed R and X share a mark). */
function logoIds(needs: readonly string[] | undefined): readonly TraceConnectorId[] {
  const ids: TraceConnectorId[] = [];
  for (const need of needs ?? []) {
    const id = (need === "lightspeed-r" ? "lightspeed" : need) as TraceConnectorId;
    if (id in CONNECTOR_LOGOS && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function listInEnglish(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]}`;
}

function ToolLogos({ needs }: { needs: readonly string[] | undefined }) {
  const ids = logoIds(needs);
  if (ids.length === 0) return null;
  const names = listInEnglish(ids.map((id) => CONNECTOR_NAMES[id]));
  return (
    <span className={styles.tools} title={names} aria-label={`Reads ${names}`} role="img">
      {ids.map((id) => (
        <span className={styles.toolMark} key={id}>
          <Image src={CONNECTOR_LOGOS[id]} alt="" width={14} height={14} unoptimized />
        </span>
      ))}
    </span>
  );
}

type Evaluation = Readonly<{
  evaluationId: string;
  status: "queued" | "running" | "finished" | "failed";
  finishedAt: string | null;
  summary: Readonly<Record<string, unknown>>;
}>;

type Payload = Readonly<{
  triggers?: unknown[];
  events?: unknown[];
  lastEvaluation?: unknown;
  openEvaluation?: unknown;
  numbers?: unknown[];
  canManage?: boolean;
  error?: string;
}>;

type Status = "loading" | "ready" | "error";

const EASE = [0.22, 1, 0.36, 1] as const;
const POLL_MS = 4_000;
const CONNECTOR_LABELS: Readonly<Record<string, string>> = Object.freeze({
  "lightspeed-r": "Lightspeed",
  "lightspeed-x": "Lightspeed",
  xero: "Xero",
  deputy: "Deputy",
  square: "Square",
  shopify: "Shopify",
  stripe: "Stripe",
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEvent(value: unknown): value is AlertEvent {
  return isRecord(value)
    && typeof value.eventId === "string"
    && typeof value.triggerKey === "string"
    && typeof value.headline === "string"
    && typeof value.body === "string"
    && typeof value.status === "string"
    && typeof value.firedAt === "string";
}

function isTrigger(value: unknown): value is TriggerCard {
  return isRecord(value)
    && typeof value.key === "string"
    && typeof value.title === "string"
    && typeof value.enabled === "boolean"
    && Array.isArray(value.recipients);
}

function isEvaluation(value: unknown): value is Evaluation {
  return isRecord(value) && typeof value.evaluationId === "string" && typeof value.status === "string";
}

function isNumber(value: unknown): value is EnrolledNumber {
  return isRecord(value) && typeof value.phone === "string" && typeof value.isOwner === "boolean";
}

function normaliseTrigger(trigger: TriggerCard): TriggerCard {
  return {
    ...trigger,
    recipients: trigger.recipients.filter((phone): phone is string => typeof phone === "string"),
    state: isRecord(trigger.state) ? (trigger.state as TriggerState) : null,
  };
}

function evaluationOpen(evaluation: Evaluation | null): boolean {
  return evaluation?.status === "queued" || evaluation?.status === "running";
}

/** "just now", "4 min ago", "3 h ago", else the zoned day and time. */
function ago(iso: string | null | undefined, now: number, timezone: string): string {
  if (!iso) return "";
  const stamp = Date.parse(iso);
  if (!Number.isFinite(stamp)) return "";
  const seconds = Math.max(0, Math.round((now - stamp) / 1000));
  if (seconds < 45) return "just now";
  if (seconds < 3_600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 6 * 3_600) return `${Math.round(seconds / 3_600)} h ago`;
  return formatInZone(new Date(stamp), timezone);
}

/** "Lightspeed to Wed 2 Sep", one per connected tool, from the last check's freshness. */
function dataThroughChips(evaluation: Evaluation | null, timezone: string): readonly string[] {
  const entries = evaluation && Array.isArray(evaluation.summary.dataThrough) ? evaluation.summary.dataThrough : [];
  const latest = new Map<string, string>();
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.connector !== "string" || typeof entry.dataThrough !== "string") continue;
    const label = CONNECTOR_LABELS[entry.connector] ?? entry.connector;
    const current = latest.get(label);
    if (!current || entry.dataThrough > current) latest.set(label, entry.dataThrough);
  }
  return [...latest.entries()].map(([label, through]) => {
    const date = new Date(through);
    const day = Number.isNaN(date.getTime())
      ? through.slice(0, 10)
      : new Intl.DateTimeFormat("en-AU", { timeZone: timezone, weekday: "short", day: "numeric", month: "short" }).format(date);
    return `${label} to ${day}`;
  });
}

function statusLabel(status: AlertEvent["status"]): string {
  switch (status) {
    case "sent": return "Sent";
    case "failed": return "Failed";
    case "muted": return "Not texted";
    default: return "Sending";
  }
}

async function post(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch("/api/alerts", {
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

export default function AlertsWorkspace({
  reduceMotion,
  panelId,
  labelledBy,
}: Readonly<{
  organisationName: string;
  reduceMotion: boolean;
  panelId: string;
  labelledBy: string;
}>) {
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState("");
  const [triggers, setTriggers] = useState<readonly TriggerCard[]>([]);
  const [events, setEvents] = useState<readonly AlertEvent[]>([]);
  const [numbers, setNumbers] = useState<readonly EnrolledNumber[]>([]);
  const [lastEvaluation, setLastEvaluation] = useState<Evaluation | null>(null);
  const [openEvaluation, setOpenEvaluation] = useState<Evaluation | null>(null);
  const [canManage, setCanManage] = useState(true);
  const [busy, setBusy] = useState<Readonly<Record<string, boolean>>>({});
  const [notice, setNotice] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const abortRef = useRef<AbortController | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timezone = useMemo(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
    } catch {
      return "UTC";
    }
  }, []);

  const showNotice = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(""), 6_000);
  }, []);

  const applyPayload = useCallback((payload: Payload | null) => {
    if (!payload) return;
    setTriggers((payload.triggers ?? []).filter(isTrigger).map(normaliseTrigger));
    setEvents((payload.events ?? []).filter(isEvent));
    setNumbers((payload.numbers ?? []).filter(isNumber));
    setLastEvaluation(isEvaluation(payload.lastEvaluation) ? payload.lastEvaluation : null);
    setOpenEvaluation(isEvaluation(payload.openEvaluation) ? payload.openEvaluation : null);
    if (typeof payload.canManage === "boolean") setCanManage(payload.canManage);
    setNow(Date.now());
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
      const response = await fetch("/api/alerts", { cache: "no-store", signal: controller.signal });
      const payload = (await response.json().catch(() => null)) as Payload | null;
      if (controller.signal.aborted) return;
      if (!response.ok) {
        if (!options?.quiet) {
          setStatus("error");
          setError(payload?.error || "Alerts could not be loaded.");
        }
        return;
      }
      applyPayload(payload);
      setStatus("ready");
    } catch (loadError) {
      if (controller.signal.aborted || options?.quiet) return;
      setStatus("error");
      setError(loadError instanceof Error ? loadError.message : "Alerts could not be loaded.");
    }
  }, [applyPayload]);

  useEffect(() => {
    queueMicrotask(() => void load());
    return () => {
      abortRef.current?.abort();
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    };
  }, [load]);

  const checking = evaluationOpen(openEvaluation);
  useEffect(() => {
    if (!checking) return;
    const timer = setInterval(() => void load({ quiet: true }), POLL_MS);
    return () => clearInterval(timer);
  }, [checking, load]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const replaceTrigger = useCallback((next: TriggerCard) => {
    setTriggers((current) => current.map((trigger) => (trigger.key === next.key ? normaliseTrigger(next) : trigger)));
  }, []);

  const markBusy = useCallback((key: string, state: boolean) => {
    setBusy((current) => {
      const next = { ...current };
      if (state) next[key] = true;
      else delete next[key];
      return next;
    });
  }, []);

  const update = async (trigger: TriggerCard, changes: Readonly<{ enabled?: boolean; recipients?: readonly string[] }>) => {
    if (!canManage) return;
    const previous = trigger;
    replaceTrigger({ ...trigger, ...changes });
    markBusy(trigger.key, true);
    try {
      const payload = await post({
        action: "update",
        triggerKey: trigger.key,
        ...(changes.enabled !== undefined ? { enabled: changes.enabled } : {}),
        ...(changes.recipients ? { recipients: [...changes.recipients] } : {}),
      });
      if (isTrigger(payload.trigger)) replaceTrigger(payload.trigger);
    } catch (updateError) {
      replaceTrigger(previous);
      showNotice(updateError instanceof Error ? updateError.message : "The alert could not be updated.");
    } finally {
      markBusy(trigger.key, false);
    }
  };

  const toggleRecipient = (trigger: TriggerCard, phone: string) => {
    const has = trigger.recipients.includes(phone);
    const recipients = has ? trigger.recipients.filter((entry) => entry !== phone) : [...trigger.recipients, phone];
    void update(trigger, { recipients });
  };

  const check = async () => {
    if (checking || busy.check) return;
    markBusy("check", true);
    try {
      const payload = await post({ action: "check" });
      if (isEvaluation(payload.evaluation)) setOpenEvaluation(payload.evaluation);
      else await load({ quiet: true });
    } catch (checkError) {
      showNotice(checkError instanceof Error ? checkError.message : "The check could not be started.");
    } finally {
      markBusy("check", false);
    }
  };

  const numberLabel = (phone: string): string => {
    const match = numbers.find((number) => number.phone === phone);
    if (!match) return formatAlertPhone(phone);
    return match.isOwner ? "You" : match.displayName ? match.displayName : formatAlertPhone(phone);
  };

  const titleOf = (key: string): string => triggers.find((trigger) => trigger.key === key)?.title ?? key;
  const chips = dataThroughChips(lastEvaluation ?? openEvaluation, timezone);
  const checkedLine = checking
    ? "Checking…"
    : lastEvaluation
      ? lastEvaluation.status === "failed"
        ? `Last check failed ${ago(lastEvaluation.finishedAt, now, timezone)}`
        : `Checked ${ago(lastEvaluation.finishedAt, now, timezone)}`
      : "Not checked yet";

  return (
    <section
      className={styles.alerts}
      id={panelId}
      role="tabpanel"
      aria-labelledby={labelledBy}
      data-testid="alerts-workspace"
      data-status={status}
    >
      <div className={styles.inner}>
        <header className={styles.header}>
          <h2 className={styles.title}>Alerts</h2>
          <div className={styles.statusBar}>
            <p className={styles.statusLine} role="status" data-testid="alerts-status">
              <span
                className={styles.statusDot}
                data-state={checking ? "live" : lastEvaluation?.status === "failed" ? "failed" : lastEvaluation ? "idle" : "none"}
                aria-hidden="true"
              />
              <span>{checkedLine}</span>
              {chips.map((chip) => (
                <span key={chip} className={styles.statusChip}>
                  <span aria-hidden="true">·</span> {chip}
                </span>
              ))}
            </p>
            {canManage ? (
              <button
                type="button"
                className={styles.checkNow}
                disabled={checking || Boolean(busy.check) || status !== "ready"}
                aria-busy={checking}
                onClick={() => void check()}
                data-testid="alerts-check"
              >
                {checking ? "Checking…" : "Check now"}
              </button>
            ) : null}
          </div>
        </header>

        {status === "ready" && numbers.length === 0 ? (
          <p className={styles.notice} role="status">
            Enrol a number on the iMessage page to receive these as texts.
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
          <div className={styles.grid} aria-busy="true">
            {[0, 1, 2, 3].map((index) => (
              <div key={index} className={styles.skeleton} aria-hidden="true">
                <span className={styles.skeletonBar} data-width="title" />
                <span className={styles.skeletonBar} data-width="line" />
              </div>
            ))}
          </div>
        ) : null}

        {status === "ready" ? (
          <div className={styles.grid} data-testid="alerts-list">
            {triggers.map((trigger, index) => (
              <motion.article
                key={trigger.key}
                className={styles.card}
                data-testid="alerts-trigger"
                data-key={trigger.key}
                data-enabled={trigger.enabled}
                aria-busy={Boolean(busy[trigger.key])}
                layout={!reduceMotion}
                initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{
                  duration: reduceMotion ? 0 : 0.32,
                  ease: EASE,
                  delay: reduceMotion ? 0 : Math.min(index * 0.03, 0.27),
                  layout: { duration: reduceMotion ? 0 : 0.24, ease: EASE },
                }}
              >
                <div className={styles.cardText}>
                  <h3 className={styles.cardTitle}>{trigger.title}</h3>
                  <p className={styles.cardSummary}>{trigger.summary || trigger.rule}</p>
                </div>
                {canManage ? (
                  <button
                    type="button"
                    className={styles.switch}
                    role="switch"
                    aria-checked={trigger.enabled}
                    aria-label={`${trigger.title} alert ${trigger.enabled ? "on" : "off"}`}
                    data-on={trigger.enabled}
                    onClick={() => void update(trigger, { enabled: !trigger.enabled })}
                  >
                    <span className={styles.knob} />
                  </button>
                ) : (
                  <span className={styles.stateChip}>{trigger.enabled ? "On" : "Off"}</span>
                )}
                {numbers.length > 0 ? (
                  <div className={styles.recipients} role="group" aria-label={`Send ${trigger.title} to`}>
                    {numbers.map((number) => {
                      const selected = trigger.recipients.includes(number.phone);
                      return (
                        <button
                          key={number.phone}
                          type="button"
                          className={styles.recipient}
                          aria-pressed={selected}
                          aria-label={`${numberLabel(number.phone)} ${formatAlertPhone(number.phone)}`}
                          title={formatAlertPhone(number.phone)}
                          disabled={!canManage || !trigger.enabled}
                          onClick={() => toggleRecipient(trigger, number.phone)}
                        >
                          <span className={styles.recipientMark} aria-hidden="true">
                            <svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>
                          </span>
                          {numberLabel(number.phone)}
                        </button>
                      );
                    })}
                  </div>
                ) : null}
                <div className={styles.cardFoot}>
                  <ToolLogos needs={trigger.needs} />
                  <span className={styles.cardFootText} data-testid="alerts-last-fired">
                    {!trigger.enabled
                      ? "Off"
                      : trigger.state?.lastFiredAt
                        ? `Last fired ${ago(trigger.state.lastFiredAt, now, timezone)}`
                        : "Hasn't fired yet"}
                  </span>
                </div>
              </motion.article>
            ))}
          </div>
        ) : null}

        {status === "ready" ? (
          <section className={styles.recent} data-testid="alerts-events" aria-label="Recent alerts">
            <h3 className={styles.recentTitle}>Recent</h3>
            {events.length === 0 ? (
              <p className={styles.recentEmpty}>Nothing has fired yet.</p>
            ) : (
              <ul className={styles.eventList}>
                {events.slice(0, 40).map((event) => (
                  <li key={event.eventId} className={styles.event} data-state={event.status}>
                    <p className={styles.eventHeadline}>{event.headline}</p>
                    <p className={styles.eventBody}>{event.body}</p>
                    <p className={styles.eventMeta}>
                      <span>{titleOf(event.triggerKey)}</span>
                      <span aria-hidden="true">·</span>
                      <span>{ago(event.firedAt, now, timezone)}</span>
                      {event.status !== "sent" ? (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className={styles.eventStatus} data-state={event.status}>{statusLabel(event.status)}</span>
                        </>
                      ) : null}
                    </p>
                    {event.error ? <p className={styles.eventError}>{event.error}</p> : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        ) : null}
      </div>
    </section>
  );
}
