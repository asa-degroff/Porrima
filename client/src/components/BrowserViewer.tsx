/**
 * BrowserViewer — persistent picture-in-picture card showing the agent's
 * latest browser frame, floating over the message area. Frames update in
 * place as new captures arrive; clicking the frame opens the shared
 * ImageLightbox. Collapsing minimizes it to an icon chip that badges when a
 * newer frame lands.
 *
 * Frame sources (see useBrowserViewer): live `browser_frame` events (Phase 2)
 * preferred, else the latest persisted screenshot derived from messages.
 * `frame` is null while a browser tool is starting up — the card shows a
 * connecting placeholder, or an explicit consent hint when the attach to the
 * user's Chrome is waiting on the native remote-debugging prompt.
 *
 * Phase 1.5 (docs/design/browser-observability.md §9): the card is movable
 * — drag the frame (a 4px threshold separates drag from click-to-enlarge) —
 * and width-resizable via the bottom-right corner grip (height stays locked
 * to the 16:10 frame aspect). Geometry clamps to the messages wrapper and
 * persists in localStorage; arrows nudge and +/- resize from the keyboard.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { RefObject } from "react";
import type { BrowserViewerFrame } from "../hooks/useBrowserViewer";
import { useBrowserViewerGeometry } from "../hooks/useBrowserViewerGeometry";
import { readStoredValue, writeStoredValue } from "../lib/storage";
import { ImageLightbox } from "./ImageLightbox";
import { ToolIcon } from "./ToolIcons";

const COLLAPSED_KEY = "porrima-browser-viewer-collapsed";
/** Pointer travel before a frame drag stops being a click. */
const DRAG_THRESHOLD_PX = 4;

