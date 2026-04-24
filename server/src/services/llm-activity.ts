// Process-local ref count of in-flight LLM inference streams. The resource
// coordinator checks this before unloading models: interrupting a live
// stream with an unload would drop the user's response mid-flight.
//
// Instrumentation principle: only wrap calls that produce user-visible
// streaming output (main chat, vision analysis). Fast background work
// (title generation, memory extraction, embeddings) uses lighter models
// on CPU — safe to ignore.

let activeStreams = 0;
const idleListeners: Array<{ maxActive: number; fn: () => void }> = [];

function notifyIdleListeners(): void {
  for (let i = idleListeners.length - 1; i >= 0; i--) {
    const listener = idleListeners[i];
    if (activeStreams <= listener.maxActive) {
      idleListeners.splice(i, 1);
      listener.fn();
    }
  }
}

export function beginStream(): void {
  activeStreams++;
}

export function endStream(): void {
  if (activeStreams <= 0) {
    activeStreams = 0;
    return;
  }
  activeStreams--;
  notifyIdleListeners();
}

export function isActive(): boolean {
  return activeStreams > 0;
}

export function activeStreamCount(): number {
  return activeStreams;
}

/**
 * Resolve as soon as activeStreams drops to 0. If already idle, resolves
 * immediately. If `signal` aborts, rejects with the abort reason and removes
 * the listener. No hard timeout — callers control it via their signal.
 */
export function waitForIdle(signal?: AbortSignal): Promise<void> {
  return waitForActiveCountAtMost(0, signal);
}

/**
 * Resolve as soon as the number of active user-visible LLM streams is at most
 * `maxActive`. This lets a request that is already counted as active wait for
 * other streams without waiting for itself.
 */
export function waitForActiveCountAtMost(maxActive: number, signal?: AbortSignal): Promise<void> {
  if (activeStreams <= maxActive) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const onIdle = () => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const onAbort = () => {
      const i = idleListeners.findIndex((listener) => listener.fn === onIdle);
      if (i >= 0) idleListeners.splice(i, 1);
      reject(signal?.reason ?? new Error("Aborted while waiting for LLM to finish"));
    };

    idleListeners.push({ maxActive, fn: onIdle });
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
