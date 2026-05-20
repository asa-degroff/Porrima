import { useMemo, useState, useEffect, useRef, useCallback } from "react";
import type { ChatListItem as ChatListItemType, ChatType, Project } from "../types";
import type { CacheResidency } from "../api/client";
import { ChatListItem } from "./ChatListItem";
import { ContextMenu, ContextMenuItem, useLongPress } from "./ui/ContextMenu";
import { PolyhedronLogo } from "./PolyhedronLogo";
import { useActivityShape, useActivityHue, useActivitySaturation } from "../hooks/useActivityStyle";
import { BlueskySection } from "./BlueskySection";
import { useSidebarState } from "../hooks/useSidebarState";
import { useGestureDrawer } from "../hooks/useGestureDrawer";
import { SidebarSearch, SearchResults } from "./SidebarSearch";
import { searchConversations } from "../api/client";
import type { ConversationSearchResult } from "../types";
import { PrefillActivityIcon } from "./PrefillActivityIcon";
import { SystemStatsBar } from "./SystemStatsBar";
import type { SystemStatsSample } from "../types";

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
  onWarmCache?: (chatId: string) => void;
  cacheWarmingChatIds?: Set<string>;
  cacheWarmErrors?: Map<string, string>;
  onOpenSettings: () => void;
  onOpenMemoryDebug?: () => void;
  onOpenModelStats?: () => void;
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
  isAutomationRunning?: boolean;
  synthesisComplete?: boolean;
  sleepModeActive?: boolean;
  sleepCycleActive?: boolean;
  isExtractionRunning?: boolean;
  isWakeCycleRunning?: boolean;
  onSynthesisSleep?: () => void;
  onSynthesisRun?: () => void;
  onWakeRun?: () => void;
  isImageSandboxOpen?: boolean;
  cacheResidency?: Map<string, CacheResidency>;
  systemStatsHistory?: SystemStatsSample[];
  systemStatsCurrent?: SystemStatsSample | null;
  systemStatsHiddenGpus?: string[];
  showSystemStats?: boolean;
  agentName?: string;
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

function SectionDepthShadow({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div
      className="pointer-events-none absolute inset-x-0 bottom-px h-5 z-10 bg-gradient-to-t from-black/10 via-black/3 to-transparent"
      style={{
        maskImage: "linear-gradient(to right, transparent, black 8%, black 92%, transparent)",
        WebkitMaskImage: "linear-gradient(to right, transparent, black 8%, black 92%, transparent)",
      }}
      aria-hidden="true"
    />
  );
}

// Dynamic sidebar logo — mirrors the octahedron geometry with user-selected hue/saturation
function SidebarLogo({ size = 24 }: { size?: number }) {
  const hue = useActivityHue()
  const saturation = useActivitySaturation()
  const half = size / 2
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
    >
      {/* Top-left (lightest) */}
      <polygon
        points={`${half},${size * 0.168} ${size * 0.168},${half} ${half},${half}`}
        fill={`hsl(${hue}, ${saturation}%, 74%)`}
      />
      {/* Top-right (light) */}
      <polygon
        points={`${half},${size * 0.168} ${size * 0.832},${half} ${half},${half}`}
        fill={`hsl(${hue}, ${saturation}%, 65%)`}
      />
      {/* Bottom-left (dark) */}
      <polygon
        points={`${size * 0.168},${half} ${half},${size * 0.832} ${half},${half}`}
        fill={`hsl(${hue}, ${saturation}%, 46%)`}
      />
      {/* Bottom-right (darkest) */}
      <polygon
        points={`${size * 0.832},${half} ${half},${size * 0.832} ${half},${half}`}
        fill={`hsl(${hue}, ${saturation}%, 38%)`}
      />
    </svg>
  )
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

