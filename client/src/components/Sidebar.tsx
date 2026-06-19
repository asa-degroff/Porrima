import { useMemo, useState, useEffect, useRef, useCallback, useId, useLayoutEffect } from "react";
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

const SIDEBAR_COLLAPSE_DURATION_MS = 200;
type SidebarRevealOrigin = "top" | "bottom";

function snapToDevicePixel(value: number) {
  if (!Number.isFinite(value)) return 0;
  const ratio = window.devicePixelRatio || 1;
  return Math.round(value * ratio) / ratio;
}

function ceilToDevicePixel(value: number) {
  if (!Number.isFinite(value)) return 0;
  const ratio = window.devicePixelRatio || 1;
  return Math.ceil(value * ratio) / ratio;
}

function usePrefersReducedMotion() {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    if (!window.matchMedia) return;

    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setPrefersReducedMotion(query.matches);
    update();

    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return prefersReducedMotion;
}

interface SidebarSectionSnapshot {
  expanded: boolean[];
  tops: Array<number | null>;
}

interface OpeningSectionMotion {
  index: number | null;
  revealOrigin: SidebarRevealOrigin;
}

function measureSectionTops(refs: Array<React.RefObject<HTMLDivElement | null>>) {
  return refs.map((ref) => ref.current?.getBoundingClientRect().top ?? null);
}

function useOpeningSectionMotion(
  refs: Array<React.RefObject<HTMLDivElement | null>>,
  expandedStates: boolean[],
  layoutKey: string
) {
  const previousSnapshotRef = useRef<SidebarSectionSnapshot | null>(null);
  const [openingSectionMotion, setOpeningSectionMotion] = useState<OpeningSectionMotion>({
    index: null,
    revealOrigin: "top",
  });
  const prefersReducedMotion = usePrefersReducedMotion();

  const captureSnapshot = useCallback(() => {
    previousSnapshotRef.current = {
      expanded: [...expandedStates],
      tops: measureSectionTops(refs),
    };
  }, [refs, expandedStates]);

  useLayoutEffect(() => {
    const elements = refs.map((ref) => ref.current);
    const targetTops = measureSectionTops(refs);
    const previousSnapshot = previousSnapshotRef.current;
    const nextSnapshot = { expanded: [...expandedStates], tops: targetTops };

    if (prefersReducedMotion || !previousSnapshot || previousSnapshot.expanded.length !== expandedStates.length) {
      previousSnapshotRef.current = nextSnapshot;
      setOpeningSectionMotion({ index: null, revealOrigin: "top" });
      return;
    }

    const changedIndexes = expandedStates.flatMap((expanded, index) =>
      expanded === previousSnapshot.expanded[index] ? [] : [index]
    );
    const changedIndex = changedIndexes.length === 1 ? changedIndexes[0] : -1;
    const isOpening = changedIndex >= 0 && !previousSnapshot.expanded[changedIndex] && expandedStates[changedIndex];

    previousSnapshotRef.current = nextSnapshot;

    if (!isOpening) {
      setOpeningSectionMotion({ index: null, revealOrigin: "top" });
      return;
    }

    const changedPreviousTop = previousSnapshot.tops[changedIndex];
    const changedTargetTop = targetTops[changedIndex];
    const changedDeltaY = changedPreviousTop !== null && changedTargetTop !== null
      ? snapToDevicePixel(changedPreviousTop - changedTargetTop)
      : 0;
    const revealOrigin: SidebarRevealOrigin = changedDeltaY > 0.5 ? "bottom" : "top";
    setOpeningSectionMotion({ index: changedIndex, revealOrigin });

    const movingElements = elements.flatMap((element, index) => {
      const previousTop = previousSnapshot.tops[index];
      const targetTop = targetTops[index];
      const deltaY = previousTop !== null && targetTop !== null ? snapToDevicePixel(previousTop - targetTop) : 0;

      if (!element || Math.abs(deltaY) < 0.5) {
        return [];
      }

      return [{
        element,
        deltaY,
        previousStyles: {
          transition: element.style.transition,
          transform: element.style.transform,
          zIndex: element.style.zIndex,
          willChange: element.style.willChange,
        },
      }];
    });

    for (const { element, deltaY, previousStyles } of movingElements) {
      element.style.transition = "none";
      element.style.transform = `${previousStyles.transform ? `${previousStyles.transform} ` : ""}translateY(${deltaY}px)`;
      element.style.zIndex = "20";
      element.style.willChange = "transform";
    }

    movingElements[0]?.element.getBoundingClientRect();

    const frame = movingElements.length > 0
      ? window.requestAnimationFrame(() => {
          for (const { element, previousStyles } of movingElements) {
            element.style.transition = `transform ${SIDEBAR_COLLAPSE_DURATION_MS}ms ease-out`;
            element.style.transform = previousStyles.transform;
          }
        })
      : null;

    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (frame !== null) {
        window.cancelAnimationFrame(frame);
      }
      for (const { element, previousStyles } of movingElements) {
        element.style.transition = previousStyles.transition;
        element.style.transform = previousStyles.transform;
        element.style.zIndex = previousStyles.zIndex;
        element.style.willChange = previousStyles.willChange;
      }
      previousSnapshotRef.current = {
        expanded: [...expandedStates],
        tops: measureSectionTops(refs),
      };
      setOpeningSectionMotion({ index: null, revealOrigin: "top" });
    };

    const timer = window.setTimeout(finish, SIDEBAR_COLLAPSE_DURATION_MS);

    return () => {
      window.clearTimeout(timer);
      finish();
    };
  }, [layoutKey, prefersReducedMotion, refs, expandedStates]);

  useLayoutEffect(() => {
    if (openingSectionMotion.index !== null) return;
    previousSnapshotRef.current = {
      expanded: [...expandedStates],
      tops: measureSectionTops(refs),
    };
  });

  return { openingSectionMotion, captureSnapshot };
}

