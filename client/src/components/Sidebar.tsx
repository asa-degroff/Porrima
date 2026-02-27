import { useMemo } from "react";
import type { ChatListItem as ChatListItemType, ChatType } from "../types";
import { ChatListItem } from "./ChatListItem";

interface Props {
  chats: ChatListItemType[];
  activeChatId: string | null;
  onSelectChat: (id: string) => void;
  onNewChat: (type: ChatType) => void;
  onDeleteChat: (id: string) => void;
  onOpenSettings: () => void;
  isOpen: boolean;
  onClose: () => void;
}

export function Sidebar({
  chats,
  activeChatId,
  onSelectChat,
  onNewChat,
  onDeleteChat,
  onOpenSettings,
  isOpen,
  onClose,
}: Props) {
  const agentChats = useMemo(
    () => chats.filter((c) => c.type === "agent"),
    [chats]
  );
  const quickChats = useMemo(
    () => chats.filter((c) => c.type !== "agent"),
    [chats]
  );

  return (
    <div className={`w-72 h-full flex flex-col backdrop-blur-xl bg-white/[0.08] border-r border-white/10 fixed inset-y-0 left-0 z-30 transition-transform duration-300 ease-in-out md:static md:translate-x-0 md:z-auto ${isOpen ? "translate-x-0" : "-translate-x-full"}`}>
      {/* Header */}
      <div className="p-4 border-b border-white/10 flex items-center justify-between">
        <h1 className="text-lg font-semibold text-white/90 tracking-tight">
          qu.je
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

      {/* Chat Sections */}
      <div className="flex-1 overflow-y-auto">
        {/* Agent Chats Section */}
        <div className="px-3 pt-3 pb-1">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] font-semibold tracking-wider uppercase text-white/30 px-1">
              Agent Chats
            </span>
          </div>
          <button
            onClick={() => { onNewChat("agent"); onClose(); }}
            className="w-full px-3 py-2 rounded-xl bg-purple-500/15 border border-purple-400/25 text-purple-300 text-sm font-medium hover:bg-purple-500/25 transition-all flex items-center justify-center gap-2 mb-1"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14" />
              <path d="M5 12h14" />
            </svg>
            New Agent Chat
          </button>
          <div className="space-y-0.5">
            {agentChats.map((chat) => (
              <ChatListItem
                key={chat.id}
                chat={chat}
                active={chat.id === activeChatId}
                onSelect={() => { onSelectChat(chat.id); onClose(); }}
                onDelete={() => onDeleteChat(chat.id)}
              />
            ))}
            {agentChats.length === 0 && (
              <p className="text-center text-white/20 text-xs py-3 px-2">
                Agent chats have persistent memory
              </p>
            )}
          </div>
        </div>

        {/* Divider */}
        <div className="mx-4 my-2 border-t border-white/5" />

        {/* Quick Chats Section */}
        <div className="px-3 pb-2">
          <div className="flex items-center justify-between mb-1.5">
            <span className="text-[10px] font-semibold tracking-wider uppercase text-white/30 px-1">
              Quick Chats
            </span>
          </div>
          <button
            onClick={() => { onNewChat("quick"); onClose(); }}
            className="w-full px-3 py-2 rounded-xl bg-blue-500/15 border border-blue-400/25 text-blue-300 text-sm font-medium hover:bg-blue-500/25 transition-all flex items-center justify-center gap-2 mb-1"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14" />
              <path d="M5 12h14" />
            </svg>
            New Quick Chat
          </button>
          <div className="space-y-0.5">
            {quickChats.map((chat) => (
              <ChatListItem
                key={chat.id}
                chat={chat}
                active={chat.id === activeChatId}
                onSelect={() => { onSelectChat(chat.id); onClose(); }}
                onDelete={() => onDeleteChat(chat.id)}
              />
            ))}
            {quickChats.length === 0 && (
              <p className="text-center text-white/20 text-xs py-3 px-2">
                Standalone one-off conversations
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
