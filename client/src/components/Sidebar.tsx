import { useMemo, useState } from "react";
import type { ChatListItem as ChatListItemType, ChatType, Project } from "../types";
import { ChatListItem } from "./ChatListItem";
import { OctahedronLogo } from "./OctahedronLogo";
import { useSidebarState } from "../hooks/useSidebarState";

interface Props {
  chats: ChatListItemType[];
  projects: Project[];
  activeChatId: string | null;
  activeView: 'chats' | 'notebooks';
  onSelectChat: (id: string) => void;
  onSwitchView: (view: 'chats' | 'notebooks') => void;
  onNewChat: (type: ChatType, projectId?: string) => void;
  onNewProject: () => void;
  onDeleteChat: (id: string) => void;
  onDeleteProject: (id: string) => void;
  onSendToNotebook?: (chatId: string, chatTitle: string) => void;
  onOpenSettings: () => void;
  onOpenImageSandbox: () => void;
  isOpen: boolean;
  onClose: () => void;
  isStreaming?: boolean;
  hasUnreadNotebooks?: boolean;
  ttsBarVisible?: boolean;
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

function ProjectSection({
  project,
  chats,
  activeChatId,
  expanded,
  onToggleExpanded,
  onSelectChat,
  onNewChat,
  onDeleteChat,
  onDeleteProject,
  onSendToNotebook,
}: {
  project: Project;
  chats: ChatListItemType[];
  activeChatId: string | null;
  expanded: boolean;
  onToggleExpanded: () => void;
  onSelectChat: (id: string) => void;
  onNewChat: (type: ChatType, projectId?: string) => void;
  onDeleteChat: (id: string) => void;
  onDeleteProject: (id: string) => void;
  onSendToNotebook?: (chatId: string, chatTitle: string) => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div className="rounded-lg bg-white/[0.03] border border-white/[0.06]">
      <div className="flex items-center gap-1.5 px-2 py-1.5 group">
        <button
          onClick={onToggleExpanded}
          className="flex items-center gap-1.5 flex-1 min-w-0 cursor-pointer"
        >
          <span className="text-emerald-400/50">
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
            </svg>
          </span>
          <span className="text-xs font-medium text-white/70 truncate">{project.name}</span>
          <span className="text-white/20 ml-auto shrink-0">
            <ChevronIcon expanded={expanded} />
          </span>
        </button>
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
            {confirmDelete ? (
            <div className="flex items-center gap-1">
              <button
                onClick={() => { onDeleteProject(project.id); setConfirmDelete(false); }}
                className="text-[10px] px-1.5 py-0.5 rounded bg-red-500/25 border border-red-400/30 text-red-300 hover:bg-red-500/40"
              >
                Del
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="text-[10px] px-1.5 py-0.5 rounded bg-white/10 border border-white/15 text-white/50 hover:text-white/80"
              >
                No
              </button>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              className="text-white/30 hover:text-red-400 transition-colors p-0.5 rounded hover:bg-white/5"
              title="Delete project"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6h18" />
                <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
              </svg>
            </button>
          )}
        </div>
      </div>
      {expanded && (
        <div className="px-1 pb-1.5">
          <button
            onClick={() => onNewChat("agent", project.id)}
            className="w-full px-2 py-1.5 rounded-xl bg-emerald-500/15 border border-emerald-400/25 text-emerald-300 text-xs font-medium hover:bg-emerald-500/25 transition-all flex items-center justify-center gap-1.5 mb-2"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14" />
              <path d="M5 12h14" />
            </svg>
            New Chat
          </button>
          {chats.length > 0 ? (
            <div className="space-y-0.5">
              {chats.map((chat) => (
                <ChatListItem
                  key={chat.id}
                  chat={chat}
                  active={chat.id === activeChatId}
                  onSelect={() => onSelectChat(chat.id)}
                  onDelete={() => onDeleteChat(chat.id)}
                  onSendToNotebook={onSendToNotebook}
                />
              ))}
            </div>
          ) : (
            <p className="text-center text-white/20 text-[10px] py-2">
              No chats yet
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function Sidebar({
  chats,
  projects,
  activeChatId,
  activeView,
  onSelectChat,
  onSwitchView,
  onNewChat,
  onNewProject,
  onDeleteChat,
  onDeleteProject,
  onSendToNotebook,
  onOpenSettings,
  onOpenImageSandbox,
  isOpen,
  onClose,
  isStreaming = false,
  hasUnreadNotebooks = false,
  ttsBarVisible = false,
}: Props) {
  const {
    projectsExpanded,
    setProjectsExpanded,
    agentExpanded,
    setAgentExpanded,
    quickExpanded,
    setQuickExpanded,
    getProjectExpanded,
    setProjectExpanded,
  } = useSidebarState();

  const agentChats = useMemo(
    () => chats.filter((c) => c.type === "agent" && !c.projectId),
    [chats]
  );
  const quickChats = useMemo(
    () => chats.filter((c) => c.type !== "agent" && !c.projectId),
    [chats]
  );

  // Group chats by project
  const chatsByProject = useMemo(() => {
    const map: Record<string, ChatListItemType[]> = {};
    for (const project of projects) {
      map[project.id] = chats.filter((c) => c.projectId === project.id);
    }
    return map;
  }, [chats, projects]);

  return (
    <div className={`w-72 h-full flex flex-col backdrop-blur-sm bg-white/[0.03] border-r border-white/10 fixed inset-y-0 left-0 z-30 transition-transform duration-300 ease-in-out md:static md:translate-x-0 md:z-auto ${isOpen ? "translate-x-0" : "-translate-x-full"}`}>
      {/* Header */}
      <div className="px-3 pt-3 pb-2 shrink-0">
        <div className="flex items-center justify-between rounded-full bg-black/20 border border-white/[0.05] px-4 py-2.5 shadow-[inset_0_1px_7px_rgba(0,0,0,0.5)]">
          <div className="relative flex items-center">
            {/* Static logo + title */}
            <div className={`flex items-center gap-2 transition-opacity duration-300 ${isStreaming ? 'opacity-0' : 'opacity-100'}`}>
              <img src="/logo.svg" alt="qu.je" className="w-6 h-6" />
              <h1 className="text-lg font-semibold text-white/90 tracking-tight">
                qu.je
              </h1>
            </div>
            {/* Animated octahedrons — shown during streaming */}
            <div className={`absolute inset-0 flex items-center transition-opacity duration-300 ${isStreaming ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
              <OctahedronLogo isActive={isStreaming} />
            </div>
          </div>
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
        {/* View switcher */}
        <div className="flex gap-1 mt-2">
          <button
            onClick={() => onSwitchView('chats')}
            className={`flex-1 px-3 py-1.5 text-xs rounded-lg transition-colors ${activeView === 'chats' ? 'bg-white/10 text-white/80' : 'text-white/40 hover:text-white/60'}`}
          >
            Chats
          </button>
          <button
            onClick={() => onSwitchView('notebooks')}
            className={`flex-1 px-3 py-1.5 text-xs rounded-lg transition-colors relative ${activeView === 'notebooks' ? 'bg-white/10 text-white/80' : 'text-white/40 hover:text-white/60'}`}
          >
            Notebooks
            {hasUnreadNotebooks && activeView !== 'notebooks' && (
              <span className="absolute top-1 right-2 w-2 h-2 rounded-full bg-purple-400" />
            )}
          </button>
        </div>
      </div>

      {/* Chat Sections — flex column, each section grows when expanded */}
      <div className="flex-1 flex flex-col min-h-0">
        {/* Projects Section */}
        {projects.length > 0 && (
          <div className={`flex flex-col min-h-0 border-b border-white/5 ${projectsExpanded ? "flex-1" : "shrink-0"}`}>
            <div className="px-3 pt-3 pb-1 shrink-0">
              <div className="flex items-center justify-between mb-1.5">
                <button
                  onClick={() => setProjectsExpanded(!projectsExpanded)}
                  className="flex items-center gap-1.5 px-1 group cursor-pointer"
                >
                  <span className="text-white/30 group-hover:text-white/50 transition-colors">
                    <ChevronIcon expanded={projectsExpanded} />
                  </span>
                  <span className="text-[10px] font-semibold tracking-wider uppercase text-white/30 group-hover:text-white/50 transition-colors">
                    Projects
                  </span>
                  {!projectsExpanded && projects.length > 0 && (
                    <span className="text-[10px] text-white/20 ml-1">{projects.length}</span>
                  )}
                </button>
                {projectsExpanded && (
                  <button
                    onClick={onNewProject}
                    className="text-white/30 hover:text-white/60 transition-colors p-1 rounded-lg hover:bg-white/5"
                    title="New project"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 5v14" />
                      <path d="M5 12h14" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
            {projectsExpanded && (
              <div className="flex-1 overflow-y-auto pb-1">
                <div className="space-y-1 pl-3 pr-2">
                  {projects.map((project) => (
                    <ProjectSection
                      key={project.id}
                      project={project}
                      chats={chatsByProject[project.id] || []}
                      expanded={getProjectExpanded(project.id)}
                      onToggleExpanded={() => setProjectExpanded(project.id, !getProjectExpanded(project.id))}
                      activeChatId={activeChatId}
                      onSelectChat={(id) => { onSelectChat(id); onClose(); }}
                      onNewChat={onNewChat}
                      onDeleteChat={onDeleteChat}
                      onDeleteProject={onDeleteProject}
                      onSendToNotebook={onSendToNotebook}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* New Project button when no projects exist */}
        {projects.length === 0 && (
          <div className="px-3 pt-3 pb-1 shrink-0 border-b border-white/5">
            <button
              onClick={onNewProject}
              className="w-full px-3 py-2 rounded-xl bg-emerald-500/15 border border-emerald-400/25 text-emerald-300 text-sm font-medium hover:bg-emerald-500/25 transition-all flex items-center justify-center gap-2"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14" />
                <path d="M5 12h14" />
              </svg>
              New Project
            </button>
          </div>
        )}

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
            <div className="flex-1 overflow-y-auto pb-1">
              <div className="space-y-0.5 pl-3 pr-2">
                {agentChats.map((chat) => (
                  <ChatListItem
                    key={chat.id}
                    chat={chat}
                    active={chat.id === activeChatId}
                    onSelect={() => { onSelectChat(chat.id); onClose(); }}
                    onDelete={() => onDeleteChat(chat.id)}
                    onSendToNotebook={onSendToNotebook}
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
            <div className="flex-1 overflow-y-auto pb-2">
              <div className="space-y-0.5 pl-3 pr-2">
                {quickChats.map((chat) => (
                  <ChatListItem
                    key={chat.id}
                    chat={chat}
                    active={chat.id === activeChatId}
                    onSelect={() => { onSelectChat(chat.id); onClose(); }}
                    onDelete={() => onDeleteChat(chat.id)}
                    onSendToNotebook={onSendToNotebook}
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

      {/* Image Sandbox */}
      <div className="px-3 pb-3 shrink-0">
        <button
          onClick={() => { onOpenImageSandbox(); onClose(); }}
          className="w-full px-3 py-2 rounded-xl bg-amber-500/15 border border-amber-400/25 text-amber-300 text-sm font-medium hover:bg-amber-500/25 transition-all flex items-center justify-center gap-2"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
            <circle cx="9" cy="9" r="2" />
            <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
          </svg>
          Image Sandbox
        </button>
      </div>
      {/* Spacer for TTS bar */}
      {ttsBarVisible && <div className="h-[56px] shrink-0" />}
      </div>
    </div>
  );
}
