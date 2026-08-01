"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type SVGProps } from "react";
import styles from "./dash.module.css";

type IconName =
  | "search"
  | "panel"
  | "monitor"
  | "sun"
  | "moon"
  | "home"
  | "chat"
  | "agents"
  | "connections"
  | "audio"
  | "images"
  | "codex"
  | "key"
  | "usage"
  | "logs"
  | "batches"
  | "storage"
  | "plugins"
  | "settings"
  | "more"
  | "organization"
  | "profile"
  | "docs"
  | "terms"
  | "help"
  | "logout"
  | "chevron"
  | "chevrons"
  | "plus"
  | "arrowUp"
  | "arrowUpRight"
  | "sparkle"
  | "close";

type NavItem = {
  label: string;
  icon: IconName;
};

const navItems: NavItem[] = [
  { label: "Chat", icon: "chat" },
  { label: "Agents", icon: "agents" },
  { label: "Connections", icon: "connections" },
];

const pageTabs: Record<string, string[]> = {
  Chat: ["Playground", "Threads"],
  Agents: ["Overview", "Runs"],
  Connections: ["Connected apps"],
};

const timeRanges = ["24h", "7d", "30d", "90d"];

type ConnectionId = "lightspeed" | "xero";
type ConnectionStatus = "idle" | "connecting" | "syncing" | "connected";

const connectionProviders: Array<{ id: ConnectionId; name: string }> = [
  { id: "lightspeed", name: "Lightspeed" },
  { id: "xero", name: "Xero" },
];

type Theme = "system" | "light" | "dark";

const themeOptions: Array<{ value: Theme; label: string; icon: IconName }> = [
  { value: "system", label: "System theme", icon: "monitor" },
  { value: "light", label: "Light theme", icon: "sun" },
  { value: "dark", label: "Dark theme", icon: "moon" },
];

const themeStorageKey = "albert-theme";

const themeListeners = new Set<() => void>();
let themeSnapshot: Theme = "system";

function isTheme(value: string | null): value is Theme {
  return value === "system" || value === "light" || value === "dark";
}

function getThemeSnapshot(): Theme {
  if (typeof window === "undefined") return themeSnapshot;

  try {
    const storedTheme = window.localStorage.getItem(themeStorageKey);
    if (isTheme(storedTheme)) themeSnapshot = storedTheme;
  } catch {
    // The in-memory preference remains available when browser storage is blocked.
  }

  return themeSnapshot;
}

function getServerThemeSnapshot(): Theme {
  return "system";
}

function subscribeToTheme(listener: () => void) {
  themeListeners.add(listener);
  const handleStorageChange = () => listener();
  window.addEventListener("storage", handleStorageChange);

  return () => {
    themeListeners.delete(listener);
    window.removeEventListener("storage", handleStorageChange);
  };
}

function setThemePreference(nextTheme: Theme) {
  themeSnapshot = nextTheme;

  try {
    window.localStorage.setItem(themeStorageKey, nextTheme);
  } catch {
    // The in-memory preference remains available when browser storage is blocked.
  }

  themeListeners.forEach((listener) => listener());
}

