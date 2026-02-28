import { useMemo, useState } from "react";
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

function ChevronIcon({ expanded }: { expanded: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`transition-transform duration-200 ${expanded ? "rotate-90" : ""}`}
    >
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
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
  const [agentExpanded, setAgentExpanded] = useState(true);
  const [quickExpanded, setQuickExpanded] = useState(true);

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
      <div className="p-4 border-b border-white/10 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2">
          <img src="/logo.svg" alt="qu.je" className="w-6 h-6" />
          <h1 className="text-lg font-semibold text-white/90 tracking-tight">
            qu.je
          </h1>
        </div>
        <div className="flex items-center gap-1">
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
      </div>

      {/* Chat Sections — flex column, each section grows when expanded */}
      <div className="flex-1 flex flex-col min-h-0">
        {/* Agent Chats Section */}
        <div className={`flex flex-col min-h-0 border-b border-white/5 ${agentExpanded ? "flex-1" : "shrink-0"}`}>
          {/* Section header — always visible */}
          <div className="px-3 pt-3 pb-1 shrink-0">
            <button
              onClick={() => setAgentExpanded(!agentExpanded)}
              className="flex items-center gap-1.5 px-1 mb-1.5 group cursor-pointer"
            >
              <span className="text-white/30 group-hover:text-white/50 transition-colors">
                <ChevronIcon expanded={agentExpanded} />
              </span>
              <span className="text-[10px] font-semibold tracking-wider uppercase text-white/30 group-hover:text-white/50 transition-colors">
                Agent Chats
              </span>
              {!agentExpanded && agentChats.length > 0 && (
                <span className="text-[10px] text-white/20 ml-auto">{agentChats.length}</span>
              )}
            </button>
            {agentExpanded && (
              <button
                onClick={() => { onNewChat("agent"); onClose(); }}
                className="w-full px-3 py-2 rounded-xl bg-purple-500/15 border border-purple-400/25 text-purple-300 text-sm font-medium hover:bg-purple-500/25 transition-all flex items-center justify-center gap-2"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 5v14" />
                  <path d="M5 12h14" />
                </svg>
                New Agent Chat
              </button>
            )}
          </div>
          {/* Scrollable chat list */}
          {agentExpanded && (
            <div className="flex-1 overflow-y-auto px-3 pb-1">
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
          )}
        </div>

        {/* Quick Chats Section */}
        <div className={`flex flex-col min-h-0 ${quickExpanded ? "flex-1" : "shrink-0"}`}>
          {/* Section header — always visible */}
          <div className="px-3 pt-3 pb-1 shrink-0">
            <button
              onClick={() => setQuickExpanded(!quickExpanded)}
              className="flex items-center gap-1.5 px-1 mb-1.5 group cursor-pointer"
            >
              <span className="text-white/30 group-hover:text-white/50 transition-colors">
                <ChevronIcon expanded={quickExpanded} />
              </span>
              <span className="text-[10px] font-semibold tracking-wider uppercase text-white/30 group-hover:text-white/50 transition-colors">
                Quick Chats
              </span>
              {!quickExpanded && quickChats.length > 0 && (
                <span className="text-[10px] text-white/20 ml-auto">{quickChats.length}</span>
              )}
            </button>
            {quickExpanded && (
              <button
                onClick={() => { onNewChat("quick"); onClose(); }}
                className="w-full px-3 py-2 rounded-xl bg-blue-500/15 border border-blue-400/25 text-blue-300 text-sm font-medium hover:bg-blue-500/25 transition-all flex items-center justify-center gap-2"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 5v14" />
                  <path d="M5 12h14" />
                </svg>
                New Quick Chat
              </button>
            )}
          </div>
          {/* Scrollable chat list */}
          {quickExpanded && (
            <div className="flex-1 overflow-y-auto px-3 pb-2">
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
          )}
        </div>
      </div>
    </div>
  );
}
