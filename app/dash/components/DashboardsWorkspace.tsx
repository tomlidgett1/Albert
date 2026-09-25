"use client";

/**
 * Dashboards — the list (ADR 0134, on Sigma's home model): every dashboard
 * the member has built, most recently touched first, and one way to start
 * a new one. A row opens its dashboard; a new dashboard opens blank in
 * dashboard mode, where the chat builds it in natural language. Rename and
 * delete live in the row's More menu, the way Sigma's document menu does.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { DashboardSummary } from "@/services/control-plane/src/dashboard-repository";
import styles from "./dashboards.module.css";

type Status = "loading" | "ready" | "error";

function icon(path: React.ReactNode) {
  return <svg viewBox="0 0 24 24" aria-hidden="true">{path}</svg>;
}

/** "just now", "4 min ago", "3 h ago", else the day. */
function editedAgo(iso: string, now: number): string {
  const stamp = Date.parse(iso);
  if (!Number.isFinite(stamp)) return "";
  const seconds = Math.max(0, Math.round((now - stamp) / 1000));
  if (seconds < 45) return "just now";
  if (seconds < 3_600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 24 * 3_600) return `${Math.round(seconds / 3_600)} h ago`;
  return new Intl.DateTimeFormat("en-AU", { day: "numeric", month: "short" }).format(new Date(stamp));
}

function elementsLabel(count: number): string {
  if (count === 0) return "Empty";
  return count === 1 ? "1 element" : `${count} elements`;
}

export function dashboardDisplayTitle(dashboard: Pick<DashboardSummary, "title">): string {
  return dashboard.title?.trim() || "Untitled dashboard";
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => null) as (T & { error?: string }) | null;
  if (!response.ok || !payload) throw new Error(payload?.error ?? "The dashboards are unavailable.");
  return payload;
}

