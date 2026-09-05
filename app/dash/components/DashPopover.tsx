"use client";

/**
 * A small anchored popover rendered through a portal. Dashboard tiles live
 * inside transformed, overflow-clipped grid items, so a menu positioned
 * inside a tile is clipped by the tile and a fixed-position child is
 * trapped by the item's transform; portalling to the body and positioning
 * from the anchor's rect sidesteps both. Closes on outside pointer-down and
 * Escape, returns focus to the anchor, and flips above the anchor when the
 * viewport runs out below.
 */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import styles from "./dash-popover.module.css";

const VIEWPORT_MARGIN = 8;
const ANCHOR_GAP = 6;

export function DashPopover({
  anchor,
  open,
  onClose,
  align = "end",
  role = "dialog",
  label,
  width,
  children,
}: Readonly<{
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  /** Which anchor edge the popover hangs from. */
  align?: "start" | "end";
  role?: "dialog" | "menu";
  label: string;
  width?: number;
  children: ReactNode;
}>) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<Readonly<{ top: number; left: number; above: boolean }> | null>(null);

  useLayoutEffect(() => {
    // Closed: nothing to place. A stale position from the last opening is
    // corrected by place() before the next paint, so it never shows.
    if (!open || !anchor) return;
    const place = () => {
      const surface = surfaceRef.current;
      const rect = anchor.getBoundingClientRect();
      const size = surface
        ? { width: surface.offsetWidth, height: surface.offsetHeight }
        : { width: width ?? 240, height: 200 };
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      let left = align === "end" ? rect.right - size.width : rect.left;
      left = Math.max(VIEWPORT_MARGIN, Math.min(left, viewportWidth - size.width - VIEWPORT_MARGIN));
      const below = rect.bottom + ANCHOR_GAP;
      const fitsBelow = below + size.height <= viewportHeight - VIEWPORT_MARGIN;
      const above = !fitsBelow && rect.top - ANCHOR_GAP - size.height >= VIEWPORT_MARGIN;
      const top = above
        ? rect.top - ANCHOR_GAP - size.height
        : Math.max(VIEWPORT_MARGIN, Math.min(below, viewportHeight - size.height - VIEWPORT_MARGIN));
      setPosition({ top, left, above });
    };
    place();
    const frame = window.requestAnimationFrame(place);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [align, anchor, open, width]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (surfaceRef.current?.contains(target) || anchor?.contains(target)) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        anchor?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [anchor, onClose, open]);

  useEffect(() => {
    if (!open) return;
    const surface = surfaceRef.current;
    if (!surface) return;
    const first = surface.querySelector<HTMLElement>("input, textarea, select, button, [tabindex]:not([tabindex='-1'])");
    const frame = window.requestAnimationFrame(() => first?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={surfaceRef}
      className={styles.surface}
      role={role}
      aria-label={label}
      data-above={position?.above ? "true" : undefined}
      style={{
        top: position?.top ?? -9999,
        left: position?.left ?? -9999,
        visibility: position ? "visible" : "hidden",
        ...(width ? { width } : {}),
      }}
    >
      {children}
    </div>,
    // Keep the dashboard's theme tokens on portalled menus. The outer dash
    // is untransformed; the tile and grid ancestors still cannot clip us.
    anchor?.closest("[data-theme]") ?? document.body,
  );
}
