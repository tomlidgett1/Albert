"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import Image from "next/image";
import styles from "../dash.module.css";
import {
  FIVETRAN_PROVIDERS,
  isFivetranProviderId,
  isVisibleConnectionProvider,
  type ConnectionProviderData,
} from "./ConnectionsWorkspace";

const VISIBLE_CAP = 5;
const STACK_SPRING = { type: "spring" as const, stiffness: 480, damping: 30, mass: 0.65 };
const MENU_SPRING = { type: "spring" as const, stiffness: 520, damping: 34, mass: 0.7 };
const ROW_EASE = [0.04, 0.62, 0.23, 0.98] as const;

type ConnectedTool = {
  id: string;
  name: string;
  logo: string;
};

type CatalogueItem = ConnectedTool & {
  status: "connected" | "available" | "soon";
};

function displayToolName(name: string) {
  return name.replace(/\s*\(Fivetran\)\s*$/iu, "").trim();
}

function displayProviderName(provider: ConnectionProviderData) {
  if (isFivetranProviderId(provider.id)) return FIVETRAN_PROVIDERS[provider.id].sourceName;
  return displayToolName(provider.name);
}

function collectConnectedTools(providers: readonly ConnectionProviderData[]): ConnectedTool[] {
  const seen = new Set<string>();
  const tools: ConnectedTool[] = [];
  for (const provider of providers) {
    if (provider.comingSoon || provider.connections.length === 0) continue;
    if (seen.has(provider.logo)) continue;
    seen.add(provider.logo);
    tools.push({
      id: provider.id,
      name: displayProviderName(provider),
      logo: provider.logo,
    });
  }
  return tools;
}

function collectCatalogue(providers: readonly ConnectionProviderData[]) {
  const items: CatalogueItem[] = [];
  for (const provider of providers) {
    if (!isVisibleConnectionProvider(provider)) continue;
    const status = provider.comingSoon
      ? "soon"
      : provider.connections.length > 0
        ? "connected"
        : "available";
    const next: CatalogueItem = {
      id: provider.id,
      name: displayProviderName(provider),
      logo: provider.logo,
      status,
    };
    const existing = items.find((item) => item.logo === next.logo);
    if (existing) {
      if (existing.status !== "connected" && status === "connected") {
        existing.id = next.id;
        existing.name = next.name;
        existing.status = "connected";
      }
      continue;
    }
    items.push(next);
  }
  return {
    connected: items.filter((item) => item.status === "connected"),
    available: items.filter((item) => item.status === "available"),
    soon: items.filter((item) => item.status === "soon"),
  };
}

function stackOffset(index: number, expanded: boolean) {
  if (index === 0) return 0;
  return expanded ? 6 : -10;
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m5.5 12.5 4.2 4.2 8.8-9.4" />
    </svg>
  );
}

function CatalogueRow({
  item,
  index,
  reduceMotion,
  onSelect,
}: {
  item: CatalogueItem;
  index: number;
  reduceMotion: boolean | null;
  onSelect: () => void;
}) {
  const statusLabel = item.status === "connected"
    ? "Connected"
    : item.status === "soon"
      ? "Soon"
      : "Connect";
  return (
    <motion.button
      className={styles.view2ToolsMenuRow}
      type="button"
      data-status={item.status}
      aria-label={`${item.name}, ${statusLabel}`}
      onClick={onSelect}
      initial={reduceMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{
        delay: reduceMotion ? 0 : Math.min(0.045 + index * 0.018, 0.18),
        ...(reduceMotion ? { duration: 0 } : MENU_SPRING),
      }}
    >
      <span className={styles.view2ToolsMenuMark}>
        <Image src={item.logo} alt="" width={16} height={16} unoptimized />
      </span>
      <span className={styles.view2ToolsMenuName}>{item.name}</span>
      {item.status === "connected" ? (
        <span className={styles.view2ToolsMenuStatus} aria-hidden="true">
          <CheckIcon />
        </span>
      ) : (
        <span className={styles.view2ToolsMenuStatus} data-tone={item.status}>
          {statusLabel}
        </span>
      )}
    </motion.button>
  );
}

