import type { Chat, ChatMessage } from "../types.js";
import { estimateTextTokens } from "./token-count.js";
import {
  getCachedAugmentedPrompt,
  getCachedPromptBreakdown,
} from "./memory-context.js";
import { getAgentTools, type ToolSideEffects } from "./agent-tools.js";

/**
 * Context breakdown: attribute the current context window across the system
 * prompt, memory, tool schemas, conversation, and the model's last output.
 *
 * The LLM only reports aggregate input/output token counts, so every category
 * other than those two is an estimate. To keep the detail view honest, the
 * per-category estimates are scaled so the input-side categories sum exactly
 * to the real LLM-reported input count (when one is available). Output is the
 * real completion count and is never scaled.
 */

export type BreakdownGroup = "system" | "memory" | "tools" | "conversation" | "output";

export interface ContextBreakdownRow {
  key: string;
  label: string;
  group: BreakdownGroup;
  tokens: number;
}

export interface ContextBreakdownGroupTotal {
  key: BreakdownGroup;
  label: string;
  tokens: number;
}

export interface ContextBreakdown {
  chatId: string;
  contextWindow: number;
  /** Real LLM-reported figures from the latest agent turn, when present. */
  usage: { input: number; output: number; totalTokens: number } | null;
  /** True when no real usage anchor exists and figures are pure estimates. */
  estimated: boolean;
  /** True when the rendered-prompt cache was cold (e.g. after a restart). */
  promptCached: boolean;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  rows: ContextBreakdownRow[];
  groups: ContextBreakdownGroupTotal[];
}

// Noop side effects so we can build tool schemas for size estimation only.
const NOOP_EFFECTS: ToolSideEffects = {
  onArtifact: () => {},
  onVisual: () => {},
  onAskUser: () => {},
};

const GROUP_LABELS: Record<BreakdownGroup, string> = {
  system: "System prompt",
  memory: "Memory",
  tools: "Tools",
  conversation: "Conversation",
  output: "Output",
};

const GROUP_ORDER: BreakdownGroup[] = ["system", "memory", "tools", "conversation", "output"];

/** Per-message framing overhead (role headers, separators). Mirrors compaction.ts. */
const MESSAGE_FRAMING_TOKENS = 8;

function toolSchemaTokens(chat: Chat): number {
  if (chat.type === "quick") return 0;
  try {
    const contextWindow = chat.contextWindow || 32768;
    const tools = getAgentTools(chat.id, NOOP_EFFECTS, contextWindow, chat.projectId, chat.type);
    if (!tools.length) return 0;
    return estimateTextTokens(JSON.stringify(tools), "structured");
  } catch {
    return 0;
  }
}

/** Split in-context conversation messages into content categories. */
function conversationTokens(messages: ChatMessage[]): Record<string, number> {
  const acc = {
    userMessages: 0,
    assistantText: 0,
    thinking: 0,
    toolCalls: 0,
    toolResults: 0,
    memoryDelta: 0,
    compactionSummary: 0,
    framing: 0,
  };

  for (const m of messages) {
    if (m._outOfContext) continue;
    acc.framing += MESSAGE_FRAMING_TOKENS;

    // Hidden system rows are memory deltas / passive recall injected mid-history.
    if (m.role === "system") {
      acc.memoryDelta += estimateTextTokens(m.content);
      continue;
    }

    if (m.role === "user") {
      acc.userMessages += estimateTextTokens(m.content);
      if (m.timeAnchor) acc.userMessages += estimateTextTokens(m.timeAnchor);
      if (m.images?.length) acc.userMessages += m.images.length * 256;
      continue;
    }

    // agent
    if (m._isCompactionSummary) {
      acc.compactionSummary += estimateTextTokens(m.content);
      continue;
    }
    acc.assistantText += estimateTextTokens(m.content);
    if (m.thinking) acc.thinking += estimateTextTokens(m.thinking);
    if (m.toolCalls) {
      for (const tc of m.toolCalls) {
        let argTokens = 0;
        try {
          argTokens = estimateTextTokens(JSON.stringify(tc.arguments ?? {}), "structured");
        } catch {
          argTokens = 0;
        }
        acc.toolCalls += 50 + argTokens;
      }
    }
    if (m.toolResults) {
      for (const r of m.toolResults) {
        acc.toolResults += estimateTextTokens(r.content, "tool_result") + 20;
      }
    }
  }

  return acc;
}

/** Find the latest in-context agent usage to anchor the real input total. */
function latestUsage(messages: ChatMessage[]): { input: number; output: number; totalTokens: number } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m._outOfContext) continue;
    if (m.role === "assistant" && m.usage && m.usage.input > 0) {
      return { input: m.usage.input, output: m.usage.output, totalTokens: m.usage.totalTokens };
    }
  }
  return null;
}