function Icon({ name, ...props }: { name: IconName } & SVGProps<SVGSVGElement>) {
  const shared = {
    fill: "none",
    stroke: "currentColor",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    strokeWidth: 1.9,
    viewBox: "0 0 24 24",
    "aria-hidden": true,
    ...props,
  };

  switch (name) {
    case "search":
      return <svg {...shared}><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 5 5" /></svg>;
    case "panel":
      return <svg {...shared}><rect x="3.5" y="4" width="17" height="16" rx="2.5" /><path d="M12 4v16" /></svg>;
    case "monitor":
      return <svg {...shared}><rect x="3.5" y="5" width="17" height="11.5" rx="1.8" /><path d="M9 20h6M12 16.5V20" /></svg>;
    case "sun":
      return <svg {...shared}><circle cx="12" cy="12" r="3.5" /><path d="M12 2.8v2M12 19.2v2M21.2 12h-2M4.8 12h-2M18.5 5.5l-1.4 1.4M6.9 17.1l-1.4 1.4M18.5 18.5l-1.4-1.4M6.9 6.9 5.5 5.5" /></svg>;
    case "moon":
      return <svg {...shared}><path d="M19.7 14.5A7.8 7.8 0 0 1 9.5 4.3a8 8 0 1 0 10.2 10.2Z" /></svg>;
    case "home":
      return <svg {...shared}><path d="m3.5 10.8 8.5-7 8.5 7" /><path d="M5.3 9.8v9.1a1.5 1.5 0 0 0 1.5 1.5h10.4a1.5 1.5 0 0 0 1.5-1.5V9.8" /><path d="M9.2 20.4v-5.8h5.6v5.8" /></svg>;
    case "chat":
      return <svg {...shared}><path d="M20.2 11.2c0 4.5-3.7 8.1-8.3 8.1a8.8 8.8 0 0 1-3.2-.6l-4.7 1.2 1.2-4.3a7.8 7.8 0 0 1-1.5-4.4c0-4.5 3.7-8.1 8.2-8.1s8.3 3.6 8.3 8.1Z" /></svg>;
    case "agents":
      return <svg {...shared}><path d="M12 3.5 13.5 9l5.5 1.5-5.5 1.5-1.5 5.5-1.5-5.5L5 10.5 10.5 9 12 3.5Z" /><path d="m18.2 15.5.6 2.1 2.1.6-2.1.6-.6 2.1-.6-2.1-2.1-.6 2.1-.6.6-2.1Z" /></svg>;
    case "connections":
      return <svg {...shared}><path d="M9.2 14.8 7.6 16.4a3.2 3.2 0 0 1-4.5-4.5l3.3-3.3a3.2 3.2 0 0 1 4.5 0" /><path d="m14.8 9.2 1.6-1.6a3.2 3.2 0 0 1 4.5 4.5l-3.3 3.3a3.2 3.2 0 0 1-4.5 0" /><path d="m8.5 15.5 7-7" /></svg>;
    case "audio":
      return <svg {...shared}><path d="M6 10v4" /><path d="M10 6.5v11" /><path d="M14 9v6" /><path d="M18 7v10" /></svg>;
    case "images":
      return <svg {...shared}><rect x="3.5" y="4" width="17" height="16" rx="2" /><circle cx="9" cy="9" r="1.6" /><path d="m4.5 17 4.3-4.1a1.6 1.6 0 0 1 2.2 0l2.1 2 1.8-1.6a1.6 1.6 0 0 1 2.2 0l2.4 2.3" /></svg>;
    case "codex":
      return <svg {...shared}><path d="M7.1 8.1a4.4 4.4 0 0 1 8.1-1.2 4.1 4.1 0 0 1 2.5 7.4 4.3 4.3 0 0 1-7.4 2.9 4.2 4.2 0 0 1-5.8-5.9 4.1 4.1 0 0 1 2.6-3.2Z" /><path d="m12 8.3.7 2.1 2.1.7-2.1.7-.7 2.1-.7-2.1-2.1-.7 2.1-.7.7-2.1Z" /></svg>;
    case "key":
      return <svg {...shared}><circle cx="8.5" cy="15.5" r="3.6" /><path d="m11.2 12.8 7.5-7.5 2.2 2.2-1.7 1.7 1.2 1.2-1.8 1.8-1.2-1.2-2.7 2.7" /></svg>;
    case "usage":
      return <svg {...shared}><path d="m3.5 17 5.1-5.1 3.4 2.6 7.8-8" /><path d="M15.4 6.5h4.4v4.4" /></svg>;
    case "logs":
      return <svg {...shared}><path d="m5 7 2-2h10l2 2" /><path d="m5 12 2-2h10l2 2" /><path d="m5 17 2-2h10l2 2" /></svg>;
    case "batches":
      return <svg {...shared}><path d="M8.3 4.2H6.5a2 2 0 0 0-2 2v2.1a2 2 0 0 1-2 2 2 2 0 0 1 2 2v2.1a2 2 0 0 0 2 2h1.8" /><path d="M15.7 4.2h1.8a2 2 0 0 1 2 2v2.1a2 2 0 0 0 2 2 2 2 0 0 0-2 2v2.1a2 2 0 0 1-2 2h-1.8" /><path d="M9 8.5h6M9 12h6M9 15.5h6" /></svg>;
    case "storage":
      return <svg {...shared}><ellipse cx="12" cy="5.7" rx="7" ry="2.8" /><path d="M5 5.7v6.3c0 1.6 3.1 2.8 7 2.8s7-1.2 7-2.8V5.7" /><path d="M5 12v6.3c0 1.6 3.1 2.8 7 2.8s7-1.2 7-2.8V12" /></svg>;
    case "plugins":
      return <svg {...shared}><circle cx="12" cy="12" r="8.6" /><path d="M9.2 9.2 14.8 8l-1.2 5.6-5.6 1.2 1.2-5.6Z" /><path d="m15.8 8.2 1.4-1.4" /></svg>;
    case "settings":
      return <svg {...shared}><path d="m9.6 4.1.7-1.3h3.4l.7 1.3 1.6.9 1.4-.2 1.7 3-1 1.1.1 1.9 1 1.1-1.7 3-1.4-.2-1.6.9-.7 1.3h-3.4l-.7-1.3-1.6-.9-1.4.2-1.7-3 1-1.1-.1-1.9-1-1.1 1.7-3 1.4.2 1.6-.9Z" /><circle cx="12" cy="11.1" r="2.6" /></svg>;
    case "more":
      return <svg {...shared}><circle cx="5" cy="12" r="1.1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.1" fill="currentColor" stroke="none" /></svg>;
    case "organization":
      return <svg {...shared}><path d="M4 20V8.5l5-3v14.5M9 20h11M15 20V4h5v16" /><path d="M6.5 11h.1M6.5 14.5h.1M17.5 8h.1M17.5 11.5h.1M17.5 15h.1" /></svg>;
    case "profile":
      return <svg {...shared}><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="9.5" r="2.6" /><path d="M7.5 17.3a5.5 5.5 0 0 1 9 0" /></svg>;
    case "docs":
      return <svg {...shared}><path d="M6.2 4.2h8.1l3.5 3.5v12.1H6.2z" /><path d="M14.3 4.2v4h3.5M8.8 12h6.4M8.8 15.5h4.7" /></svg>;
    case "terms":
      return <svg {...shared}><path d="M7 3.8h8.7l2.4 2.4v14H7z" /><path d="M15.7 3.8v3h2.4M9.5 11h6M9.5 14.5h6M9.5 18h3.2" /></svg>;
    case "help":
      return <svg {...shared}><circle cx="12" cy="12" r="8.5" /><path d="M8.9 9.2a3.2 3.2 0 0 1 6.1 1.4c0 2-2.7 2.2-2.7 3.8M12.3 17.2v.1" /></svg>;
    case "logout":
      return <svg {...shared}><path d="M10 4.2H6.2a2 2 0 0 0-2 2v11.6a2 2 0 0 0 2 2H10" /><path d="M13 8.2 17 12l-4 3.8M17 12H8.3" /></svg>;
    case "chevron":
      return <svg {...shared}><path d="m9 5 7 7-7 7" /></svg>;
    case "chevrons":
      return <svg {...shared}><path d="m7.5 9 4.5-4 4.5 4" /><path d="m7.5 15 4.5 4 4.5-4" /></svg>;
    case "plus":
      return <svg {...shared}><path d="M12 5v14M5 12h14" /></svg>;
    case "arrowUp":
      return <svg {...shared}><path d="M12 18V6M7.5 10.5 12 6l4.5 4.5" /></svg>;
    case "arrowUpRight":
      return <svg {...shared}><path d="M6 18 18 6M8 6h10v10" /></svg>;
    case "sparkle":
      return <svg {...shared}><path d="m12 3 1.3 4.7L18 9l-4.7 1.3L12 15l-1.3-4.7L6 9l4.7-1.3L12 3ZM18.5 14l.7 2.8L22 17.5l-2.8.7-.7 2.8-.7-2.8-2.8-.7 2.8-.7.7-2.8ZM5.5 15l.6 2.1 2.1.6-2.1.6-.6 2.1-.6-2.1-2.1-.6 2.1-.6.6-2.1Z" /></svg>;
    case "close":
      return <svg {...shared}><path d="m6 6 12 12M18 6 6 18" /></svg>;
    default:
      return null;
  }
}