export function View2ConnectedTools({
  providers,
  onOpenConnections,
}: {
  providers: readonly ConnectionProviderData[];
  onOpenConnections: () => void;
}) {
  const reactId = useId();
  const menuId = `${reactId}-menu`;
  const reduceMotion = useReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const leaveTimerRef = useRef<number | undefined>(undefined);

  const tools = useMemo(() => collectConnectedTools(providers), [providers]);
  const catalogue = useMemo(() => collectCatalogue(providers), [providers]);
  const visible = tools.slice(0, VISIBLE_CAP);
  const hiddenCount = Math.max(0, tools.length - visible.length);
  const connectLabel = tools.length > 0 ? "Connect more" : "Connect";
  const itemCount = visible.length + (hiddenCount > 0 ? 1 : 0) + 1;
  const stackOpen = expanded || menuOpen;
  const spring = reduceMotion ? { duration: 0 } : STACK_SPRING;

  const open = () => {
    if (leaveTimerRef.current !== undefined) {
      window.clearTimeout(leaveTimerRef.current);
      leaveTimerRef.current = undefined;
    }
    setExpanded(true);
  };

  const close = () => {
    if (menuOpen) return;
    if (leaveTimerRef.current !== undefined) window.clearTimeout(leaveTimerRef.current);
    leaveTimerRef.current = window.setTimeout(() => {
      setExpanded(false);
      leaveTimerRef.current = undefined;
    }, 90);
  };

  const closeMenu = () => setMenuOpen(false);

  const openCatalogue = () => {
    setExpanded(true);
    setMenuOpen((current) => !current);
  };

  const chooseTool = () => {
    closeMenu();
    onOpenConnections();
  };

  useEffect(() => () => {
    if (leaveTimerRef.current !== undefined) window.clearTimeout(leaveTimerRef.current);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) closeMenu();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const availableOffset = catalogue.connected.length;
  const soonOffset = availableOffset + catalogue.available.length;

  return (
    <div
      className={styles.view2Tools}
      ref={rootRef}
      data-expanded={stackOpen ? "true" : "false"}
      data-menu-open={menuOpen ? "true" : "false"}
      onMouseEnter={open}
      onMouseLeave={close}
      onFocusCapture={open}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close();
      }}
    >
      <div className={styles.view2ToolsTrack} role="group" aria-label={
        tools.length === 0
          ? "No tools connected"
          : `${tools.length} connected ${tools.length === 1 ? "tool" : "tools"}`
      }>
        {visible.map((tool, index) => {
          const tipId = `${reactId}-tool-${tool.id}`;
          return (
            <motion.div
              className={styles.view2ToolTipWrap}
              key={tool.id}
              style={{ zIndex: index + 1 }}
              initial={false}
              animate={{ marginLeft: stackOffset(index, stackOpen) }}
              transition={{
                ...spring,
                delay: reduceMotion ? 0 : index * 0.028,
              }}
            >
              <button
                className={styles.view2Tool}
                type="button"
                aria-label={tool.name}
                aria-describedby={stackOpen && !menuOpen ? tipId : undefined}
                onClick={onOpenConnections}
              >
                <span className={styles.view2ToolMark}>
                  <Image src={tool.logo} alt="" width={15} height={15} unoptimized />
                </span>
              </button>
              <span className={styles.view2ToolTip} id={tipId} role="tooltip">{tool.name}</span>
            </motion.div>
          );
        })}

        {hiddenCount > 0 ? (
          <motion.div
            className={styles.view2ToolTipWrap}
            style={{ zIndex: visible.length + 1 }}
            initial={false}
            animate={{ marginLeft: stackOffset(visible.length, stackOpen) }}
            transition={{
              ...spring,
              delay: reduceMotion ? 0 : visible.length * 0.028,
            }}
          >
            <button
              className={styles.view2Tool}
              type="button"
              aria-label={`${hiddenCount} more connected ${hiddenCount === 1 ? "tool" : "tools"}`}
              aria-describedby={stackOpen && !menuOpen ? `${reactId}-more` : undefined}
              onClick={onOpenConnections}
            >
              <span className={`${styles.view2ToolMark} ${styles.view2ToolMore}`}>
                +{hiddenCount}
              </span>
            </button>
            <span className={styles.view2ToolTip} id={`${reactId}-more`} role="tooltip">
              {hiddenCount} more
            </span>
          </motion.div>
        ) : null}

        <motion.div
          className={styles.view2ToolTipWrap}
          style={{ zIndex: itemCount }}
          initial={false}
          animate={{ marginLeft: stackOffset(itemCount - 1, stackOpen) }}
          transition={{
            ...spring,
            delay: reduceMotion ? 0 : (itemCount - 1) * 0.028,
          }}
        >
          <motion.button
            className={styles.view2ToolConnect}
            type="button"
            aria-label={connectLabel}
            aria-expanded={menuOpen}
            aria-haspopup="dialog"
            aria-controls={menuId}
            onClick={openCatalogue}
            initial={false}
            animate={{ paddingRight: stackOpen ? 10 : 0 }}
            transition={spring}
          >
            <motion.span
              className={styles.view2ToolConnectIcon}
              initial={false}
              animate={{ rotate: menuOpen ? 45 : 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.2, ease: [0.22, 1, 0.36, 1] }}
            >
              <PlusIcon />
            </motion.span>
            <motion.span
              className={styles.view2ToolConnectLabel}
              initial={false}
              animate={{
                width: stackOpen ? (tools.length > 0 ? 80 : 52) : 0,
                opacity: stackOpen ? 1 : 0,
              }}
              transition={spring}
            >
              {connectLabel}
            </motion.span>
          </motion.button>
        </motion.div>
      </div>

      <AnimatePresence>
        {menuOpen ? (
          <motion.div
            className={styles.view2ToolsMenu}
            id={menuId}
            role="dialog"
            aria-label="Tools"
            initial={reduceMotion ? false : { opacity: 0, y: 12, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={reduceMotion ? undefined : { opacity: 0, y: 8, scale: 0.97 }}
            transition={
              reduceMotion
                ? { duration: 0 }
                : {
                    opacity: { duration: 0.2, ease: "easeOut" },
                    y: MENU_SPRING,
                    scale: MENU_SPRING,
                  }
            }
          >
            <motion.div
              className={styles.view2ToolsMenuClip}
              initial={reduceMotion ? false : { height: 0 }}
              animate={{ height: "auto" }}
              exit={{ height: 0 }}
              transition={{
                duration: reduceMotion ? 0 : 0.4,
                ease: ROW_EASE,
              }}
            >
              <div className={styles.view2ToolsMenuInner}>
                {catalogue.connected.length > 0 ? (
                  <section className={styles.view2ToolsMenuSection} aria-label="Connected">
                    <p className={styles.view2ToolsMenuHeading}>Connected</p>
                    {catalogue.connected.map((item, index) => (
                      <CatalogueRow
                        key={item.id}
                        item={item}
                        index={index}
                        reduceMotion={reduceMotion}
                        onSelect={chooseTool}
                      />
                    ))}
                  </section>
                ) : null}

                {catalogue.available.length > 0 ? (
                  <section className={styles.view2ToolsMenuSection} aria-label="Available">
                    <p className={styles.view2ToolsMenuHeading}>Available</p>
                    {catalogue.available.map((item, index) => (
                      <CatalogueRow
                        key={item.id}
                        item={item}
                        index={availableOffset + index}
                        reduceMotion={reduceMotion}
                        onSelect={chooseTool}
                      />
                    ))}
                  </section>
                ) : null}

                {catalogue.soon.length > 0 ? (
                  <section className={styles.view2ToolsMenuSection} aria-label="Coming soon">
                    <p className={styles.view2ToolsMenuHeading}>Soon</p>
                    {catalogue.soon.map((item, index) => (
                      <CatalogueRow
                        key={item.id}
                        item={item}
                        index={soonOffset + index}
                        reduceMotion={reduceMotion}
                        onSelect={chooseTool}
                      />
                    ))}
                  </section>
                ) : null}

                <button
                  className={styles.view2ToolsMenuManage}
                  type="button"
                  onClick={chooseTool}
                >
                  Manage connections
                </button>
              </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
