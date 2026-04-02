import { useState, useCallback, useEffect } from "react";
import type { ChatListItem as ChatListItemType } from "../types";
import { ContextMenu, ContextMenuItem, useLongPress } from "./ContextMenu";

interface Props {
  chat: ChatListItemType;
  active: boolean;
  onSelect: () => void;
  onDelete: () => void;
  onSendToNotebook?: (chatId: string, chatTitle: string) => void;
}

export function ChatListItem({ chat, active, onSelect, onDelete, onSendToNotebook }: Props) {
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

  return (
    <button
      onClick={onSelect}
      onContextMenu={handleContextMenu}
      {...longPressProps}
      className={`w-full text-left px-2.5 py-2 rounded-xl transition-all group relative ${
        active
          ? "bg-white/15 border border-white/20"
          : "hover:bg-white/8 border border-transparent"
      }`}
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

      {/* Overlapping delete button — desktop only (hidden on mobile, use long-press context menu instead) */}
      {!confirmDelete && (
        <div
          onClick={handleDeleteClick}
          className={`absolute right-0 top-0 bottom-0 flex items-center pr-2.5 pl-6 rounded-r-xl opacity-0 group-hover:opacity-100 md:opacity-100 md:group-hover:opacity-100 transition-opacity cursor-pointer hidden md:flex ${
            active
              ? "bg-gradient-to-l from-[rgba(255,255,255,0.15)] via-[rgba(255,255,255,0.15)] to-transparent"
              : "bg-gradient-to-l from-[rgba(255,255,255,0.08)] via-[rgba(255,255,255,0.08)] to-transparent"
          }`}
          title="Delete chat"
        >
          <div className="text-white/30 hover:text-red-400 transition-colors p-0.5">
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
