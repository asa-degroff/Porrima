import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  StreamFn,
} from "@mariozechner/pi-agent-core";
import { agentLoop, agentLoopContinue } from "@mariozechner/pi-agent-core";
import type { Message, Model } from "@mariozechner/pi-ai";

export interface CreateAgentLoopConfigOptions {
  model: Model<string>;
  apiKey?: string;
  keepAlive?: string | number;
  getSteeringMessages?: () => Promise<AgentMessage[]>;
  getFollowUpMessages?: () => Promise<AgentMessage[]>;
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
}

export function createAgentLoopConfig(options: CreateAgentLoopConfigOptions): AgentLoopConfig {
  const config: AgentLoopConfig = {
    model: options.model,
    apiKey: options.apiKey || "ollama",
    reasoning: options.model.reasoning ? "medium" : undefined,
    convertToLlm: options.convertToLlm || ((messages) => messages as Message[]),
    transformContext: options.transformContext,
    getSteeringMessages: options.getSteeringMessages,
    getFollowUpMessages: options.getFollowUpMessages,
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

  const stream = mode === "start"
    ? agentLoop(prompts || [], context, config, signal, streamFn)
    : agentLoopContinue(context, config, signal, streamFn);

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
