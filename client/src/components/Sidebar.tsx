import { useMemo, useState, useEffect, useRef, useCallback } from "react";
import type { ChatListItem as ChatListItemType, ChatType, Project, ProjectLocationType, SshConnection, SystemPauseStatus } from "../types";
import { fetchSshConnections, type CacheResidency } from "../api/client";
import { ChatListItem } from "./ChatListItem";
import { ContextMenu, ContextMenuItem, useLongPress } from "./ui/ContextMenu";
import { Dropdown } from "./ui/Dropdown";
import { AutomationRunnerDropdown } from "./AutomationRunnerDropdown";
import { PolyhedronLogo } from "./PolyhedronLogo";
import { useActivityShape, useActivityHue, useActivitySaturation } from "../hooks/useActivityStyle";
import { useSidebarState } from "../hooks/useSidebarState";
import { useGestureDrawer } from "../hooks/useGestureDrawer";
import { useDropdown } from "../hooks/useDropdown";
import { SidebarSearch, SearchResults } from "./SidebarSearch";
import { searchConversations } from "../api/client";
import type { ConversationSearchResult } from "../types";
import { PrefillActivityIcon } from "./PrefillActivityIcon";
import { SystemStatsBar } from "./SystemStatsBar";
import type { SystemStatsSample } from "../types";

interface PathValidation {
  valid: boolean;
  exists: boolean;
  isDirectory: boolean;
  isReadable: boolean;
  canCreate?: boolean;
  error?: string;
  hasAgentsMd?: boolean;
}

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
  onWarmNewChatBaseline?: () => void;
  cacheWarmingChatIds?: Set<string>;
  cacheWarmErrors?: Map<string, string>;
  newChatBaselineCacheWarming?: boolean;
  newChatBaselineCacheWarmError?: string | null;
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
  hasBackgroundActivity?: boolean;
  lastActiveChatId?: string | null;
  isSynthesizing?: boolean;
  isAutomationRunning?: boolean;
  synthesisComplete?: boolean;
  sleepModeActive?: boolean;
  sleepCycleActive?: boolean;
  isExtractionRunning?: boolean;
  isWakeCycleRunning?: boolean;
  systemPause?: SystemPauseStatus | null;
  onPauseSystem?: (durationMs: number | null) => Promise<void> | void;
  onResumeSystem?: () => Promise<void> | void;
  onSynthesisSleep?: () => void;
  isImageSandboxOpen?: boolean;
  imageSandboxEnabled?: boolean;
  cacheResidency?: Map<string, CacheResidency>;
  newChatBaselineResidency?: CacheResidency | null;
  systemStatsHistory?: SystemStatsSample[];
  systemStatsCurrent?: SystemStatsSample | null;
  systemStatsHiddenGpus?: string[];
  showSystemStats?: boolean;
  agentName?: string;
}

const PROJECT_COLOR_CLASSES: Record<string, { icon: string; bg: string; border: string; text: string; hover: string }> = {
  emerald: { icon: "text-emerald-400/60", bg: "bg-emerald-500/15", border: "border-emerald-400/25", text: "text-emerald-300", hover: "hover:bg-emerald-500/25" },
  purple: { icon: "text-purple-400/60", bg: "bg-purple-500/15", border: "border-purple-400/25", text: "text-purple-300", hover: "hover:bg-purple-500/25" },
  blue: { icon: "text-blue-400/60", bg: "bg-blue-500/15", border: "border-blue-400/25", text: "text-blue-300", hover: "hover:bg-blue-500/25" },
  amber: { icon: "text-amber-400/60", bg: "bg-amber-500/15", border: "border-amber-400/25", text: "text-amber-300", hover: "hover:bg-amber-500/25" },
  rose: { icon: "text-rose-400/60", bg: "bg-rose-500/15", border: "border-rose-400/25", text: "text-rose-300", hover: "hover:bg-rose-500/25" },
  cyan: { icon: "text-cyan-400/60", bg: "bg-cyan-500/15", border: "border-cyan-400/25", text: "text-cyan-300", hover: "hover:bg-cyan-500/25" },
  violet: { icon: "text-violet-400/60", bg: "bg-violet-500/15", border: "border-violet-400/25", text: "text-violet-300", hover: "hover:bg-violet-500/25" },
  orange: { icon: "text-orange-400/60", bg: "bg-orange-500/15", border: "border-orange-400/25", text: "text-orange-300", hover: "hover:bg-orange-500/25" },
  pink: { icon: "text-pink-400/60", bg: "bg-pink-500/15", border: "border-pink-400/25", text: "text-pink-300", hover: "hover:bg-pink-500/25" },
  teal: { icon: "text-teal-400/60", bg: "bg-teal-500/15", border: "border-teal-400/25", text: "text-teal-300", hover: "hover:bg-teal-500/25" },
};

function projectInitial(name: string) {
  return Array.from(name.trim())[0]?.toLocaleUpperCase() || "•";
}

const DEFAULT_PROJECT_WORKSPACE_HEIGHT = "clamp(7rem, 28vh, 14rem)";
const MIN_PROJECT_WORKSPACE_HEIGHT = 112;
const MAX_PROJECT_WORKSPACE_HEIGHT = 420;

