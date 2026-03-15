import { useState, useCallback } from "react";
import type { ChatListItem } from "../types";

interface Props {
  chat: ChatListItem;
  onCreateNotebookEntry: (chatId: string, chatTitle: string) => void;
}

export function ChatListContextMenu({ chat, onCreateNotebookEntry }: Props) {
  const [visible, setVisible] = useState(false);
  const [x, setX] = useState(0);
  const [y, setY] = useState(0);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setX(e.clientX);
    setY(e.clientY);
    setVisible(true);
  }, []);

  const handleSendToNotebook = useCallback(() => {
    onCreateNotebookEntry(chat.id, chat.title);
    setVisible(false);
  }, [chat.id, chat.title, onCreateNotebookEntry]);

  const handleClose = useCallback(() => {
    setVisible(false);
  }, []);

  // Attach handlers to parent element
  const handlers = {
    onContextMenu: handleContextMenu,
  };

  const menu = visible && (
    <div
      className="fixed z-50 min-w-[160px] rounded-lg border border-white/10 bg-black/90 backdrop-blur-xl shadow-xl"
      style={{ left: x, top: y }}
      onClick={handleClose}
    >
      <button
        onClick={handleSendToNotebook}
        className="w-full px-4 py-2 text-left text-sm text-white/80 hover:text-white hover:bg-white/5 transition-colors flex items-center gap-2"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-purple-400">
          <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
          <polyline points="14 2 14 8 20 8" />
          <path d="M12 18v-6" />
          <path d="m8 15 4 4 4-4" />
        </svg>
        Send to notebook
      </button>
    </div>
  );

  return { handlers, menu };
}
