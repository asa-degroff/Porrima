/**
 * Movable/resizable geometry for the BrowserViewer PiP (Phase 1.5,
 * docs/design/browser-observability.md §9).
 *
 * The card lives in wrapper coordinates — its positioned ancestor is the
 * messages-area wrapper in ChatView. Geometry is clamped against the live
 * wrapper bounds on every change, and again whenever the wrapper itself
 * resizes (window resize, pinned panel appearing), so the card can never
 * leave the visible area. Persisted per browser in localStorage; the pure
 * clamping math is exported for unit tests.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { RefObject } from "react";
import { readStoredValue, writeStoredValue } from "../lib/storage";

export interface ViewerGeometry {
  /** Left offset within the messages wrapper (px). */
  x: number;
  /** Top offset within the messages wrapper (px). */
  y: number;
  /** Card width (px). Height derives from the 16:10 frame aspect. */
  w: number;
}

export interface ViewerBounds {
  w: number;
  h: number;
}

export const VIEWER_MIN_W = 120;
export const VIEWER_MAX_W = 520;
export const VIEWER_MARGIN = 8;
const CHIP_SIZE = 40;
export const GEOM_KEY = "porrima-browser-viewer-geom";

/** Card height for clamping: the 16:10 frame plus the fixed footer row. */
export function estimateCardHeight(w: number, collapsed: boolean): number {
  return collapsed ? CHIP_SIZE : Math.round((w * 10) / 16) + 28;
}

/** Default docked position: top-right — the original fixed placement. */
export function defaultGeometry(bounds: ViewerBounds): ViewerGeometry {
  const mobile = bounds.w < 640;
  const w = mobile ? 132 : 210;
  return { w, x: bounds.w - w - (mobile ? 8 : 24), y: mobile ? 12 : 16 };
}

/**
 * Keep geometry inside the wrapper: width within [min, min(max, fits)],
 * x/y inside the margin box left for the card — or the 40px chip when
 * collapsed, which preserves w so the card can restore in place.
 */
export function clampGeometry(
  g: ViewerGeometry,
  bounds: ViewerBounds,
  collapsed: boolean,
): ViewerGeometry {
  const maxW = Math.min(VIEWER_MAX_W, bounds.w - 2 * VIEWER_MARGIN);
  const w = collapsed ? g.w : Math.min(Math.max(g.w, Math.min(VIEWER_MIN_W, maxW)), maxW);
  const h = collapsed ? CHIP_SIZE : estimateCardHeight(w, false);
  const maxX = Math.max(VIEWER_MARGIN, bounds.w - w - VIEWER_MARGIN);
  const maxY = Math.max(VIEWER_MARGIN, bounds.h - h - VIEWER_MARGIN);
  return {
    w,
    x: Math.min(Math.max(g.x, VIEWER_MARGIN), maxX),
    y: Math.min(Math.max(g.y, VIEWER_MARGIN), maxY),
  };
}

function loadStoredGeometry(): ViewerGeometry | null {
  try {
    const raw = readStoredValue(GEOM_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<ViewerGeometry>;
    if (typeof p.x === "number" && typeof p.y === "number" && typeof p.w === "number") {
      return { x: p.x, y: p.y, w: p.w };
    }
  } catch {
    /* corrupt or unavailable — fall through to default */
  }
  return null;
}

function writeStoredGeometry(g: ViewerGeometry): void {
  try {
    writeStoredValue(GEOM_KEY, JSON.stringify(g));
  } catch {
    /* localStorage unavailable — geometry just won't persist */
  }
}

export interface BrowserViewerGeometry {
  /** Current clamped geometry; null only before the first layout pass. */
  geom: ViewerGeometry | null;
  /** Move/resize, clamped against the live wrapper. Pass persist: false
   *  during a gesture and call persistGeometry on release. */
  setGeometry: (next: ViewerGeometry, opts?: { persist?: boolean }) => void;
  /** Persist the current geometry (call at the end of a gesture). */
  persistGeometry: () => void;
  /** Restore the default docked position and size. */
  resetGeometry: () => void;
}

export function useBrowserViewerGeometry(
  wrapperRef: RefObject<HTMLElement | null>,
  collapsed: boolean,
): BrowserViewerGeometry {
  const [geom, setGeom] = useState<ViewerGeometry | null>(loadStoredGeometry);
  const boundsRef = useRef<ViewerBounds | null>(null);
  const geomRef = useRef<ViewerGeometry | null>(null);
  geomRef.current = geom;
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;

  // Clamp against the live wrapper on mount and on every geometry change
  // (idempotent — converges in one pass).
  useLayoutEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const bounds = { w: el.clientWidth, h: el.clientHeight };
    if (bounds.w <= 0 || bounds.h <= 0) return; // no layout (e.g. jsdom)
    boundsRef.current = bounds;
    const base = geom ?? defaultGeometry(bounds);
    const clamped = clampGeometry(base, bounds, collapsed);
    if (!geom || clamped.x !== geom.x || clamped.y !== geom.y || clamped.w !== geom.w) {
      setGeom(clamped);
    }
  }, [geom, collapsed, wrapperRef]);

  // Re-clamp when the wrapper itself resizes (window, pinned panel).
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      const target = wrapperRef.current;
      if (!target) return;
      const bounds = { w: target.clientWidth, h: target.clientHeight };
      if (bounds.w <= 0 || bounds.h <= 0) return;
      boundsRef.current = bounds;
      setGeom((g) => {
        const clamped = clampGeometry(g ?? defaultGeometry(bounds), bounds, collapsed);
        if (g && clamped.x === g.x && clamped.y === g.y && clamped.w === g.w) return g;
        writeStoredGeometry(clamped);
        return clamped;
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [collapsed, wrapperRef]);

  const setGeometry = useCallback(
    (next: ViewerGeometry, opts?: { persist?: boolean }) => {
      const bounds = boundsRef.current;
      const clamped =
        bounds && bounds.w > 0 && bounds.h > 0
          ? clampGeometry(next, bounds, collapsedRef.current)
          : next;
      setGeom(clamped);
      if (opts?.persist !== false) writeStoredGeometry(clamped);
    },
    [],
  );

  const persistGeometry = useCallback(() => {
    if (geomRef.current) writeStoredGeometry(geomRef.current);
  }, []);

  const resetGeometry = useCallback(() => {
    const bounds = boundsRef.current;
    if (!bounds || bounds.w <= 0 || bounds.h <= 0) return;
    const d = defaultGeometry(bounds);
    setGeom(d);
    writeStoredGeometry(d);
  }, []);

  return { geom, setGeometry, persistGeometry, resetGeometry };
}