function RecentChatItem({
  chat,
  active,
  lastActive,
  cacheResidency,
  onSelect,
  onDelete,
  onSendToNotebook,
  onWarmCache,
  color = "purple",
  cacheWarming = false,
  cacheWarmError,
}: {
  chat: ChatListItemType;
  active: boolean;
  lastActive?: boolean;
  cacheResidency?: CacheResidency | null;
  onSelect: () => void;
  onDelete?: () => void;
  onSendToNotebook?: (chatId: string, chatTitle: string) => void;
  onWarmCache?: (chatId: string) => void;
  color?: "purple" | "blue" | "emerald" | "amber" | "rose" | "cyan" | "violet" | "orange" | "pink" | "teal";
  cacheWarming?: boolean;
  cacheWarmError?: string;
}) {
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
  const cacheTitle = formatCacheResidencyTitle(cacheResidency);
  const effectiveCacheWarming = cacheWarming || cacheResidency?.status === "warming";
  const isQueued = cacheResidency?.queuePosition !== undefined && cacheResidency.queuePosition > 0;
  const effectiveTitle = cacheWarmError ? `Cache warm failed: ${cacheWarmError}` : cacheTitle;

  const hasMenu = onDelete || onSendToNotebook || (onWarmCache && chat.type === "agent");

  return (
    <>
      <button
        onClick={onSelect}
        onContextMenu={hasMenu ? handleContextMenu : undefined}
        {...(hasMenu ? longPressProps : {})}
        className={`w-full text-left px-2.5 py-1.5 rounded-xl transition-all group relative border ${
          active
            ? "bg-white/15 border-white/20" + (cacheResidency && lastActive
                ? " shadow-[0_0_8px_rgba(168,85,247,0.15)]"
                : cacheResidency
                  ? " shadow-[0_0_8px_rgba(251,191,36,0.10)]"
                  : "")
            : cacheResidency && lastActive
              ? "hover:bg-white/8 border-purple-400/30 shadow-[0_0_8px_rgba(168,85,247,0.15)]"
              : cacheResidency
                ? "hover:bg-white/8 border-amber-400/25 shadow-[0_0_8px_rgba(251,191,36,0.10)]"
                : `hover:bg-white/8 ${colorClass.split(" ")[1]}`
        }`}
        title={effectiveTitle}
      >
        {/* Vignette overlay — darkens edges for a brighter-center active highlight effect */}
        {active && (
          <div
            className="absolute inset-0 rounded-xl pointer-events-none shadow-[inset_0_3px_8px_-4px_rgba(0,0,0,0.25),inset_0_-3px_8px_-4px_rgba(0,0,0,0.2)]"
            aria-hidden="true"
          />
        )}
        <div className="flex items-start gap-2 min-w-0">
          <span className={`text-[10px] shrink-0 mt-0.5 ${colorClass.split(" ")[0]}`}>●</span>
          <div className="flex-1 min-w-0 pr-5">
            <p className="text-xs font-medium text-white/80 leading-snug line-clamp-2">
              {chat.title}
            </p>
          </div>
        </div>
        {(effectiveCacheWarming || isQueued) && (
          <div className="absolute right-2 top-1/2 -translate-y-1/2" title={isQueued ? "Cache warming queued" : "Warming cache"}>
            <PrefillActivityIcon paused={isQueued} />
          </div>
        )}
        {cacheWarmError && !effectiveCacheWarming && !isQueued && (
          <div className="absolute right-2 top-1/2 -translate-y-1/2 text-red-300/80" title={`Cache warm failed: ${cacheWarmError}`}>
            <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 8v5" />
              <path d="M12 17h.01" />
            </svg>
          </div>
        )}
      </button>
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
            <ContextMenuItem onClick={() => { setContextMenu(null); onWarmCache(chat.id); }} disabled={effectiveCacheWarming}>
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={effectiveCacheWarming ? "animate-pulse" : "opacity-70"} style={{ color: `rgba(var(--theme-accent), ${effectiveCacheWarming ? 0.9 : 0.7})` }}>
                <path d="M8 18c-2.2 0-4 1.8-4 4" />
                <path d="M16 18c2.2 0 4 1.8 4 4" />
                <path d="M7 4c0 0 1 1.3 1 3s-1 3-1 3" />
                <path d="M12 4c0 0 1 1.3 1 3s-1 3-1 3" />
                <path d="M17 4c0 0 1 1.3 1 3s-1 3-1 3" />
                <path d="M5 18h14" />
              </svg>
              {effectiveCacheWarming ? "Warming..." : "Warm Cache"}
            </ContextMenuItem>
          )}
          {onDelete && (
            <ContextMenuItem destructive onClick={() => { setContextMenu(null); onDelete(); }}>
              <svg className="trash-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ overflow: 'visible' }}>
                <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
                <g className="trash-lid">
                  <path d="M3 6h18" />
                  <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
                </g>
              </svg>
              Delete
            </ContextMenuItem>
          )}
        </ContextMenu>
      )}
    </>
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
  onSendToNotebook,
  onWarmCache,
  cacheWarmingChatIds,
  cacheWarmErrors,
  lastActiveChatId,
  cacheResidency,
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
  onSendToNotebook?: (chatId: string, chatTitle: string) => void;
  onWarmCache?: (chatId: string) => void;
  cacheWarmingChatIds?: Set<string>;
  cacheWarmErrors?: Map<string, string>;
  lastActiveChatId?: string | null;
  cacheResidency?: Map<string, CacheResidency>;
}) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(project.name);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const handleHeaderContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const openHeaderContextMenu = useCallback((pos: { x: number; y: number }) => {
    setContextMenu(pos);
  }, []);
  const longPressProps = useLongPress(openHeaderContextMenu);

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
    setContextMenu(null);
  };

  const handleColorChange = async (newColor: string) => {
    await onEditProject({ ...project, color: newColor });
    setContextMenu(null);
  };

  const handleDelete = async () => {
    await onDeleteProject(project.id);
    setConfirmDelete(false);
    setContextMenu(null);
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
      <div
        className="flex items-center gap-1.5 px-2 py-1.5 group"
        onContextMenu={handleHeaderContextMenu}
        {...longPressProps}
      >
        <button
          onClick={onToggleExpanded}
          className="flex items-center gap-1.5 flex-1 min-w-0 cursor-pointer"
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
      {/* Project context menu */}
      {contextMenu && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={() => setContextMenu(null)}>
          <ContextMenuItem onClick={handlePinToggle}>
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="17" x2="12" y2="22" />
              <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
            </svg>
            {project.pinned ? "Unpin" : "Pin"}
          </ContextMenuItem>
          <ContextMenuItem onClick={() => { setContextMenu(null); setEditingName(true); }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-[14px] h-[14px]">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
            </svg>
            Rename
          </ContextMenuItem>
          {/* Color sub-section */}
          <div className="px-4 py-1.5 border-t border-white/5">
            <div className="flex gap-1.5 flex-wrap">
              {Object.keys(colorClasses).map((color) => (
                <button
                  key={color}
                  onClick={() => handleColorChange(color)}
                  className={`w-4 h-4 rounded-full border transition-all ${
                    colorClasses[color as keyof typeof colorClasses].bg
                  } ${
                    colorClasses[color as keyof typeof colorClasses].border
                  } ${
                    project.color === color ? 'ring-1 ring-white/50 scale-110' : 'hover:scale-105'
                  }`}
                  title={color}
                />
              ))}
            </div>
          </div>
          <ContextMenuItem destructive onClick={() => { setContextMenu(null); setConfirmDelete(true); }}>
            <svg className="trash-icon" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ overflow: 'visible' }}>
              <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
              <g className="trash-lid">
                <path d="M3 6h18" />
                <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
              </g>
            </svg>
            Delete
          </ContextMenuItem>
        </ContextMenu>
      )}
      {/* Delete confirmation overlay */}
      {confirmDelete && (
        <div className="px-2 pb-2">
          <div className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg bg-red-500/10 border border-red-400/20">
            <p className="text-xs text-white/70">Delete project?</p>
            <div className="flex gap-1.5 shrink-0">
              <button
                onClick={handleDelete}
                className="px-2 py-1 rounded-md text-xs font-medium bg-red-500/20 border border-red-400/30 text-red-300 hover:bg-red-500/30 transition-all"
              >
                Delete
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="px-2 py-1 rounded-md text-xs font-medium bg-white/10 border border-white/15 text-white/50 hover:text-white/80 transition-all"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Recent chat when collapsed */}
      {!expanded && chats.length > 0 && (
        <div className="px-2 pb-2">
          <RecentChatItem
            chat={chats[0]}
            active={chats[0].id === activeChatId}
            lastActive={chats[0].id === lastActiveChatId}
            cacheResidency={cacheResidency?.get(chats[0].id) ?? null}
            cacheWarming={cacheWarmingChatIds?.has(chats[0].id) ?? false}
            cacheWarmError={cacheWarmErrors?.get(chats[0].id)}
            onSelect={() => onSelectChat(chats[0].id)}
            onDelete={() => onDeleteChat(chats[0].id)}
            onSendToNotebook={onSendToNotebook}
            onWarmCache={onWarmCache}
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
                  cacheResidency={cacheResidency?.get(chat.id) ?? null}
                  onSelect={() => onSelectChat(chat.id)}
                  onDelete={() => onDeleteChat(chat.id)}
                  onSendToNotebook={onSendToNotebook}
                  onWarmCache={onWarmCache}
                  cacheWarming={cacheWarmingChatIds?.has(chat.id) ?? false}
                  cacheWarmError={cacheWarmErrors?.get(chat.id)}
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
  onWarmCache,
  cacheWarmingChatIds = new Set(),
  cacheWarmErrors = new Map(),
  onOpenSettings,
  onOpenMemoryDebug,
  onOpenModelStats,
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
  isAutomationRunning = false,
  synthesisComplete = false,
  sleepModeActive = false,
  sleepCycleActive = false,
  isExtractionRunning = false,
  isWakeCycleRunning = false,
  onSynthesisSleep,
  onSynthesisRun,
  onWakeRun,
  isImageSandboxOpen = false,
  cacheResidency = new Map(),
  systemStatsHistory = [],
  systemStatsCurrent,
  systemStatsHiddenGpus,
  showSystemStats = false,
  agentName = "Porrima",
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
  const effectiveSleepCycleActive = sleepCycleActive && !isStreaming;
  const sidebarActivityActive = hasBackgroundActivity || isExtractionRunning || isSynthesizing || isAutomationRunning;

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
          className={`md:hidden fixed inset-0 bg-black/60 z-20 ${isDragging || isAnimating ? "" : "transition-opacity"}`}
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
      <div ref={headerRef} className="px-3 pt-2 pb-0 shrink-0">
        {/* Search or Logo */}
        <div className="flex items-center gap-1">
          {searchActive ? (
            <div
              className="flex-1 min-w-0 rounded-full bg-black/20 border border-white/[0.05] px-4 py-2.5 shadow-[inset_0_1px_7px_rgba(0,0,0,0.5)] h-[42px] flex items-center"
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
              className="flex-1 min-w-0 flex items-center justify-start rounded-full bg-black/20 border border-white/[0.05] px-4 py-2.5 shadow-[inset_0_1px_7px_rgba(0,0,0,0.5)] h-[42px] cursor-text"
              onClick={handleActivateSearch}
            >
              <div className="relative flex items-center">
                {/* Static logo + title — hidden during background activity, extraction, or synthesis */}
                <div className={`flex items-center gap-2 transition-opacity duration-300 ${sidebarActivityActive ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}>
                  <SidebarLogo size={24} />
                  <h1 className="text-lg font-semibold text-white/90 tracking-tight">
                    {agentName}
                  </h1>
                </div>
                {/* Background activity indicator — octahedron for memory extraction, synthesis, creative directions */}
                <div className={`absolute inset-0 flex items-center transition-opacity duration-300 ${sidebarActivityActive ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
                  <PolyhedronLogo isActive={sidebarActivityActive} shape={activityShape} />
                </div>
              </div>
            </div>
          )}
        </div>

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
        {/* Synthesis status & action buttons row */}
        <div className="px-3 pt-2 pb-2 shrink-0">
          <div className="flex items-center gap-1.5">
            {/* Status indicator */}
            <div className="flex items-center gap-1.5 text-[10px] text-white/30 pl-1">
              {isSynthesizing ? (
                <>
                  <span className="text-amber-400/60">●</span>
                  <span className="text-amber-300/60">Synthesizing</span>
                </>
              ) : isWakeCycleRunning ? (
                <>
                  <span className="text-violet-400/60">●</span>
                  <span className="text-violet-300/60">Waking</span>
                </>
              ) : isAutomationRunning ? (
                <>
                  <span className="text-violet-400/60">●</span>
                  <span className="text-violet-300/60">Automating</span>
                </>
              ) : synthesisComplete ? (
                <>
                  <span className="text-emerald-400/60">●</span>
                  <span className="text-emerald-300/60">Complete</span>
                </>
              ) : isStreaming ? (
                <>
                  <span className="text-sky-400/60">●</span>
                  <span className="text-sky-300/60">Active</span>
                </>
              ) : effectiveSleepCycleActive ? (
                <>
                  <span className="text-indigo-400/60">●</span>
                  <span className="text-indigo-300/60">Sleeping</span>
                </>
              ) : (
                <>
                  <span className="text-white/20">●</span>
                  <span className="text-white/20">Idle</span>
                </>
              )}
            </div>
            {/* Spacer */}
            <div className="flex-1" />
            {/* Action buttons */}
            <div className="flex items-center gap-1">
              {onSynthesisSleep && !isSynthesizing && !isWakeCycleRunning && (
                <button
                  onClick={onSynthesisSleep}
                  disabled={sleepModeActive || effectiveSleepCycleActive || isStreaming}
                  className={`p-2 rounded-lg transition-all cursor-pointer ${
                    effectiveSleepCycleActive
                      ? 'text-indigo-400/80 bg-indigo-500/15 animate-pulse'
                      : sleepModeActive
                        ? 'text-amber-400/80 bg-amber-500/15 animate-pulse'
                        : 'text-white/30 hover:text-white/60 hover:bg-white/5'
                  }`}
                  title={isStreaming
                    ? "Chat active — release is available after the response completes"
                    : effectiveSleepCycleActive
                    ? "Sleep cycle active — autonomous mode running"
                    : "Release — let the system take over with autonomous synthesis and wake cycles"}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>
                  </svg>
                </button>
              )}
              {onSynthesisRun && !isSynthesizing && (
                <button
                  onClick={onSynthesisRun}
                  className={`p-2 rounded-lg transition-all cursor-pointer text-white/30 hover:text-white/60 hover:bg-white/5`}
                  title="Run synthesis now"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
                  </svg>
                </button>
              )}
              {/* Memory — unified memory system interface */}
              {onOpenMemoryDebug && (
                <button
                  onClick={onOpenMemoryDebug}
                  className="group p-2 text-white hover:bg-white/5 rounded-lg transition-colors shrink-0"
                  title="Memory"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="opacity-30 group-hover:opacity-60 transition-opacity">
                    <ellipse cx="12" cy="5" rx="9" ry="3"/>
                    <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
                    <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
                  </svg>
                </button>
              )}
              {/* Model stats — llama.cpp performance and cache metrics */}
              {onOpenModelStats && (
                <button
                  onClick={onOpenModelStats}
                  className="p-2 text-white/30 hover:text-white/60 hover:bg-white/5 rounded-lg transition-colors shrink-0"
                  title="Model Stats & Cache"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 20V10"/>
                    <path d="M12 20V4"/>
                    <path d="M6 20v-6"/>
                  </svg>
                </button>
              )}
              {/* Settings */}
              <button
                onClick={() => onOpenSettings()}
                className="p-2 text-white/30 hover:text-white/60 hover:bg-white/5 rounded-lg transition-colors shrink-0"
                title="Settings"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              </button>
            </div>
          </div>
        </div>

        {/* System Stats */}
        {showSystemStats && systemStatsHistory.length > 0 && (
          <div className="border-b border-white/5">
            <SystemStatsBar history={systemStatsHistory} current={systemStatsCurrent} hiddenGpus={systemStatsHiddenGpus} />
          </div>
        )}

        {/* System Chat Section */}
        {systemChats.length > 0 && (
          <div className="px-3 py-1 shrink-0 border-b border-white/5">
            <div className="px-1">
              {systemChats.map((chat) => {
                const isLastActive = chat.id === lastActiveChatId;
                const cr = cacheResidency.get(chat.id);
                const isWarming = cacheWarmingChatIds.has(chat.id) || cr?.status === "warming";
                const isQueued = cr?.queuePosition !== undefined && cr.queuePosition > 0;
                const warmError = cacheWarmErrors?.get(chat.id);
                return (
                  <button
                    key={chat.id}
                    onClick={() => { onSelectChat(chat.id); onClose(); }}
                    className={`w-full text-left px-2.5 py-1.75 rounded-xl text-xs transition-all relative border group flex items-center gap-1.5 ${
                      chat.id === activeChatId                        ? 'bg-[rgba(var(--theme-accent-muted))] text-[rgba(var(--theme-accent-text))] border-[rgba(var(--theme-accent-border))]'
                        : isLastActive
                          ? 'text-white/50 hover:text-white/70 hover:bg-white/5 border-[rgba(var(--theme-accent),0.25)] shadow-[0_0_8px_rgba(var(--theme-accent),0.12)]'
                          : 'text-white/50 hover:text-white/70 hover:bg-white/5 border-[rgba(var(--theme-accent),0.1)]'
                    }`}
                    title={warmError ? `Cache warm failed: ${warmError}` : undefined}
                  >
                    <span className="flex-1 truncate">{chat.title}</span>

                    {/* Warming animation (active or queued) */}
                    {(isWarming || isQueued) && (
                      <div className="shrink-0 pointer-events-none" title={isQueued ? "Cache warming queued" : "Warming cache"}>
                        <PrefillActivityIcon paused={isQueued} />
                      </div>
                    )}

                    {/* Error indicator */}
                    {warmError && !isWarming && !isQueued && (
                      <div className="shrink-0 text-red-300/80" title={`Cache warm failed: ${warmError}`}>
                        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round">
                          <circle cx="12" cy="12" r="10" />
                          <path d="M12 8v5" />
                          <path d="M12 17h.01" />
                        </svg>
                      </div>
                    )}

                    {/* Hover warm action — desktop only */}
                    {!isWarming && !isQueued && (
                      <div
                        onClick={(e) => {
                          e.stopPropagation();
                          onWarmCache?.(chat.id);
                        }}
                        title="Warm cache"
                        className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <div className="transition-colors p-0.5 text-white/30 hover:text-[rgba(var(--theme-accent),0.8)]">
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
                        </div>
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Projects Section */}
        {projects.length > 0 && (
          <div className={`relative flex flex-col min-h-0 border-b border-white/5 ${projectsExpanded ? "flex-1" : "shrink-0"}`}>
            <div className="px-3 pt-2 pb-0.5 shrink-0 flex items-center justify-between">
              <button
                onClick={() => setProjectsExpanded(!projectsExpanded)}
                className="flex items-center gap-1.5 px-1 mb-1 group cursor-pointer flex-1 min-w-0"
              >
                <span className="text-white/30 group-hover:text-white/50 transition-colors">
                  <ChevronIcon expanded={projectsExpanded} />
                </span>
                <span className="text-[10px] font-semibold tracking-wider uppercase text-white/30 group-hover:text-white/50 transition-colors">
                  Projects
                </span>
                {!projectsExpanded && projects.length > 0 && (
                  <span className="text-[10px] text-white/20 ml-auto">{projects.length}</span>
                )}
              </button>
            {/* New project button always shown when expanded */}
              {projectsExpanded && (
                <button
                  onClick={onNewProject}
                  className="mb-1 text-white hover:text-white transition-colors p-1 rounded-lg hover:bg-white/5"
                  title="New project"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="opacity-30 hover:opacity-60 transition-opacity">
                    <path d="M12 5v14" />
                    <path d="M5 12h14" />
                  </svg>
                </button>
              )}
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
                      onSendToNotebook={onSendToNotebook}
                      onWarmCache={onWarmCache}
                      cacheWarmingChatIds={cacheWarmingChatIds}
                      cacheWarmErrors={cacheWarmErrors}
                      lastActiveChatId={lastActiveChatId}
                      cacheResidency={cacheResidency}
                    />
                  ))}
                </div>
              </div>
            )}
            <SectionDepthShadow visible={projectsExpanded} />
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
        <div className={`relative flex flex-col min-h-0 border-b border-white/5 ${agentExpanded ? "flex-1" : "shrink-0"}`}>
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
                Global Chats
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
                lastActive={agentChats[0].id === lastActiveChatId}
                cacheResidency={cacheResidency.get(agentChats[0].id) ?? null}
                cacheWarming={cacheWarmingChatIds.has(agentChats[0].id)}
                cacheWarmError={cacheWarmErrors.get(agentChats[0].id)}
                onSelect={() => { onSelectChat(agentChats[0].id); onClose(); }}
                onDelete={() => onDeleteChat(agentChats[0].id)}
                onSendToNotebook={onSendToNotebook}
                onWarmCache={onWarmCache}
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
                    cacheResidency={cacheResidency.get(chat.id) ?? null}
                    onSelect={() => { onSelectChat(chat.id); onClose(); }}
                    onDelete={() => onDeleteChat(chat.id)}
                    onSendToNotebook={onSendToNotebook}
                    onWarmCache={onWarmCache}
                    cacheWarming={cacheWarmingChatIds.has(chat.id)}
                    cacheWarmError={cacheWarmErrors.get(chat.id)}
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
          <SectionDepthShadow visible={agentExpanded} />
        </div>

        {/* Quick Chats Section */}
        <div className={`relative flex flex-col min-h-0 border-b border-white/5 ${quickExpanded ? "flex-1" : "shrink-0"}`}>
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
                lastActive={quickChats[0].id === lastActiveChatId}
                cacheResidency={cacheResidency.get(quickChats[0].id) ?? null}
                cacheWarming={cacheWarmingChatIds.has(quickChats[0].id)}
                cacheWarmError={cacheWarmErrors.get(quickChats[0].id)}
                onSelect={() => { onSelectChat(quickChats[0].id); onClose(); }}
                onDelete={() => onDeleteChat(quickChats[0].id)}
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
                    cacheResidency={cacheResidency.get(chat.id) ?? null}
                    onSelect={() => { onSelectChat(chat.id); onClose(); }}
                    onDelete={() => onDeleteChat(chat.id)}
                    onSendToNotebook={onSendToNotebook}
                    onWarmCache={onWarmCache}
                    cacheWarming={cacheWarmingChatIds.has(chat.id)}
                    cacheWarmError={cacheWarmErrors.get(chat.id)}
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
          <SectionDepthShadow visible={quickExpanded} />
        </div>

        {/* Bluesky Section */}
        <BlueskySection onOpenSettings={onOpenSettings} onSelectChat={(id) => { onSelectChat(id); onClose(); }} />
      </div>

      {/* Notebooks + Images — alternative views */}
      <div className="px-3 pb-3 shrink-0">
        <div className="flex gap-2">
          <button
            onClick={() => { onSwitchView('notebooks'); onClose(); }}
            className="relative flex-1 px-3 py-2 rounded-xl border text-sm font-medium transition-all hover:brightness-125 flex items-center justify-center gap-2"
            style={{
              backgroundColor: `rgba(var(--theme-accent), ${activeView === 'notebooks' ? 0.15 : 0.05})`,
              borderColor: `rgba(var(--theme-accent), ${activeView === 'notebooks' ? 0.4 : 0.25})`,
              color: `rgba(var(--theme-accent-text))`,
            }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
            </svg>
            Notebooks
            {hasUnreadNotebooks && activeView !== 'notebooks' && (
              <span
                className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full animate-pulse"
                style={{ backgroundColor: `rgba(var(--theme-accent), 0.85)` }}
              />
            )}
          </button>
          <button
            onClick={() => { onOpenImageSandbox(); onClose(); }}
            className={`flex-1 px-3 py-2 rounded-xl border text-sm font-medium transition-all hover:brightness-125 flex items-center justify-center gap-2 ${
              activeView === 'notebooks' ? 'opacity-50' : ''
            }`}
            style={{
              backgroundColor: `rgba(var(--theme-accent), ${isImageSandboxOpen ? 0.15 : 0.05})`,
              borderColor: `rgba(var(--theme-accent), ${isImageSandboxOpen ? 0.4 : 0.25})`,
              color: `rgba(var(--theme-accent-text))`,
            }}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <rect width="18" height="18" x="3" y="3" rx="2" ry="2" />
              <circle cx="9" cy="9" r="2" />
              <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
            </svg>
            Images
          </button>
        </div>
      </div>
      {/* Spacer for TTS bar */}
      {ttsBarVisible && <div className="h-[56px] shrink-0" />}
      </div>
    </>
  );
}