function formatHost(pageUrl: string | null): string | null {
  if (!pageUrl) return null;
  try {
    // "" for about:blank / file:// — no hostname to show, fall back to "Browser"
    return new URL(pageUrl).hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

const minimizeIcon = (
  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

const resetIcon = (
  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
    <path d="M3 3v5h5" />
  </svg>
);

const gripIcon = (
  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
    <line x1="8" y1="16" x2="16" y2="8" />
    <line x1="12" y1="18" x2="18" y2="12" />
  </svg>
);

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  moved: boolean;
}

interface GripState {
  pointerId: number;
  startX: number;
  originW: number;
}

export function BrowserViewer({
  frame,
  active,
  consentPending = false,
  wrapperRef,
}: {
  frame: BrowserViewerFrame | null;
  active: boolean;
  /** The attach to the user's Chrome is parked on the native remote-debugging
   *  prompt. Shown in the connecting placeholder so the stall is visible. */
  consentPending?: boolean;
  wrapperRef: RefObject<HTMLElement | null>;
}) {
  const [collapsed, setCollapsed] = useState(() => readStoredValue(COLLAPSED_KEY) === "true");
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const { geom, setGeometry, persistGeometry, resetGeometry } = useBrowserViewerGeometry(
    wrapperRef,
    collapsed,
  );

  const dragState = useRef<DragState | null>(null);
  const gripState = useRef<GripState | null>(null);
  /** Set when a pointer gesture was a drag — swallows the trailing click. */
  const suppressClickRef = useRef(false);
  const [interacting, setInteracting] = useState(false);

  const frameUrl = frame?.image.url ?? "";
  // Live frames can outlive their ring entry (session swept while this tab
  // stayed open) — a failed load swaps in an "expired" placeholder.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  // URL of the frame the user last saw expanded — drives the chip badge.
  const [lastSeenUrl, setLastSeenUrl] = useState<string | null>(frameUrl);

  useEffect(() => {
    try {
      writeStoredValue(COLLAPSED_KEY, collapsed ? "true" : "false");
    } catch {
      // localStorage unavailable (private mode) — preference just won't persist.
    }
  }, [collapsed]);

  // Mark the frame seen whenever the user has the card open (expanded, or a
  // new frame landing while expanded). While collapsed, lastSeenUrl holds so
  // a newer frame lights the chip badge.
  useEffect(() => {
    if (!collapsed && frameUrl) setLastSeenUrl(frameUrl);
  }, [frameUrl, collapsed]);

  // null only before the first layout pass — nothing paints in that frame.
  if (!geom) return null;
  const { x, y, w } = geom;

  const hasUnseenUpdate = collapsed && !!frameUrl && frameUrl !== lastSeenUrl;
  const host = formatHost(frame?.pageUrl ?? null);

  // --- Drag: the frame image is the drag surface -------------------------

  const onFramePointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (!e.isPrimary || (e.pointerType === "mouse" && e.button !== 0)) return;
    // A gesture's trailing click (if any) always arrives before the next
    // pointerdown — clearing here prevents a pointercancel (which emits no
    // click) from leaving the suppress flag set and eating the next enlarge.
    suppressClickRef.current = false;
    dragState.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: x,
      originY: y,
      moved: false,
    };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* jsdom has no pointer capture — drag still works via bubbling */
    }
    setInteracting(true);
  };

  const onFramePointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = dragState.current;
    if (!d || e.pointerId !== d.pointerId) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved) {
      if (Math.hypot(dx, dy) <= DRAG_THRESHOLD_PX) return;
      d.moved = true;
    }
    setGeometry({ x: d.originX + dx, y: d.originY + dy, w }, { persist: false });
  };

  const onFramePointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = dragState.current;
    if (!d || e.pointerId !== d.pointerId) return;
    dragState.current = null;
    setInteracting(false);
    if (d.moved) {
      suppressClickRef.current = true;
      persistGeometry();
    }
  };

  const onFrameClick = () => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    setLightboxOpen(true);
  };

  // Keyboard access: arrows nudge (shift for 3x), +/- resize.
  const onFrameKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    const step = e.shiftKey ? 24 : 8;
    let dx = 0;
    let dy = 0;
    let dw = 0;
    if (e.key === "ArrowLeft") dx = -step;
    else if (e.key === "ArrowRight") dx = step;
    else if (e.key === "ArrowUp") dy = -step;
    else if (e.key === "ArrowDown") dy = step;
    else if (e.key === "+" || e.key === "=") dw = 16;
    else if (e.key === "-" || e.key === "_") dw = -16;
    else return;
    e.preventDefault();
    setGeometry({ x: x + dx, y: y + dy, w: w + dw });
  };

  // --- Resize: bottom-right corner grip, width only ----------------------

  const onGripPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.isPrimary || (e.pointerType === "mouse" && e.button !== 0)) return;
    gripState.current = { pointerId: e.pointerId, startX: e.clientX, originW: w };
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* jsdom — see above */
    }
    setInteracting(true);
    e.stopPropagation();
  };

  const onGripPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gripState.current;
    if (!g || e.pointerId !== g.pointerId) return;
    setGeometry({ x, y, w: g.originW + (e.clientX - g.startX) }, { persist: false });
  };

  const onGripPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = gripState.current;
    if (!g || e.pointerId !== g.pointerId) return;
    gripState.current = null;
    setInteracting(false);
    persistGeometry();
  };

  if (collapsed) {
    // The chip sits where the card was — the window shrinks in place.
    return (
      <div data-browser-viewer className="absolute z-20" style={{ left: x, top: y }}>
        <button
          onClick={() => setCollapsed(false)}
          className="relative flex items-center justify-center w-10 h-10 rounded-full depth-raised bg-black/40 border border-white/20 text-white/70 hover:text-white hover:bg-black/55 transition-all shadow-lg backdrop-blur-sm pressable"
          title="Open browser view"
          aria-label="Open browser view"
        >
          <ToolIcon name="browser_navigate" className="w-5 h-5" />
          {hasUnseenUpdate && (
            <span className="absolute -top-0.5 -right-0.5 w-3 h-3 rounded-full bg-purple-400 border border-black/40 animate-pulse" />
          )}
          {active && !hasUnseenUpdate && (
            <span className="absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full bg-purple-400 border border-black/40 animate-pulse" />
          )}
        </button>
      </div>
    );
  }

  return (
    <div
      data-browser-viewer
      className="absolute z-20 select-none"
      style={{ left: x, top: y, width: w }}
    >
      <div
        className={`relative rounded-xl overflow-hidden depth-raised border border-white/15 bg-black/45 backdrop-blur-md transition-shadow ${
          interacting ? "shadow-xl" : "shadow-lg"
        }`}
      >
        {frame ? (
          <button
            onPointerDown={onFramePointerDown}
            onPointerMove={onFramePointerMove}
            onPointerUp={onFramePointerUp}
            onPointerCancel={onFramePointerUp}
            onClick={onFrameClick}
            onKeyDown={onFrameKeyDown}
            className={`block w-full touch-none select-none ${interacting ? "cursor-grabbing" : "cursor-grab"}`}
            title={
              frame.pageUrl
                ? `${frame.pageUrl}\nClick to enlarge · drag to move · corner to resize`
                : "Click to enlarge · drag to move · corner to resize"
            }
            aria-label="Enlarge browser screenshot. Drag to move, corner to resize, arrow keys to nudge."
          >
            {failedUrl === frameUrl ? (
              // Live frame whose ring entry was cleared (session swept or
              // server restarted) — the bytes are gone; say so instead of
              // showing a broken image.
              <div className="w-full aspect-[16/10] flex items-center justify-center bg-black/30">
                <span className="text-[10px] text-white/40 px-3 text-center">
                  Frame expired — waiting for the next browser action
                </span>
              </div>
            ) : (
              /* key forces a remount per frame so a full-page→viewport swap never
                 stretches the old bitmap while the new one decodes */
              <img
                key={frameUrl}
                src={frameUrl}
                alt="Latest browser screenshot"
                decoding="async"
                draggable={false}
                onError={() => setFailedUrl(frameUrl)}
                className="w-full aspect-[16/10] object-cover object-top"
              />
            )}
          </button>
        ) : (
          // Browser tool running but nothing captured yet: connecting spinner,
          // or the consent hint when the Chrome attach is parked on the
          // native "allow remote debugging" prompt (Phase 2 §5.3).
          <div className="flex items-center justify-center aspect-[16/10]">
            <div className="flex flex-col items-center gap-2 px-3 text-center">
              <div className="w-5 h-5 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
              <span className="text-[10px] text-white/50 leading-snug">
                {consentPending
                  ? 'Approve the "allow remote debugging" prompt in Chrome'
                  : "Opening the browser…"}
              </span>
            </div>
          </div>
        )}
        <button
          onClick={resetGeometry}
          className="absolute top-1.5 right-[42px] flex items-center justify-center w-6 h-6 rounded-full bg-black/50 border border-white/15 text-white/60 hover:text-white hover:bg-black/70 transition-colors"
          title="Reset position and size"
          aria-label="Reset browser view position and size"
        >
          {resetIcon}
        </button>
        <button
          onClick={() => setCollapsed(true)}
          className="absolute top-1.5 right-1.5 flex items-center justify-center w-6 h-6 rounded-full bg-black/50 border border-white/15 text-white/60 hover:text-white hover:bg-black/70 transition-colors"
          title="Minimize browser view"
          aria-label="Minimize browser view"
        >
          {minimizeIcon}
        </button>
        <div className="flex items-center gap-1.5 pl-2 pr-5 py-1.5 border-t border-white/10 min-w-0">
          <span
            className={`w-1.5 h-1.5 rounded-full shrink-0 ${
              active ? "bg-purple-400 animate-pulse" : "bg-white/25"
            }`}
            title={active ? "Agent is driving the browser" : "Browser idle"}
          />
          <span className="text-[10px] text-white/70 truncate">{host ?? "Browser"}</span>
          {frame?.pageTitle && (
            <span className="text-[10px] text-white/35 truncate hidden sm:inline">
              · {frame.pageTitle}
            </span>
          )}
        </div>
        <div
          onPointerDown={onGripPointerDown}
          onPointerMove={onGripPointerMove}
          onPointerUp={onGripPointerUp}
          onPointerCancel={onGripPointerUp}
          className="absolute bottom-0 right-0 w-5 h-5 z-10 flex items-end justify-end p-0.5 cursor-nwse-resize touch-none text-white/50 hover:text-white"
          title="Drag to resize"
        >
          {gripIcon}
        </div>
      </div>
      {lightboxOpen && frame &&
        createPortal(
          <ImageLightbox image={frame.image} onClose={() => setLightboxOpen(false)} />,
          document.body,
        )}
    </div>
  );
}
