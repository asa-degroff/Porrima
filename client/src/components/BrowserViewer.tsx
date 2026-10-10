/**
 * BrowserViewer — persistent picture-in-picture card showing the agent's
 * latest browser screenshot, floating over the top-right of the message
 * area. Frames update in place as new screenshots arrive; clicking the
 * frame opens the shared ImageLightbox. Collapsing minimizes it to an
 * icon chip that badges when a newer frame lands.
 *
 * State is derived from the chat's messages (see useBrowserViewer) — there
 * is no separate browser event stream in Phase 1.
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { BrowserViewerFrame } from "../hooks/useBrowserViewer";
import { readStoredValue, writeStoredValue } from "../lib/storage";
import { ImageLightbox } from "./ImageLightbox";
import { ToolIcon } from "./ToolIcons";

const COLLAPSED_KEY = "porrima-browser-viewer-collapsed";

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

export function BrowserViewer({ frame, active }: { frame: BrowserViewerFrame; active: boolean }) {
  const [collapsed, setCollapsed] = useState(() => readStoredValue(COLLAPSED_KEY) === "true");
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const frameUrl = frame.image.url ?? "";
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
    if (!collapsed) setLastSeenUrl(frameUrl);
  }, [frameUrl, collapsed]);

  const hasUnseenUpdate = collapsed && frameUrl !== lastSeenUrl;
  const host = formatHost(frame.pageUrl);

  if (collapsed) {
    return (
      <div className="absolute top-3 right-2 sm:top-4 sm:right-6 z-20">
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
    <div className="absolute top-3 right-2 sm:top-4 sm:right-6 z-20 w-[132px] sm:w-[210px]">
      <div className="relative rounded-xl overflow-hidden depth-raised border border-white/15 bg-black/45 shadow-lg backdrop-blur-md">
        <button
          onClick={() => setLightboxOpen(true)}
          className="block w-full cursor-zoom-in"
          title={frame.pageUrl ? `${frame.pageUrl}\nClick to enlarge` : "Click to enlarge"}
          aria-label="Enlarge browser screenshot"
        >
          {/* key forces a remount per frame so a full-page→viewport swap never
              stretches the old bitmap while the new one decodes */}
          <img
            key={frameUrl}
            src={frameUrl}
            alt="Latest browser screenshot"
            decoding="async"
            draggable={false}
            className="w-full aspect-[16/10] object-cover object-top"
          />
        </button>
        <button
          onClick={() => setCollapsed(true)}
          className="absolute top-1.5 right-1.5 flex items-center justify-center w-6 h-6 rounded-full bg-black/50 border border-white/15 text-white/60 hover:text-white hover:bg-black/70 transition-colors"
          title="Minimize browser view"
          aria-label="Minimize browser view"
        >
          {minimizeIcon}
        </button>
        <div className="flex items-center gap-1.5 px-2 py-1.5 border-t border-white/10 min-w-0">
          <span
            className={`w-1.5 h-1.5 rounded-full shrink-0 ${
              active ? "bg-purple-400 animate-pulse" : "bg-white/25"
            }`}
            title={active ? "Agent is driving the browser" : "Browser idle"}
          />
          <span className="text-[10px] text-white/70 truncate">{host ?? "Browser"}</span>
          {frame.pageTitle && (
            <span className="text-[10px] text-white/35 truncate hidden sm:inline">
              · {frame.pageTitle}
            </span>
          )}
        </div>
      </div>
      {lightboxOpen &&
        createPortal(
          <ImageLightbox image={frame.image} onClose={() => setLightboxOpen(false)} />,
          document.body,
        )}
    </div>
  );
}
