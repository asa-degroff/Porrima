import { useCallback } from "react";
import type { ChatListItem } from "../types";

interface Props {
  chats: ChatListItem[];
  filterText: string;
  onSelect: (chatId: string, chatTitle: string, preview?: string) => void;
  onClose: () => void;
  anchorRect: DOMRect | null;
}

export function ChatLinkPicker({ chats, filterText, onSelect, onClose, anchorRect }: Props) {
  const filtered = chats.filter(c =>
    c.title.toLowerCase().includes(filterText.toLowerCase())
  ).slice(0, 10);

  const handleSelect = useCallback((chat: ChatListItem) => {
    onSelect(chat.id, chat.title, chat.title);
    onClose();
  }, [onSelect, onClose]);

  const position = anchorRect ? {
    top: anchorRect.bottom + window.scrollY + 4,
    left: anchorRect.left + window.scrollX,
  } : { top: 100, left: 100 };

  return (
    <div
      className="link-picker-popup fixed z-50 w-80 max-h-96 overflow-auto rounded-lg border border-white/10 app-solid-popover shadow-xl"
      style={position}
    >
      <div className="px-3 py-2 border-b border-white/10">
        <h4 className="text-xs font-medium text-white/60 uppercase tracking-wider">Link to Chat</h4>
      </div>
      {filtered.length === 0 ? (
        <div className="px-4 py-3 text-sm text-white/40">
          No chats match "{filterText}"
        </div>
      ) : (
        <div className="py-1">
          {filtered.map((chat) => (
            <button
              key={chat.id}
              onClick={() => handleSelect(chat)}
              className="w-full px-4 py-2 text-left text-sm text-white/70 hover:text-white hover:bg-white/5 transition-colors flex flex-col gap-1"
            >
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full ${chat.type === 'agent' ? 'bg-purple-400' : 'bg-blue-400'}`} />
                <span className="font-medium truncate flex-1">{chat.title}</span>
              </div>
              <span className="text-xs text-white/30 truncate pl-4">{chat.preview || 'No messages yet'}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
