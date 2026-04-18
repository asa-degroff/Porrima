import { useMemo, useState, useEffect, useRef } from "react";
import type { ChatListItem as ChatListItemType, ChatType, Project } from "../types";
import { ChatListItem } from "./ChatListItem";
import { PolyhedronLogo } from "./PolyhedronLogo";
import { useActivityShape } from "../hooks/useActivityStyle";
import { BlueskySection } from "./BlueskySection";
import { useSidebarState } from "../hooks/useSidebarState";
import { useGestureDrawer } from "../hooks/useGestureDrawer";
import { SidebarSearch, SearchResults } from "./SidebarSearch";
import { searchConversations } from "../api/client";
import type { ConversationSearchResult } from "../types";

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
  onOpen: () => void;
  isStreaming?: boolean;
  hasUnreadNotebooks?: boolean;
  ttsBarVisible?: boolean;
  blueskyChatId?: string;
  hasBackgroundActivity?: boolean;
  lastActiveChatId?: string | null;
  isSynthesizing?: boolean;
  synthesisComplete?: boolean;
  sleepModeActive?: boolean;
  onSynthesisSleep?: () => void;
  onSynthesisRun?: () => void;
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

function RecentChatItem({
  chat,
  active,
  onSelect,
  color = "purple",
}: {
  chat: ChatListItemType;
  active: boolean;
  onSelect: () => void;
  color?: "purple" | "blue" | "emerald" | "amber" | "rose" | "cyan" | "violet" | "orange" | "pink" | "teal";
}) {
  const colorClasses: Record<string, string> = {
    purple: "text-purple-300/60 border-purple-400/20",
    blue: "text-blue-300/60 border-blue-400/20",
    emerald: "text-emerald-300/60 border-emerald-400/20",
    amber: "text-amber-300/60 border-amber-400/20",
    rose: "text-rose-300/60 border-rose-400/20",
    cyan: "text-cyan-300/60 border-cyan-400/20",
    violet: "text-violet-300/60 border-violet-400/20",
    orange: "text-orange-300/60 border-orange-400/20",
    pink: "text-pink-300/60 border-pink-400/20",
    teal: "text-teal-300/60 border-teal-400/20",
  };
  
  const colorClass = colorClasses[color] || colorClasses.purple;
  
  return (
    <button
      onClick={onSelect}
      className={`w-full text-left px-2.5 py-1.5 rounded-xl transition-all group relative ${
        active
          ? "bg-white/15 border border-white/20"
          : `hover:bg-white/8 border ${colorClass.split(" ")[1]}`
      }`}
    >
      <div className="flex items-start gap-2 min-w-0">
        <span className={`text-[10px] shrink-0 mt-0.5 ${colorClass.split(" ")[0]}`}>●</span>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-white/80 leading-snug line-clamp-2">
            {chat.title}
          </p>
        </div>
      </div>
    </button>
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
  onEditProject,
  editMode,
  onSendToNotebook,
  lastActiveChatId,
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
  onEditProject: (project: Project) => void;
  editMode: boolean;
  onSendToNotebook?: (chatId: string, chatTitle: string) => void;
  lastActiveChatId?: string | null;
}) {
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(project.name);
  const nameInputRef = useRef<HTMLInputElement>(null);

  // Focus name input when editing starts
  useEffect(() => {
    if (editingName && nameInputRef.current) {
      nameInputRef.current.focus();
      nameInputRef.current.select();
    }
  }, [editingName]);

  // Color mapping for Tailwind classes
  // Note: All color classes must be fully written out for Tailwind v4 to detect them
  const colorClasses: Record<string, { icon: string; bg: string; border: string; text: string; hover: string }> = {
    emerald: { icon: "text-emerald-400/50", bg: "bg-emerald-500/15", border: "border-emerald-400/25", text: "text-emerald-300", hover: "hover:bg-emerald-500/25" },
    purple: { icon: "text-purple-400/50", bg: "bg-purple-500/15", border: "border-purple-400/25", text: "text-purple-300", hover: "hover:bg-purple-500/25" },
    blue: { icon: "text-blue-400/50", bg: "bg-blue-500/15", border: "border-blue-400/25", text: "text-blue-300", hover: "hover:bg-blue-500/25" },
    amber: { icon: "text-amber-400/50", bg: "bg-amber-500/15", border: "border-amber-400/25", text: "text-amber-300", hover: "hover:bg-amber-500/25" },
    rose: { icon: "text-rose-400/50", bg: "bg-rose-500/15", border: "border-rose-400/25", text: "text-rose-300", hover: "hover:bg-rose-500/25" },
    cyan: { icon: "text-cyan-400/50", bg: "bg-cyan-500/15", border: "border-cyan-400/25", text: "text-cyan-300", hover: "hover:bg-cyan-500/25" },
    violet: { icon: "text-violet-400/50", bg: "bg-violet-500/15", border: "border-violet-400/25", text: "text-violet-300", hover: "hover:bg-violet-500/25" },
    orange: { icon: "text-orange-400/50", bg: "bg-orange-500/15", border: "border-orange-400/25", text: "text-orange-300", hover: "hover:bg-orange-500/25" },
    pink: { icon: "text-pink-400/50", bg: "bg-pink-500/15", border: "border-pink-400/25", text: "text-pink-300", hover: "hover:bg-pink-500/25" },
    teal: { icon: "text-teal-400/50", bg: "bg-teal-500/15", border: "border-teal-400/25", text: "text-teal-300", hover: "hover:bg-teal-500/25" },
  };

  const colors = colorClasses[project.color] || colorClasses.emerald;

  const handlePinToggle = async () => {
    await onEditProject({ ...project, pinned: !project.pinned });
  };

  const handleColorChange = async (newColor: string) => {
    await onEditProject({ ...project, color: newColor });
    setShowColorPicker(false);
  };

  const handleDelete = async () => {
    await onDeleteProject(project.id);
    setConfirmDelete(false);
  };

  const handleNameSubmit = async () => {
    if (nameInput.trim() && nameInput.trim() !== project.name) {
      await onEditProject({ ...project, name: nameInput.trim() });
    } else {
      setNameInput(project.name);
    }
    setEditingName(false);
  };

  const handleNameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleNameSubmit();
    } else if (e.key === 'Escape') {
      setNameInput(project.name);
      setEditingName(false);
    }
  };

  // Reset name input when project changes
  useEffect(() => {
    setNameInput(project.name);
  }, [project.name]);

  return (
    <div className="rounded-lg bg-white/[0.03] border border-white/[0.06]">
      <div className="flex items-center gap-1.5 px-2 py-1.5 group">
        <button
          onClick={onToggleExpanded}
          disabled={editMode}
          className="flex items-center gap-1.5 flex-1 min-w-0 cursor-pointer disabled:cursor-default"
        >
          <span className={colors.icon}>
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
            </svg>
          </span>
          {editingName ? (
            <input
              ref={nameInputRef}
              type="text"
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              onBlur={handleNameSubmit}
              onKeyDown={handleNameKeyDown}
              className="flex-1 min-w-0 bg-white/10 border border-white/20 rounded px-2 py-0.5 text-xs text-white/80 outline-none focus:border-white/40"
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span className="text-xs font-medium text-white/70 truncate">{project.name}</span>
          )}
          {project.pinned && (
            <span className="text-amber-400/50 shrink-0 ml-1" title="Pinned">
              <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="17" x2="12" y2="22"></line>
                <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"></path>
              </svg>
            </span>
          )}
          <span className="text-white/20 ml-auto shrink-0">
            <ChevronIcon expanded={expanded} />
          </span>
        </button>
      </div>
      
      {editMode && (
        <div className="px-2 pb-2 pt-1 border-t border-white/5 mt-1">
          <div className="flex items-center gap-1">
            {/* Pin button */}
            <button
              onClick={handlePinToggle}
              className={`p-2 rounded-lg transition-colors ${
                project.pinned 
                  ? 'text-amber-400 hover:text-amber-300' 
                  : 'text-white/40 hover:text-white/60'
              }`}
              title={project.pinned ? "Unpin project" : "Pin project"}
            >
              {project.pinned ? (
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="17" x2="12" y2="22"></line>
                  <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"></path>
                  <line x1="3" y1="3" x2="21" y2="21"></line>
                </svg>
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="17" x2="12" y2="22"></line>
                  <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"></path>
                </svg>
              )}
            </button>
            {/* Color picker button */}
            <button
              onClick={() => setShowColorPicker(!showColorPicker)}
              className="p-2 text-white/40 hover:text-white/60 transition-colors rounded-lg"
              title="Change color"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={colors.text}>
                <circle cx="12" cy="12" r="10"/>
                <circle cx="12" cy="12" r="4"/>
              </svg>
            </button>
            {/* Rename button */}
            <button
              onClick={() => setEditingName(true)}
              className="p-2 text-white/40 hover:text-white/60 transition-colors rounded-lg"
              title="Rename project"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-[18px] h-[18px]">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
            </button>
            {/* Delete button */}
            {confirmDelete ? (
              <div className="flex items-center gap-1 ml-auto">
                <button
                  onClick={handleDelete}
                  className="px-3 py-1.5 rounded-lg bg-red-500/15 border border-red-400/25 text-red-300 hover:bg-red-500/25 text-xs font-medium"
                >
                  Confirm
                </button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="px-3 py-1.5 rounded-lg bg-white/10 border border-white/15 text-white/50 hover:text-white/80 text-xs font-medium"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                className="p-2 text-white/40 hover:text-red-400 transition-colors rounded-lg ml-auto"
                title="Delete project"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 6h18" />
                  <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                  <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                </svg>
              </button>
            )}
          </div>
        </div>
      )}
      
      {/* Color picker dropdown */}
      {showColorPicker && (
        <div className="px-2 pb-2">
          <div className="flex gap-1 flex-wrap">
            {Object.keys(colorClasses).map((color) => (
              <button
                key={color}
                onClick={() => handleColorChange(color)}
                className={`w-5 h-5 rounded-full border-2 transition-all ${
                  colorClasses[color as keyof typeof colorClasses].bg
                } ${
                  colorClasses[color as keyof typeof colorClasses].border
                } ${
                  project.color === color ? 'scale-110' : 'hover:scale-105'
                }`}
                title={color}
              />
            ))}
          </div>
        </div>
      )}
      {/* Recent chat when collapsed */}
      {!expanded && chats.length > 0 && (
        <div className="px-2 pb-2">
          <RecentChatItem
            chat={chats[0]}
            active={chats[0].id === activeChatId}
            onSelect={() => onSelectChat(chats[0].id)}
            color={project.color as any}
          />
        </div>
      )}
      
      {expanded && (
        <div className="px-1 pb-1.5">
          <button
            onClick={() => onNewChat("agent", project.id)}
            className={`w-full px-2 py-1.5 rounded-xl text-sm font-medium border ${colors.bg} ${colors.border} ${colors.text} ${colors.hover} transition-all flex items-center justify-center gap-2 mb-2`}
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
                  lastActive={chat.id === lastActiveChatId}
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
  onOpen,
  isStreaming = false,
  hasUnreadNotebooks = false,
  ttsBarVisible = false,
  blueskyChatId,
  hasBackgroundActivity = false,
  lastActiveChatId = null,
  isSynthesizing = false,
  synthesisComplete = false,
  sleepModeActive = false,
  onSynthesisSleep,
  onSynthesisRun,
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
  const activityShape = useActivityShape();

  const [projectsEditMode, setProjectsEditMode] = useState(false);
  const [previousExpandedStates, setPreviousExpandedStates] = useState<Record<string, boolean>>({});
  const [searchActive, setSearchActive] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<ConversationSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const headerRef = useRef<HTMLDivElement>(null);
  const agentScrollRef = useRef<HTMLDivElement>(null);
  const quickScrollRef = useRef<HTMLDivElement>(null);
  const [agentScrolled, setAgentScrolled] = useState(false);
  const [quickScrolled, setQuickScrolled] = useState(false);

  useEffect(() => {
    if (!agentExpanded) { setAgentScrolled(false); return; }
    const el = agentScrollRef.current;
    if (!el) return;
    const onScroll = () => setAgentScrolled(el.scrollTop > 0);
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [agentExpanded]);

  useEffect(() => {
    if (!quickExpanded) { setQuickScrolled(false); return; }
    const el = quickScrollRef.current;
    if (!el) return;
    const onScroll = () => setQuickScrolled(el.scrollTop > 0);
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [quickExpanded]);

  // Click outside to close search
  useEffect(() => {
    if (!searchActive) return;

    function handleClickOutside(e: MouseEvent) {
      if (headerRef.current && !headerRef.current.contains(e.target as Node)) {
        setSearchActive(false);
        setSearchQuery("");
        setSearchResults([]);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [searchActive]);

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchActive && searchQuery.trim().length >= 2) {
        performSearch();
      } else {
        setSearchResults([]);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [searchActive, searchQuery]);

  async function performSearch() {
    setSearchLoading(true);
    try {
      const r = await searchConversations(searchQuery, undefined, 20);
      setSearchResults(r);
    } catch (e: any) {
      console.error("Search failed:", e);
      setSearchResults([]);
    } finally {
      setSearchLoading(false);
    }
  }

  function handleSelectResult(result: ConversationSearchResult) {
    onSelectChat(result.chatId);
    setSearchActive(false);
    setSearchQuery("");
    setSearchResults([]);
  }

  function handleActivateSearch(e: React.MouseEvent) {
    e.stopPropagation();
    setSearchActive(true);
  }

  const agentChats = useMemo(
    () => chats.filter((c) => (c.type === "agent" || c.type === "bluesky") && !c.projectId && c.id !== blueskyChatId),
    [chats, blueskyChatId]
  );
  const quickChats = useMemo(
    () => chats.filter((c) => c.type === "quick" && !c.projectId),
    [chats]
  );
  const systemChats = useMemo(
    () => chats.filter((c) => c.type === "system" && !c.projectId),
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

  // Gesture drawer hook for mobile slide-over
  const { handlers: gestureHandlers, edgeHandlers, containerRef: gestureRef, style: gestureStyle, openProgress, isDragging, isAnimating } = useGestureDrawer({
    isOpen,
    onClose,
    onOpen,
    direction: "right",
    threshold: 0.4, // 40% of sidebar width to snap
  });

  return (
    <>
      {/* Edge swipe zone — invisible touch target along left edge when sidebar is closed.
           Stays mounted during drag so the touch sequence isn't interrupted. */}
      {!isOpen && !isAnimating && (
        <div
          className="md:hidden fixed inset-y-0 left-0 w-5 z-20"
          onTouchStart={edgeHandlers.onTouchStart}
          onTouchMove={edgeHandlers.onTouchMove}
          onTouchEnd={edgeHandlers.onTouchEnd}
        />
      )}
      {/* Backdrop for mobile — opacity tracks drag progress */}
      {(isOpen || isDragging || isAnimating) && (
        <div
          className={`md:hidden fixed inset-0 bg-black/60 backdrop-blur-xs z-20 ${isDragging || isAnimating ? "" : "transition-opacity"}`}
          style={{ opacity: openProgress * 0.6 }}
          onClick={onClose}
        />
      )}
      {/* Sidebar container — desktop is static, mobile is fixed with gesture support */}
      <div
        className={`w-72 h-full flex flex-col backdrop-blur-xs bg-white/[0.03] border-r border-white/10 fixed inset-y-0 left-0 z-30 md:static md:translate-x-0 md:z-auto ${isDragging || isAnimating ? "" : "transition-transform duration-300 ease-in-out"} ${!isDragging && !isAnimating ? (isOpen ? "translate-x-0 md:translate-x-0" : "-translate-x-full md:translate-x-0") : ""}`}
        ref={gestureRef}
        onTouchStart={gestureHandlers.onTouchStart}
        onTouchMove={gestureHandlers.onTouchMove}
        onTouchEnd={gestureHandlers.onTouchEnd}
        style={gestureStyle}
      >
        {/* Header */}
      <div ref={headerRef} className="px-3 pt-3 pb-0 shrink-0">
        {/* Search or Logo — mutually exclusive, same fixed height */}
        {searchActive ? (
          <div
            className="rounded-full bg-black/20 border border-white/[0.05] px-4 py-2.5 shadow-[inset_0_1px_7px_rgba(0,0,0,0.5)] h-[42px] flex items-center"
            onClick={(e) => e.stopPropagation()}
          >
            <SidebarSearch
              isActive={searchActive}
              query={searchQuery}
              onQueryChange={setSearchQuery}
              onClose={() => { setSearchActive(false); setSearchQuery(""); }}
              onSelectResult={handleSelectResult}
            />
          </div>
        ) : (
          <div
            className="flex items-center justify-between rounded-full bg-black/20 border border-white/[0.05] px-4 py-2.5 shadow-[inset_0_1px_7px_rgba(0,0,0,0.5)] h-[42px] cursor-text"
            onClick={handleActivateSearch}
          >
            <div className="relative flex items-center">
              {/* Static logo + title — hidden during background activity */}
              <div className={`flex items-center gap-2 transition-opacity duration-300 ${hasBackgroundActivity ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}>
                <img src="/logo.svg" alt="qu.je" className="w-6 h-6" />
                <h1 className="text-lg font-semibold text-white/90 tracking-tight">
                  qu.je
                </h1>
              </div>
              {/* Background activity indicator — octahedron for memory extraction, synthesis, creative directions */}
              <div className={`absolute inset-0 flex items-center transition-opacity duration-300 ${hasBackgroundActivity ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
                <PolyhedronLogo isActive={true} shape={activityShape} />
              </div>
            </div>
            <button
              onClick={(e) => { e.stopPropagation(); onOpenSettings(); }}
              className="text-white/40 hover:text-white/70 transition-colors p-1 rounded-lg hover:bg-white/5"
              title="Settings"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </button>
          </div>
        )}

        {/* View switcher — only show when search is not active */}
        {!searchActive && (
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
        )}

        {/* Search results — separate from header, pushes content down */}
        {searchActive && (
          <SearchResults
            results={searchResults}
            loading={searchLoading}
            query={searchQuery}
            onSelectResult={(r) => handleSelectResult(r)}
          />
        )}
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
                  <div className="flex items-center gap-1">
                    {/* Edit mode toggle */}
                    <button
                      onClick={() => {
                        if (!projectsEditMode) {
                          // Save current expanded states before entering edit mode
                          const states: Record<string, boolean> = {};
                          projects.forEach(p => {
                            states[p.id] = getProjectExpanded(p.id);
                          });
                          setPreviousExpandedStates(states);
                          // Collapse all projects when entering edit mode
                          projects.forEach(p => setProjectExpanded(p.id, false));
                        } else {
                          // Restore previous expanded states when exiting edit mode
                          Object.entries(previousExpandedStates).forEach(([id, expanded]) => {
                            setProjectExpanded(id, expanded);
                          });
                        }
                        setProjectsEditMode(!projectsEditMode);
                      }}
                      className={`text-white/30 hover:text-white/60 transition-colors p-1 rounded-lg hover:bg-white/5 ${projectsEditMode ? 'text-white/60 bg-white/10' : ''}`}
                      title={projectsEditMode ? "Done editing" : "Edit projects"}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                      </svg>
                    </button>
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
                  </div>
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
                      onEditProject={async (updatedProject) => {
                        await fetch(`/api/projects/${updatedProject.id}`, {
                          method: "PATCH",
                          credentials: "include",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ 
                            name: updatedProject.name, 
                            color: updatedProject.color, 
                            pinned: updatedProject.pinned 
                          }),
                        });
                        // Trigger a refresh of projects
                        window.dispatchEvent(new CustomEvent("projects:updated"));
                      }}
                      editMode={projectsEditMode}
                      onSendToNotebook={onSendToNotebook}
                      lastActiveChatId={lastActiveChatId}
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
          <div className="px-3 pt-2 pb-0.5 shrink-0 flex items-center">
            <button
              onClick={() => setAgentExpanded(!agentExpanded)}
              className="flex items-center gap-1.5 px-1 mb-1 group cursor-pointer flex-1 min-w-0"
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
            <button
              onClick={() => { onNewChat("agent"); onClose(); }}
              aria-label="New agent chat"
              title="New agent chat"
              aria-hidden={!(agentExpanded && agentScrolled)}
              tabIndex={agentExpanded && agentScrolled ? 0 : -1}
              className={`mb-1 ml-1 w-5 h-5 flex items-center justify-center rounded-md text-purple-300/70 hover:text-purple-200 hover:bg-purple-500/15 transition-opacity cursor-pointer ${agentExpanded && agentScrolled ? "opacity-100" : "opacity-0 pointer-events-none"}`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14" />
                <path d="M5 12h14" />
              </svg>
            </button>
          </div>
          {/* Recent chat when collapsed */}
          {!agentExpanded && agentChats.length > 0 && (
            <div className="px-2 pb-2">
              <RecentChatItem
                chat={agentChats[0]}
                active={agentChats[0].id === activeChatId}
                onSelect={() => { onSelectChat(agentChats[0].id); onClose(); }}
                color="purple"
              />
            </div>
          )}
           {/* Scrollable chat list */}
          {agentExpanded && (
            <div ref={agentScrollRef} className="flex-1 overflow-y-auto overflow-x-hidden pb-1">
              <div className="space-y-0.5 px-3">
                <button
                  onClick={() => { onNewChat("agent"); onClose(); }}
                  className="w-full px-3 py-2 rounded-xl bg-purple-500/15 border border-purple-400/25 text-purple-300 text-sm font-medium hover:bg-purple-500/25 transition-all flex items-center justify-center gap-2 mb-2"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 5v14" />
                    <path d="M5 12h14" />
                  </svg>
                  New Agent Chat
                </button>
                {agentChats.map((chat) => (
                  <ChatListItem
                    key={chat.id}
                    chat={chat}
                    active={chat.id === activeChatId}
                    lastActive={chat.id === lastActiveChatId}
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
          <div className="px-3 pt-2 pb-0.5 shrink-0 flex items-center">
            <button
              onClick={() => setQuickExpanded(!quickExpanded)}
              className="flex items-center gap-1.5 px-1 mb-1 group cursor-pointer flex-1 min-w-0"
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
            <button
              onClick={() => { onNewChat("quick"); onClose(); }}
              aria-label="New quick chat"
              title="New quick chat"
              aria-hidden={!(quickExpanded && quickScrolled)}
              tabIndex={quickExpanded && quickScrolled ? 0 : -1}
              className={`mb-1 ml-1 w-5 h-5 flex items-center justify-center rounded-md text-blue-300/70 hover:text-blue-200 hover:bg-blue-500/15 transition-opacity cursor-pointer ${quickExpanded && quickScrolled ? "opacity-100" : "opacity-0 pointer-events-none"}`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14" />
                <path d="M5 12h14" />
              </svg>
            </button>
          </div>
          {/* Recent chat when collapsed */}
          {!quickExpanded && quickChats.length > 0 && (
            <div className="px-2 pb-2">
              <RecentChatItem
                chat={quickChats[0]}
                active={quickChats[0].id === activeChatId}
                onSelect={() => { onSelectChat(quickChats[0].id); onClose(); }}
                color="blue"
              />
            </div>
          )}
          {/* Scrollable chat list */}
          {quickExpanded && (
            <div ref={quickScrollRef} className="flex-1 overflow-y-auto overflow-x-hidden pb-2">
              <div className="space-y-0.5 px-3">
                <button
                  onClick={() => { onNewChat("quick"); onClose(); }}
                  className="w-full px-3 py-2 rounded-xl bg-blue-500/15 border border-blue-400/25 text-blue-300 text-sm font-medium hover:bg-blue-500/25 transition-all flex items-center justify-center gap-2 mb-2"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 5v14" />
                    <path d="M5 12h14" />
                  </svg>
                  New Quick Chat
                </button>
                {quickChats.map((chat) => (
                  <ChatListItem
                    key={chat.id}
                    chat={chat}
                    active={chat.id === activeChatId}
                    lastActive={chat.id === lastActiveChatId}
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

        {/* Bluesky Section */}
        <BlueskySection onOpenSettings={onOpenSettings} onSelectChat={(id) => { onSelectChat(id); onClose(); }} />
        {/* System Chat Section */}
        {systemChats.length > 0 && (
          <div className="px-3 pb-1 shrink-0 border-b border-white/5">
            <div className="flex items-center gap-1.5 px-1 mb-1 group cursor-pointer">
              <span className="text-amber-400/30 group-hover:text-amber-300/50 transition-colors">
                <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 2a4 4 0 0 1 4 4c0 1.95-2 4-4 8-2-4-4-6.05-4-8a4 4 0 0 1 4-4Z"/>
                  <path d="M10.5 11.5a2.5 2.5 0 0 0 3 0"/>
                </svg>
              </span>
              <span className="text-[10px] font-semibold tracking-wider uppercase text-amber-300/40 group-hover:text-amber-300/60 transition-colors">
                System
              </span>
            </div>
            <div className="px-1 pb-1">
              {systemChats.map((chat) => (
                <button
                  key={chat.id}
                  onClick={() => { onSelectChat(chat.id); onClose(); }}
                  className={`w-full text-left px-2.5 py-1.5 rounded-lg text-xs transition-colors ${
                    chat.id === activeChatId
                      ? 'bg-amber-500/15 text-amber-200 border border-amber-400/20'
                      : 'text-white/50 hover:text-white/70 hover:bg-white/5'
                  }`}
                >
                  <span className="truncate block">{chat.title}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {/* Synthesis Section */}
        <div className="px-3 pb-2 shrink-0">
          <div className="flex items-center gap-2">
            {/* Status indicator */}
            <div className="flex-1 flex items-center gap-2 text-[10px] text-white/30">
              <span className="font-semibold tracking-wider uppercase">Synthesis</span>
              <div className="flex items-center gap-1.5 ml-auto">
                {isSynthesizing ? (
                  <>
                    <PolyhedronLogo isActive={true} shape={activityShape} />
                    <span className="text-amber-300/60">Synthesizing</span>
                  </>
                ) : synthesisComplete ? (
                  <>
                    <span className="text-emerald-400/60">●</span>
                    <span className="text-emerald-300/60">Complete</span>
                  </>
                ) : (
                  <>
                    <span className="text-white/20">●</span>
                    <span className="text-white/20">Idle</span>
                  </>
                )}
              </div>
            </div>
            {/* Actions */}
            <div className="flex items-center gap-1">
              {onSynthesisSleep && !isSynthesizing && (
                <button
                  onClick={onSynthesisSleep}
                  disabled={sleepModeActive}
                  className={`p-1.5 rounded-md transition-all cursor-pointer ${
                    sleepModeActive
                      ? 'text-amber-400/80 bg-amber-500/15 animate-pulse'
                      : 'text-white/30 hover:text-white/60 hover:bg-white/5'
                  }`}
                  title="Sleep Mode — trigger synthesis and skip next periodic cycle"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>
                  </svg>
                </button>
              )}
              {onSynthesisRun && !isSynthesizing && (
                <button
                  onClick={onSynthesisRun}
                  className={`p-1.5 rounded-md transition-all cursor-pointer text-white/30 hover:text-white/60 hover:bg-white/5`}
                  title="Run synthesis now"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
                  </svg>
                </button>
              )}
            </div>
          </div>
        </div>
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
      {/* System Chat */}
        <div className="px-3 pb-3 shrink-0">
          <button
            onClick={() => { onSelectChat("system"); onClose(); }}
            className="w-full px-3 py-2 rounded-xl bg-amber-500/10 border border-amber-400/15 text-amber-200/60 text-sm font-medium hover:bg-amber-500/20 hover:text-amber-200/80 transition-all flex items-center justify-center gap-2"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/>
              <path d="M12 16v-4"/>
              <path d="M12 8h.01"/>
            </svg>
            Synthesis & Reflection
          </button>
        </div>
        {/* Spacer for TTS bar */}
      {ttsBarVisible && <div className="h-[56px] shrink-0" />}
      </div>
    </>
  );
}
