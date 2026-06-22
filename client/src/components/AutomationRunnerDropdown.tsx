import { useState, useCallback, useRef, useEffect } from "react";
import { useDropdown } from "../hooks/useDropdown";
import { fetchAutomations, runAutomationNow } from "../api/client";
import type { AutomationTask, SystemPauseStatus } from "../types";

interface Props {
  isSynthesizing?: boolean;
  isWakeCycleRunning?: boolean;
  isAutomationRunning?: boolean;
  isStreaming?: boolean;
  systemPause?: SystemPauseStatus | null;
  onPauseSystem?: (durationMs: number | null) => Promise<void> | void;
  onResumeSystem?: () => Promise<void> | void;
}

const PAUSE_OPTIONS = [
  { id: "1h", label: "1 hour", durationMs: 60 * 60 * 1000 },
  { id: "6h", label: "6 hours", durationMs: 6 * 60 * 60 * 1000 },
  { id: "1d", label: "1 day", durationMs: 24 * 60 * 60 * 1000 },
  { id: "manual", label: "Until resumed", durationMs: null },
] as const;

function getDisplayTitle(task: AutomationTask): string {
  if (task.kind === "synthesis") return "Synthesis";
  if (task.kind === "wake") return "Wake Cycle";
  return task.title;
}

function getIconForKind(kind: AutomationTask["kind"]) {
  switch (kind) {
    case "synthesis":
      return (
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
        </svg>
      );
    case "wake":
      return (
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
        </svg>
      );
    default:
      return (
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polygon points="5 3 19 12 5 21 5 3" />
        </svg>
      );
  }
}

