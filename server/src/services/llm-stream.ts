import type { AssistantMessage } from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream, streamSimple } from "@mariozechner/pi-ai";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import { beginStream as beginLLMStream, endStream as endLLMStream } from "./llm-activity.js";

/**
 * Inactivity timeouts for LLM streaming.
 *
 * Local models can take several minutes to load and prefill large contexts.
 * Cloud models should answer faster, but may still buffer large tool-call
 * arguments before the first event.
 */
const LOCAL_INACTIVITY_TIMEOUT_MS = 1_800_000;
const CLOUD_INACTIVITY_TIMEOUT_MS = 300_000;
const CLOUD_FIRST_EVENT_TIMEOUT_MS = 300_000;

function isCloudModel(modelId: string): boolean {
  return modelId.includes(":cloud");
}

/**
 * Create a stream function that handles pre-aborted signals gracefully, merges
 * per-chat Ollama options, records LLM activity, and converts stream stalls into
 * explicit assistant error events.
 */
export function createSafeStreamFn(
  chatOllamaOptions?: { keepAlive?: string | number; numGpu?: number; numPredict?: number },
): StreamFn {
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

    const mergedOptions = chatOllamaOptions
      ? {
          ...options,
          keepAlive: chatOllamaOptions.keepAlive,
          numGpu: chatOllamaOptions.numGpu,
          numPredict: chatOllamaOptions.numPredict,
        }
      : options;

    const rawStream = streamSimple(model, ctx, mergedOptions);
    const wrappedStream = createAssistantMessageEventStream();

    const cloud = isCloudModel(model.id);
    const ongoingTimeout = cloud ? CLOUD_INACTIVITY_TIMEOUT_MS : LOCAL_INACTIVITY_TIMEOUT_MS;
    const firstEventTimeout = cloud ? CLOUD_FIRST_EVENT_TIMEOUT_MS : LOCAL_INACTIVITY_TIMEOUT_MS;

    (async () => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let ended = false;
      let receivedFirstEvent = false;

      const endStream = () => {
        if (!ended) {
          ended = true;
          wrappedStream.end();
        }
      };

      const resetTimer = () => {
        if (timer) clearTimeout(timer);
        const timeout = receivedFirstEvent ? ongoingTimeout : firstEventTimeout;
        timer = setTimeout(() => {
          console.error(
            `[stream] inactivity timeout (${timeout}ms, cloud=${cloud}, firstEvent=${receivedFirstEvent}) - model may be stuck: ${model.id}`,
          );
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
            errorMessage: `Model unresponsive for ${timeout / 1000}s - it may be stuck loading. Try again or use a different model.`,
            timestamp: Date.now(),
          };
          wrappedStream.push({
            type: "error",
            reason: "error",
            error: errorMsg,
          } as any);
          endStream();
        }, timeout);
      };

      resetTimer();
      beginLLMStream();

      try {
        for await (const event of rawStream) {
          if (ended) break;
          receivedFirstEvent = true;
          resetTimer();
          wrappedStream.push(event);
        }
      } catch (err) {
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
        endLLMStream();
        endStream();
      }
    })();

    return wrappedStream;
  };
}