function clampProjectWorkspaceHeight(height: number) {
  const viewportLimit = typeof window === "undefined"
    ? MAX_PROJECT_WORKSPACE_HEIGHT
    : Math.floor(window.innerHeight * 0.55);
  const maxHeight = Math.max(
    MIN_PROJECT_WORKSPACE_HEIGHT,
    Math.min(MAX_PROJECT_WORKSPACE_HEIGHT, viewportLimit),
  );
  return Math.round(Math.min(Math.max(height, MIN_PROJECT_WORKSPACE_HEIGHT), maxHeight));
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

function formatNewChatBaselineTitle(residency?: CacheResidency | null): string | undefined {
  if (!residency) return undefined;
  const parts = [residency.active ? "New chat baseline cache active" : "New chat baseline cache warm"];
  if (typeof residency.inferredCacheHitRatio === "number") {
    parts.push(`last hit ${(residency.inferredCacheHitRatio * 100).toFixed(1)}%`);
  }
  if (typeof residency.slotId === "number") {
    parts.push(`slot ${residency.slotId}`);
  } else {
    parts.push(`${residency.bindingMode} slot selection`);
  }
  parts.push("project context may still prefill");
  return parts.join(" - ");
}

function newChatBaselineClass(residency?: CacheResidency | null): string {
  return residency ? "ring-1 ring-amber-400/35 shadow-[0_0_8px_rgba(251,191,36,0.12)]" : "";
}

function isResidencyQueued(residency?: CacheResidency | null): boolean {
  return residency?.queuePosition !== undefined && residency.queuePosition > 0;
}

function newChatBaselineActionLabel(
  residency: CacheResidency | null | undefined,
  warming: boolean,
  queued: boolean,
): string {
  if (queued) return "Warm queued";
  if (warming) return "Warming...";
  return residency ? "Refresh Baseline Cache" : "Warm Baseline Cache";
}

function ChangeProjectDirectoryModal({
  project,
  onClose,
  onSave,
}: {
  project: Project;
  onClose: () => void;
  onSave: (project: Project) => Promise<void>;
}) {
  const [path, setPath] = useState(project.path);
  const [locationType, setLocationType] = useState<ProjectLocationType>(project.locationType || "local");
  const [sshConnectionId, setSshConnectionId] = useState(project.sshConnectionId || "");
  const [sshConnections, setSshConnections] = useState<SshConnection[]>([]);
  const [loadingSshConnections, setLoadingSshConnections] = useState(false);
  const [validation, setValidation] = useState<PathValidation | null>(null);
  const [validating, setValidating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const sshConnectionDd = useDropdown();
  const selectedSshConnection = sshConnections.find((connection) => connection.id === sshConnectionId);

  const validatePath = useCallback(async (pathToValidate: string) => {
    setValidating(true);
    setError(null);
    try {
      const res = await fetch("/api/projects/validate", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path: pathToValidate,
          locationType,
          sshConnectionId: locationType === "ssh" ? sshConnectionId : undefined,
        }),
      });
      const data = await res.json();
      setValidation(data);
    } catch {
      setValidation({ valid: false, exists: false, isDirectory: false, isReadable: false, error: "Network error" });
    } finally {
      setValidating(false);
    }
  }, [locationType, sshConnectionId]);

  useEffect(() => {
    setLoadingSshConnections(true);
    fetchSshConnections()
      .then((connections) => {
        setSshConnections(connections);
        setSshConnectionId((current) => current || connections[0]?.id || "");
      })
      .catch(() => setSshConnections([]))
      .finally(() => setLoadingSshConnections(false));
  }, []);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (!path.trim() || (locationType === "ssh" && !sshConnectionId)) {
        setValidation(null);
        return;
      }
      validatePath(path.trim());
    }, 400);
    return () => clearTimeout(timer);
  }, [path, locationType, sshConnectionId, validatePath]);

  const handleSave = async () => {
    if (!validation?.valid || !path.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({
        ...project,
        path: path.trim(),
        locationType,
        sshConnectionId: locationType === "ssh" ? sshConnectionId : undefined,
      });
      onClose();
    } catch (e: any) {
      setError(e.message || "Failed to update working directory");
    } finally {
      setSaving(false);
    }
  };

  const hasRemoteTarget = locationType === "local" || Boolean(sshConnectionId);
  const changed =
    path.trim() !== project.path ||
    locationType !== (project.locationType || "local") ||
    (locationType === "ssh" && sshConnectionId !== (project.sshConnectionId || ""));
  const canSave = Boolean(changed && validation?.valid && hasRemoteTarget && !saving);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center app-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={modalRef}
        className="w-full max-w-lg mx-4 bg-[#111318] border border-white/15 rounded-2xl shadow-2xl max-h-[85vh] flex flex-col"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/10 shrink-0">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold text-white/90">Working Directory</h2>
            <p className="text-xs text-white/40 truncate">{project.name}</p>
          </div>
          <button onClick={onClose} className="text-white/40 hover:text-white/70 transition-colors pressable" aria-label="Close">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18" />
              <path d="M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-6 py-5 space-y-5 overflow-y-auto">
          <div className="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
            <div className="text-xs text-white/35">Current</div>
            <div className="text-xs font-mono text-white/60 truncate" title={project.path}>{project.path}</div>
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-medium text-white/60">Location</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  setLocationType("local");
                  setValidation(null);
                }}
                className={`px-3 py-2 text-sm rounded-lg border transition-all pressable ${
                  locationType === "local"
                    ? "bg-emerald-500/15 border-emerald-400/30 text-emerald-200"
                    : "bg-white/5 border-white/10 text-white/50 hover:bg-white/10"
                }`}
              >
                Local
              </button>
              <button
                type="button"
                onClick={() => {
                  setLocationType("ssh");
                  setValidation(null);
                }}
                className={`px-3 py-2 text-sm rounded-lg border transition-all ${
                  locationType === "ssh"
                    ? "bg-emerald-500/15 border-emerald-400/30 text-emerald-200"
                    : "bg-white/5 border-white/10 text-white/50 hover:bg-white/10"
                }`}
              >
                SSH
              </button>
            </div>
          </div>

          {locationType === "ssh" && (
            <div className="space-y-2">
              <label className="block text-sm font-medium text-white/60">SSH Connection</label>
              <Dropdown
                state={sshConnectionDd}
                disabled={loadingSshConnections || sshConnections.length === 0}
                panelClassName="left-0 right-0 top-full mt-1 max-h-[260px] overflow-y-auto"
                trigger={
                  <span className="truncate flex-1 text-left">
                    {loadingSshConnections
                      ? "Loading connections..."
                      : selectedSshConnection
                        ? `${selectedSshConnection.name} (${selectedSshConnection.username ? `${selectedSshConnection.username}@` : ""}${selectedSshConnection.host})`
                        : "Select a connection"}
                  </span>
                }
              >
                {sshConnections.map((connection) => (
                  <button
                    key={connection.id}
                    onClick={() => {
                      setSshConnectionId(connection.id);
                      setValidation(null);
                      sshConnectionDd.close();
                    }}
                    className={`w-full text-left px-3 py-2 text-xs transition-all ${
                      connection.id === sshConnectionId
                        ? "text-white bg-emerald-500/15"
                        : "text-white/60 hover:bg-white/10 hover:text-white/80"
                    }`}
                  >
                    {connection.name} ({connection.username ? `${connection.username}@` : ""}{connection.host})
                  </button>
                ))}
              </Dropdown>
              {sshConnections.length === 0 && !loadingSshConnections && (
                <p className="text-xs text-amber-300/80 bg-amber-500/10 border border-amber-400/20 rounded-lg px-3 py-2">
                  Add an SSH connection in Settings before using a remote working directory.
                </p>
              )}
            </div>
          )}

          <div className="space-y-2">
            <label className="block text-sm font-medium text-white/60">Project Path</label>
            <div className="relative">
              <input
                type="text"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder={locationType === "ssh" ? "/home/user/projects/my-project on the remote host" : "/home/user/projects/my-project"}
                className="w-full bg-white/5 border border-white/15 rounded-lg px-3 py-2 text-sm text-white/80 placeholder-white/30 outline-none focus:ring-1 focus:ring-emerald-400/30 focus:border-emerald-400/30 transition-all pr-10"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && canSave) {
                    handleSave();
                  }
                }}
              />
              {validating && (
                <div className="absolute right-3 top-1/2 -translate-y-1/2">
                  <div className="w-4 h-4 border-2 border-white/20 border-t-white/60 rounded-full animate-spin" />
                </div>
              )}
              {!validating && validation && (
                <div className="absolute right-3 top-1/2 -translate-y-1/2">
                  {validation.valid ? (
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgb(34, 197, 94)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
                      <polyline points="22 4 12 14.01 9 11.01" />
                    </svg>
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="rgb(239, 68, 68)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="8" x2="12" y2="12" />
                      <line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                  )}
                </div>
              )}
            </div>

            {locationType === "ssh" && !sshConnectionId && (
              <div className="text-xs px-3 py-2 rounded-lg border bg-amber-500/10 border-amber-400/20 text-amber-300">
                Select an SSH connection to validate the remote path.
              </div>
            )}
            {validation && hasRemoteTarget && (
              <div className={`text-xs px-3 py-2 rounded-lg border ${
                validation.valid
                  ? "bg-emerald-500/10 border-emerald-400/20 text-emerald-300"
                  : "bg-red-500/10 border-red-400/20 text-red-300"
              }`}>
                {validation.valid ? (
                  <div className="space-y-1">
                    <div className="font-medium">Path is valid</div>
                    {validation.hasAgentsMd ? (
                      <div className="opacity-80">AGENTS.md will be used for project context</div>
                    ) : (
                      <div className="opacity-80">No AGENTS.md was found in this directory</div>
                    )}
                  </div>
                ) : (
                  <div className="space-y-1">
                    <div className="font-medium">{validation.error || "Invalid path"}</div>
                    {!validation.exists && <div className="opacity-80">Path does not exist</div>}
                    {validation.exists && !validation.isDirectory && <div className="opacity-80">Path is a file, not a directory</div>}
                    {validation.exists && !validation.isReadable && <div className="opacity-80">Path is not readable</div>}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="text-xs text-white/40 leading-relaxed">
            Existing chats stay attached to this project. Future file tools, shell commands, and project context will use the new directory.
          </div>

          {error && (
            <div className="text-sm text-red-400 bg-red-500/10 border border-red-400/20 rounded-lg px-3 py-2">
              {error}
            </div>
          )}
        </div>

        <div className="px-6 py-4 border-t border-white/10 shrink-0 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm rounded-lg bg-white/5 border border-white/10 text-white/60 hover:text-white/80 hover:bg-white/10 transition-all pressable"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={!canSave}
            className={`px-4 py-2 text-sm rounded-lg font-medium transition-all flex items-center gap-2 pressable ${
              canSave
                ? "bg-emerald-500/20 border border-emerald-400/30 text-emerald-300 hover:bg-emerald-500/30"
                : "bg-white/5 border border-white/10 text-white/30 cursor-not-allowed"
            }`}
          >
            {saving && <div className="w-3 h-3 border-2 border-emerald-400/30 border-t-emerald-200 rounded-full animate-spin" />}
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SelectedProjectPanel({
  project,
  chats,
  activeChatId,
  onSelectChat,
  onNewChat,
  onDeleteChat,
  onDeleteProject,
  onEditProject,
  onSendToNotebook,
  onWarmCache,
  onWarmNewChatBaseline,
  cacheWarmingChatIds,
  cacheWarmErrors,
  newChatBaselineCacheWarming = false,
  newChatBaselineCacheWarmError = null,
  lastActiveChatId,
  cacheResidency,
  newChatBaselineResidency,
}: {
  project: Project;
  chats: ChatListItemType[];
  activeChatId: string | null;
  onSelectChat: (id: string) => void;
  onNewChat: (type: ChatType, projectId?: string) => void;
  onDeleteChat: (id: string) => void;
  onDeleteProject: (id: string) => void;
  onEditProject: (project: Project) => Promise<void>;
  onSendToNotebook?: (chatId: string, chatTitle: string) => void;
  onWarmCache?: (chatId: string) => void;
  onWarmNewChatBaseline?: () => void;
  cacheWarmingChatIds?: Set<string>;
  cacheWarmErrors?: Map<string, string>;
  newChatBaselineCacheWarming?: boolean;
  newChatBaselineCacheWarmError?: string | null;
  lastActiveChatId?: string | null;
  cacheResidency?: Map<string, CacheResidency>;
  newChatBaselineResidency?: CacheResidency | null;
}) {
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [newChatContextMenu, setNewChatContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [changingDirectory, setChangingDirectory] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState(project.name);
  const [showAllChats, setShowAllChats] = useState(false);

  const SIDEBAR_CHAT_PAGE_SIZE = 30;
  const newChatBaselineTitle = newChatBaselineCacheWarmError
    ? `New chat cache warm failed: ${newChatBaselineCacheWarmError}`
    : formatNewChatBaselineTitle(newChatBaselineResidency);
  const newChatBaselineQueued = isResidencyQueued(newChatBaselineResidency);
  const newChatBaselineWarming = newChatBaselineCacheWarming || newChatBaselineResidency?.status === "warming";
  const newChatBaselineBusy = newChatBaselineQueued || newChatBaselineWarming;
  const newChatBaselineMenuLabel = newChatBaselineActionLabel(
    newChatBaselineResidency,
    newChatBaselineWarming,
    newChatBaselineQueued,
  );

  useEffect(() => {
    if (!confirmDelete) return;
    window.dispatchEvent(new CustomEvent("sidebar-block-close:show"));
    return () => {
      window.dispatchEvent(new CustomEvent("sidebar-block-close:hide"));
    };
  }, [confirmDelete]);

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

  const handleNewChatContextMenu = useCallback((e: React.MouseEvent) => {
    if (!onWarmNewChatBaseline) return;
    e.preventDefault();
    e.stopPropagation();
    setNewChatContextMenu({ x: e.clientX, y: e.clientY });
  }, [onWarmNewChatBaseline]);

  const openNewChatContextMenu = useCallback((pos: { x: number; y: number }) => {
    if (!onWarmNewChatBaseline) return;
    setNewChatContextMenu(pos);
  }, [onWarmNewChatBaseline]);
  const newChatLongPressProps = useLongPress(openNewChatContextMenu);

  // Focus name input when editing starts
  useEffect(() => {
    if (editingName && nameInputRef.current) {
      nameInputRef.current.focus();
      nameInputRef.current.select();
    }
  }, [editingName]);

  const colors = PROJECT_COLOR_CLASSES[project.color] || PROJECT_COLOR_CLASSES.emerald;

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
    <div className="relative flex h-full min-h-0 flex-col">
      <div className="group flex min-h-9 shrink-0 items-center gap-1 border-b border-white/[0.06] px-1.5 py-0.5 select-none">
        <div
          onContextMenu={handleHeaderContextMenu}
          {...longPressProps}
          role="button"
          tabIndex={0}
          aria-label={`${project.name} project options`}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1 py-1 text-left hover:bg-white/[0.04]"
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
            <span className="truncate text-xs font-medium text-white/75">{project.name}</span>
          )}
          {project.pinned && (
            <span className="text-amber-400/50 shrink-0 ml-1" title="Pinned">
              <svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="17" x2="12" y2="22"></line>
                <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"></path>
              </svg>
            </span>
          )}
          <span className="ml-auto shrink-0 text-[10px] tabular-nums text-white/25">{chats.length}</span>
        </div>
        <button
          onClick={() => onNewChat("agent", project.id)}
          onContextMenu={handleNewChatContextMenu}
          {...(onWarmNewChatBaseline ? newChatLongPressProps : {})}
          aria-label={`New chat in ${project.name}`}
          title={newChatBaselineTitle || `New chat in ${project.name}`}
          className={`relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md border text-white/30 transition-colors hover:bg-white/[0.06] hover:text-white/70 pressable ${newChatBaselineClass(newChatBaselineResidency)} ${newChatBaselineResidency ? "border-amber-400/30" : "border-transparent"}`}
        >
          {(newChatBaselineWarming || newChatBaselineQueued) ? (
            <PrefillActivityIcon paused={newChatBaselineQueued} />
          ) : (
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14" />
              <path d="M5 12h14" />
            </svg>
          )}
        </button>
      </div>
      {/* Project context menu */}
      {contextMenu && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={() => setContextMenu(null)} blocksSidebarClose>
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
          <ContextMenuItem onClick={() => { setContextMenu(null); setChangingDirectory(true); }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-[14px] h-[14px]">
              <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
              <path d="M12 11h7" />
              <path d="m16 8 3 3-3 3" />
            </svg>
            Working directory
          </ContextMenuItem>
          {/* Color sub-section */}
          <div className="px-4 py-1.5 border-t border-white/5">
            <div className="flex gap-1.5 flex-wrap">
              {Object.keys(PROJECT_COLOR_CLASSES).map((color) => (
                <button
                  key={color}
                  onClick={() => handleColorChange(color)}
                  className={`w-4 h-4 rounded-full border transition-all ${
                    PROJECT_COLOR_CLASSES[color].bg
                  } ${
                    PROJECT_COLOR_CLASSES[color].border
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
      {newChatContextMenu && (
        <ContextMenu x={newChatContextMenu.x} y={newChatContextMenu.y} onClose={() => setNewChatContextMenu(null)} blocksSidebarClose>
          <ContextMenuItem
            onClick={() => {
              setNewChatContextMenu(null);
              onWarmNewChatBaseline?.();
            }}
            disabled={newChatBaselineBusy}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={newChatBaselineBusy ? "animate-pulse" : "opacity-70"} style={{ color: `rgba(var(--theme-accent), ${newChatBaselineBusy ? 0.9 : 0.7})` }}>
              <path d="M8 18c-2.2 0-4 1.8-4 4" />
              <path d="M16 18c2.2 0 4 1.8 4 4" />
              <path d="M7 4c0 0 1 1.3 1 3s-1 3-1 3" />
              <path d="M12 4c0 0 1 1.3 1 3s-1 3-1 3" />
              <path d="M17 4c0 0 1 1.3 1 3s-1 3-1 3" />
              <path d="M5 18h14" />
            </svg>
            {newChatBaselineMenuLabel}
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
                className="px-2 py-1 rounded-md text-xs font-medium bg-red-500/20 border border-red-400/30 text-red-300 hover:bg-red-500/30 transition-all pressable"
              >
                Delete
              </button>
              <button
                onClick={() => setConfirmDelete(false)}
                className="px-2 py-1 rounded-md text-xs font-medium bg-white/10 border border-white/15 text-white/50 hover:text-white/80 transition-all pressable"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      {changingDirectory && (
        <ChangeProjectDirectoryModal
          project={project}
          onClose={() => setChangingDirectory(false)}
          onSave={onEditProject}
        />
      )}
      <div className="project-chat-scroll-pane min-h-0 flex-1 overflow-y-auto overflow-x-clip px-1.5 py-1">
            {chats.length > 0 ? (
              <>
                <div className="space-y-px">
                  {(showAllChats ? chats : chats.slice(0, SIDEBAR_CHAT_PAGE_SIZE)).map((chat) => (
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
                {!showAllChats && chats.length > SIDEBAR_CHAT_PAGE_SIZE && (
                  <button
                    onClick={() => setShowAllChats(true)}
                    className={`mt-1 w-full rounded-lg border px-2 py-1.5 text-xs font-medium transition-all ${colors.bg} ${colors.border} ${colors.text} ${colors.hover} pressable`}
                  >
                    Show {chats.length - SIDEBAR_CHAT_PAGE_SIZE} more
                  </button>
                )}
              </>
            ) : (
              <p className="px-2 py-2 text-[10px] text-white/25">
                No chats yet
              </p>
            )}
      </div>
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
  onWarmNewChatBaseline,
  cacheWarmingChatIds = new Set(),
  cacheWarmErrors = new Map(),
  newChatBaselineCacheWarming = false,
  newChatBaselineCacheWarmError = null,
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
  hasBackgroundActivity = false,
  lastActiveChatId = null,
  isSynthesizing = false,
  isAutomationRunning = false,
  synthesisComplete = false,
  sleepModeActive = false,
  sleepCycleActive = false,
  isExtractionRunning = false,
  isWakeCycleRunning = false,
  systemPause = null,
  onPauseSystem,
  onResumeSystem,
  onSynthesisSleep,
  isImageSandboxOpen = false,
  imageSandboxEnabled = true,
  cacheResidency = new Map(),
  newChatBaselineResidency = null,
  systemStatsHistory = [],
  systemStatsCurrent,
  systemStatsHiddenGpus,
  showSystemStats = false,
  agentName = "Porrima",
}: Props) {
  const {
    selectedProjectId,
    setSelectedProjectId,
    projectWorkspaceHeight,
    setProjectWorkspaceHeight,
  } = useSidebarState();
  const activityShape = useActivityShape();
  const effectiveSleepCycleActive = sleepCycleActive && !isStreaming;
  const systemPauseActive = systemPause?.active ?? false;
  const systemPausePending = systemPause?.pending ?? false;
  const sidebarActivityActive = hasBackgroundActivity || isExtractionRunning || isSynthesizing || isAutomationRunning;
  const newChatBaselineTitle = newChatBaselineCacheWarmError
    ? `New chat cache warm failed: ${newChatBaselineCacheWarmError}`
    : formatNewChatBaselineTitle(newChatBaselineResidency);
  const newChatBaselineQueued = isResidencyQueued(newChatBaselineResidency);
  const newChatBaselineWarming = newChatBaselineCacheWarming || newChatBaselineResidency?.status === "warming";
  const newChatBaselineBusy = newChatBaselineQueued || newChatBaselineWarming;
  const newChatBaselineMenuLabel = newChatBaselineActionLabel(
    newChatBaselineResidency,
    newChatBaselineWarming,
    newChatBaselineQueued,
  );

  const [searchActive, setSearchActive] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<ConversationSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [newChatContextMenu, setNewChatContextMenu] = useState<{ x: number; y: number } | null>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const projectWorkspaceRef = useRef<HTMLDivElement>(null);
  const projectResizeRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
    currentHeight: number;
  } | null>(null);
  const [projectWorkspaceHeightDraft, setProjectWorkspaceHeightDraft] = useState<number | null>(() =>
    projectWorkspaceHeight === null ? null : clampProjectWorkspaceHeight(projectWorkspaceHeight)
  );
  const [isProjectWorkspaceResizing, setIsProjectWorkspaceResizing] = useState(false);
  const [agentShowAll, setAgentShowAll] = useState(false);
  const [quickShowAll, setQuickShowAll] = useState(false);
  const SIDEBAR_CHAT_PAGE_SIZE = 30;

  // Track blocking interactions (delete confirmations, context menus) so the
  // mobile sidebar doesn't auto-close while the user is interacting with them.
  const blockCloseCountRef = useRef(0);
  const blockCloseRef = useRef(false);
  const [blockClose, setBlockClose] = useState(false);
  useEffect(() => {
    const onShow = () => {
      blockCloseCountRef.current += 1;
      blockCloseRef.current = true;
      setBlockClose(true);
    };
    const onHide = () => {
      blockCloseCountRef.current = Math.max(0, blockCloseCountRef.current - 1);
      blockCloseRef.current = blockCloseCountRef.current > 0;
      setBlockClose(blockCloseRef.current);
    };
    window.addEventListener("sidebar-block-close:show", onShow);
    window.addEventListener("sidebar-block-close:hide", onHide);
    return () => {
      window.removeEventListener("sidebar-block-close:show", onShow);
      window.removeEventListener("sidebar-block-close:hide", onHide);
    };
  }, []);
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

  const handleNewChatContextMenu = useCallback((e: React.MouseEvent) => {
    if (!onWarmNewChatBaseline) return;
    e.preventDefault();
    e.stopPropagation();
    setNewChatContextMenu({ x: e.clientX, y: e.clientY });
  }, [onWarmNewChatBaseline]);

  const openNewChatContextMenu = useCallback((pos: { x: number; y: number }) => {
    if (!onWarmNewChatBaseline) return;
    setNewChatContextMenu(pos);
  }, [onWarmNewChatBaseline]);
  const newChatLongPressProps = useLongPress(openNewChatContextMenu);

  const agentChats = useMemo(
    () => chats.filter((c) => c.type === "agent" && !c.projectId),
    [chats]
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
  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId]
  );
  const displayedProject = selectedProject ?? projects[0] ?? null;
  const activeChatProjectId = useMemo(
    () => chats.find((chat) => chat.id === activeChatId)?.projectId ?? null,
    [activeChatId, chats]
  );
  const lastAutoSelectedChatIdRef = useRef<string | null>(null);
  const knownProjectIdsRef = useRef<Set<string> | null>(null);

  // Navigating into a project chat selects its workspace. Manual rail selection
  // remains stable because this only runs when the active chat actually changes.
  useEffect(() => {
    if (!activeChatProjectId || !activeChatId) {
      lastAutoSelectedChatIdRef.current = null;
      return;
    }
    if (lastAutoSelectedChatIdRef.current === activeChatId) return;
    lastAutoSelectedChatIdRef.current = activeChatId;
    setSelectedProjectId(activeChatProjectId);
  }, [activeChatId, activeChatProjectId, setSelectedProjectId]);

  // Keep persisted selection valid as projects are loaded or deleted.
  useEffect(() => {
    if (projects.length === 0) {
      if (selectedProjectId !== null) setSelectedProjectId(null);
      return;
    }
    if (!projects.some((project) => project.id === selectedProjectId)) {
      const activeProjectStillExists = projects.some((project) => project.id === activeChatProjectId);
      setSelectedProjectId(activeProjectStillExists ? activeChatProjectId : projects[0].id);
    }
  }, [activeChatProjectId, projects, selectedProjectId, setSelectedProjectId]);

  // A newly created project becomes the visible workspace without requiring a
  // second click after the creation modal closes.
  useEffect(() => {
    const nextIds = new Set(projects.map((project) => project.id));
    const knownIds = knownProjectIdsRef.current;
    knownProjectIdsRef.current = nextIds;
    if (!knownIds) return;
    const addedProjects = projects.filter((project) => !knownIds.has(project.id));
    if (addedProjects.length === 1) {
      setSelectedProjectId(addedProjects[0].id);
    }
  }, [projects, setSelectedProjectId]);

  useEffect(() => {
    if (isProjectWorkspaceResizing) return;
    setProjectWorkspaceHeightDraft(
      projectWorkspaceHeight === null ? null : clampProjectWorkspaceHeight(projectWorkspaceHeight)
    );
  }, [isProjectWorkspaceResizing, projectWorkspaceHeight]);

  const handleProjectResizePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !projectWorkspaceRef.current) return;
    const startHeight = projectWorkspaceRef.current.getBoundingClientRect().height;
    const initialHeight = clampProjectWorkspaceHeight(startHeight);
    projectResizeRef.current = {
      pointerId: e.pointerId,
      startY: e.clientY,
      startHeight: initialHeight,
      currentHeight: initialHeight,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
    setProjectWorkspaceHeightDraft(initialHeight);
    setIsProjectWorkspaceResizing(true);
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleProjectResizePointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const resize = projectResizeRef.current;
    if (!resize || resize.pointerId !== e.pointerId) return;
    const nextHeight = clampProjectWorkspaceHeight(resize.startHeight + e.clientY - resize.startY);
    resize.currentHeight = nextHeight;
    setProjectWorkspaceHeightDraft(nextHeight);
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const finishProjectResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const resize = projectResizeRef.current;
    if (!resize || resize.pointerId !== e.pointerId) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    projectResizeRef.current = null;
    setIsProjectWorkspaceResizing(false);
    setProjectWorkspaceHeight(resize.currentHeight);
    e.preventDefault();
    e.stopPropagation();
  }, [setProjectWorkspaceHeight]);

  const resetProjectWorkspaceHeight = useCallback(() => {
    projectResizeRef.current = null;
    setIsProjectWorkspaceResizing(false);
    setProjectWorkspaceHeightDraft(null);
    setProjectWorkspaceHeight(null);
  }, [setProjectWorkspaceHeight]);

  const handleProjectResizeKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Home") {
      e.preventDefault();
      resetProjectWorkspaceHeight();
      return;
    }
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    e.preventDefault();
    const currentHeight = projectWorkspaceHeightDraft
      ?? projectWorkspaceRef.current?.getBoundingClientRect().height
      ?? MIN_PROJECT_WORKSPACE_HEIGHT;
    const nextHeight = clampProjectWorkspaceHeight(currentHeight + (e.key === "ArrowDown" ? 16 : -16));
    setProjectWorkspaceHeightDraft(nextHeight);
    setProjectWorkspaceHeight(nextHeight);
  }, [projectWorkspaceHeightDraft, resetProjectWorkspaceHeight, setProjectWorkspaceHeight]);

  // Gesture drawer hook for mobile slide-over
  const { handlers: gestureHandlers, edgeHandlers, containerRef: gestureRef, style: gestureStyle, openProgress, isDragging, isAnimating } = useGestureDrawer({
    isOpen,
    onClose,
    onOpen,
    direction: "right",
    threshold: 0.4, // 40% of sidebar width to snap
    disabled: blockClose || isProjectWorkspaceResizing,
    disabledRef: blockCloseRef,
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
          onTouchCancel={edgeHandlers.onTouchCancel}
        />
      )}
      {/* Backdrop for mobile — opacity tracks drag progress */}
      {(isOpen || isDragging || isAnimating) && (
        <div
          className={`md:hidden fixed inset-0 bg-black/60 z-20 ${isDragging || isAnimating ? "" : "transition-opacity"}`}
          style={{ opacity: openProgress * 0.6 }}
          onClick={() => {
            // Don't close while a chat-item confirmation/context menu is visible
            if (blockCloseCountRef.current > 0) return;
            onClose();
          }}
        />
      )}
      {/* Sidebar container — desktop is static, mobile is fixed with gesture support */}
      <div
        className={`w-72 h-full flex flex-col app-glass-surface border-r border-white/10 fixed inset-y-0 left-0 z-30 md:static md:translate-x-0 md:z-auto ${isDragging || isAnimating ? "" : "transition-transform duration-300 ease-in-out"} ${!isDragging && !isAnimating ? (isOpen ? "translate-x-0 md:translate-x-0" : "-translate-x-full md:translate-x-0") : ""}`}
        ref={gestureRef}
        onTouchStart={gestureHandlers.onTouchStart}
        onTouchMove={gestureHandlers.onTouchMove}
        onTouchEnd={gestureHandlers.onTouchEnd}
        onTouchCancel={gestureHandlers.onTouchCancel}
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
                <div
                  className={`pointer-events-none absolute inset-0 flex items-center transition-opacity duration-300 ${sidebarActivityActive ? 'opacity-100' : 'opacity-0'}`}
                  aria-hidden="true"
                >
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

      {/* Chat navigation — fixed controls above one flowing scroll region. */}
      <div className="flex-1 flex flex-col min-h-0">
        {/* Synthesis status & action buttons row */}
        <div className="px-3 pt-2 pb-2 shrink-0">
          <div className="flex items-center gap-1.5">
            {/* Status indicator */}
            <div className="flex items-center gap-1.5 text-[10px] text-white/30 pl-1">
              {systemPausePending ? (
                <>
                  <span className="text-amber-400/60">●</span>
                  <span className="text-amber-300/60">Pause pending</span>
                </>
              ) : isSynthesizing ? (
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
              ) : systemPauseActive ? (
                <>
                  <span className="text-amber-400/60">●</span>
                  <span className="text-amber-300/60">Paused</span>
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
                  disabled={sleepModeActive || effectiveSleepCycleActive || isStreaming || systemPauseActive}
                  className={`p-2 rounded-lg transition-all cursor-pointer pressable ${
                    effectiveSleepCycleActive
                      ? 'text-indigo-400/80 bg-indigo-500/15 animate-pulse'
                      : sleepModeActive
                        ? 'text-amber-400/80 bg-amber-500/15 animate-pulse'
                        : systemPauseActive
                          ? 'text-white/15 cursor-not-allowed'
                        : 'text-white/30 hover:text-white/60 hover:bg-white/5'
                  }`}
                  title={isStreaming
                    ? "Chat active — release is available after the response completes"
                    : systemPauseActive
                    ? "System paused — resume before releasing autonomous mode"
                    : effectiveSleepCycleActive
                    ? "Sleep cycle active — autonomous mode running"
                    : "Release — let the system take over with autonomous synthesis and wake cycles"}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>
                  </svg>
                </button>
              )}
              <AutomationRunnerDropdown
                isSynthesizing={isSynthesizing}
                isWakeCycleRunning={isWakeCycleRunning}
                isAutomationRunning={isAutomationRunning}
                isStreaming={isStreaming}
                systemPause={systemPause}
                onPauseSystem={onPauseSystem}
                onResumeSystem={onResumeSystem}
              />
              {/* Memory — unified memory system interface */}
              {onOpenMemoryDebug && (
                <button
                  onClick={onOpenMemoryDebug}
                  className="group p-2 text-white hover:bg-white/5 rounded-lg transition-colors shrink-0 pressable"
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
                  className="p-2 text-white/30 hover:text-white/60 hover:bg-white/5 rounded-lg transition-colors shrink-0 pressable"
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
                className="p-2 text-white/30 hover:text-white/60 hover:bg-white/5 rounded-lg transition-colors shrink-0 pressable"
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

        <div className="sidebar-scroll-pane flex-1 min-h-0 overflow-y-auto overflow-x-clip pb-2">
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
                    className={`group relative flex min-h-8 w-full items-center gap-1.5 rounded-lg border px-2 py-1.5 text-left text-xs transition-all ${
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

        {/* Projects — compact workspace rail plus one selected project's chats. */}
        <section className={displayedProject ? "" : "border-b border-white/5 pb-1"} aria-labelledby="sidebar-projects-heading">
          <div className="flex min-h-8 items-center px-3 pt-1.5">
            <h2 id="sidebar-projects-heading" className="flex-1 px-1 text-[10px] font-semibold uppercase tracking-wider text-white/30">
              Projects
            </h2>
            <span className="mr-1 text-[10px] tabular-nums text-white/20">{projects.length}</span>
            <button
              onClick={onNewProject}
              className="flex h-7 w-7 items-center justify-center rounded-md text-white/30 transition-colors hover:bg-white/[0.06] hover:text-white/70 pressable"
              title="New project"
              aria-label="New project"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14" />
                <path d="M5 12h14" />
              </svg>
            </button>
          </div>
          {displayedProject ? (
            <>
            <div
              ref={projectWorkspaceRef}
              className="mx-2 flex min-h-0 overflow-hidden"
              style={{ height: projectWorkspaceHeightDraft ?? DEFAULT_PROJECT_WORKSPACE_HEIGHT }}
            >
              <div
                className="project-rail-scroll-pane w-11 shrink-0 overflow-y-auto overflow-x-hidden border-r border-white/[0.06] px-1 py-1.5"
                aria-label="Projects"
              >
                <div className="flex flex-col items-center gap-1">
                  {projects.map((project) => {
                    const colors = PROJECT_COLOR_CLASSES[project.color] || PROJECT_COLOR_CLASSES.emerald;
                    const selected = project.id === displayedProject.id;
                    const containsActiveChat = project.id === activeChatProjectId;
                    return (
                      <button
                        key={project.id}
                        type="button"
                        onClick={() => setSelectedProjectId(project.id)}
                        aria-label={`Select ${project.name}`}
                        aria-pressed={selected}
                        title={project.name}
                        className={`relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border text-xs font-semibold transition-all pressable ${
                          selected
                            ? `${colors.bg} ${colors.border} ${colors.text} shadow-[inset_0_0_0_1px_rgba(255,255,255,0.05)]`
                            : `border-transparent bg-white/[0.025] ${colors.icon} hover:border-white/10 hover:bg-white/[0.06]`
                        }`}
                      >
                        {projectInitial(project.name)}
                        {project.pinned && (
                          <span className="absolute right-0.5 top-0.5 h-1 w-1 rounded-full bg-amber-300/70" aria-label="Pinned" />
                        )}
                        {containsActiveChat && (
                          <span className="absolute bottom-0.5 h-0.5 w-3 rounded-full bg-white/55" aria-label="Contains active chat" />
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div className="min-w-0 flex-1">
                <SelectedProjectPanel
                  key={displayedProject.id}
                  project={displayedProject}
                  chats={chatsByProject[displayedProject.id] || []}
                  activeChatId={activeChatId}
                  onSelectChat={(id) => { onSelectChat(id); onClose(); }}
                  onNewChat={onNewChat}
                  onDeleteChat={onDeleteChat}
                  onDeleteProject={onDeleteProject}
                  onEditProject={async (updatedProject) => {
                    const res = await fetch(`/api/projects/${updatedProject.id}`, {
                      method: "PATCH",
                      credentials: "include",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        name: updatedProject.name,
                        path: updatedProject.path,
                        locationType: updatedProject.locationType || "local",
                        sshConnectionId: updatedProject.locationType === "ssh" ? updatedProject.sshConnectionId : undefined,
                        color: updatedProject.color,
                        pinned: updatedProject.pinned,
                      }),
                    });
                    if (!res.ok) {
                      const err = await res.json().catch(() => ({}));
                      throw new Error((err as any).error || "Failed to update project");
                    }
                    window.dispatchEvent(new CustomEvent("projects:updated"));
                  }}
                  onSendToNotebook={onSendToNotebook}
                  onWarmCache={onWarmCache}
                  onWarmNewChatBaseline={onWarmNewChatBaseline}
                  cacheWarmingChatIds={cacheWarmingChatIds}
                  cacheWarmErrors={cacheWarmErrors}
                  newChatBaselineCacheWarming={newChatBaselineCacheWarming}
                  newChatBaselineCacheWarmError={newChatBaselineCacheWarmError}
                  lastActiveChatId={lastActiveChatId}
                  cacheResidency={cacheResidency}
                  newChatBaselineResidency={newChatBaselineResidency}
                />
              </div>
            </div>
            <div
              role="separator"
              aria-label="Resize projects section"
              aria-orientation="horizontal"
              aria-valuemin={MIN_PROJECT_WORKSPACE_HEIGHT}
              aria-valuemax={clampProjectWorkspaceHeight(Number.MAX_SAFE_INTEGER)}
              aria-valuenow={projectWorkspaceHeightDraft ?? projectWorkspaceHeight ?? undefined}
              tabIndex={0}
              title="Drag to resize projects. Double-click or press Home to reset."
              onPointerDown={handleProjectResizePointerDown}
              onPointerMove={handleProjectResizePointerMove}
              onPointerUp={finishProjectResize}
              onPointerCancel={finishProjectResize}
              onDoubleClick={resetProjectWorkspaceHeight}
              onKeyDown={handleProjectResizeKeyDown}
              onTouchStart={(e) => e.stopPropagation()}
              className="group relative h-2 cursor-row-resize touch-none select-none outline-none"
            >
              <span
                className={`pointer-events-none absolute inset-x-3 top-1/2 h-px -translate-y-1/2 transition-colors ${
                  isProjectWorkspaceResizing
                    ? "bg-white/30"
                    : "bg-white/[0.06] group-hover:bg-white/20 group-focus:bg-white/20"
                }`}
                aria-hidden="true"
              />
            </div>
            </>
          ) : (
            <p className="px-4 pb-1.5 text-[10px] text-white/25">No projects yet</p>
          )}
        </section>

        {/* Global agent chats */}
        <section className="border-b border-white/5 pb-1" aria-labelledby="sidebar-global-heading">
          <div className="flex min-h-8 items-center px-3 pt-1.5">
            <h2 id="sidebar-global-heading" className="flex-1 px-1 text-[10px] font-semibold uppercase tracking-wider text-white/30">
              Global Chats
            </h2>
            <span className="mr-1 text-[10px] tabular-nums text-white/20">{agentChats.length}</span>
            <button
              onClick={() => { onNewChat("agent"); onClose(); }}
              onContextMenu={handleNewChatContextMenu}
              {...(onWarmNewChatBaseline ? newChatLongPressProps : {})}
              aria-label="New global chat"
              title={newChatBaselineTitle || "New global chat"}
              className={`relative flex h-7 w-7 items-center justify-center rounded-md border text-purple-300/50 transition-colors hover:bg-purple-500/10 hover:text-purple-200 pressable ${newChatBaselineClass(newChatBaselineResidency)} ${newChatBaselineResidency ? "border-amber-400/30" : "border-transparent"}`}
            >
              {(newChatBaselineWarming || newChatBaselineQueued) ? (
                <PrefillActivityIcon paused={newChatBaselineQueued} />
              ) : (
                <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 5v14" />
                  <path d="M5 12h14" />
                </svg>
              )}
            </button>
          </div>
          <div className="space-y-px px-3">
            {(agentShowAll ? agentChats : agentChats.slice(0, SIDEBAR_CHAT_PAGE_SIZE)).map((chat) => (
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
            {!agentShowAll && agentChats.length > SIDEBAR_CHAT_PAGE_SIZE && (
              <button
                onClick={() => setAgentShowAll(true)}
                className="w-full rounded-lg border border-purple-400/20 bg-purple-500/10 px-2 py-1.5 text-xs font-medium text-purple-300 transition-colors hover:bg-purple-500/20 pressable"
              >
                Show {agentChats.length - SIDEBAR_CHAT_PAGE_SIZE} more
              </button>
            )}
            {agentChats.length === 0 && (
              <p className="px-2 pb-1.5 text-[10px] text-white/25">No global chats yet</p>
            )}
          </div>
        </section>

        {/* Quick chats */}
        <section className="pb-1" aria-labelledby="sidebar-quick-heading">
          <div className="flex min-h-8 items-center px-3 pt-1.5">
            <h2 id="sidebar-quick-heading" className="flex-1 px-1 text-[10px] font-semibold uppercase tracking-wider text-white/30">
              Quick Chats
            </h2>
            <span className="mr-1 text-[10px] tabular-nums text-white/20">{quickChats.length}</span>
            <button
              onClick={() => { onNewChat("quick"); onClose(); }}
              aria-label="New quick chat"
              title="New quick chat"
              className="flex h-7 w-7 items-center justify-center rounded-md border border-transparent text-blue-300/50 transition-colors hover:bg-blue-500/10 hover:text-blue-200 pressable"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14" />
                <path d="M5 12h14" />
              </svg>
            </button>
          </div>
          <div className="space-y-px px-3">
            {(quickShowAll ? quickChats : quickChats.slice(0, SIDEBAR_CHAT_PAGE_SIZE)).map((chat) => (
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
            {!quickShowAll && quickChats.length > SIDEBAR_CHAT_PAGE_SIZE && (
              <button
                onClick={() => setQuickShowAll(true)}
                className="w-full rounded-lg border border-blue-400/20 bg-blue-500/10 px-2 py-1.5 text-xs font-medium text-blue-300 transition-colors hover:bg-blue-500/20 pressable"
              >
                Show {quickChats.length - SIDEBAR_CHAT_PAGE_SIZE} more
              </button>
            )}
            {quickChats.length === 0 && (
              <p className="px-2 pb-1.5 text-[10px] text-white/25">No quick chats yet</p>
            )}
          </div>
        </section>

        </div>


      </div>

      {/* Notebooks + Images — alternative views */}
      <div className="px-3 pb-3 shrink-0">
        <div className="flex gap-2">
          <button
            onClick={() => { onSwitchView('notebooks'); onClose(); }}
            className="relative flex-1 px-3 py-2 rounded-xl border text-sm font-medium transition-all hover:brightness-125 flex items-center justify-center gap-2 pressable"
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
          {imageSandboxEnabled && (
            <button
              onClick={() => { onOpenImageSandbox(); onClose(); }}
              className={`flex-1 px-3 py-2 rounded-xl border text-sm font-medium transition-all hover:brightness-125 flex items-center justify-center gap-2 pressable ${
                activeView === 'notebooks' ? 'opacity-50' : ''
              }`}
              style={{
                backgroundColor: `rgba(var(--theme-accent), ${isImageSandboxOpen ? 0.15 : 0.05})`,
                borderColor: `rgba(var(--theme-accent), ${isImageSandboxOpen ? 0.4 : 0.25})`,
                color: `rgba(var(--theme-accent-text))`,
              }}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path fill-rule="evenodd" clip-rule="evenodd" d="M5 3h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2ZM5 5v14h14V5H5ZM9 7a2 2 0 110 4 2 2 0 010-4ZM5 19l3.5-4.5 3 3 4-5.5L19 15v4H5Z" />
              </svg>
              Images
            </button>
          )}
        </div>
      </div>
      {/* Spacer for TTS bar */}
      {ttsBarVisible && <div className="h-[56px] shrink-0" />}
      </div>
      {newChatContextMenu && (
        <ContextMenu x={newChatContextMenu.x} y={newChatContextMenu.y} onClose={() => setNewChatContextMenu(null)} blocksSidebarClose>
          <ContextMenuItem
            onClick={() => {
              setNewChatContextMenu(null);
              onWarmNewChatBaseline?.();
            }}
            disabled={newChatBaselineBusy}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={newChatBaselineBusy ? "animate-pulse" : "opacity-70"} style={{ color: `rgba(var(--theme-accent), ${newChatBaselineBusy ? 0.9 : 0.7})` }}>
              <path d="M8 18c-2.2 0-4 1.8-4 4" />
              <path d="M16 18c2.2 0 4 1.8 4 4" />
              <path d="M7 4c0 0 1 1.3 1 3s-1 3-1 3" />
              <path d="M12 4c0 0 1 1.3 1 3s-1 3-1 3" />
              <path d="M17 4c0 0 1 1.3 1 3s-1 3-1 3" />
              <path d="M5 18h14" />
            </svg>
            {newChatBaselineMenuLabel}
          </ContextMenuItem>
        </ContextMenu>
      )}
    </>
  );
}
