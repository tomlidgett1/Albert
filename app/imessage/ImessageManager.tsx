"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import styles from "./imessage.module.css";

type Enrollment = Readonly<{
  enrollmentId: string;
  phone: string;
  displayName: string | null;
  email: string | null;
  isOwner: boolean;
  enabled: boolean;
  createdAt: string;
}>;

type Workspace = Readonly<{
  allowGroupChats: boolean;
  enrollments: readonly Enrollment[];
}>;

type Loaded = Readonly<{
  botNumber: string;
  botNumberDisplay: string;
  workspace: Workspace;
  canManage: boolean;
}>;

const PHONE_PATTERN = /^\+[1-9]\d{5,14}$/u;

function normalisePhone(raw: string): string {
  return raw.replace(/[\s().-]/gu, "");
}

function formatPhone(phone: string): string {
  if (/^\+614\d{8}$/u.test(phone)) {
    return `+61 ${phone.slice(3, 6)} ${phone.slice(6, 9)} ${phone.slice(9)}`;
  }
  if (/^\+1\d{10}$/u.test(phone)) {
    return `+1 (${phone.slice(2, 5)}) ${phone.slice(5, 8)}-${phone.slice(8)}`;
  }
  return phone;
}

async function post(body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch("/api/imessage", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(typeof payload.error === "string" ? payload.error : "The change could not be saved.");
  }
  return payload;
}

async function loadWorkspace(signal?: AbortSignal): Promise<Loaded | null> {
  const response = await fetch("/api/imessage", { cache: "no-store", signal });
  if (response.status === 401) return null;
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(typeof payload.error === "string" ? payload.error : "iMessage setup could not be loaded.");
  }
  return payload as unknown as Loaded;
}