function AnimatedListReveal({
  open,
  animate = false,
  origin = "top",
  children,
  className = "",
}: {
  open: boolean;
  animate?: boolean;
  origin?: SidebarRevealOrigin;
  children: React.ReactNode;
  className?: string;
}) {
  const [revealed, setRevealed] = useState(false);

  useLayoutEffect(() => {
    if (!open || !animate) {
      setRevealed(true);
      return;
    }

    setRevealed(false);
    const frame = window.requestAnimationFrame(() => setRevealed(true));
    return () => window.cancelAnimationFrame(frame);
  }, [open, animate, origin]);

  const isRevealing = open && animate && !revealed;

  return (
    <div
      className={`min-h-0 transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none ${className}`}
      style={{
        opacity: isRevealing ? 0.45 : undefined,
        transform: isRevealing ? `translateY(${origin === "bottom" ? "6px" : "-6px"})` : undefined,
      }}
    >
      {children}
    </div>
  );
}

function AnimatedCollapse({
  open,
  id,
  closeFromHeight,
  children,
  className = "",
  innerClassName = "",
}: {
  open: boolean;
  id?: string;
  closeFromHeight?: number | null;
  children: React.ReactNode;
  className?: string;
  innerClassName?: string;
}) {
  const [shouldRender, setShouldRender] = useState(open);
  const [maxHeight, setMaxHeight] = useState<string | undefined>(open ? undefined : "0px");
  const [visible, setVisible] = useState(open);
  const outerRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);

  const measureOpenHeight = useCallback((outer: HTMLDivElement | null, inner: HTMLDivElement | null, fallbackHeight: number) => {
    if (!outer) {
      return ceilToDevicePixel(inner?.scrollHeight ?? fallbackHeight);
    }

    const previousTransition = outer.style.transition;
    const previousMaxHeight = outer.style.maxHeight;

    outer.style.transition = "none";
    outer.style.maxHeight = "none";
    const allocatedHeight = outer.getBoundingClientRect().height;
    outer.style.maxHeight = previousMaxHeight;
    outer.style.transition = previousTransition;

    return ceilToDevicePixel(allocatedHeight || inner?.scrollHeight || fallbackHeight);
  }, []);

  useLayoutEffect(() => {
    const outer = outerRef.current;
    const inner = innerRef.current;

    if (open) {
      setShouldRender(true);
      const currentHeight = ceilToDevicePixel(outer?.getBoundingClientRect().height ?? 0);
      const targetHeight = measureOpenHeight(outer, inner, currentHeight);
      setMaxHeight(`${currentHeight}px`);
      setVisible(true);

      const frame = window.requestAnimationFrame(() => {
        setMaxHeight(`${targetHeight}px`);
      });

      const timer = window.setTimeout(() => {
        setMaxHeight(undefined);
      }, SIDEBAR_COLLAPSE_DURATION_MS);

      return () => {
        window.cancelAnimationFrame(frame);
        window.clearTimeout(timer);
      };
    }

    if (!shouldRender) {
      return;
    }

    const currentHeight = closeFromHeight ?? outer?.offsetHeight ?? inner?.scrollHeight ?? 0;
    setMaxHeight(`${currentHeight}px`);
    setVisible(true);

    const frame = window.requestAnimationFrame(() => {
      setVisible(false);
      setMaxHeight("0px");
    });

    const timer = window.setTimeout(() => {
      setShouldRender(false);
    }, SIDEBAR_COLLAPSE_DURATION_MS);

    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(timer);
    };
  }, [open, shouldRender, closeFromHeight]);

  if (!shouldRender && !open) return null;

  return (
    <div
      ref={outerRef}
      id={id}
      aria-hidden={!open}
      className={`overflow-hidden transition-[max-height,opacity] duration-200 ease-out motion-reduce:transition-none ${
        visible ? "opacity-100" : "opacity-0 pointer-events-none"
      } ${className}`}
      style={{ maxHeight }}
    >
      <div ref={innerRef} className={`min-h-0 overflow-hidden ${innerClassName}`}>
        {children}
      </div>
    </div>
  );
}