function RowMenu({
  dashboard,
  onRename,
  onDelete,
}: Readonly<{
  dashboard: DashboardSummary;
  onRename: () => void;
  onDelete: () => void;
}>) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const areaRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!areaRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setConfirming(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        setConfirming(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);
  const title = dashboardDisplayTitle(dashboard);
  return (
    <div className={styles.rowMenu} ref={areaRef}>
      <button
        type="button"
        className={styles.rowMenuTrigger}
        aria-label={`More options for ${title}`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-active={open ? "true" : undefined}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
          setConfirming(false);
        }}
      >
        {icon(<><circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" /></>)}
      </button>
      {open ? (
        <div className={styles.menu} role="menu" aria-label={`${title} options`} onClick={(event) => event.stopPropagation()}>
          {confirming ? (
            <div className={styles.menuConfirm}>
              <p>Delete “{title}” and everything on it?</p>
              <div>
                <button type="button" onClick={() => { setOpen(false); setConfirming(false); }}>Cancel</button>
                <button type="button" data-danger="true" onClick={() => { setOpen(false); setConfirming(false); onDelete(); }}>Delete</button>
              </div>
            </div>
          ) : (
            <>
              <button type="button" role="menuitem" onClick={() => { setOpen(false); onRename(); }}>Rename</button>
              <button type="button" role="menuitem" data-danger="true" onClick={() => setConfirming(true)}>Delete</button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

export default function DashboardsWorkspace({
  onOpen,
  onCreate,
  creating = false,
  reloadKey = 0,
}: Readonly<{
  /** Opens one dashboard. */
  onOpen: (dashboardId: string) => void;
  /** Creates a blank dashboard and takes the owner into dashboard mode. */
  onCreate: () => void;
  creating?: boolean;
  /** Bump to re-fetch (a build applied, a dashboard was created elsewhere). */
  reloadKey?: number;
}>) {
  const [status, setStatus] = useState<Status>("loading");
  const [error, setError] = useState("");
  const [dashboards, setDashboards] = useState<readonly DashboardSummary[]>([]);
  const [renaming, setRenaming] = useState<Readonly<{ dashboardId: string; draft: string }> | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const payload = await request<{ dashboards: DashboardSummary[] }>("/api/dashboard/list", { cache: "no-store" });
      setDashboards(payload.dashboards);
      setStatus("ready");
      setError("");
      setNow(Date.now());
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The dashboards are unavailable.");
      setStatus("error");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load, reloadKey]);

  const rename = async (dashboardId: string, title: string) => {
    const current = dashboards.find((entry) => entry.dashboardId === dashboardId);
    setRenaming(null);
    if (!current) return;
    const cleaned = title.trim().slice(0, 80);
    if ((cleaned || null) === (current.title ?? null)) return;
    setDashboards((entries) => entries.map((entry) => (
      entry.dashboardId === dashboardId ? { ...entry, title: cleaned || null } : entry
    )));
    try {
      await request("/api/dashboard/rename", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: cleaned || null, expectedRevision: current.revision, dashboardId }),
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The dashboard could not be renamed.");
    }
    await load();
  };

  const remove = async (dashboardId: string) => {
    setDashboards((entries) => entries.filter((entry) => entry.dashboardId !== dashboardId));
    try {
      const payload = await request<{ dashboards: DashboardSummary[] }>("/api/dashboard", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dashboardId }),
      });
      setDashboards(payload.dashboards);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The dashboard could not be deleted.");
      await load();
    }
  };

  const createButton = (
    <button className={styles.create} type="button" onClick={onCreate} disabled={creating}>
      {icon(<path d="M12 5v14M5 12h14" />)}
      {creating ? "Creating…" : "New dashboard"}
    </button>
  );

  return (
    <section className={styles.dashboards} aria-label="Dashboards">
      <div className={styles.inner}>
        {/* The page header already says "Dashboards"; one line and one button here. */}
        <header className={styles.header}>
          <p className={styles.line}>
            {status === "ready" && dashboards.length > 0
              ? `${dashboards.length === 1 ? "One dashboard" : `${dashboards.length} dashboards`}, live from your connected data.`
              : "Describe what you want to watch and Albert builds it, live."}
          </p>
          {createButton}
        </header>
        {error ? <p className={styles.error} role="status">{error}</p> : null}
        {status === "loading" ? (
          <p className={styles.state}>Loading your dashboards…</p>
        ) : dashboards.length === 0 ? (
          <div className={styles.empty}>
            <span className={styles.emptyIcon}>
              {icon(<><rect x="3.5" y="4" width="17" height="16" rx="2.5" /><path d="M3.5 10h17M10 10v10" /></>)}
            </span>
            <h3>No dashboards yet</h3>
            <p>Start one and tell Albert what to watch. Every element is a governed query that stays live.</p>
            {createButton}
          </div>
        ) : (
          <ul className={styles.list} aria-label="Your dashboards">
            {dashboards.map((dashboard) => {
              const title = dashboardDisplayTitle(dashboard);
              const isRenaming = renaming?.dashboardId === dashboard.dashboardId;
              return (
                <li key={dashboard.dashboardId} className={styles.row}>
                  {isRenaming ? (
                    <input
                      className={styles.renameInput}
                      autoFocus
                      aria-label="Dashboard name"
                      maxLength={80}
                      value={renaming.draft}
                      onFocus={(event) => event.currentTarget.select()}
                      onChange={(event) => setRenaming({ dashboardId: dashboard.dashboardId, draft: event.target.value })}
                      onBlur={() => void rename(dashboard.dashboardId, renaming.draft)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                        if (event.key === "Escape") setRenaming(null);
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className={styles.open}
                      onClick={() => onOpen(dashboard.dashboardId)}
                    >
                      <span className={styles.rowIcon}>
                        {icon(<><rect x="3.5" y="4" width="17" height="16" rx="2.5" /><path d="M3.5 10h17M10 10v10" /></>)}
                      </span>
                      <span className={styles.rowText}>
                        <span className={styles.rowTitle}>{title}</span>
                        <span className={styles.rowMeta}>
                          {elementsLabel(dashboard.tileCount)} · Edited {editedAgo(dashboard.updatedAt, now)}
                        </span>
                      </span>
                    </button>
                  )}
                  <RowMenu
                    dashboard={dashboard}
                    onRename={() => setRenaming({ dashboardId: dashboard.dashboardId, draft: dashboard.title ?? "" })}
                    onDelete={() => void remove(dashboard.dashboardId)}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
