import type { AssistantMessage } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream, streamSimple } from "@mariozechner/pi-ai";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import { beginStream as beginLLMStream, endStream as endLLMStream } from "./llm-activity.js";
import type { LlamaSlotLease } from "./llama-slot-leases.js";
import type { ModelProgressCallback, ModelProgressEvent } from "./model-progress.js";

/**
 * Inactivity timeouts for LLM streaming.
 *
 * Local models can take several minutes to load and prefill large contexts.
 * Cloud models should answer faster, but may still buffer large tool-call
 * arguments before the first event.
 */
const LOCAL_INACTIVITY_TIMEOUT_MS = 1_800_000;
const LOCAL_PREFILL_NO_PROGRESS_TIMEOUT_MS = 600_000;
const LOCAL_FIRST_EVENT_ABSOLUTE_TIMEOUT_MS = 7_200_000;
const CLOUD_INACTIVITY_TIMEOUT_MS = 300_000;
const CLOUD_FIRST_EVENT_TIMEOUT_MS = 300_000;

function isCloudModel(modelId: string): boolean {
  return modelId.includes(":cloud");
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export interface SafeStreamHooks {
  onModelProgress?: ModelProgressCallback;
  promptDebugChatId?: string;
  /** Controls whether the prefill progress indicator should be shown.
   *  - `true`: always show (first turns)
   *  - `false`: always hide
   *  - `undefined`: defer to provider cold-prefill detection
   *  - function: evaluated per-LLM-call with iteration count for dynamic control */
  modelProgressShowIndicator?: boolean | ((iteration: number) => boolean | undefined);
}

/**
 * Create a stream function that handles pre-aborted signals gracefully, merges
 * per-chat Ollama options, records LLM activity, and converts stream stalls into
 * explicit assistant error events.
 */
export function createSafeStreamFn(
  chatOllamaOptions?: { keepAlive?: string | number; numGpu?: number; numPredict?: number },
  llamaSlotLease?: LlamaSlotLease | null,
  hooks?: SafeStreamHooks,
): StreamFn {
  const showIndicatorConfig = hooks?.modelProgressShowIndicator;
  // Track LLM call count within this agent loop (1 = first call, 2+ = tool iterations)
  let iterationCount = 0;
  return (model, ctx, options) => {
    if (options?.signal?.aborted) {
      console.log("[stream] signal already aborted, returning empty abort stream");
      const stream = createAssistantMessageEventStream();
      const msg: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "aborted",
        timestamp: Date.now(),
      };
      stream.push({ type: "error", reason: "aborted", error: msg });
      return stream;
    }

    const streamAbortController = new AbortController();
    const externalSignal = options?.signal;
    const onExternalAbort = () => {
      if (!streamAbortController.signal.aborted) {
        streamAbortController.abort(externalSignal?.reason);
      }
    };
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });

    const pendingProgress: ModelProgressEvent[] = [];
    let handleProviderProgress: ModelProgressCallback = (progress) => {
      pendingProgress.push(progress);
    };

    const mergedOptions: Record<string, unknown> = { ...(options ?? {}) };
    mergedOptions.signal = streamAbortController.signal;
    mergedOptions.onModelProgress = (progress: ModelProgressEvent) => handleProviderProgress(progress);

    // Resolve showIndicator per-LLM-call: supports static boolean, undefined, or function(iteration)
    iterationCount++;
    if (typeof showIndicatorConfig === "function") {
      mergedOptions.modelProgressShowIndicator = showIndicatorConfig(iterationCount);
    } else {
      mergedOptions.modelProgressShowIndicator = showIndicatorConfig ?? false;
    }
    if (chatOllamaOptions) {
      mergedOptions.keepAlive = chatOllamaOptions.keepAlive;
      mergedOptions.numGpu = chatOllamaOptions.numGpu;
      mergedOptions.numPredict = chatOllamaOptions.numPredict;
    }
    if (llamaSlotLease) {
      mergedOptions.llamaSlotLease = llamaSlotLease;
    }
    if (hooks?.promptDebugChatId) {
      mergedOptions.llamaPromptDebugChatId = hooks.promptDebugChatId;
    }

    const rawStream = streamSimple(model, ctx, mergedOptions as any);
    const wrappedStream = createAssistantMessageEventStream();

    const cloud = isCloudModel(model.id);
    const ongoingTimeout = cloud ? CLOUD_INACTIVITY_TIMEOUT_MS : LOCAL_INACTIVITY_TIMEOUT_MS;
    const firstEventTimeout = cloud ? CLOUD_FIRST_EVENT_TIMEOUT_MS : LOCAL_INACTIVITY_TIMEOUT_MS;
    const localNoProgressTimeout = readPositiveIntEnv("LLM_LOCAL_PREFILL_NO_PROGRESS_TIMEOUT_MS", LOCAL_PREFILL_NO_PROGRESS_TIMEOUT_MS);
    const localAbsoluteTimeout = readPositiveIntEnv("LLM_LOCAL_FIRST_EVENT_ABSOLUTE_TIMEOUT_MS", LOCAL_FIRST_EVENT_ABSOLUTE_TIMEOUT_MS);

    (async () => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let absoluteTimer: ReturnType<typeof setTimeout> | null = null;
      let ended = false;
      let receivedFirstEvent = false;
      let receivedProviderProgress = false;

      const endStream = () => {
        if (!ended) {
          ended = true;
          wrappedStream.end();
        }
      };

      const failStream = (message: string) => {
        if (ended) return;
        console.error(message);
        if (!streamAbortController.signal.aborted) {
          streamAbortController.abort(new Error(message));
        }
        const errorMsg: AssistantMessage = {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "error",
          errorMessage: message,
          timestamp: Date.now(),
        };
        wrappedStream.push({
          type: "error",
          reason: "error",
          error: errorMsg,
        } as any);
        endStream();
      };

      const resetTimer = () => {
        if (timer) clearTimeout(timer);
        const timeout = receivedFirstEvent
          ? ongoingTimeout
          : (!cloud && receivedProviderProgress ? localNoProgressTimeout : firstEventTimeout);
        timer = setTimeout(() => {
          const progressText = receivedProviderProgress ? "no prefill progress" : "no first event";
          failStream(
            `Model unresponsive for ${timeout / 1000}s (${progressText}) - it may be stuck loading. Try again or use a different model.`,
          );
        }, timeout);
      };

      handleProviderProgress = (progress) => {
        if (ended || streamAbortController.signal.aborted) return;
        if (progress.phase === "prefill" && typeof progress.processedTokens === "number" && progress.processedTokens > 0) {
          receivedProviderProgress = true;
        }
        resetTimer();
        hooks?.onModelProgress?.(progress);
      };
      for (const progress of pendingProgress.splice(0)) {
        handleProviderProgress(progress);
      }

      resetTimer();
      if (!cloud) {
        absoluteTimer = setTimeout(() => {
          if (!receivedFirstEvent) {
            failStream(
              `Model unresponsive for ${localAbsoluteTimeout / 1000}s before first output - long prefill exceeded the hard timeout.`,
            );
          }
        }, localAbsoluteTimeout);
      }
      beginLLMStream();

      try {
        for await (const event of rawStream) {
          if (ended) break;
          if (!receivedFirstEvent) {
            receivedFirstEvent = true;
            if (absoluteTimer) {
              clearTimeout(absoluteTimer);
              absoluteTimer = null;
            }
          }
          resetTimer();
          wrappedStream.push(event);
        }
      } catch (err) {
        if (ended) return;
        console.error("[stream] error from LLM stream:", err);
        const errorMsg: AssistantMessage = {
          role: "assistant",
          content: [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "error",
          errorMessage: err instanceof Error ? err.message : String(err),
          timestamp: Date.now(),
        };
        wrappedStream.push({
          type: "error",
          reason: "error",
          error: errorMsg,
        } as any);
      } finally {
        if (timer) clearTimeout(timer);
        if (absoluteTimer) clearTimeout(absoluteTimer);
        externalSignal?.removeEventListener("abort", onExternalAbort);
        endLLMStream();
        endStream();
      }
    })();

    return wrappedStream;
  };
}