export function computeContextBreakdown(chat: Chat, contextWindow: number): ContextBreakdown {
  const cachedPrompt = getCachedAugmentedPrompt(chat.id);
  const section = getCachedPromptBreakdown(chat.id);
  // Quick chats have no memory-augmented prompt to be "cold" — the base system
  // prompt is read directly from the chat, so treat it as fully resolved.
  const promptCached = cachedPrompt != null || chat.type === "quick";

  // ---- System prompt sections (from the captured stable-prefix breakdown) ----
  const basePrompt = section?.basePrompt ?? estimateTextTokens(chat.systemPrompt || "");
  const persona = section?.persona ?? 0;
  const userDocument = section?.userDocument ?? 0;
  const memoryBlocks = section?.memoryBlocks ?? 0;
  const zeitgeist = section?.zeitgeist ?? 0;
  const projectContext = section?.projectContext ?? 0;
  const retrievedMemories = section?.retrievedMemories ?? 0;

  // Skills are appended by the caller after the memory-context builder, so they
  // live at the tail of the cached rendered prompt. Isolate them by length.
  let skills = 0;
  if (cachedPrompt && section && cachedPrompt.length > section.systemPromptChars) {
    skills = estimateTextTokens(cachedPrompt.slice(section.systemPromptChars));
  }

  // ---- Tools + conversation ----
  const tools = toolSchemaTokens(chat);
  const conv = conversationTokens(chat.messages);
  // Memory deltas / passive recall live in chat history as hidden "system" rows;
  // the conversation sweep already counted them, so use that as the source of
  // truth (it reflects what is actually in context, including post-compaction
  // stripping of stale deltas).
  const memoryDelta = conv.memoryDelta;

  // ---- Assemble input-side rows (everything except the model's output) ----
  const inputRows: ContextBreakdownRow[] = [
    { key: "basePrompt", label: "Instructions", group: "system", tokens: basePrompt },
    { key: "persona", label: "Persona", group: "system", tokens: persona },
    { key: "userDocument", label: "User profile", group: "system", tokens: userDocument },
    { key: "projectContext", label: "Project (AGENTS.md)", group: "system", tokens: projectContext },
    { key: "zeitgeist", label: "Continuity (zeitgeist)", group: "system", tokens: zeitgeist },
    { key: "skills", label: "Skills", group: "system", tokens: skills },
    { key: "memoryBlocks", label: "Memory blocks", group: "memory", tokens: memoryBlocks },
    { key: "retrievedMemories", label: "Recalled memories", group: "memory", tokens: retrievedMemories },
    { key: "memoryDelta", label: "Memory updates", group: "memory", tokens: memoryDelta },
    { key: "tools", label: "Tool definitions", group: "tools", tokens: tools },
    { key: "userMessages", label: "Your messages", group: "conversation", tokens: conv.userMessages },
    { key: "assistantText", label: "Agent replies", group: "conversation", tokens: conv.assistantText },
    { key: "compactionSummary", label: "Compaction summary", group: "conversation", tokens: conv.compactionSummary },
    { key: "thinking", label: "Reasoning", group: "conversation", tokens: conv.thinking },
    { key: "toolCalls", label: "Tool calls", group: "conversation", tokens: conv.toolCalls },
    { key: "toolResults", label: "Tool results", group: "conversation", tokens: conv.toolResults },
    { key: "framing", label: "Message overhead", group: "conversation", tokens: conv.framing },
  ];

  const estimatedInput = inputRows.reduce((sum, r) => sum + r.tokens, 0);
  const usage = latestUsage(chat.messages);
  const hasAnchor = !!usage && usage.input > 0 && estimatedInput > 0;

  // Scale input-side estimates so they sum to the real reported input count.
  let scaledRows = inputRows;
  if (hasAnchor && usage) {
    const scale = usage.input / estimatedInput;
    scaledRows = inputRows.map((r) => ({ ...r, tokens: Math.round(r.tokens * scale) }));
    // Correct rounding drift on the largest row so the total matches exactly.
    const scaledTotal = scaledRows.reduce((sum, r) => sum + r.tokens, 0);
    const drift = usage.input - scaledTotal;
    if (drift !== 0) {
      let largest = 0;
      for (let i = 1; i < scaledRows.length; i++) {
        if (scaledRows[i].tokens > scaledRows[largest].tokens) largest = i;
      }
      scaledRows[largest] = { ...scaledRows[largest], tokens: Math.max(0, scaledRows[largest].tokens + drift) };
    }
  }

  const outputTokens = usage?.output ?? 0;
  const inputTokens = hasAnchor && usage ? usage.input : estimatedInput;
  const totalTokens = inputTokens + outputTokens;

  // Group totals (input groups from scaled rows; output added separately).
  const groupTotals = new Map<BreakdownGroup, number>();
  for (const r of scaledRows) {
    groupTotals.set(r.group, (groupTotals.get(r.group) ?? 0) + r.tokens);
  }
  groupTotals.set("output", outputTokens);

  const groups: ContextBreakdownGroupTotal[] = GROUP_ORDER
    .map((key) => ({ key, label: GROUP_LABELS[key], tokens: groupTotals.get(key) ?? 0 }))
    .filter((g) => g.tokens > 0);

  const rows = scaledRows.filter((r) => r.tokens > 0);

  return {
    chatId: chat.id,
    contextWindow,
    usage,
    estimated: !hasAnchor,
    promptCached,
    inputTokens,
    outputTokens,
    totalTokens,
    rows,
    groups,
  };
}