function useCollapsedPreviewFade(expanded: boolean, hasPreview: boolean) {
  const [fadingIn, setFadingIn] = useState(!expanded && hasPreview);

  useEffect(() => {
    if (expanded || !hasPreview) {
      setFadingIn(false);
      return;
    }

    // Start invisible, fade in after collapse animation completes
    setFadingIn(false);
    const timer = window.setTimeout(() => {
      setFadingIn(true);
    }, SIDEBAR_COLLAPSE_DURATION_MS);

    return () => window.clearTimeout(timer);
  }, [expanded, hasPreview]);

  // Preview is always in the DOM when collapsed (reserves layout space),
  // but fades in after the collapse animation to avoid visual clutter mid-animation.
  return { showPreview: !expanded && hasPreview, fadeIn: fadingIn };
}

function CollapsedPreviewFrame({
  children,
  fadeIn = true,
  measureRef,
  measuring = false,
}: {
  children: React.ReactNode;
  fadeIn?: boolean;
  measureRef?: React.RefObject<HTMLDivElement | null>;
  measuring?: boolean;
}) {
  return (
    <div
      ref={measureRef}
      aria-hidden={measuring || !fadeIn}
      className={`px-2 pb-2 ${
        measuring
          ? "absolute left-0 right-0 top-0 invisible pointer-events-none"
          : `transition-opacity duration-200 ease-out ${fadeIn ? "opacity-100" : "opacity-0 pointer-events-none"}`
      }`}
    >
      {children}
    </div>
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
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
        className={`w-full text-left px-2.5 py-1.5 rounded-xl transition-all group relative border select-none ${
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
        <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={() => setContextMenu(null)} blocksSidebarClose>
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
  expanded: boolean;
  onToggleExpanded: () => void;
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
  const [expandedCloseHeight, setExpandedCloseHeight] = useState<number | null>(null);
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
    if (!expanded) {
      setShowAllChats(false);
    }
  }, [expanded]);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const collapsedPreviewMeasureRef = useRef<HTMLDivElement>(null);
  const expandedContentId = useId();

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

  const handleToggleExpanded = useCallback(() => {
    if (expanded) {
      const expandedHeight = document.getElementById(expandedContentId)?.offsetHeight ?? 0;
      const previewHeight = collapsedPreviewMeasureRef.current?.offsetHeight ?? 0;
      setExpandedCloseHeight(Math.max(0, expandedHeight - previewHeight));
    }
    onToggleExpanded();
  }, [expanded, expandedContentId, onToggleExpanded]);

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
  const { showPreview: collapsedPreviewVisible, fadeIn: collapsedPreviewFade } = useCollapsedPreviewFade(expanded, chats.length > 0);

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
    <div className="relative rounded-lg bg-white/[0.03] border border-white/[0.06]">
      {chats.length > 0 && (
        <CollapsedPreviewFrame measureRef={collapsedPreviewMeasureRef} measuring>
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
        </CollapsedPreviewFrame>
      )}
      <div
        className="flex items-center gap-1.5 px-2 py-1.5 group select-none"
        onContextMenu={handleHeaderContextMenu}
        {...longPressProps}
      >
        <button
          onClick={handleToggleExpanded}
          aria-expanded={expanded}
          aria-controls={expandedContentId}
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
      
      <AnimatedCollapse open={expanded} id={expandedContentId} closeFromHeight={expandedCloseHeight}>
        <div className="px-1 pb-1.5">
          <button
            onClick={() => onNewChat("agent", project.id)}
            onContextMenu={handleNewChatContextMenu}
            {...(onWarmNewChatBaseline ? newChatLongPressProps : {})}
            title={newChatBaselineTitle}
            className={`w-full px-2 py-1.5 rounded-xl text-sm font-medium border ${colors.bg} ${colors.border} ${colors.text} ${colors.hover} transition-all flex items-center justify-center gap-2 mb-2 pressable relative ${newChatBaselineClass(newChatBaselineResidency)}`}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 5v14" />
              <path d="M5 12h14" />
            </svg>
            New Chat
            {(newChatBaselineWarming || newChatBaselineQueued) && (
              <span className="absolute right-2 top-1/2 -translate-y-1/2" title={newChatBaselineQueued ? "New chat baseline warm queued" : "Warming new chat baseline"}>
                <PrefillActivityIcon paused={newChatBaselineQueued} />
              </span>
            )}
          </button>
          {chats.length > 0 ? (
            <>
              <div className="space-y-0.5">
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
                  className={`w-full px-2 py-1.5 mt-1 rounded-xl text-xs font-medium border transition-all ${colors.bg} ${colors.border} ${colors.text} ${colors.hover} pressable`}
                >
                  Show {chats.length - SIDEBAR_CHAT_PAGE_SIZE} more
                </button>
              )}
            </>
          ) : (
            <p className="text-center text-white/20 text-[10px] py-2">
              No chats yet
            </p>
          )}
        </div>
      </AnimatedCollapse>
      {/* Recent chat when collapsed — reserves final height immediately, then fades in after collapse */}
      {collapsedPreviewVisible && (
        <CollapsedPreviewFrame fadeIn={collapsedPreviewFade}>
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
        </CollapsedPreviewFrame>
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
  const projectsSectionRef = useRef<HTMLDivElement>(null);
  const agentSectionRef = useRef<HTMLDivElement>(null);
  const quickSectionRef = useRef<HTMLDivElement>(null);
  const agentScrollRef = useRef<HTMLDivElement>(null);
  const quickScrollRef = useRef<HTMLDivElement>(null);
  const agentPreviewMeasureRef = useRef<HTMLDivElement>(null);
  const quickPreviewMeasureRef = useRef<HTMLDivElement>(null);
  const projectsContentId = useId();
  const agentContentId = useId();
  const quickContentId = useId();
  const [projectsCloseHeight, setProjectsCloseHeight] = useState<number | null>(null);
  const [agentCloseHeight, setAgentCloseHeight] = useState<number | null>(null);
  const [quickCloseHeight, setQuickCloseHeight] = useState<number | null>(null);
  const [agentScrolled, setAgentScrolled] = useState(false);
  const [quickScrolled, setQuickScrolled] = useState(false);
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
  const mainSectionRefs = useMemo(
    () => [projectsSectionRef, agentSectionRef, quickSectionRef],
    []
  );
  const mainSectionExpandedStates = useMemo(
    () => [projects.length > 0 && projectsExpanded, agentExpanded, quickExpanded],
    [projects.length, projectsExpanded, agentExpanded, quickExpanded]
  );
  const mainSectionLayoutKey = mainSectionExpandedStates.join(":");
  const { openingSectionMotion, captureSnapshot: captureMainSectionSnapshot } = useOpeningSectionMotion(
    mainSectionRefs,
    mainSectionExpandedStates,
    mainSectionLayoutKey
  );

  useEffect(() => {
    if (!agentExpanded) { setAgentScrolled(false); setAgentShowAll(false); return; }
    const el = agentScrollRef.current;
    if (!el) return;
    const onScroll = () => setAgentScrolled(el.scrollTop > 0);
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [agentExpanded]);

  useEffect(() => {
    if (!quickExpanded) { setQuickScrolled(false); setQuickShowAll(false); return; }
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

  const handleToggleProjectsExpanded = useCallback(() => {
    captureMainSectionSnapshot();
    if (projectsExpanded) {
      setProjectsCloseHeight(document.getElementById(projectsContentId)?.offsetHeight ?? null);
    }
    setProjectsExpanded(!projectsExpanded);
  }, [captureMainSectionSnapshot, projectsExpanded, projectsContentId, setProjectsExpanded]);

  const handleToggleAgentExpanded = useCallback(() => {
    captureMainSectionSnapshot();
    if (agentExpanded) {
      const expandedHeight = document.getElementById(agentContentId)?.offsetHeight ?? 0;
      const previewHeight = agentPreviewMeasureRef.current?.offsetHeight ?? 0;
      setAgentCloseHeight(Math.max(0, expandedHeight - previewHeight));
    }
    setAgentExpanded(!agentExpanded);
  }, [captureMainSectionSnapshot, agentExpanded, agentContentId, setAgentExpanded]);

  const handleToggleQuickExpanded = useCallback(() => {
    captureMainSectionSnapshot();
    if (quickExpanded) {
      const expandedHeight = document.getElementById(quickContentId)?.offsetHeight ?? 0;
      const previewHeight = quickPreviewMeasureRef.current?.offsetHeight ?? 0;
      setQuickCloseHeight(Math.max(0, expandedHeight - previewHeight));
    }
    setQuickExpanded(!quickExpanded);
  }, [captureMainSectionSnapshot, quickExpanded, quickContentId, setQuickExpanded]);

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
  const { showPreview: agentPreviewVisible, fadeIn: agentPreviewFade } = useCollapsedPreviewFade(agentExpanded, agentChats.length > 0);
  const { showPreview: quickPreviewVisible, fadeIn: quickPreviewFade } = useCollapsedPreviewFade(quickExpanded, quickChats.length > 0);

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
    disabled: blockClose,
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
        className={`w-72 h-full flex flex-col backdrop-blur-xs bg-white/[0.03] border-r border-white/10 fixed inset-y-0 left-0 z-30 md:static md:translate-x-0 md:z-auto ${isDragging || isAnimating ? "" : "transition-transform duration-300 ease-in-out"} ${!isDragging && !isAnimating ? (isOpen ? "translate-x-0 md:translate-x-0" : "-translate-x-full md:translate-x-0") : ""}`}
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

      {/* Chat Sections — flex column, each section grows when expanded */}
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
          <div ref={projectsSectionRef} className={`relative flex flex-col min-h-0 border-b border-white/5 ${projectsExpanded ? "flex-1" : "shrink-0"}`}>
            <div className="px-3 pt-2 pb-0.5 shrink-0 flex items-center justify-between">
              <button
                onClick={handleToggleProjectsExpanded}
                aria-expanded={projectsExpanded}
                aria-controls={projectsContentId}
                className="flex items-center gap-1.5 px-1 mb-1 group cursor-pointer flex-1 min-w-0"
              >
                <span className="text-white/30 group-hover:text-white/50 transition-colors">
                  <ChevronIcon expanded={projectsExpanded} />
                </span>
                <span className="text-[10px] font-semibold tracking-wider uppercase text-white/30 group-hover:text-white/50 transition-colors">
                  Projects
                </span>
              </button>
              <div className="mb-1 ml-1 min-w-5 h-5 flex items-center justify-center shrink-0">
                {projectsExpanded ? (
                  <button
                    onClick={onNewProject}
                    className="w-5 h-5 flex items-center justify-center rounded-md text-white hover:text-white hover:bg-white/5 transition-colors pressable"
                    title="New project"
                    aria-label="New project"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="opacity-30 hover:opacity-60 transition-opacity">
                      <path d="M12 5v14" />
                      <path d="M5 12h14" />
                    </svg>
                  </button>
                ) : (
                  <span className="text-[10px] text-white/20 px-1">{projects.length}</span>
                )}
              </div>
            </div>
            <AnimatedCollapse open={projectsExpanded} id={projectsContentId} closeFromHeight={projectsCloseHeight} className="flex-1 min-h-0" innerClassName="flex flex-col h-full min-h-0">
              <div className="sidebar-scroll-pane flex-1 min-h-0 overflow-y-auto pb-1">
                <AnimatedListReveal
                  open={projectsExpanded}
                  animate={openingSectionMotion.index === 0}
                  origin={openingSectionMotion.index === 0 ? openingSectionMotion.revealOrigin : "top"}
                  className="space-y-1 pl-3 pr-2"
                >
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
                            pinned: updatedProject.pinned 
                          }),
                        });
                        if (!res.ok) {
                          const err = await res.json().catch(() => ({}));
                          throw new Error((err as any).error || "Failed to update project");
                        }
                        // Trigger a refresh of projects
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
                  ))}
                </AnimatedListReveal>
              </div>
            </AnimatedCollapse>
            <SectionDepthShadow visible={projectsExpanded} />
          </div>
        )}

        {/* New Project button when no projects exist */}
        {projects.length === 0 && (
          <div className="px-3 pt-3 pb-1 shrink-0 border-b border-white/5">
            <button
              onClick={onNewProject}
              className="w-full px-3 py-2 rounded-xl bg-emerald-500/15 border border-emerald-400/25 text-emerald-300 text-sm font-medium hover:bg-emerald-500/25 transition-all flex items-center justify-center gap-2 pressable"
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
        <div ref={agentSectionRef} className={`relative flex flex-col min-h-0 border-b border-white/5 ${agentExpanded ? "flex-1" : "shrink-0"}`}>
          {agentChats.length > 0 && (
            <CollapsedPreviewFrame measureRef={agentPreviewMeasureRef} measuring>
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
            </CollapsedPreviewFrame>
          )}
          {/* Section header — always visible */}
          <div className="px-3 pt-2 pb-0.5 shrink-0 flex items-center">
            <button
              onClick={handleToggleAgentExpanded}
              aria-expanded={agentExpanded}
              aria-controls={agentContentId}
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
              onContextMenu={handleNewChatContextMenu}
              {...(onWarmNewChatBaseline ? newChatLongPressProps : {})}
              aria-label="New agent chat"
              title={newChatBaselineTitle || "New agent chat"}
              aria-hidden={!(agentExpanded && agentScrolled)}
              tabIndex={agentExpanded && agentScrolled ? 0 : -1}
              className={`mb-1 ml-1 w-5 h-5 flex items-center justify-center rounded-md text-purple-300/70 hover:text-purple-200 hover:bg-purple-500/15 transition-opacity cursor-pointer pressable border ${newChatBaselineResidency ? "border-amber-400/35 shadow-[0_0_8px_rgba(251,191,36,0.12)]" : "border-transparent"} ${agentExpanded && agentScrolled ? "opacity-100" : "opacity-0 pointer-events-none"}`}
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
           {/* Scrollable chat list */}
          <AnimatedCollapse open={agentExpanded} id={agentContentId} closeFromHeight={agentCloseHeight} className="flex-1 min-h-0" innerClassName="flex flex-col h-full min-h-0">
            <div ref={agentScrollRef} className="sidebar-scroll-pane flex-1 min-h-0 overflow-y-auto overflow-x-hidden pb-1">
              <AnimatedListReveal
                open={agentExpanded}
                animate={openingSectionMotion.index === 1}
                origin={openingSectionMotion.index === 1 ? openingSectionMotion.revealOrigin : "top"}
                className="space-y-0.5 px-3"
              >
                <button
                  onClick={() => { onNewChat("agent"); onClose(); }}
                  onContextMenu={handleNewChatContextMenu}
                  {...(onWarmNewChatBaseline ? newChatLongPressProps : {})}
                  title={newChatBaselineTitle}
                  className={`w-full px-3 py-2 rounded-xl bg-purple-500/15 border border-purple-400/25 text-purple-300 text-sm font-medium hover:bg-purple-500/25 transition-all flex items-center justify-center gap-2 mb-2 pressable relative ${newChatBaselineClass(newChatBaselineResidency)}`}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 5v14" />
                    <path d="M5 12h14" />
                  </svg>
                  New Chat
                  {(newChatBaselineWarming || newChatBaselineQueued) && (
                    <span className="absolute right-3 top-1/2 -translate-y-1/2" title={newChatBaselineQueued ? "New chat baseline warm queued" : "Warming new chat baseline"}>
                      <PrefillActivityIcon paused={newChatBaselineQueued} />
                    </span>
                  )}
                </button>
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
                    className="w-full px-3 py-2 rounded-xl bg-purple-500/15 border border-purple-400/25 text-purple-300 text-xs font-medium hover:bg-purple-500/25 transition-all pressable"
                  >
                    Show {agentChats.length - SIDEBAR_CHAT_PAGE_SIZE} more
                  </button>
                )}
                {agentChats.length === 0 && (
                  <p className="text-center text-white/20 text-xs py-3 px-2">
                    Agent chats have persistent memory
                  </p>
                )}
              </AnimatedListReveal>
            </div>
          </AnimatedCollapse>
          {/* Recent chat when collapsed — reserves final height immediately, then fades in after collapse */}
          {agentPreviewVisible && (
            <CollapsedPreviewFrame fadeIn={agentPreviewFade}>
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
            </CollapsedPreviewFrame>
          )}
          <SectionDepthShadow visible={agentExpanded} />
        </div>

        {/* Quick Chats Section */}
        <div ref={quickSectionRef} className={`relative flex flex-col min-h-0 ${quickExpanded ? "flex-1" : "shrink-0"}`}>
          {quickChats.length > 0 && (
            <CollapsedPreviewFrame measureRef={quickPreviewMeasureRef} measuring>
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
            </CollapsedPreviewFrame>
          )}
          {/* Section header — always visible */}
          <div className="px-3 pt-2 pb-0.5 shrink-0 flex items-center">
            <button
              onClick={handleToggleQuickExpanded}
              aria-expanded={quickExpanded}
              aria-controls={quickContentId}
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
              className={`mb-1 ml-1 w-5 h-5 flex items-center justify-center rounded-md text-blue-300/70 hover:text-blue-200 hover:bg-blue-500/15 transition-opacity cursor-pointer pressable ${quickExpanded && quickScrolled ? "opacity-100" : "opacity-0 pointer-events-none"}`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 5v14" />
                <path d="M5 12h14" />
              </svg>
            </button>
          </div>
          {/* Scrollable chat list */}
          <AnimatedCollapse open={quickExpanded} id={quickContentId} closeFromHeight={quickCloseHeight} className="flex-1 min-h-0" innerClassName="flex flex-col h-full min-h-0">
            <div ref={quickScrollRef} className="sidebar-scroll-pane flex-1 min-h-0 overflow-y-auto overflow-x-hidden pb-2">
              <AnimatedListReveal
                open={quickExpanded}
                animate={openingSectionMotion.index === 2}
                origin={openingSectionMotion.index === 2 ? openingSectionMotion.revealOrigin : "top"}
                className="space-y-0.5 px-3"
              >
                <button
                  onClick={() => { onNewChat("quick"); onClose(); }}
                  className="w-full px-3 py-2 rounded-xl bg-blue-500/15 border border-blue-400/25 text-blue-300 text-sm font-medium hover:bg-blue-500/25 transition-all flex items-center justify-center gap-2 mb-2 pressable"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 5v14" />
                    <path d="M5 12h14" />
                  </svg>
                  New Quick Chat
                </button>
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
                    className="w-full px-3 py-2 rounded-xl bg-blue-500/15 border border-blue-400/25 text-blue-300 text-xs font-medium hover:bg-blue-500/25 transition-all pressable"
                  >
                    Show {quickChats.length - SIDEBAR_CHAT_PAGE_SIZE} more
                  </button>
                )}
                {quickChats.length === 0 && (
                  <p className="text-center text-white/20 text-xs py-3 px-2">
                    Standalone one-off conversations
                  </p>
                )}
              </AnimatedListReveal>
            </div>
          </AnimatedCollapse>
          {/* Recent chat when collapsed — reserves final height immediately, then fades in after collapse */}
          {quickPreviewVisible && (
            <CollapsedPreviewFrame fadeIn={quickPreviewFade}>
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
            </CollapsedPreviewFrame>
          )}
          <SectionDepthShadow visible={quickExpanded} />
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
