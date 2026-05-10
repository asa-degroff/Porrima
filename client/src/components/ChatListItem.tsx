import { useState, useCallback, useEffect } from "react";
import type { ChatListItem as ChatListItemType } from "../types";
import type { CacheResidency } from "../api/client";
import { ContextMenu, ContextMenuItem, useLongPress } from "./ui/ContextMenu";
import { PrefillActivityIcon } from "./PrefillActivityIcon";

interface Props {
  chat: ChatListItemType;
  active: boolean;
  lastActive?: boolean;
  cacheResidency?: CacheResidency | null;
  onSelect: () => void;
  onDelete: () => void;
  onSendToNotebook?: (chatId: string, chatTitle: string) => void;
  onWarmCache?: (chatId: string) => void;
  cacheWarming?: boolean;
  cacheWarmError?: string;
}

function formatCacheResidencyTitle(residency?: CacheResidency | null): string | undefined {
  if (!residency) return undefined;
  const parts = [residency.active ? "Cache active" : "Cache warm"];
  if (typeof residency.inferredCacheHitRatio === "number") {
    parts.push(`last hit ${(residency.inferredCacheHitRatio * 100).toFixed(1)}%`);
  }
  if (typeof residency.slotId === "number") {
    parts.push(`slot ${residency.slotId}`);
  } else {
    parts.push(`${residency.bindingMode} slot selection`);
  }
  return parts.join(" - ");
}