export function ImessageManager() {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [needsSignIn, setNeedsSignIn] = useState(false);
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showNotice = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 5000);
  }, []);

  const applyWorkspace = useCallback((workspace: Loaded | null) => {
    setNeedsSignIn(workspace === null);
    setLoaded(workspace);
  }, []);

  const refresh = useCallback(async () => {
    applyWorkspace(await loadWorkspace());
  }, [applyWorkspace]);

  useEffect(() => {
    const controller = new AbortController();
    loadWorkspace(controller.signal).then((workspace) => {
      if (!controller.signal.aborted) applyWorkspace(workspace);
    }).catch((error) => {
      if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : "Something went wrong.");
    });
    return () => {
      controller.abort();
      if (noticeTimer.current) clearTimeout(noticeTimer.current);
    };
  }, [applyWorkspace]);

  const normalised = normalisePhone(phone);
  const phoneValid = PHONE_PATTERN.test(normalised);

  const addNumber = useCallback(async () => {
    if (!phoneValid || busy) return;
    setBusy(true);
    try {
      const result = await post({
        action: "enroll",
        phone: normalised,
        ...(name.trim() ? { displayName: name.trim() } : {}),
      });
      setPhone("");
      setName("");
      await refresh();
      if (result.existed) showNotice(`${formatPhone(normalised)} was already enrolled - switched back on.`);
      else if (result.introSent) showNotice(`Enrolled. Intro text sent to ${formatPhone(normalised)}.`);
      else showNotice(`Enrolled ${formatPhone(normalised)}.`);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "The number could not be enrolled.");
    } finally {
      setBusy(false);
    }
  }, [busy, name, normalised, phoneValid, refresh, showNotice]);

  const removeEnrollment = useCallback(async (enrollment: Enrollment) => {
    if (confirmingRemove !== enrollment.enrollmentId) {
      setConfirmingRemove(enrollment.enrollmentId);
      setTimeout(() => setConfirmingRemove((current) => (current === enrollment.enrollmentId ? null : current)), 3500);
      return;
    }
    setConfirmingRemove(null);
    try {
      await post({ action: "remove", enrollmentId: enrollment.enrollmentId });
      await refresh();
      showNotice(`Removed ${formatPhone(enrollment.phone)}.`);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "The enrolment could not be removed.");
    }
  }, [confirmingRemove, refresh, showNotice]);

  const toggleEnabled = useCallback(async (enrollment: Enrollment) => {
    try {
      await post({ action: "setEnabled", enrollmentId: enrollment.enrollmentId, enabled: !enrollment.enabled });
      await refresh();
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "The enrolment could not be updated.");
    }
  }, [refresh, showNotice]);

  const toggleGroups = useCallback(async () => {
    if (!loaded) return;
    const next = !loaded.workspace.allowGroupChats;
    setLoaded({ ...loaded, workspace: { ...loaded.workspace, allowGroupChats: next } });
    try {
      await post({ action: "setGroupChats", allowed: next });
    } catch (error) {
      await refresh().catch(() => undefined);
      showNotice(error instanceof Error ? error.message : "The setting could not be saved.");
    }
  }, [loaded, refresh, showNotice]);

  const enrollments = useMemo(() => loaded?.workspace.enrollments ?? [], [loaded]);

  if (needsSignIn) {
    return (
      <main className={styles.page}>
        <div className={styles.column}>
          <h1 className={styles.title}>iMessage</h1>
          <p className={styles.subtitle}>Sign in to Albert to manage who can text it.</p>
          <a className={styles.signIn} href="/dash">Open Albert</a>
        </div>
      </main>
    );
  }

  return (
    <main className={styles.page}>
      <div className={styles.column}>
        <a className={styles.back} href="/dash">← Albert</a>
        <h1 className={styles.title}>iMessage</h1>
        <p className={styles.subtitle}>Text Albert. Answers from your live data.</p>

        {loadError ? <p className={styles.error}>{loadError}</p> : null}

        <section className={styles.hero}>
          <span className={styles.kicker}>Text this number</span>
          <span className={styles.number}>{loaded?.botNumberDisplay ?? "· · ·"}</span>
          <span className={styles.heroCaption}>Save it as Albert. Ask anything about the business.</span>
        </section>

        <section>
          <span className={styles.sectionLabel}>People</span>
          <div className={styles.card}>
            {!loaded ? (
              <div className={styles.skeleton}>
                <div className={styles.skeletonRow} />
                <div className={styles.skeletonRow} />
              </div>
            ) : (
              <>
                {enrollments.map((enrollment) => (
                  <div key={enrollment.enrollmentId} className={styles.personRow} data-disabled={!enrollment.enabled}>
                    <span className={styles.dot} data-on={enrollment.enabled} aria-hidden />
                    <div className={styles.personText}>
                      <span className={styles.personName}>
                        {enrollment.displayName ?? formatPhone(enrollment.phone)}
                      </span>
                      <span className={styles.personMeta}>
                        {enrollment.displayName ? formatPhone(enrollment.phone) : null}
                        {enrollment.displayName && enrollment.email ? " · " : ""}
                        {enrollment.email ?? ""}
                      </span>
                    </div>
                    {enrollment.isOwner ? (
                      <span className={styles.ownerChip}>Owner</span>
                    ) : loaded.canManage ? (
                      <span className={styles.rowActions}>
                        <button
                          type="button"
                          className={styles.switch}
                          data-on={enrollment.enabled}
                          role="switch"
                          aria-checked={enrollment.enabled}
                          aria-label={`${enrollment.enabled ? "Disable" : "Enable"} ${formatPhone(enrollment.phone)}`}
                          onClick={() => void toggleEnabled(enrollment)}
                        >
                          <span className={styles.knob} />
                        </button>
                        <button
                          type="button"
                          className={styles.remove}
                          data-confirming={confirmingRemove === enrollment.enrollmentId}
                          onClick={() => void removeEnrollment(enrollment)}
                        >
                          {confirmingRemove === enrollment.enrollmentId ? "Remove?" : "×"}
                        </button>
                      </span>
                    ) : null}
                  </div>
                ))}
                {loaded.canManage ? (
                  <form
                    className={styles.addRow}
                    onSubmit={(event) => {
                      event.preventDefault();
                      void addNumber();
                    }}
                  >
                    <input
                      className={styles.input}
                      value={phone}
                      onChange={(event) => setPhone(event.target.value)}
                      placeholder="+61…"
                      inputMode="tel"
                      autoComplete="off"
                      aria-label="Phone number"
                    />
                    <input
                      className={styles.input}
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder="Name"
                      autoComplete="off"
                      aria-label="Name (optional)"
                    />
                    <button className={styles.add} type="submit" disabled={!phoneValid || busy}>
                      {busy ? "Adding…" : "Add"}
                    </button>
                  </form>
                ) : null}
              </>
            )}
          </div>
          {notice ? <p className={styles.notice}>{notice}</p> : null}
        </section>

        <section className={styles.groupCard}>
          <div className={styles.groupText}>
            <span className={styles.groupTitle}>Group chats</span>
            <span className={styles.groupCaption}>
              Add the number to any group chat, then say “Albert” to ask.
            </span>
          </div>
          {loaded?.canManage ? (
            <button
              type="button"
              className={styles.switch}
              data-on={loaded?.workspace.allowGroupChats ?? false}
              role="switch"
              aria-checked={loaded?.workspace.allowGroupChats ?? false}
              aria-label="Allow group chats"
              onClick={() => void toggleGroups()}
            >
              <span className={styles.knob} />
            </button>
          ) : (
            <span className={styles.groupState}>{loaded?.workspace.allowGroupChats ? "On" : "Off"}</span>
          )}
        </section>

        <p className={styles.footnote}>Only enrolled numbers can reach Albert.</p>
      </div>
    </main>
  );
}