export function AutomationRunnerDropdown({
  isSynthesizing = false,
  isWakeCycleRunning = false,
  isAutomationRunning = false,
  isStreaming = false,
  systemPause = null,
  onPauseSystem,
  onResumeSystem,
}: Props) {
  const dropdown = useDropdown(false);
  const [tasks, setTasks] = useState<AutomationTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [pauseActionId, setPauseActionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadedRef = useRef(false);

  // Close dropdown when streaming starts — prevents user being stuck with an open menu
  useEffect(() => {
    if (isStreaming && dropdown.open) {
      dropdown.close();
    }
  }, [isStreaming, dropdown]);

  // Fetch automations on first open
  useEffect(() => {
    if (dropdown.open && !loadedRef.current && !loading) {
      loadedRef.current = true;
      (async () => {
        setLoading(true);
        setError(null);
        try {
          const res = await fetchAutomations();
          // Sort: built-in first (synthesis, wake), then custom by orderIndex
          const sorted = [...res.tasks].sort((a, b) => {
            if (a.builtIn !== b.builtIn) return a.builtIn ? -1 : 1;
            return a.orderIndex - b.orderIndex;
          });
          setTasks(sorted);
        } catch (e: any) {
          console.error("[AutomationRunnerDropdown] Failed to fetch:", e.message);
          setError("Could not load automations");
        } finally {
          setLoading(false);
        }
      })();
    }
  }, [dropdown.open, loading]);

  const handleRun = useCallback(async (task: AutomationTask) => {
    if (runningId) return;
    setRunningId(task.id);
    setError(null);
    try {
      await runAutomationNow(task.id);
      dropdown.close();
    } catch (e: any) {
      console.error(`[AutomationRunnerDropdown] Run failed:`, e.message);
      setError(e.message || "Run failed");
    } finally {
      setRunningId(null);
    }
  }, [runningId, dropdown]);

  const handlePause = useCallback(async (id: string, durationMs: number | null) => {
    if (!onPauseSystem || pauseActionId) return;
    setPauseActionId(id);
    setError(null);
    try {
      await onPauseSystem(durationMs);
      dropdown.close();
    } catch (e: any) {
      console.error("[AutomationRunnerDropdown] Pause failed:", e.message);
      setError(e.message || "Pause failed");
    } finally {
      setPauseActionId(null);
    }
  }, [onPauseSystem, pauseActionId, dropdown]);

  const handleResume = useCallback(async () => {
    if (!onResumeSystem || pauseActionId) return;
    setPauseActionId("resume");
    setError(null);
    try {
      await onResumeSystem();
      dropdown.close();
    } catch (e: any) {
      console.error("[AutomationRunnerDropdown] Resume failed:", e.message);
      setError(e.message || "Resume failed");
    } finally {
      setPauseActionId(null);
    }
  }, [onResumeSystem, pauseActionId, dropdown]);

  const isTaskDisabled = useCallback((task: AutomationTask) => {
    const isStreamingActive = isStreaming;
    if (task.kind === "synthesis" && isSynthesizing) return true;
    if (task.kind === "wake" && isWakeCycleRunning) return true;
    if (task.kind === "custom" && isAutomationRunning) return true;
    if (runningId === task.id) return true;
    if (isStreamingActive) return true;
    return false;
  }, [isSynthesizing, isWakeCycleRunning, isAutomationRunning, runningId, isStreaming]);

  const getTaskStatusText = useCallback((task: AutomationTask) => {
    if (isStreaming) return "Chat active — will run after response completes";
    if (task.kind === "synthesis" && isSynthesizing) return "Already running";
    if (task.kind === "wake" && isWakeCycleRunning) return "Already running";
    if (task.kind === "custom" && isAutomationRunning) return "Automation in progress";
    if (runningId === task.id) return "Starting...";
    return undefined;
  }, [isSynthesizing, isWakeCycleRunning, isAutomationRunning, runningId, isStreaming]);

  const trigger = (
    <button
      onClick={() => !isStreaming && dropdown.toggle()}
      disabled={isStreaming}
      className={`p-2 rounded-lg transition-all cursor-pointer pressable ${
        isStreaming
          ? 'text-white/15 cursor-not-allowed'
          : 'text-white/30 hover:text-white/60 hover:bg-white/5'
      }`}
      type="button"
      aria-label="Automation actions"
      title="Run automation or pause background work"
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
      </svg>
    </button>
  );

  return (
    <div className="relative">
      <div ref={dropdown.ref}>
        {trigger}
        {dropdown.open && (
          <div
            className="absolute z-30 top-full mt-1 -translate-x-1/2 left-1/2 animate-dropdown-enter app-solid-popover border rounded-xl shadow-2xl py-1 overflow-hidden min-w-[180px]"
            style={{
              backgroundColor: `color-mix(in srgb, rgb(var(--theme-primary)) 8%, rgb(15, 15, 20) 92%)`,
              borderColor: `rgba(var(--theme-primary-border))`,
            }}
          >
            {error && (
              <div className="px-3 py-2 text-xs text-red-400/80 border-b border-white/5">
                {error}
              </div>
            )}

            <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-white/30">
              Pause for...
            </div>
            <div className="pb-1">
              {PAUSE_OPTIONS.map((option) => {
                const busy = pauseActionId === option.id;
                const disabled = !onPauseSystem || Boolean(pauseActionId);
                return (
                  <button
                    key={option.id}
                    type="button"
                    onClick={() => !disabled && handlePause(option.id, option.durationMs)}
                    disabled={disabled}
                    className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm transition-colors text-left ${
                      disabled
                        ? "text-white/25 cursor-not-allowed"
                        : "text-white/80 hover:bg-white/5 hover:text-white"
                    }`}
                  >
                    <span>
                      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="6" y="4" width="4" height="16" rx="1" />
                        <rect x="14" y="4" width="4" height="16" rx="1" />
                      </svg>
                    </span>
                    <span className="truncate flex-1">{option.label}</span>
                    {busy && <span className="text-white/30 text-[10px]">...</span>}
                  </button>
                );
              })}
              {systemPause?.active && (
                <button
                  type="button"
                  onClick={() => handleResume()}
                  disabled={!onResumeSystem || Boolean(pauseActionId)}
                  title={systemPause.pending ? "Pause is pending until current background work finishes" : undefined}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-sm transition-colors text-left text-emerald-200/80 hover:bg-white/5 hover:text-emerald-100"
                >
                  <span>
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                      <polygon points="7 4 19 12 7 20 7 4" />
                    </svg>
                  </span>
                  <span className="truncate flex-1">Resume</span>
                  {pauseActionId === "resume" && <span className="text-white/30 text-[10px]">...</span>}
                </button>
              )}
            </div>

            <div className="h-px bg-white/5" />

            <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wide text-white/30">
              Run now
            </div>

            {loading ? (
              <div className="px-3 py-2 text-xs text-white/40">Loading...</div>
            ) : tasks.filter(t => t.enabled && !t.archived).length === 0 ? (
              <div className="px-3 py-2 text-xs text-white/40">No automations</div>
            ) : (
              <div>
                {tasks.filter(t => t.enabled && !t.archived).map((task) => {
                  const disabled = isTaskDisabled(task);
                  const statusText = getTaskStatusText(task);
                  const isRunning = runningId === task.id;

                  return (
                    <button
                      key={task.id}
                      type="button"
                      onClick={() => !disabled && handleRun(task)}
                      disabled={disabled}
                      title={statusText}
                      className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm transition-colors text-left ${
                        disabled
                          ? "text-white/25 cursor-not-allowed"
                          : "text-white/80 hover:bg-white/5 hover:text-white"
                      }`}
                    >
                      <span className={isRunning ? "animate-spin" : ""}>
                        {getIconForKind(task.kind)}
                      </span>
                      <span className="truncate flex-1">{getDisplayTitle(task)}</span>
                      {isRunning && (
                        <span className="text-white/30 text-[10px]">…</span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
