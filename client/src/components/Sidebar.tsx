import type { ChatListItem as ChatListItemType } from "../types";
import { ChatListItem } from "./ChatListItem";

interface Props {
  chats: ChatListItemType[];
  activeChatId: string | null;
  onSelectChat: (id: string) => void;
  onNewChat: () => void;
  onDeleteChat: (id: string) => void;
  onOpenSettings: () => void;
}

export function Sidebar({
  chats,
  activeChatId,
  onSelectChat,
  onNewChat,
  onDeleteChat,
  onOpenSettings,
}: Props) {
  return (
    <div className="w-72 h-full flex flex-col backdrop-blur-xl bg-white/[0.08] border-r border-white/10">
      {/* Header */}
      <div className="p-4 border-b border-white/10 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-white/90 tracking-tight">
          Pi Web UI
        </h1>
        <button
          onClick={onOpenSettings}
          className="text-white/40 hover:text-white/70 transition-colors p-1 rounded-lg hover:bg-white/5"
          title="Settings"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        </button>
      </div>

      {/* New Chat Button */}
      <div className="p-3">
        <button
          onClick={onNewChat}
          className="w-full px-4 py-2.5 rounded-xl bg-blue-500/15 border border-blue-400/25 text-blue-300 text-sm font-medium hover:bg-blue-500/25 transition-all flex items-center justify-center gap-2"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 5v14" />
            <path d="M5 12h14" />
          </svg>
          New Chat
        </button>
      </div>

      {/* Chat List */}
      <div className="flex-1 overflow-y-auto px-2 pb-2 space-y-0.5">
        {chats.map((chat) => (
          <ChatListItem
            key={chat.id}
            chat={chat}
            active={chat.id === activeChatId}
            onSelect={() => onSelectChat(chat.id)}
            onDelete={() => onDeleteChat(chat.id)}
          />
        ))}
        {chats.length === 0 && (
          <p className="text-center text-white/30 text-xs mt-8 px-4">
            No chats yet. Start a new conversation!
          </p>
        )}
      </div>
    </div>
  );
}
