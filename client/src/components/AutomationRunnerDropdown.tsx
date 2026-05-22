import { useState, useCallback, useRef, useEffect } from "react";
import { useDropdown } from "../hooks/useDropdown";
import { fetchAutomations, runAutomationNow } from "../api/client";
import type { AutomationTask } from "../types";

interface Props {
  isSynthesizing?: boolean;
  isWakeCycleRunning?: boolean;
  isAutomationRunning?: boolean;
  isStreaming?: boolean;
}

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
}: Props) {
  const dropdown = useDropdown(false);
  const [tasks, setTasks] = useState<AutomationTask[]>([]);
  const [loading, setLoading] = useState(false);
  const [runningId, setRunningId] = useState<string | null>(null);
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
      className={`p-2 rounded-lg transition-all cursor-pointer ${
        isStreaming
          ? 'text-white/15 cursor-not-allowed'
          : 'text-white/30 hover:text-white/60 hover:bg-white/5'
      }`}
      title="Run automation"
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
            className="absolute z-30 top-full mt-1 -translate-x-1/2 left-1/2 animate-dropdown-enter backdrop-blur-xl border rounded-xl shadow-2xl py-1 overflow-hidden min-w-[180px]"
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

            {loading ? (
              <div className="px-3 py-2 text-xs text-white/40">Loading...</div>
            ) : tasks.length === 0 ? (
              <div className="px-3 py-2 text-xs text-white/40">No automations</div>
            ) : (
              <div>
                {tasks.map((task) => {
                  const disabled = isTaskDisabled(task);
                  const statusText = getTaskStatusText(task);
                  const isRunning = runningId === task.id;

                  return (
                    <button
                      key={task.id}
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