export function ChatListItem({ chat, active, lastActive = false, cacheResidency, onSelect, onDelete, onSendToNotebook, onWarmCache, cacheWarming = false, cacheWarmError }: Props) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const openContextMenu = useCallback((pos: { x: number; y: number }) => {
    setContextMenu(pos);
  }, []);
  const longPressProps = useLongPress(openContextMenu);

  // Close confirmation on Escape
  useEffect(() => {
    if (!confirmDelete) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") setConfirmDelete(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [confirmDelete]);

  const handleDeleteClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(true);
  }, []);

  const handleConfirmDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onDelete();
    setConfirmDelete(false);
  }, [onDelete]);

  const handleCancelDelete = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(false);
  }, []);
  const cacheTitle = formatCacheResidencyTitle(cacheResidency);
  const effectiveCacheWarming = cacheWarming || cacheResidency?.status === "warming";
  const effectiveTitle = cacheWarmError ? `Cache warm failed: ${cacheWarmError}` : cacheTitle;

  const handleWarm = useCallback(() => {
    setContextMenu(null);
    if (effectiveCacheWarming) return;
    onWarmCache?.(chat.id);
  }, [effectiveCacheWarming, onWarmCache, chat.id]);

  return (
    <button
      onClick={onSelect}
      onContextMenu={handleContextMenu}
      {...longPressProps}
      className={`w-full text-left px-2.5 py-2 rounded-xl transition-all group relative border ${
        active ? "bg-white/15" : "hover:bg-white/8"
      } ${
        active
          ? "border-white/20"
          : cacheResidency && lastActive
            ? "border-purple-400/30 shadow-[0_0_8px_rgba(168,85,247,0.15)]"
            : cacheResidency
              ? "border-amber-400/25 shadow-[0_0_8px_rgba(251,191,36,0.10)]"
              : "border-transparent"
      }`}
      title={effectiveTitle}
    >
      {/* Always-rendered content to maintain consistent height */}
      <div className={`min-w-0 ${confirmDelete ? "invisible" : ""}`}>
        <p className="text-sm font-medium text-white/90 leading-snug pr-5">
          {chat.title}
        </p>
        {chat.preview && (
          <p className="text-xs text-white/40 truncate mt-0.25 pr-5">
            {chat.preview}
          </p>
        )}
      </div>

      {/* Delete confirmation overlay — absolute so it doesn't affect height */}
      {confirmDelete && (
        <div className="absolute inset-0 flex items-center justify-between gap-2 px-3">
          <p className="text-xs text-white/70 truncate">Delete this chat?</p>
          <div className="flex gap-1.5 shrink-0">
            <span
              role="button"
              onClick={handleConfirmDelete}
              className="px-2 py-0.5 rounded-md text-xs font-medium bg-red-500/25 border border-red-400/30 text-red-300 hover:bg-red-500/40 transition-all cursor-pointer"
            >
              Delete
            </span>
            <span
              role="button"
              onClick={handleCancelDelete}
              className="px-2 py-0.5 rounded-md text-xs font-medium bg-white/10 border border-white/15 text-white/50 hover:text-white/80 hover:bg-white/15 transition-all cursor-pointer"
            >
              Cancel
            </span>
          </div>
        </div>
      )}

      {effectiveCacheWarming && !confirmDelete && (
        <div
          className="absolute right-2.5 top-1/2 -translate-y-1/2 pointer-events-none"
          title="Warming cache"
        >
          <PrefillActivityIcon />
        </div>
      )}

      {cacheWarmError && !effectiveCacheWarming && !confirmDelete && (
        <div
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-red-300/80"
          title={`Cache warm failed: ${cacheWarmError}`}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M12 8v5" />
            <path d="M12 17h.01" />
          </svg>
        </div>
      )}

      {/* Hover action — warm cache for agent chats, delete for others — desktop only */}
      {!confirmDelete && !effectiveCacheWarming && !cacheWarmError && (
        <div
          onClick={(e) => {
            e.stopPropagation();
            if (chat.type === "agent" && onWarmCache) {
              if (!effectiveCacheWarming) onWarmCache(chat.id);
            } else {
              handleDeleteClick(e);
            }
          }}
          className={`absolute right-0 top-0 bottom-0 flex items-center pr-2.5 pl-6 rounded-r-xl opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer hidden md:flex`}
          title={chat.type === "agent" ? "Warm cache" : "Delete chat"}
        >
          <div className={`transition-colors p-0.5 ${chat.type === "agent" ? "text-white/30 hover:text-[rgba(var(--theme-accent),0.8)]" : "text-white/30 hover:text-red-400"}`}>
            {chat.type === "agent" ? (
              /* Hot spring / steam icon — ♨️ style: three wavy updrafts from a base */
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M8 18c-2.2 0-4 1.8-4 4" />
                <path d="M16 18c2.2 0 4 1.8 4 4" />
                <path d="M7 4c0 0 1 1.3 1 3s-1 3-1 3" />
                <path d="M12 4c0 0 1 1.3 1 3s-1 3-1 3" />
                <path d="M17 4c0 0 1 1.3 1 3s-1 3-1 3" />
                <path d="M5 18h14" />
              </svg>
            ) : (
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 6h18" />
                <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
              </svg>
            )}
          </div>
        </div>
      )}

      {/* Context menu */}
      {contextMenu && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={() => setContextMenu(null)}>
          {onSendToNotebook && (
            <ContextMenuItem onClick={() => { setContextMenu(null); onSendToNotebook(chat.id, chat.title); }}>
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-purple-400">
                <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                <polyline points="14 2 14 8 20 8" />
                <path d="M12 18v-6" />
                <path d="m8 15 4 4 4-4" />
              </svg>
              Send to notebook
            </ContextMenuItem>
          )}
          {onWarmCache && chat.type === "agent" && (
            <ContextMenuItem onClick={handleWarm} disabled={effectiveCacheWarming}>
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={effectiveCacheWarming ? "animate-pulse" : "opacity-70"} style={{ color: `rgba(var(--theme-accent), ${effectiveCacheWarming ? 0.9 : 0.7})` }}>
                <path d="M12 2c.132 0 .263.001.393.003"/>
                <path d="M7 5h10"/>
                <path d="M11 4v2"/>
                <path d="M13 4v2"/>
                <path d="M12 8a4 4 0 0 0-4 4c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2 4 4 0 0 0-4-4Z"/>
                <path d="M12 14v3"/>
              </svg>
              {effectiveCacheWarming ? "Warming..." : "Warm Cache"}
            </ContextMenuItem>
          )}
          <ContextMenuItem destructive onClick={() => { setContextMenu(null); setConfirmDelete(true); }}>
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 6h18" />
              <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
              <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
            </svg>
            Delete
          </ContextMenuItem>
        </ContextMenu>
      )}
    </button>
  );
}
