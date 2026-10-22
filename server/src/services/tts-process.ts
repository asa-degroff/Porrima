import type { ChildProcess } from "child_process";

/**
 * Wall-clock deadlines for one-shot TTS children.
 *
 * The persistent worker pool already has per-request timeouts and respawns a
 * wedged worker. The direct/fallback paths spawn a Python process per request
 * with no deadline: if model load or synthesis wedges, the request promise
 * never settles and the process lives forever.
 *
 * The children are spawned detached so a signal reaches the whole process
 * group (the Python wrapper may own ffmpeg or other helpers).
 */
export const TTS_FALLBACK_TIMEOUT_MS = {
  kokoro: 120_000,
  "qwen3-tts": 120_000,
  "supertonic-3": 30_000,
} as const;

const KILL_GRACE_MS = 2_000;

export interface TtsDeadline {
  /** Cancel the timer (call on close/error). */
  clear(): void;
  /** True once the deadline fired and the timeout was reported. */
  timedOut(): boolean;
}

export function armTtsDeadline(
  proc: ChildProcess,
  timeoutMs: number,
  onTimeout: (message: string) => void,
  label: string,
): TtsDeadline {
  let fired = false;
  const timer = setTimeout(() => {
    fired = true;
    killProcessTree(proc, "SIGTERM");
    const hardKill = setTimeout(() => killProcessTree(proc, "SIGKILL"), KILL_GRACE_MS);
    hardKill.unref?.();
    onTimeout(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`);
  }, timeoutMs);
  timer.unref?.();

  return {
    clear: () => clearTimeout(timer),
    timedOut: () => fired,
  };
}

/** Signal the child's process group when it has one, else the child itself. */
export function killProcessTree(proc: ChildProcess, signal: NodeJS.Signals): void {
  const pid = proc.pid;
  if (!pid) return;
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // Not a group leader (or the group is already gone) — fall back.
    }
  }
  try {
    proc.kill(signal);
  } catch {
    // Already exited.
  }
}