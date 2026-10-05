import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentTurnContext,
  StreamFn,
} from "@earendil-works/pi-agent-core";
import { agentLoop, agentLoopContinue } from "@earendil-works/pi-agent-core";
import type { Message, Model } from "@earendil-works/pi-ai";
import { createInitialSystemMessage } from "@earendil-works/pi-ai";

export interface CreateAgentLoopConfigOptions {
  model: Model<string>;
  apiKey?: string;
  keepAlive?: string | number;
  /**
   * System prompt for this run. pi-agent-core 1.0 carries the prompt as the
   * transcript's leading system message, so this wrapper prepends it at the
   * convertToLlm boundary — one place, shared by live, replay, and headless
   * paths. A getter is re-evaluated per request, so a mid-turn prompt rebuild
   * (compaction, skill activation) is picked up like the old per-context
   * `systemPrompt` field was.
   */
  systemPrompt?: string | (() => string | undefined);
  getSteeringMessages?: () => Promise<AgentMessage[]>;
  getFollowUpMessages?: () => Promise<AgentMessage[]>;
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  shouldStopAfterTurn?: (context: AgentTurnContext) => boolean | Promise<boolean>;
}

export function createAgentLoopConfig(options: CreateAgentLoopConfigOptions): AgentLoopConfig {
  const systemPromptOption = options.systemPrompt;
  const getSystemPrompt =
    typeof systemPromptOption === "function" ? systemPromptOption : () => systemPromptOption;
  const baseConvertToLlm = options.convertToLlm ?? ((messages: AgentMessage[]) => messages as Message[]);

  const config: AgentLoopConfig = {
    model: options.model,
    apiKey: options.apiKey || "llamacpp",
    reasoning: options.model.reasoning ? "medium" : undefined,
    convertToLlm: async (messages) => {
      const converted = await baseConvertToLlm(messages);
      const system = createInitialSystemMessage(getSystemPrompt(), undefined);
      return system ? [system, ...converted] : converted;
    },
    transformContext: options.transformContext,
    getSteeringMessages: options.getSteeringMessages,
    getFollowUpMessages: options.getFollowUpMessages,
    finishTurn: options.shouldStopAfterTurn
      ? async (turn) => {
          // The removed shouldStopAfterTurn ran only for normal responses;
          // finishTurn also runs for error/aborted responses, whose decisions
          // are ignored because those responses are hard exits.
          if (turn.message.stopReason === "error" || turn.message.stopReason === "aborted") {
            return undefined;
          }
          return (await options.shouldStopAfterTurn!(turn)) ? { action: "end" } : undefined;
        }
      : undefined,
    toolExecution: "parallel",
  };
  if (options.keepAlive !== undefined) {
    (config as any).keepAlive = options.keepAlive;
  }
  return config;
}

export interface RunAgentLoopOptions {
  context: AgentContext;
  config: AgentLoopConfig;
  signal?: AbortSignal;
  streamFn?: StreamFn;
  logPrefix?: string;
  mode: "start" | "continue";
  prompts?: AgentMessage[];
  onEvent?: (event: AgentEvent) => void | Promise<void>;
}

export interface RunAgentLoopResult {
  events: number;
  messages: AgentMessage[];
}

class StopAgentLoop extends Error {
  constructor() {
    super("Agent loop stopped by caller");
    this.name = "StopAgentLoop";
  }
}

export function stopAgentLoop(): never {
  throw new StopAgentLoop();
}

/**
 * Low-level pi-agent-core loop driver shared by HTTP chats and headless
 * automations. Callers own prompt construction, compaction, history mutation,
 * transport events, and persistence so KV-cache-sensitive replay shape stays
 * outside this core. Callback and stream-result errors are intentionally
 * propagated; adapters decide whether to map them to SSE errors or a headless
 * failed turn.
 */
export async function runAgentLoop(options: RunAgentLoopOptions): Promise<RunAgentLoopResult> {
  const {
    context,
    config,
    signal,
    streamFn,
    mode,
    prompts,
    onEvent,
    logPrefix = "agent-loop",
  } = options;

  // pi-agent-core 0.80+ requires streamFn to be non-optional.
  // All Porrima callers always provide one; this is a safety fallback.
  const effectiveStreamFn: StreamFn = streamFn || (() => {
    throw new Error("streamFn not provided — all callers must provide a stream function");
  });

  const stream = mode === "start"
    ? agentLoop(prompts || [], context, config, signal, effectiveStreamFn)
    : agentLoopContinue(context, config, signal, effectiveStreamFn);

  let events = 0;
  try {
    for await (const event of stream) {
      events++;
      await onEvent?.(event);
    }
  } catch (e: any) {
    if (e instanceof StopAgentLoop) {
      return { events, messages: [] };
    }
    console.error(`[${logPrefix}] loop failed:`, e?.message || e);
    throw e;
  }

  try {
    const messages = await stream.result();
    return { events, messages };
  } catch (e: any) {
    console.error(`[${logPrefix}] result retrieval failed:`, e?.message || e);
    throw e;
  }
}