type ChatMessage = {
  id: number;
  text: string;
  attachment?: string;
};

export default function DashPage() {
  const [activeItem, setActiveItem] = useState("Chat");
  const [activeTab, setActiveTab] = useState(pageTabs.Chat[0]);
  const [activeRange, setActiveRange] = useState(timeRanges[0]);
  const theme = useSyncExternalStore(
    subscribeToTheme,
    getThemeSnapshot,
    getServerThemeSnapshot,
  );
  const [connectionStates, setConnectionStates] = useState<Record<ConnectionId, ConnectionStatus>>({
    lightspeed: "idle",
    xero: "idle",
  });
  const [connectionProgress, setConnectionProgress] = useState<Record<ConnectionId, number>>({
    lightspeed: 0,
    xero: 0,
  });
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [albertPopupOpen, setAlbertPopupOpen] = useState(true);
  const [albertPopupClosing, setAlbertPopupClosing] = useState(false);
  const [chatDraft, setChatDraft] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [attachmentName, setAttachmentName] = useState("");
  const [tabIndicator, setTabIndicator] = useState({ left: 0, width: 0 });
  const [rangeIndicator, setRangeIndicator] = useState({ left: 0, width: 0 });
  const tabBarRef = useRef<HTMLDivElement>(null);
  const rangeBarRef = useRef<HTMLDivElement>(null);
  const accountAreaRef = useRef<HTMLDivElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const albertPopupRef = useRef<HTMLElement>(null);
  const popupCloseButtonRef = useRef<HTMLButtonElement>(null);
  const popupPreviousFocusRef = useRef<HTMLElement | null>(null);
  const connectionAnimationFramesRef = useRef<Partial<Record<ConnectionId, number>>>({});
  const filteredItems = useMemo(
    () => navItems.filter((item) => item.label.toLowerCase().includes(query.toLowerCase())),
    [query],
  );
  const tabs = pageTabs[activeItem] ?? ["Overview"];
  useEffect(() => {
    const connectionTimers = connectionProviders
      .filter(({ id }) => connectionStates[id] === "connecting")
      .map(({ id }) => window.setTimeout(() => {
        setConnectionStates((states) => (
          states[id] === "connecting" ? { ...states, [id]: "syncing" } : states
        ));
      }, 900));

    return () => connectionTimers.forEach((timer) => window.clearTimeout(timer));
  }, [connectionStates]);

  useEffect(() => {
    connectionProviders.forEach(({ id }) => {
      const isSyncing = connectionStates[id] === "syncing";
      const activeFrame = connectionAnimationFramesRef.current[id];

      if (!isSyncing) {
        if (activeFrame !== undefined) {
          window.cancelAnimationFrame(activeFrame);
          delete connectionAnimationFramesRef.current[id];
        }
        return;
      }

      if (activeFrame !== undefined) return;

      const startedAt = performance.now();
      const animateProgress = (now: number) => {
        const linearProgress = Math.min((now - startedAt) / 1900, 1);
        const easedProgress = 1 - Math.pow(1 - linearProgress, 5);
        setConnectionProgress((progress) => ({
          ...progress,
          [id]: Math.round(easedProgress * 100),
        }));

        if (linearProgress < 1) {
          connectionAnimationFramesRef.current[id] = window.requestAnimationFrame(animateProgress);
        } else {
          delete connectionAnimationFramesRef.current[id];
          setConnectionStates((states) => (
            states[id] === "syncing" ? { ...states, [id]: "connected" } : states
          ));
        }
      };

      connectionAnimationFramesRef.current[id] = window.requestAnimationFrame(animateProgress);
    });
  }, [connectionStates]);

  useEffect(() => () => {
    Object.values(connectionAnimationFramesRef.current).forEach((frame) => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    });
  }, []);

  useLayoutEffect(() => {
    const updateIndicator = (
      container: HTMLDivElement | null,
      setIndicator: (value: { left: number; width: number }) => void,
    ) => {
      const activeButton = container?.querySelector<HTMLButtonElement>("[data-active='true']");
      if (!container || !activeButton) return;
      const containerRect = container.getBoundingClientRect();
      const buttonRect = activeButton.getBoundingClientRect();
      setIndicator({
        left: buttonRect.left - containerRect.left,
        width: buttonRect.width,
      });
    };

    const updateIndicators = () => {
      updateIndicator(tabBarRef.current, setTabIndicator);
      updateIndicator(rangeBarRef.current, setRangeIndicator);
    };

    updateIndicators();
    window.addEventListener("resize", updateIndicators);
    return () => window.removeEventListener("resize", updateIndicators);
  }, [activeItem, activeTab, activeRange]);

  useEffect(() => {
    if (!accountOpen) return;

    const closeMenuOnOutsidePress = (event: PointerEvent) => {
      if (!accountAreaRef.current?.contains(event.target as Node)) {
        setAccountOpen(false);
      }
    };

    const closeMenuOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAccountOpen(false);
    };

    document.addEventListener("pointerdown", closeMenuOnOutsidePress);
    document.addEventListener("keydown", closeMenuOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeMenuOnOutsidePress);
      document.removeEventListener("keydown", closeMenuOnEscape);
    };
  }, [accountOpen]);

  useEffect(() => {
    if (!albertPopupOpen) {
      popupPreviousFocusRef.current?.focus();
      return;
    }

    const closePopupOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setAlbertPopupClosing(true);

      if (event.key !== "Tab") return;

      const focusableElements = albertPopupRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusableElements?.length) return;

      const firstElement = focusableElements[0];
      const lastElement = focusableElements[focusableElements.length - 1];
      if (event.shiftKey && document.activeElement === firstElement) {
        event.preventDefault();
        lastElement.focus();
      } else if (!event.shiftKey && document.activeElement === lastElement) {
        event.preventDefault();
        firstElement.focus();
      }
    };

    popupPreviousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", closePopupOnEscape);
    const focusPopup = window.requestAnimationFrame(() => popupCloseButtonRef.current?.focus());

    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", closePopupOnEscape);
      window.cancelAnimationFrame(focusPopup);
    };
  }, [albertPopupOpen]);

  useEffect(() => {
    if (!albertPopupClosing) return;

    const closeTimer = window.setTimeout(() => {
      setAlbertPopupOpen(false);
      setAlbertPopupClosing(false);
    }, 180);

    return () => window.clearTimeout(closeTimer);
  }, [albertPopupClosing]);

  const sendChatMessage = () => {
    const text = chatDraft.trim();
    if (!text && !attachmentName) return;

    setChatMessages((messages) => [
      ...messages,
      { id: Date.now(), text, attachment: attachmentName || undefined },
    ]);
    setChatDraft("");
    setAttachmentName("");
  };

  const openAlbertChat = () => {
    setActiveItem("Chat");
    setActiveTab(pageTabs.Chat[0]);
    setAlbertPopupClosing(true);
  };

  const openAlbertPopup = () => {
    setAlbertPopupClosing(false);
    setAlbertPopupOpen(true);
  };

  const startConnection = (id: ConnectionId) => {
    if (connectionStates[id] !== "idle") return;
    setConnectionProgress((progress) => ({ ...progress, [id]: 0 }));
    setConnectionStates((states) => ({ ...states, [id]: "connecting" }));
  };

  return (
    <main
      className={`${styles.dash} ${collapsed ? styles.collapsed : ""}`}
      data-theme={theme}
    >
      <aside className={styles.sidebar} inert={albertPopupOpen}>
        <div className={styles.sidebarHeader}>
          <div className={styles.projectBrand}>
            <span className={styles.projectName}>Albert</span>
          </div>
          <button
            className={styles.collapseButton}
            type="button"
            aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() => setCollapsed((value) => !value)}
          >
            <Icon name="panel" />
          </button>
        </div>

        <label className={styles.searchBox}>
          <Icon name="search" />
          <input
            aria-label="Search"
            placeholder="Search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <kbd>⌘K</kbd>
        </label>

        <nav className={styles.navigation} aria-label="Project navigation">
          {filteredItems.length > 0 ? (
            filteredItems.map((item) => {
              const isActive = item.label === activeItem;
              return (
                <button
                  className={`${styles.navItem} ${isActive ? styles.active : ""}`}
                  key={item.label}
                  type="button"
                  aria-current={isActive ? "page" : undefined}
                  onClick={() => {
                    setActiveItem(item.label);
                    setActiveTab(pageTabs[item.label][0]);
                  }}
                >
                  <Icon name={item.icon} />
                  <span className={styles.navLabel}>{item.label}</span>
                </button>
              );
            })
          ) : (
            <p className={styles.noResults}>No matches</p>
          )}
        </nav>

        <div className={styles.accountArea} ref={accountAreaRef}>
          <div
            className={`${styles.accountPopover} ${accountOpen ? styles.accountPopoverOpen : ""}`}
            role="dialog"
            aria-label="Account menu"
            aria-hidden={!accountOpen}
            inert={!accountOpen}
          >
            <p className={styles.accountEmail}>tom@lidgett.net</p>
            <div className={styles.themeSwitcher} aria-label="Theme" role="group">
              {themeOptions.map((option) => (
                <button
                  className={theme === option.value ? styles.themeActive : ""}
                  key={option.value}
                  type="button"
                  aria-label={option.label}
                  aria-pressed={theme === option.value}
                  onClick={() => setThemePreference(option.value)}
                >
                  <Icon name={option.icon} />
                </button>
              ))}
            </div>

            <div className={styles.accountDivider} />

            <button className={styles.accountWorkspace} type="button">
              <span className={styles.accountAvatar}>P</span>
              <span className={styles.accountWorkspaceCopy}>
                <strong>Personal</strong>
                <small>Organization</small>
              </span>
              <Icon name="chevron" />
            </button>

            <div className={styles.accountDivider} />

            <div className={styles.accountLinks}>
              <button type="button"><Icon name="organization" /><span>Organization settings</span></button>
              <button type="button"><Icon name="profile" /><span>Profile settings</span></button>
            </div>

            <div className={styles.accountDivider} />

            <div className={styles.accountLinks}>
              <button type="button"><Icon name="docs" /><span>Developer docs</span></button>
              <button type="button"><Icon name="terms" /><span>Terms &amp; policies</span></button>
              <button type="button"><Icon name="help" /><span>Help</span></button>
            </div>

            <div className={styles.accountDivider} />

            <button className={styles.logoutButton} type="button"><Icon name="logout" /><span>Log out</span></button>
          </div>

          <button
            className={styles.accountTrigger}
            type="button"
            aria-expanded={accountOpen}
            aria-haspopup="dialog"
            onClick={() => setAccountOpen((value) => !value)}
          >
            <span className={styles.accountAvatar}>P</span>
            <span className={styles.accountWorkspaceCopy}>
              <strong>Personal</strong>
              <small>Organization</small>
            </span>
          </button>
        </div>
      </aside>

      <section className={styles.content} aria-labelledby="dash-title" inert={albertPopupOpen}>
        <header className={`${styles.pageHeader} ${activeItem === "Connections" ? styles.pageHeaderSimple : ""}`}>
          <div className={styles.pageHeaderTop}>
            <h1 id="dash-title">{activeItem}</h1>
          </div>
          {activeItem !== "Connections" ? (
            <div className={styles.headerSubnav}>
            <div className={styles.tabBar} ref={tabBarRef} role="tablist" aria-label={`${activeItem} views`}>
              {tabs.map((tab) => (
                <button
                  className={`${styles.tabButton} ${activeTab === tab ? styles.tabActive : ""}`}
                  key={tab}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === tab}
                  data-active={activeTab === tab}
                  onClick={() => setActiveTab(tab)}
                >
                  {tab}
                </button>
              ))}
              <span
                className={styles.tabIndicator}
                style={{ left: tabIndicator.left, width: tabIndicator.width }}
                aria-hidden="true"
              />
            </div>
            <div className={styles.headerActions}>
              <button
                className={styles.albertTrigger}
                type="button"
                aria-haspopup="dialog"
                aria-expanded={albertPopupOpen}
                onClick={openAlbertPopup}
              >
                <Icon name="sparkle" />
                <span>Try Albert</span>
              </button>
              <div className={styles.rangeBar} ref={rangeBarRef} role="tablist" aria-label="Time range">
                {timeRanges.map((range) => (
                  <button
                    className={`${styles.rangeButton} ${activeRange === range ? styles.rangeActive : ""}`}
                    key={range}
                    type="button"
                    role="tab"
                    aria-selected={activeRange === range}
                    data-active={activeRange === range}
                    onClick={() => setActiveRange(range)}
                  >
                    {range}
                  </button>
                ))}
                <span
                  className={styles.rangeIndicator}
                  style={{ left: rangeIndicator.left, width: rangeIndicator.width }}
                  aria-hidden="true"
                />
              </div>
            </div>
            </div>
          ) : null}
        </header>
        {activeItem === "Chat" ? (
          <div className={styles.chatWorkspace}>
            {chatMessages.length === 0 ? (
              <div className={styles.chatEmptyState}>
                <p className={styles.contentEyebrow}>ALBERT CHAT</p>
                <h2>How can Albert help?</h2>
                <p>Ask about your business, systems, or what to do next.</p>
              </div>
            ) : (
              <div className={styles.chatMessages} aria-live="polite">
                {chatMessages.map((message) => (
                  <article className={styles.chatMessage} key={message.id}>
                    {message.text ? <p>{message.text}</p> : null}
                    {message.attachment ? <span>{message.attachment}</span> : null}
                  </article>
                ))}
              </div>
            )}

            <form
              className={styles.chatComposer}
              onSubmit={(event) => {
                event.preventDefault();
                sendChatMessage();
              }}
            >
              {attachmentName ? (
                <div className={styles.attachmentRow}>
                  <span>{attachmentName}</span>
                  <button
                    type="button"
                    aria-label={`Remove ${attachmentName}`}
                    onClick={() => setAttachmentName("")}
                  >
                    ×
                  </button>
                </div>
              ) : null}
              <textarea
                aria-label="Message Albert"
                placeholder="Message Albert"
                rows={1}
                value={chatDraft}
                onChange={(event) => setChatDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    sendChatMessage();
                  }
                }}
              />
              <div className={styles.chatComposerFooter}>
                <input
                  ref={attachmentInputRef}
                  className={styles.fileInput}
                  type="file"
                  tabIndex={-1}
                  aria-hidden="true"
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    if (file) setAttachmentName(file.name);
                    event.currentTarget.value = "";
                  }}
                />
                <button
                  className={styles.composerIconButton}
                  type="button"
                  aria-label="Add attachment"
                  onClick={() => attachmentInputRef.current?.click()}
                >
                  <Icon name="plus" />
                </button>
                <span className={styles.composerModel}>Albert</span>
                <button
                  className={styles.chatSendButton}
                  type="submit"
                  aria-label="Send message"
                  disabled={!chatDraft.trim() && !attachmentName}
                >
                  <Icon name="arrowUp" />
                </button>
              </div>
            </form>
            <p className={styles.chatHint}>Albert can make mistakes. Check important information.</p>
          </div>
        ) : activeItem === "Connections" ? (
          <div className={styles.simpleConnectionsWorkspace}>
            <div className={styles.simpleConnectionsList} role="list" aria-label="Available connections">
              {connectionProviders.map((provider) => {
                const status = connectionStates[provider.id];
                const progress = connectionProgress[provider.id];

                return (
                  <article className={styles.simpleConnectionRow} key={provider.id} role="listitem">
                    <div className={styles.simpleConnectionIdentity}>
                      <span className={styles.simpleConnectionLogo} data-provider={provider.id} aria-hidden="true">
                        {provider.id === "lightspeed" ? "L" : "X"}
                      </span>
                      <h2>{provider.name}</h2>
                    </div>

                    <div className={styles.simpleConnectionAction}>
                      {status === "idle" ? (
                        <button
                          className={styles.simpleConnectionButton}
                          type="button"
                          onClick={() => startConnection(provider.id)}
                        >
                          Connect
                        </button>
                      ) : null}
                      {status === "connecting" ? (
                        <div className={styles.simpleConnectionStatus} role="status" aria-label={`Connecting to ${provider.name}`}>
                          <span className={styles.simpleConnectionSpinner} aria-hidden="true" />
                          <span>Connecting</span>
                        </div>
                      ) : null}
                      {status === "syncing" ? (
                        <div className={styles.simpleConnectionSyncing} role="status" aria-label={`Syncing ${provider.name}, ${progress}% complete`}>
                          <div className={styles.simpleConnectionProgressLabel}>
                            <span>Syncing</span>
                            <strong>{progress}%</strong>
                          </div>
                          <div className={styles.simpleConnectionProgress} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
                            <span style={{ width: `${progress}%` }} />
                          </div>
                        </div>
                      ) : null}
                      {status === "connected" ? (
                        <div className={styles.simpleConnectionStatusConnected} role="status">
                          <span aria-hidden="true">✓</span>
                          <span>Connected</span>
                        </div>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>
          </div>
        ) : (
          <div className={styles.contentBody}>
            <p className={styles.contentEyebrow}>ALBERT DASH</p>
            <h2>{activeTab}</h2>
            <p className={styles.contentDescription}>
              Your {activeTab.toLowerCase()} workspace is ready. Choose a view from the tabs above to get started.
            </p>
          </div>
        )}
      </section>

      {albertPopupOpen ? (
        <div
          className={`${styles.popupBackdrop} ${albertPopupClosing ? styles.popupBackdropClosing : ""}`}
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setAlbertPopupClosing(true);
          }}
        >
          <section
            ref={albertPopupRef}
            className={`${styles.albertPopup} ${albertPopupClosing ? styles.albertPopupClosing : ""}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="albert-popup-title"
            aria-describedby="albert-popup-description"
          >
            <button
              ref={popupCloseButtonRef}
              className={styles.popupClose}
              type="button"
              aria-label="Close Albert introduction"
              onClick={() => setAlbertPopupClosing(true)}
            >
              <Icon name="close" />
            </button>

            <div className={styles.popupIntro}>
              <span className={styles.popupMark}><Icon name="sparkle" /></span>
              <span className={styles.popupEyebrow}>ALBERT</span>
            </div>
            <h2 id="albert-popup-title">A clearer way to find your next step.</h2>
            <p id="albert-popup-description">
              Ask Albert about your activity, uncover what changed, and turn a question into an action in seconds.
            </p>

            <div className={styles.popupPreview} aria-hidden="true">
              <div className={styles.popupPreviewTopline}>
                <span>YOUR WORKSPACE</span>
                <span>NOW</span>
              </div>
              <div className={styles.popupInsight}>
                <span className={styles.popupInsightMark}><Icon name="sparkle" /></span>
                <p>“What should I focus on this week?”</p>
              </div>
              <div className={styles.popupInsightReply}>
                <span>Albert</span>
                <p>I found three priorities worth your attention.</p>
              </div>
            </div>

            <div className={styles.popupActions}>
              <button className={styles.popupSecondaryAction} type="button" onClick={() => setAlbertPopupClosing(true)}>
                Maybe later
              </button>
              <button className={styles.popupPrimaryAction} type="button" onClick={openAlbertChat}>
                <span>Open Albert</span>
                <Icon name="arrowUpRight" />
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </main>
  );
}
