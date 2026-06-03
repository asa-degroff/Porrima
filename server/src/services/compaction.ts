import type { Chat, ChatMessage } from "../types.js";
import { getNextArchiveSequence, saveArchives, getArchive, getChat, saveChat, withChatWriteLock, type ContextArchive, updateChatTitle } from "./chat-storage.js";
import { regenerateTitle } from "./title-generation.js";
import { readOpenAIContentStream, withExtractionMutex } from "./memory-extraction.js";
import { recordModelStats } from "./model-stats.js";
import { ensureRouterModelLoaded, normalizeRouterModelId } from "./llama-router-client.js";
import { resolveExtractionRequestSettings } from "./extraction-settings.js";
import {
  countLlamaTextTokens,
  estimateTextTokens,
  shouldExactCountText,
} from "./token-count.js";
import { recordToolResultExactTokenEstimate } from "./token-estimate-observability.js";

export interface CompactionResult {
  truncated: boolean;
  removedCount: number;
  removedMessages?: ChatMessage[];
  /** Estimated token count of removed messages (chars/4 approximation) */
  estimatedTokenCount?: number;
}

export const COMPACTION_TRIGGER_RATIO = 0.85;
export const COMPACTION_TARGET_RATIO = 0.30;
export const COMPACTION_HARD_CAP_RATIO = 0.95;
const ARCHIVE_INDEX_MAX_TOKENS = 768;

/**
 * Detect tool-call-like syntax in thinking text.
 *
 * Models like Qwen 3.5/3.6 via llama.cpp sometimes draft tool calls in their
 * thinking stream (e.g. `<function=read_file>...</function>`) as part of
 * internal reasoning, but then stop with stopReason="stop" instead of emitting
 * the actual structured tool call. This leaves the tool call stranded as text.
 *
 * Returns true if the thinking text contains what looks like a drafted tool call
 * that was never materialized into a structured call.
 */
export function hasStrandedToolCall(thinkingText: string): boolean {
  if (!thinkingText || thinkingText.length < 20) return false;
  // Match the pi-ai tool call XML-like syntax in thinking text.
  // The model drafts tool calls as: <function=name> or <function/name>
  // (sometimes with / instead of =, depending on model version/prompting).
  // We match either form to be robust.
  const toolCallPattern = /<function[=\/][a-zA-Z_][a-zA-Z0-9_]*>/;
  return toolCallPattern.test(thinkingText);
}

/**
 * Estimate token count from character count and content shape. English prose
 * averages ~4 chars/token, but dense SVG/JSON/code/log text can be closer to
 * 1.5 chars/token.
 */
function estimateTokens(text: string, kind: "default" | "structured" | "tool_result" = "default"): number {
  return estimateTextTokens(text, kind);
}

/**
 * Per-in-context-message framing overhead. Covers role headers, chat-template
 * separators, begin/end-of-turn markers, and other wire-format scaffolding
 * that the char-based estimator would otherwise miss. Anthropic/OpenAI both
 * document ~4 tokens/message; 8 is deliberately conservative because pi-ai
 * splits tool results into their own messages and chat templates vary.
 */
const MESSAGE_FRAMING_TOKENS = 8;

/**
 * Estimate token cost of the serialized tool schema sent with every request.
 * With ~30 tools each carrying a JSON schema, this can easily add 5–10K tokens
 * that would otherwise go uncounted and let compaction skip past the
 * threshold while the actual payload exceeds the model's window.
 */
function estimateToolSchemaTokens(tools: unknown): number {
  if (!tools) return 0;
  const arr = Array.isArray(tools) ? tools : [tools];
  if (arr.length === 0) return 0;
  try {
    return estimateTokens(JSON.stringify(arr), "structured");
  } catch {
    return 0;
  }
}

function estimateToolCallTokens(toolCall: NonNullable<ChatMessage["toolCalls"]>[number]): number {
  let tokens = 50;
  try {
    tokens += estimateTokens(JSON.stringify(toolCall.arguments ?? {}), "structured");
  } catch {
    // Keep the fixed call overhead if arguments are not serializable.
  }
  return tokens;
}

function estimateToolResultContentTokens(content: string): number {
  return estimateTokens(content, "tool_result");
}

function estimateToolResultPromptTokens(content: string): number {
  return estimateToolResultContentTokens(content) + 20 + MESSAGE_FRAMING_TOKENS;
}

function estimateMessageContentTokens(m: ChatMessage): number {
  let tokens = estimateTokens(m.content);
  if (m.role === "user" && m.images?.length) tokens += m.images.length * 256;
  if (m.role === "assistant") {
    if (m.thinking) tokens += estimateTokens(m.thinking);
    if (m.toolCalls) {
      for (const tc of m.toolCalls) tokens += estimateToolCallTokens(tc);
    }
    if (m.toolResults) {
      for (const r of m.toolResults) tokens += estimateToolResultContentTokens(r.content) + 20;
    }
  }
  return tokens;
}

function scaledMessageContentTokens(m: ChatMessage, scaleFactor: number): number {
  return Math.ceil(estimateMessageContentTokens(m) * scaleFactor);
}

/**
 * Pure character-based estimate of all in-context messages + system prompt.
 * Does not rely on LLM-reported usage. Cheap, deterministic, and unaffected
 * by stale anchors when the system prompt or tool schemas change between turns.
 */
function charEstimateContextSize(
  messages: Chat["messages"],
  systemPrompt: string,
  tools?: unknown,
): number {
  let total = estimateTokens(systemPrompt);
  total += estimateToolSchemaTokens(tools);
  for (const m of messages) {
    if (m._outOfContext) continue;
    total += MESSAGE_FRAMING_TOKENS;
    if (m.role === "assistant" && m.toolResults) {
      total += estimateTokens(m.content);
      if (m.thinking) total += estimateTokens(m.thinking);
      if (m.toolCalls) {
        for (const tc of m.toolCalls) total += estimateToolCallTokens(tc);
      }
      // Each tool result is its own framed pi-ai message at send time.
      for (const r of m.toolResults) total += estimateToolResultPromptTokens(r.content);
    } else if (m.role === "system") {
      // Persisted system-delta messages (memory injections) take real space
      // in the prompt — count them so compaction triggers when needed.
      total += estimateTokens(m.content);
    } else {
      total += estimateMessageContentTokens(m);
    }
  }
  return total;
}

/**
 * Estimate total context size including system prompt and all messages.
 * Exported as `estimateContextTokens` for use in chat route fallback compaction.
 *
 * Returns the MAX of two estimates:
 * - Path A (usage anchor): LLM-reported `usage.totalTokens` on the last
 *   in-context assistant message, plus char-estimates for anything added
 *   since. Accurate when the system prompt, tool schemas, and in-context
 *   message set haven't materially changed since that usage was captured.
 * - Path B (char-based): pure char-count of systemPrompt + all in-context
 *   messages. Unaffected by changes to system prompt / tools between turns.
 *
 * Taking the max protects against Path A going stale — common on resume
 * (contextState reset → fresh memory retrieval grows systemPrompt), after
 * AGENTS.md / persona / memory-block changes, or when tool schemas grow.
 * In steady state Path A wins (since it includes framing overhead that
 * char estimation doesn't). When the prompt grows, Path B wins.
 */
export { estimateContextSize as estimateContextTokens };
export interface ContextEstimateBreakdown {
  /** Conservative estimate used for compaction decisions. */
  estimatedTokens: number;
  /** Lower-noise estimate used for UI display when a usage anchor is available. */
  displayTokens: number;
  selectedPath: "usage_anchor" | "char_estimate";
  displayPath: "usage_anchor" | "char_estimate";
  pathATokens?: number;
  pathBTokens: number;
  lastUsageIndex?: number;
  lastUsageInput?: number;
  lastUsageOutput?: number;
  lastUsageTotal?: number;
  postUsageAdditionalTokens?: number;
}

function estimateContextBreakdown(
  messages: Chat["messages"],
  systemPrompt: string,
  tools?: unknown,
): ContextEstimateBreakdown {
  // Path B: pure char-based estimate across the whole in-context set + prompt.
  const pathBTokens = charEstimateContextSize(messages, systemPrompt, tools);

  // Path A: anchor on the latest in-context assistant's reported usage.
  let lastKnownUsage = 0;
  let lastUsageIndex = -1;
  let lastUsageInput: number | undefined;
  let lastUsageOutput: number | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]._outOfContext) continue;
    if (messages[i].role === "assistant" && messages[i].usage?.totalTokens) {
      lastKnownUsage = messages[i].usage!.totalTokens;
      lastUsageInput = messages[i].usage!.input;
      lastUsageOutput = messages[i].usage!.output;
      lastUsageIndex = i;
      break;
    }
  }

  if (lastKnownUsage === 0 || lastUsageIndex < 0) {
    // Cold start / first turn — no prior usage to anchor on.
    return {
      estimatedTokens: pathBTokens,
      displayTokens: pathBTokens,
      selectedPath: "char_estimate",
      displayPath: "char_estimate",
      pathBTokens,
    };
  }

  let additionalTokens = 0;
  // The usage anchor is captured when the assistant turn completes, before
  // tool results are appended and sent back as input to the next iteration.
  // Count same-row tool results as post-usage additions or a large read_file
  // result can be invisible to Path A.
  const usageAnchor = messages[lastUsageIndex];
  if (usageAnchor.role === "assistant" && usageAnchor.toolResults?.length) {
    for (const r of usageAnchor.toolResults) additionalTokens += estimateToolResultPromptTokens(r.content);
  }
  for (let i = lastUsageIndex + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m._outOfContext) continue;
    additionalTokens += MESSAGE_FRAMING_TOKENS;
    additionalTokens += estimateTokens(m.content);
    if (m.images?.length) additionalTokens += m.images.length * 256;
    if (m.role === "assistant") {
      if (m.thinking) additionalTokens += estimateTokens(m.thinking);
      if (m.toolCalls) {
        for (const tc of m.toolCalls) additionalTokens += estimateToolCallTokens(tc);
      }
      if (m.toolResults) {
        for (const r of m.toolResults) {
          additionalTokens += estimateToolResultPromptTokens(r.content);
        }
      }
    }
  }
  const pathATokens = lastKnownUsage + additionalTokens;

  return {
    estimatedTokens: Math.max(pathATokens, pathBTokens),
    displayTokens: pathATokens,
    selectedPath: pathATokens >= pathBTokens ? "usage_anchor" : "char_estimate",
    displayPath: "usage_anchor",
    pathATokens,
    pathBTokens,
    lastUsageIndex,
    lastUsageInput,
    lastUsageOutput,
    lastUsageTotal: lastKnownUsage,
    postUsageAdditionalTokens: additionalTokens,
  };
}

function estimateContextSize(
  messages: Chat["messages"],
  systemPrompt: string,
  tools?: unknown,
): number {
  return estimateContextBreakdown(messages, systemPrompt, tools).estimatedTokens;
}

export interface ExactContextTokenEstimate {
  /** Conservative estimate used for compaction decisions. Exact tokenization only raises this value. */
  estimatedTokens: number;
  /** Exact-adjusted estimate for UI display. Uses the usage anchor when available. */
  refinedTokens: number;
  approximateTokens: number;
  approximateDisplayTokens: number;
  exactToolResultCount: number;
  /** Positive-only exact-token delta applied to `estimatedTokens`. */
  exactDelta: number;
  /** Signed exact-token delta applied to `refinedTokens`. */
  signedExactDelta: number;
  exactElapsedMs: number;
  errors: string[];
  contextBreakdown: ContextEstimateBreakdown;
}

function findLastUsageIndex(messages: Chat["messages"]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]._outOfContext) continue;
    if (messages[i].role === "assistant" && messages[i].usage?.totalTokens) return i;
  }
  return -1;
}

function collectPostUsageToolResults(messages: Chat["messages"]): Array<{
  label: string;
  toolName?: string;
  content: string;
  approximateTokens: number;
}> {
  const lastUsageIndex = findLastUsageIndex(messages);
  const candidates: Array<{ label: string; toolName?: string; content: string; approximateTokens: number }> = [];

  const addResult = (messageIndex: number, resultIndex: number, content: string, toolName?: string) => {
    if (!content) return;
    candidates.push({
      label: `m${messageIndex}.toolResult${resultIndex}`,
      toolName,
      content,
      approximateTokens: estimateToolResultContentTokens(content),
    });
  };

  if (lastUsageIndex < 0) {
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m._outOfContext || m.role !== "assistant" || !m.toolResults?.length) continue;
      m.toolResults.forEach((r, idx) => addResult(i, idx, r.content, r.toolName));
    }
    return candidates;
  }

  const anchor = messages[lastUsageIndex];
  if (anchor.role === "assistant" && anchor.toolResults?.length) {
    anchor.toolResults.forEach((r, idx) => addResult(lastUsageIndex, idx, r.content, r.toolName));
  }

  for (let i = lastUsageIndex + 1; i < messages.length; i++) {
    const m = messages[i];
    if (m._outOfContext || m.role !== "assistant" || !m.toolResults?.length) continue;
    m.toolResults.forEach((r, idx) => addResult(i, idx, r.content, r.toolName));
  }

  return candidates;
}

export async function estimateContextTokensWithExactToolResults(
  messages: Chat["messages"],
  systemPrompt: string,
  tools: unknown,
  options: {
    baseUrl?: string;
    modelId?: string;
    chatId?: string;
    phase?: string;
    contextWindow?: number;
    timeoutMs?: number;
    minToolResultChars?: number;
  } = {},
): Promise<ExactContextTokenEstimate> {
  const contextBreakdown = estimateContextBreakdown(messages, systemPrompt, tools);
  const approximateTokens = contextBreakdown.estimatedTokens;
  const approximateDisplayTokens = contextBreakdown.displayTokens;
  const base: ExactContextTokenEstimate = {
    estimatedTokens: approximateTokens,
    refinedTokens: approximateDisplayTokens,
    approximateTokens,
    approximateDisplayTokens,
    exactToolResultCount: 0,
    exactDelta: 0,
    signedExactDelta: 0,
    exactElapsedMs: 0,
    errors: [],
    contextBreakdown,
  };

  if (!options.baseUrl || !options.modelId) return base;

  const candidates = collectPostUsageToolResults(messages);
  if (candidates.length === 0) return base;

  const nearContextLimit = options.contextWindow
    ? approximateTokens / options.contextWindow >= 0.70
    : false;
  const minChars = options.minToolResultChars ?? 16_000;
  const selected = candidates
    .filter((c) => nearContextLimit || shouldExactCountText(c.content, "tool_result", minChars))
    .sort((a, b) => b.approximateTokens - a.approximateTokens)
    .slice(0, 12);
  if (selected.length === 0) return base;

  let positiveDelta = 0;
  let signedDelta = 0;
  for (const candidate of selected) {
    try {
      const exact = await countLlamaTextTokens(
        options.baseUrl,
        options.modelId,
        candidate.content,
        { timeoutMs: options.timeoutMs },
      );
      base.exactElapsedMs += exact.elapsedMs;
      base.exactToolResultCount++;
      recordToolResultExactTokenEstimate({
        chatId: options.chatId,
        phase: options.phase,
        modelId: options.modelId,
        label: candidate.label,
        toolName: candidate.toolName,
        content: candidate.content,
        exactTokens: exact.tokens,
        exactElapsedMs: exact.elapsedMs,
        exactCached: exact.cached,
      });
      const delta = exact.tokens - candidate.approximateTokens;
      if (delta > 0) positiveDelta += delta;
      signedDelta += delta;
    } catch (err) {
      base.errors.push(`${candidate.label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  base.exactDelta = positiveDelta;
  base.signedExactDelta = signedDelta;
  base.estimatedTokens = approximateTokens + positiveDelta;
  base.refinedTokens = Math.max(0, approximateDisplayTokens + signedDelta);
  return base;
}

/**
 * Attempt to shrink a single oversized assistant message by archiving a prefix
 * of its `(toolCall, toolResult)` pairs. The caller passes `budgetTokens` — the
 * maximum tokens the shrunk message should fit within — and the helper greedily
 * keeps tail pairs (most recent first) until adding another pair would breach.
 *
 * The synthesized head (archived portion) carries the original thinking and the
 * peeled pairs. The caller is responsible for feeding it through `archiveAndIndex`
 * alongside any other removed messages, so all archive IDs appear in one summary.
 *
 * Mutates `msg` in place: `toolCalls` and `toolResults` lose the peeled pairs;
 * `thinking` is cleared (it travels with the head).
 *
 * Returns null when splitting is ineligible:
 *   - role ≠ assistant
 *   - fewer than 2 tool calls (nothing to split at a pair boundary)
 *   - even the last single pair + content exceeds the budget (split won't help)
 *   - every pair would be kept (no archiving would happen)
 */
type AssistantRetentionSplitMode = "tool-pair-tail" | "tool-payload-stripped";

interface AssistantRetentionSplit {
  head: ChatMessage;
  originalPairs: number;
  archivedPairs: number;
  keptPairs: number;
  archivedTokens: number;
  mode: AssistantRetentionSplitMode;
}

function trySplitAssistantMessage(
  msg: ChatMessage,
  budgetTokens: number,
  scaleFactor: number,
): AssistantRetentionSplit | null {
  if (msg.role !== "assistant") return null;
  const toolCalls = msg.toolCalls;
  const toolResults = msg.toolResults ?? [];
  if (!toolCalls || toolCalls.length < 2) return null;

  // Per-pair token estimates aligned with charEstimateContextSize. Tool
  // arguments can be large for tools like create_artifact/edit_file, so they
  // must be counted or compaction will underestimate the real wire payload.
  const pairEstimates = toolCalls.map((tc) => {
    const tr = toolResults.find((r) => r.toolCallId === tc.id);
    let tokens = estimateToolCallTokens(tc);
    if (tr) tokens += estimateToolResultPromptTokens(tr.content);
    return Math.ceil(tokens * scaleFactor);
  });

  // Fixed tail cost after split: the final text content + one MESSAGE_FRAMING.
  // Thinking goes with the head and is no longer part of the kept message.
  const contentTokens = Math.ceil(estimateTokens(msg.content) * scaleFactor);
  const framing = Math.ceil(MESSAGE_FRAMING_TOKENS * scaleFactor);

  let runningTotal = contentTokens + framing;
  let firstKeptIdx = toolCalls.length; // sentinel: nothing fit
  for (let i = toolCalls.length - 1; i >= 0; i--) {
    if (runningTotal + pairEstimates[i] <= budgetTokens) {
      runningTotal += pairEstimates[i];
      firstKeptIdx = i;
    } else {
      break;
    }
  }

  // Can't fit even the final pair + content within budget — split is futile.
  if (firstKeptIdx === toolCalls.length) return null;
  // Everything fits; no split needed.
  if (firstKeptIdx === 0) return null;

  const archivedIds = new Set(toolCalls.slice(0, firstKeptIdx).map((tc) => tc.id));
  const archivedCalls = toolCalls.slice(0, firstKeptIdx);
  const archivedResults = toolResults.filter((tr) => archivedIds.has(tr.toolCallId));

  const head: ChatMessage = {
    role: "assistant",
    content: "",                 // final text stays on the kept tail
    thinking: msg.thinking,
    toolCalls: archivedCalls,
    toolResults: archivedResults,
    timestamp: msg.timestamp,
    _outOfContext: true,
  };

  // Mutate in place.
  msg.toolCalls = toolCalls.slice(firstKeptIdx);
  msg.toolResults = toolResults.filter((tr) => !archivedIds.has(tr.toolCallId));
  msg.thinking = undefined;

  const archivedTokens = archivedCalls.reduce((sum, tc) => {
    const tr = archivedResults.find((r) => r.toolCallId === tc.id);
    let t = estimateToolCallTokens(tc);
    if (tr) t += estimateToolResultContentTokens(tr.content) + 20;
    return sum + t;
  }, 0) + (head.thinking ? estimateTokens(head.thinking) : 0);

  return {
    head,
    originalPairs: toolCalls.length,
    archivedPairs: archivedCalls.length,
    keptPairs: msg.toolCalls.length,
    archivedTokens,
    mode: "tool-pair-tail",
  };
}

function tryStripAssistantToolPayloadForTextRetention(
  msg: ChatMessage,
  budgetTokens: number,
  scaleFactor: number,
): AssistantRetentionSplit | null {
  if (msg.role !== "assistant") return null;
  if (!msg.content.trim()) return null;
  // Only strip completed tool payloads. A bare tool call with no result may be
  // a pending protocol item and should stay paired in the active transcript.
  const hasToolPayload = Boolean(msg.toolResults?.length);
  if (!hasToolPayload) return null;

  const keptTokens = Math.ceil(estimateTokens(msg.content) * scaleFactor)
    + Math.ceil(MESSAGE_FRAMING_TOKENS * scaleFactor);
  if (keptTokens > budgetTokens) return null;

  const archivedCalls = msg.toolCalls ? structuredClone(msg.toolCalls) : undefined;
  const archivedResults = msg.toolResults ? structuredClone(msg.toolResults) : undefined;
  const archivedPairCount = Math.max(archivedCalls?.length ?? 0, archivedResults?.length ?? 0);
  const head: ChatMessage = {
    role: "assistant",
    content: "",
    thinking: msg.thinking,
    toolCalls: archivedCalls,
    toolResults: archivedResults,
    timestamp: msg.timestamp,
    _outOfContext: true,
  };

  msg.toolCalls = undefined;
  msg.toolResults = undefined;
  msg.thinking = undefined;

  return {
    head,
    originalPairs: archivedPairCount,
    archivedPairs: archivedPairCount,
    keptPairs: 0,
    archivedTokens: estimateMessageContentTokens(head),
    mode: "tool-payload-stripped",
  };
}

function tryCompactAssistantMessageForRetention(
  msg: ChatMessage,
  budgetTokens: number,
  scaleFactor: number,
): AssistantRetentionSplit | null {
  // Visible assistant prose is usually the densest continuity signal. If a row
  // has final text plus bulky tool payloads, archive the payload and keep the
  // prose before trying to preserve any tool pairs.
  return (
    tryStripAssistantToolPayloadForTextRetention(msg, budgetTokens, scaleFactor) ??
    trySplitAssistantMessage(msg, budgetTokens, scaleFactor)
  );
}

function backfillOlderMessagesAfterSplit(
  messages: ChatMessage[],
  inContextIndices: number[],
  startIC: number,
  currentKeepFromIC: number,
  runningTotal: number,
  targetTokens: number,
  effectiveEstimates: number[],
  scaleFactor: number,
  splitInfos: AssistantRetentionSplit[],
): { keepFromIC: number; runningTotal: number; backfilled: number } {
  let keepFromIC = currentKeepFromIC;
  let backfilled = 0;

  for (let ic = startIC; ic >= 0; ic--) {
    if (runningTotal + effectiveEstimates[ic] <= targetTokens) {
      runningTotal += effectiveEstimates[ic];
      keepFromIC = ic;
      backfilled++;
      continue;
    }

    const remainingBudget = Math.max(0, targetTokens - runningTotal);
    const candidateIdx = inContextIndices[ic];
    const splitInfo = tryCompactAssistantMessageForRetention(messages[candidateIdx], remainingBudget, scaleFactor);
    if (!splitInfo) break;

    splitInfos.push(splitInfo);
    runningTotal += scaledMessageContentTokens(messages[candidateIdx], scaleFactor);
    keepFromIC = ic;
    backfilled++;
  }

  return { keepFromIC, runningTotal, backfilled };
}

/**
 * Proactively truncate chat history BEFORE sending to the LLM if context
 * would exceed the safe threshold (~85% of context window).
 *
 * This prevents broken responses from hitting the context limit mid-generation.
 * Trigger is at 85%, but the budget target is 30% — matching post-response
 * compaction. Targeting the same level the next turn would compact to anyway
 * avoids a second cache-invalidating compaction later in the turn, and gives
 * subsequent turns headroom before the next trigger.
 *
 * Returns CompactionResult if truncation occurred, null if context is already safe.
 */
export async function truncateBeforeSend(
  chat: Chat,
  contextWindow: number,
  systemPrompt: string,
  onCompacting?: () => void,
  onKeepalive?: () => void,
  tools?: unknown,
  exactTokenOptions?: { baseUrl?: string; modelId?: string; timeoutMs?: number },
): Promise<CompactionResult | null> {
  const noOp = null;
  const messages = chat.messages;
  if (messages.length <= 2) return noOp;

  const exactEstimate = await estimateContextTokensWithExactToolResults(messages, systemPrompt, tools, {
    ...exactTokenOptions,
    chatId: chat.id,
    phase: "pre_send",
    contextWindow,
  });
  const estimatedTokens = exactEstimate.estimatedTokens;
  if (exactEstimate.exactToolResultCount > 0 || exactEstimate.errors.length > 0) {
    console.log(
      `[token-estimate] chat=${chat.id} phase=pre-send approx=${exactEstimate.approximateTokens} ` +
      `estimated=${estimatedTokens} exactToolResults=${exactEstimate.exactToolResultCount} ` +
      `delta=${exactEstimate.exactDelta} elapsedMs=${exactEstimate.exactElapsedMs}` +
      (exactEstimate.errors.length ? ` errors=${exactEstimate.errors.length}` : ""),
    );
  }
  const charEstimate = charEstimateContextSize(messages, systemPrompt, tools);
  // Trigger and target are decoupled: we only compact when well into the
  // danger zone (85%), but when we do, we compact down to 30% — the same
  // level post-response targets. Compacting to 85% would leave us one turn
  // away from re-triggering and would also guarantee a second compaction
  // from the post-response path in the same turn.
  const trigger = contextWindow * COMPACTION_TRIGGER_RATIO;
  const target = contextWindow * COMPACTION_TARGET_RATIO;

  // Fallthrough: if the primary estimator says we're safe, we still enforce
  // a hard-cap check at the bottom (see "Hard-cap safety pass"). This catches
  // cases where the usage-anchor path understates the real payload (e.g., the
  // system prompt grew since the anchor was captured — common on resume after
  // contextState reset re-freezes memories into the prompt).
  if (estimatedTokens <= trigger) {
    return await hardCapSafetyPass(chat, contextWindow, systemPrompt, onCompacting, onKeepalive, tools);
  }

  onCompacting?.();

  // Record which path drove the estimate so spurious triggers are diagnosable.
  // `usage=N` means the LLM-reported token count dominated; `charEst` means
  // char-based estimation did (typically when system prompt grew between turns
  // or no prior usage exists).
  let lastUsage = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]._outOfContext) continue;
    if (messages[i].role === "assistant" && messages[i].usage?.totalTokens) {
      lastUsage = messages[i].usage!.totalTokens;
      break;
    }
  }
  // drivingPath indicates which estimator path won the max():
  // "usage=N" → Path A (usage anchor) dominated — steady state
  // "charEst" → Path B (char-based) dominated — prompt/tools grew, or no anchor
  const drivingPath = lastUsage > 0 && estimatedTokens !== charEstimate
    ? `usage=${lastUsage}`
    : `charEst`;
  console.log(
    `[compaction] Pre-send truncation triggered: ${estimatedTokens} tokens > ${trigger} trigger, target=${target} (drivingPath=${drivingPath}, charEst=${charEstimate}, ctx=${contextWindow})`
  );

  // Build index of in-context messages for budget calculation
  const icIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (!messages[i]._outOfContext) icIndices.push(i);
  }
  if (icIndices.length <= 2) {
    // Too few in-context messages to compact conventionally; still run the
    // hard-cap pass so the breach is logged (and, if forcible, aggressively
    // truncated via truncateChatHistory).
    return await hardCapSafetyPass(chat, contextWindow, systemPrompt, onCompacting, onKeepalive, tools);
  }

  // Per-message token estimates for in-context messages.
  // Note: system-role messages contribute estimateTokens(m.content) via the
  // base assignment above — no role-specific addenda needed (no images,
  // thinking, tool calls, or tool results on system deltas).
  const icEstimates = icIndices.map((idx) => estimateMessageContentTokens(messages[idx]));

  // Apply scaling factor for accurate estimates
  const messageContentTokens = icEstimates.reduce((s, t) => s + t, 0);
  const charEstimateTotal = estimateTokens(systemPrompt) + messageContentTokens;
  const scaleFactor = charEstimateTotal > 0 ? estimatedTokens / charEstimateTotal : 1;
  const scaledEstimates = icEstimates.map((t) => Math.ceil(t * scaleFactor));
  const overheadTokens = Math.ceil(estimateTokens(systemPrompt) * scaleFactor);

  // Iterate backwards over in-context messages to find budget boundary.
  // Fills up to the 30% target, not the 85% trigger, so the post-compaction
  // payload has room to grow before the next trigger fires.
  // The first in-context message is no longer pinned: anchoring the original
  // user prompt across compaction cycles derails conversations whose topic has
  // drifted, since the agent sees the opener spliced against unrelated recent
  // context. The inserted compaction summary already captures earlier work.
  let runningTotal = overheadTokens;
  let keepFromIC = icIndices.length; // sentinel: nothing fit yet
  for (let ic = icIndices.length - 1; ic >= 0; ic--) {
    if (runningTotal + scaledEstimates[ic] <= target) {
      runningTotal += scaledEstimates[ic];
      keepFromIC = ic;
    } else {
      break;
    }
  }

  // Split optimization: backward-fill stops either because everything fit
  // (keepFromIC === 0) or because a message was too big. In the latter case,
  // the boundary message at icIndices[keepFromIC - 1] would be archived whole.
  // If it's an assistant turn with ≥2 tool-call pairs, peel its head off so
  // its tail (last N pairs + final content) stays in context.
  const splitInfos: AssistantRetentionSplit[] = [];
  if (keepFromIC === icIndices.length) {
    // Last-resort: not even the last message fit. Split it.
    const lastOrigIdx = icIndices[icIndices.length - 1];
    const splitInfo = tryCompactAssistantMessageForRetention(
      messages[lastOrigIdx],
      Math.max(0, target - overheadTokens),
      scaleFactor,
    );
    if (splitInfo) {
      // Archive the split head alongside everything older than the last message.
      splitInfos.push(splitInfo);
      keepFromIC = icIndices.length - 1;
      console.log(
        `[compaction] Mid-message split (tail): chat=${chat.id} msgIdx=${lastOrigIdx} ` +
        `originalPairs=${splitInfo.originalPairs} archivedPairs=${splitInfo.archivedPairs} ` +
        `keptPairs=${splitInfo.keptPairs} archivedTokens=${splitInfo.archivedTokens} mode=${splitInfo.mode}`,
      );
      runningTotal = overheadTokens + scaledMessageContentTokens(messages[lastOrigIdx], scaleFactor);
      const backfill = backfillOlderMessagesAfterSplit(
        messages,
        icIndices,
        icIndices.length - 2,
        keepFromIC,
        runningTotal,
        target,
        scaledEstimates,
        scaleFactor,
        splitInfos,
      );
      keepFromIC = backfill.keepFromIC;
      runningTotal = backfill.runningTotal;
      if (backfill.backfilled > 0) {
        console.log(
          `[compaction] Backfilled ${backfill.backfilled} compact recent message(s) after tail split; ` +
          `keepFromIC=${keepFromIC} runningTotal=${Math.ceil(runningTotal)}/${Math.ceil(target)}`,
        );
      }
    } else {
      console.warn(`[compaction] No recent messages fit within target (overhead ${overheadTokens} alone > ${target}), keeping last 2 in-context`);
      keepFromIC = Math.max(0, icIndices.length - 2);
    }
  } else if (keepFromIC > 0) {
    // Boundary split: backward-fill stopped because the next-older message
    // didn't fit. If that boundary is a tool-call-heavy assistant turn, peel
    // off its head so its tail rides along with the kept window instead of
    // being archived whole.
    const boundaryICIdx = keepFromIC - 1;
    const boundaryOrigIdx = icIndices[boundaryICIdx];
    const remainingBudget = Math.max(0, target - runningTotal);
    const splitInfo = tryCompactAssistantMessageForRetention(
      messages[boundaryOrigIdx],
      remainingBudget,
      scaleFactor,
    );
    if (splitInfo) {
      splitInfos.push(splitInfo);
      keepFromIC = boundaryICIdx;
      console.log(
        `[compaction] Mid-message split (boundary): chat=${chat.id} msgIdx=${boundaryOrigIdx} ` +
        `originalPairs=${splitInfo.originalPairs} archivedPairs=${splitInfo.archivedPairs} ` +
        `keptPairs=${splitInfo.keptPairs} archivedTokens=${splitInfo.archivedTokens} mode=${splitInfo.mode}`,
      );
      runningTotal += scaledMessageContentTokens(messages[boundaryOrigIdx], scaleFactor);
      const backfill = backfillOlderMessagesAfterSplit(
        messages,
        icIndices,
        boundaryICIdx - 1,
        keepFromIC,
        runningTotal,
        target,
        scaledEstimates,
        scaleFactor,
        splitInfos,
      );
      keepFromIC = backfill.keepFromIC;
      runningTotal = backfill.runningTotal;
      if (backfill.backfilled > 0) {
        console.log(
          `[compaction] Backfilled ${backfill.backfilled} compact recent message(s) after boundary split; ` +
          `keepFromIC=${keepFromIC} runningTotal=${Math.ceil(runningTotal)}/${Math.ceil(target)}`,
        );
      }
    }
  }

  const messagesToMarkCount = keepFromIC;
  const splitSummary = splitInfos.length
    ? ` + ${splitInfos.length} split head(s) (${splitInfos.reduce((sum, s) => sum + s.archivedPairs, 0)} pair(s))`
    : "";
  console.log(`[compaction] Pre-send budget: overhead=${overheadTokens} scale=${scaleFactor.toFixed(2)} keepFromIC=${keepFromIC} marking=${messagesToMarkCount}/${icIndices.length} in-context${splitSummary}`);

  if (messagesToMarkCount <= 0 && splitInfos.length === 0) {
    // Budget planning says keep everything AND no split occurred — nothing to
    // archive on this pass. Run the hard-cap pass so it can force aggressive
    // compaction if the actual payload still exceeds the cap.
    return await hardCapSafetyPass(chat, contextWindow, systemPrompt, onCompacting, onKeepalive, tools);
  }

  // Collect removed messages for archiving. Deep-copy each message so that
  // subsequent content stripping (ARCHIVED_CONTENT_CAP) does not mutate the
  // objects passed to archiveAndIndex or the CompactionResult returned to the
  // caller (which is used for memory extraction by preCompactionFlush).
  // Without deep-copying, stripping truncates toolResults.content and
  // thinking in the SAME objects, causing archives to see already-stripped
  // content if saveArchives runs asynchronously, and causing memory
  // extraction to see truncated tool results.
  const removedMessages: ChatMessage[] = [];
  const markedIndices: number[] = [];
  for (let ic = 0; ic < keepFromIC; ic++) {
    const origIdx = icIndices[ic];
    removedMessages.push(structuredClone(messages[origIdx]));
    markedIndices.push(origIdx);
  }
  for (const splitInfo of splitInfos) removedMessages.push(structuredClone(splitInfo.head));

  // Also include any already-`_outOfContext` messages that have been stripped
  // by a previous compaction pass. These messages precede the newly-compacted
  // block and their content in archives may be thin (fallback descriptions
  // or truncated tool results). Re-archiving them alongside the new block
  // ensures the archive has full-fidelity content for the entire region
  // of the conversation that is being pushed out of context.
  const alreadyOutOfContextIndices: number[] = [];
  // Walk backwards from the first in-context message to find contiguous
  // _outOfContext messages in the array that aren't compaction summaries.
  // These are predecessors that were archived in a prior pass — their
  // content is already stripped but their archives may have thin descriptions.
  const insertionOrigIdx = icIndices[keepFromIC];
  for (let i = insertionOrigIdx - 1; i >= 0; i--) {
    if (messages[i]._outOfContext && !messages[i]._isCompactionSummary) {
      alreadyOutOfContextIndices.unshift(i);
    } else if (!messages[i]._outOfContext) {
      // In-context messages between _outOfContext ones and the insertion
      // point shouldn't exist by construction, but stop if we see one to
      // avoid pulling in non-contiguous _outOfContext blocks from earlier.
      break;
    }
    // Compaction summaries mark the boundary of a prior compaction block;
    // stop here so we don't re-archive messages from a different era.
    if (messages[i]._isCompactionSummary) break;
  }
  for (const idx of alreadyOutOfContextIndices) {
    removedMessages.push(structuredClone(messages[idx]));
  }

  // Archive in deferred mode — mechanical descriptions now, LLM enrichment
  // runs in the background so the user turn isn't blocked on a CPU model call.
  const { summaryText, archiveIds } = await archiveAndIndex(chat.id, removedMessages, chat.modelId, {
    mode: "deferred",
    onKeepalive,
  });

  // Mark messages as out-of-context, strip large content
  const ARCHIVED_CONTENT_CAP = 500;
  for (const origIdx of markedIndices) {
    const m = messages[origIdx];
    m._outOfContext = true;
    if (m.toolResults) {
      for (const r of m.toolResults) {
        if (r.content && r.content.length > ARCHIVED_CONTENT_CAP) {
          r.content = r.content.slice(0, ARCHIVED_CONTENT_CAP) + "\n[archived]";
        }
      }
    }
    if (m.thinking && m.thinking.length > ARCHIVED_CONTENT_CAP) {
      m.thinking = m.thinking.slice(0, ARCHIVED_CONTENT_CAP) + "\n[archived]";
    }
    if (m.images) {
      m.images = m.images.map(img => ({ ...img, data: "" }));
    }
  }

  // Insert summary before the first kept in-context message. When a split
  // happened without full-message removal, treat the split as 1 compacted
  // unit so the UI still shows a compaction indicator (it checks truthiness).
  const insertionIdx = icIndices[keepFromIC];
  const summaryMessage: ChatMessage = {
    role: "assistant",
    content: summaryText,
    thinking: undefined,
    timestamp: Date.now(),
    _isCompactionSummary: true,
    _compactedMessageCount: messagesToMarkCount + splitInfos.length,
    _archiveIds: archiveIds,
  };
  messages.splice(insertionIdx, 0, summaryMessage);
  chat.messages = messages;

  // Mark stale memory-delta messages (role: "system") in the kept tail as
  // out-of-context. The post-compaction memory reset rebuilds the frozen set
  // into the new system prompt, so these deltas' content is now redundant —
  // keeping them in-context would just bloat the prompt and the LLM would
  // see the same memory text twice (once in the prompt, once mid-conversation).
  let strippedDeltas = 0;
  for (let i = insertionIdx + 1; i < messages.length; i++) {
    if (messages[i].role === "system" && !messages[i]._outOfContext) {
      messages[i]._outOfContext = true;
      strippedDeltas++;
    }
  }
  if (strippedDeltas > 0) {
    console.log(`[compaction] Marked ${strippedDeltas} stale system-delta message(s) out-of-context in kept tail`);
  }

  const estimatedRemovedTokens = removedMessages.reduce((sum, m) => sum + estimateMessageContentTokens(m), 0);

  const inContextCount = chat.messages.filter(m => !m._outOfContext).length;
  console.log(
    `[compaction] Pre-send compacted chat ${chat.id}: marked ${messagesToMarkCount} messages out-of-context ` +
    `(~${estimatedRemovedTokens} est. tokens) → ${inContextCount} in-context, ${chat.messages.length} total`
  );

  // Regenerate title based on in-context messages to keep it current
  try {
    const inContextMsgs = chat.messages.filter(m => !m._outOfContext);
    const newTitle = await regenerateTitle(inContextMsgs);
    if (newTitle && newTitle !== chat.title) {
      await updateChatTitle(chat.id, newTitle);
      chat.title = newTitle;
      console.log(`[compaction] Title updated: "${chat.title}"`);
    }
  } catch (err) {
    console.warn("[compaction] Title regeneration failed:", err);
  }

  // Count the split (if any) as 1 compacted unit so user-facing messaging
  // ("Removed N messages") doesn't report 0 when a partial compaction happened.
  const primaryResult: CompactionResult = {
    truncated: true,
    removedCount: messagesToMarkCount + splitInfos.length,
    removedMessages,
    estimatedTokenCount: estimatedRemovedTokens,
  };

  // Hard-cap safety pass: even after primary truncation, verify the actual
  // payload fits. Handles cases where the budget planning used a scale factor
  // that under-counted (e.g., tool schemas bloat the real payload beyond
  // what char estimation sees).
  const additional = await hardCapSafetyPass(chat, contextWindow, systemPrompt, undefined, onKeepalive, tools);
  if (additional && additional.truncated) {
    return {
      truncated: true,
      removedCount: primaryResult.removedCount + additional.removedCount,
      removedMessages: [...(primaryResult.removedMessages || []), ...(additional.removedMessages || [])],
      estimatedTokenCount: (primaryResult.estimatedTokenCount || 0) + (additional.estimatedTokenCount || 0),
    };
  }
  return primaryResult;
}

/**
 * Hard-cap safety pass. Runs a pure char-based estimate of the current
 * in-context payload and, if it exceeds 95% of the context window, forces
 * aggressive compaction via `truncateChatHistory(forceCompact=true)` which
 * targets 30% of the window.
 *
 * This is a defensive net for cases where the primary estimator's usage
 * anchor has gone stale — e.g., the system prompt grew between turns (new
 * memories frozen after contextState reset, expanded AGENTS.md, added
 * memory blocks), or tool schemas grew. Without this, the primary estimator
 * can return a value under the 75% threshold while the real payload exceeds
 * the model's context size, causing llama.cpp to hang during prompt ingest.
 *
 * Returns null if the payload is already under the hard cap, otherwise the
 * result of the forced compaction.
 */
async function hardCapSafetyPass(
  chat: Chat,
  contextWindow: number,
  systemPrompt: string,
  onCompacting?: () => void,
  onKeepalive?: () => void,
  tools?: unknown,
): Promise<CompactionResult | null> {
  const charEstimate = charEstimateContextSize(chat.messages, systemPrompt, tools);
  const hardCap = contextWindow * COMPACTION_HARD_CAP_RATIO;
  if (charEstimate <= hardCap) return null;

  const icCount = chat.messages.filter((m) => !m._outOfContext).length;
  if (icCount <= 2) {
    console.error(
      `[compaction] Hard-cap breach but only ${icCount} in-context messages — cannot compact further. ` +
      `charEstimate=${charEstimate}/${contextWindow} (${((charEstimate / contextWindow) * 100).toFixed(0)}%). ` +
      `The payload will be sent anyway and may be truncated or rejected by the model.`
    );
    return null;
  }

  console.warn(
    `[compaction] Hard-cap safety triggered: charEstimate=${charEstimate} > ${hardCap.toFixed(0)} ` +
    `(95% of ctx=${contextWindow}) — running aggressive compaction (target 30%)`
  );

  // Force compaction targeting 30% of the context window. This is the same
  // code path used by post-response compaction and manual /compact, so it
  // archives properly and generates index summaries.
  // truncateChatHistory fires onCompacting internally when it starts marking
  // messages, so don't double-fire from here.
  const aggressive = await truncateChatHistory(chat, contextWindow, true, onCompacting, onKeepalive, undefined, systemPrompt, tools);
  if (!aggressive.truncated) {
    console.error(
      `[compaction] Aggressive compaction failed to reduce context further. ` +
      `charEstimate=${charEstimate}/${contextWindow}. Proceeding with current payload.`
    );
    return null;
  }

  const postCharEstimate = charEstimateContextSize(chat.messages, systemPrompt, tools);
  console.log(
    `[compaction] Hard-cap safety pass complete: removed ${aggressive.removedCount} more messages, ` +
    `charEstimate ${charEstimate} → ${postCharEstimate} (${((postCharEstimate / contextWindow) * 100).toFixed(0)}% of ctx)`
  );
  return aggressive;
}

// ---------------------------------------------------------------------------
// Indexed archival — replaces narrative summaries with structured indexes
// ---------------------------------------------------------------------------

/**
 * Group removed messages into logical archive blocks:
 * - User + visible assistant turn (including all _toolLoopId fragments) → one block
 * - Standalone visible assistant turn (all _toolLoopId fragments) → one block
 * - Legacy collapsed assistant-with-tools row → one block
 * - Standalone messages → one block
 */
function groupIntoBlocks(messages: ChatMessage[]): ChatMessage[][] {
  const blocks: ChatMessage[][] = [];
  let i = 0;

  // Walk forward from `start` while consecutive assistant rows share
  // the given _toolLoopId. Returns the next index after the run.
  const collectLoopFragments = (start: number, loopId: string, into: ChatMessage[]): number => {
    let j = start;
    while (
      j < messages.length &&
      messages[j].role === "assistant" &&
      messages[j]._toolLoopId === loopId
    ) {
      into.push(messages[j]);
      j++;
    }
    return j;
  };

  while (i < messages.length) {
    const m = messages[i];

    // User + following visible assistant turn. Canonical multi-fragment
    // turns share a _toolLoopId across N rows; archive them together so a
    // single visible exchange becomes a single archive block.
    if (m.role === "user") {
      const block: ChatMessage[] = [m];
      const next = i + 1 < messages.length ? messages[i + 1] : null;
      if (next?.role === "assistant") {
        if (next._toolLoopId) {
          i = collectLoopFragments(i + 1, next._toolLoopId, block);
        } else {
          block.push(next);
          i += 2;
        }
      } else {
        i++;
      }
      blocks.push(block);
      continue;
    }

    // Canonical tool-loop fragments not preceded by a user message
    // (e.g., a turn that survived compaction without its user prompt).
    if (m.role === "assistant" && m._toolLoopId) {
      const block: ChatMessage[] = [];
      i = collectLoopFragments(i, m._toolLoopId, block);
      blocks.push(block);
      continue;
    }

    // Legacy collapsed assistant turn with bundled tool calls/results.
    if (m.role === "assistant" && m.toolCalls?.length) {
      blocks.push([m]);
      i++;
      continue;
    }

    // Anything else: standalone block
    blocks.push([m]);
    i++;
  }
  return blocks;
}

/**
 * Format a block of messages into readable text for the index description.
 * Prioritizes analytical content (findings, conclusions, decisions) over
 * mechanical actions (tool call names, file paths). For long messages,
 * includes both the beginning and end to capture introductions AND conclusions.
 */
function blockToText(block: ChatMessage[], maxPerMessage = 400): string {
  const parts: string[] = [];
  for (const m of block) {
    if (m.role === "user") {
      // User messages are usually questions or requests — keep the full context
      parts.push(`user: ${truncateMiddle(m.content, maxPerMessage)}`);
    } else if (m.role === "assistant") {
      // Assistant messages may contain analysis, conclusions, or findings
      // that are far more valuable than tool call names
      if (m.content) {
        const contentSnippet = truncateMiddle(m.content, maxPerMessage);
        parts.push(`assistant: ${contentSnippet}`);
      }
      // Tool calls: include names and brief args for identification,
      // but focus on results which contain the actual information
      if (m.toolCalls?.length) {
        const callSummary = m.toolCalls
          .map(tc => `${tc.name}(${summarizeArgs(tc.arguments, 80)})`)
          .join(", ");
        parts.push(`tools: ${callSummary}`);
      }
      if (m.toolResults?.length) {
        for (const tr of m.toolResults) {
          // Tool results often contain the key findings (file contents, search results, etc.)
          parts.push(`result [${tr.toolName}]: ${truncateMiddle(tr.content, 300)}`);
        }
      }
    }
  }
  return parts.join("\n");
}

/**
 * Truncate a string showing both the beginning and end, with a gap indicator.
 * This captures introductions AND conclusions for long messages.
 */
function truncateMiddle(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const headLen = Math.ceil(maxLen * 0.6);
  const tailLen = Math.floor(maxLen * 0.4) - 5; // -5 for " ... "
  return `${text.slice(0, headLen)} ... ${text.slice(-tailLen)}`;
}

/**
 * Summarize tool call arguments for the index — extracts key-value pairs
 * rather than dumping raw JSON.
 */
function summarizeArgs(args: Record<string, unknown>, maxLen: number): string {
  try {
    const entries = Object.entries(args);
    if (entries.length === 0) return "";
    // For single simple values, just show the value
    if (entries.length === 1 && typeof entries[0][1] === "string") {
      const val = String(entries[0][1]);
      return val.length > maxLen ? val.slice(0, maxLen) + "..." : val;
    }
    // For multiple args, show key=value pairs
    const summary = entries
      .map(([k, v]) => {
        const val = typeof v === "string" ? v : JSON.stringify(v);
        return `${k}=${val.length > 40 ? val.slice(0, 40) + "..." : val}`;
      })
      .join(", ");
    return summary.length > maxLen ? summary.slice(0, maxLen) + "..." : summary;
  } catch {
    return JSON.stringify(args).slice(0, maxLen);
  }
}

/** Generate a readable fallback description when the LLM index generation fails. */
function generateFallbackDescription(block: ChatMessage[]): string {
  // Try to find the most informative content in the block
  let assistantAnalysis = "";
  let userQuestion = "";
  const toolNames: string[] = [];
  let resultPreview = "";

  for (const m of block) {
    if (m.role === "user" && !userQuestion) {
      userQuestion = m.content.slice(0, 120).replace(/\n/g, " ");
    }
    if (m.role === "assistant") {
      // Prefer substantial analysis over short tool-call-only messages
      if (m.content && m.content.length > 100) {
        // For long responses, take the beginning and end to capture conclusions
        const head = m.content.slice(0, 80).replace(/\n/g, " ");
        const tail = m.content.length > 200
          ? " ... " + m.content.slice(-60).replace(/\n/g, " ")
          : "";
        assistantAnalysis = head + tail;
      } else if (m.content && !assistantAnalysis) {
        assistantAnalysis = m.content.slice(0, 80).replace(/\n/g, " ");
      }
      if (m.toolCalls?.length) {
        for (const tc of m.toolCalls) toolNames.push(tc.name);
      }
      if (m.toolResults?.length && !resultPreview) {
        // Extract a meaningful snippet from the first result
        const firstResult = m.toolResults[0];
        resultPreview = firstResult.content.slice(0, 100).replace(/\n/g, " ");
      }
    }
  }

  // Prioritize: analysis > result > question > tool names
  if (assistantAnalysis) return assistantAnalysis;
  if (resultPreview) return resultPreview;
  if (userQuestion) return `Question: ${userQuestion}`;
  if (toolNames.length > 0) {
    const unique = [...new Set(toolNames)];
    return `Tool calls: ${unique.join(", ")} (${toolNames.length} total)`;
  }
  return "Conversation context";
}

/** Build the indexed-summary text inserted into the chat from an archive set. */
function buildSummaryText(archives: Pick<ContextArchive, "id" | "indexEntry">[]): string {
  const indexLines = archives.map((a) => `- ${a.id} — ${a.indexEntry}`).join("\n");
  return `[Compacted context — use read_archived_context to retrieve details]\nArchived blocks:\n${indexLines}`;
}

/** Build the LLM prompt that generates one-line descriptions for an archive batch. */
function buildIndexPrompt(blockDescriptions: Array<{ id: string; text: string }>): { systemPrompt: string; inputParts: string } {
  const perBlockBudget = Math.min(1200, Math.max(500, Math.floor(6000 / blockDescriptions.length)));
  const inputParts = blockDescriptions
    .map((b) => `[${b.id}]\n${b.text.slice(0, perBlockBudget)}`)
    .join("\n\n---\n\n");

  const systemPrompt = `You are generating a structured index of conversation content being archived for future retrieval.
For each block below (identified by its archive ID), write a one-line description.

Format your response as exactly one line per block:
${blockDescriptions.map((b) => `- ${b.id} — <description>`).join("\n")}

Descriptions should capture the SIGNIFICANCE of each block — what was learned, decided, or accomplished — not just what actions were taken. A good description answers "why would I need this later?"

Good descriptions:
- archive:abc:001 — Identified P0 bug in memory reset during compaction; /compact path skipped resetMemoryContext
- archive:abc:002 — Reviewed indexed summary architecture; concluded lossless archival beats narrative summarization
- archive:abc:003 — Read compaction.ts to understand truncation thresholds (85% trigger,30% target for both pre-send and post-response)
- archive:abc:004 — User prefers systems that preserve full-fidelity message storage with indexed access rather than lossy summarization

Bad descriptions (too vague or action-focused):
- archive:abc:001 — File reads and grep searches
- archive:abc:002 — Tool calls: read_file, edit_file
- archive:abc:004 — User asked about memory

Prioritize: conclusions > findings > decisions > questions asked > tools used.
If the agent analyzed something, describe the analysis result, not just the analysis process.

Output ONLY the formatted lines, nothing else.`;

  return { systemPrompt, inputParts };
}

/**
 * Call the extraction model to produce index descriptions. If no dedicated
 * extraction URL is configured, fall back to the main chat model. Empty string
 * means callers should use mechanical fallback descriptions.
 */
async function runIndexGeneration(
  blockDescriptions: Array<{ id: string; text: string }>,
  modelId: string,
  onKeepalive?: () => void,
): Promise<string> {
  const { getSettings } = await import("./chat-storage.js");
  const settings = await getSettings();
  const extractionUrl = settings.extractionModelUrl;
  const extractionSettings = await resolveExtractionRequestSettings(settings);
  const { systemPrompt, inputParts } = buildIndexPrompt(blockDescriptions);

  const keepaliveInterval = onKeepalive ? setInterval(onKeepalive, 10_000) : null;
  try {
    let outputText = "";

    if (extractionUrl) {
      outputText = await withExtractionMutex(async () => {
        const extractionModelId = normalizeRouterModelId(settings.extractionModelId || "index-gen");
        // Router-mode preflight: ensure the configured extraction model is the
        // active one before issuing the chat completion. Single-model mode
        // returns "not-router" and we proceed with whatever the slot launched.
        await ensureRouterModelLoaded(extractionUrl, extractionModelId, {
          contextWindow: extractionSettings.ctxSize,
        });
        const requestSignal = AbortSignal.timeout(extractionSettings.timeoutMs);
        const res = await fetch(`${extractionUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: extractionModelId,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: inputParts },
            ],
            max_tokens: Math.min(extractionSettings.maxTokens, ARCHIVE_INDEX_MAX_TOKENS),
            temperature: 0.3,
            stream: true,
            ...(process.env.LLAMACPP_CACHE_PROMPT !== "0" ? { cache_prompt: true } : {}),
          }),
          signal: requestSignal,
        });
        if (res.ok && res.body) {
          const streamResult = await readOpenAIContentStream(res.body, requestSignal);
          if (streamResult.timings) {
            try {
              recordModelStats(extractionModelId, "llamacpp-extraction", streamResult.timings);
            } catch (e) {
              console.warn("[compaction] Failed to record extraction model stats:", e);
            }
          }
          return streamResult.content;
        }
        return "";
      });

      // A configured extraction server is intentional isolation from the main
      // chat model. If it fails or emits no content, use mechanical archive
      // descriptions instead of evicting warm main-model slots.
      if (!outputText.trim()) {
        console.warn("[compaction] Extraction index generation produced no output; using fallback archive descriptions");
        return "";
      }
    }

    if (!outputText) {
      const { streamChat } = await import("./agent.js");
      const result = await streamChat(
        modelId,
        [{ role: "user", content: inputParts, timestamp: Date.now() }],
        systemPrompt,
        () => {},
      );
      outputText = result.content.trim() || result.thinking?.trim() || "";
    }
    console.log(`[compaction] Index LLM output (${outputText.length}ch): ${outputText.slice(0, 300)}`);
    return outputText;
  } catch (err) {
    console.error("[compaction] Index generation failed:", err);
    return "";
  } finally {
    if (keepaliveInterval) clearInterval(keepaliveInterval);
  }
}

/** Parse LLM index output and assign indexEntry to each archive by ID match. */
function applyIndexOutput(archives: ContextArchive[], outputText: string): number {
  let assigned = 0;
  for (const line of outputText.split("\n")) {
    const match = line.match(/^[-*]?\s*(archive:\S+)\s*[—–\-:]\s*(.+)$/);
    if (match) {
      const archive = archives.find((a) => a.id === match[1]);
      if (archive) {
        archive.indexEntry = match[2].trim();
        assigned++;
      }
    }
  }
  return assigned;
}

/**
 * Archive removed messages and generate an indexed summary.
 *
 * Two modes:
 * - `sync` (default): run the LLM index generation inline, then return the
 *   rich summary text. Keeps compaction simple when the caller is not
 *   time-sensitive.
 * - `deferred`: assign mechanical fallback descriptions immediately so the
 *   chat can proceed with minimal latency, persist archives, and kick off
 *   `enrichArchiveDescriptions` in the background. The background task
 *   upgrades both the archive rows (for FTS retrieval) and the chat's
 *   compaction-summary message (located via `_archiveIds`).
 *
 * Returns the summary text + archive IDs so callers can stamp `_archiveIds`
 * on the summary message for later enrichment patching.
 */
async function archiveAndIndex(
  chatId: string,
  removedMessages: ChatMessage[],
  modelId: string,
  opts: { mode?: "sync" | "deferred"; onKeepalive?: () => void } = {},
): Promise<{ summaryText: string; archiveIds: string[] }> {
  const mode = opts.mode ?? "sync";
  if (removedMessages.length === 0) return { summaryText: "", archiveIds: [] };

  // Filter out compaction summary messages — they contain archive indices and
  // system metadata, not actual conversation content worth archiving.
  // Also filter persisted system-delta (memory injection) messages — they're
  // duplicates of memory-store entries and produce empty archive blocks.
  const substantiveMessages = removedMessages.filter(
    (m) => !m._isCompactionSummary && m.role !== "system"
  );
  if (substantiveMessages.length === 0) return { summaryText: "", archiveIds: [] };

  const blocks = groupIntoBlocks(substantiveMessages);
  if (blocks.length === 0) return { summaryText: "", archiveIds: [] };

  // Assign archive IDs + initial (empty) rows
  let seq = getNextArchiveSequence(chatId);
  const shortChatId = chatId.slice(0, 8);
  const archives: ContextArchive[] = [];
  const blockDescriptions: Array<{ id: string; text: string }> = [];

  for (const block of blocks) {
    const id = `archive:${shortChatId}:${String(seq).padStart(3, "0")}`;
    const text = blockToText(block);
    const tokens = block.reduce((sum, m) => {
      let t = estimateTokens(m.content);
      if (m.toolResults) for (const r of m.toolResults) t += estimateToolResultContentTokens(r.content);
      if (m.thinking) t += estimateTokens(m.thinking);
      return sum + t;
    }, 0);

    archives.push({
      id,
      chatId,
      sequenceNum: seq,
      messages: block,
      indexEntry: "",
      messageCount: block.length,
      estimatedTokens: tokens,
      createdAt: new Date().toISOString(),
    });
    blockDescriptions.push({ id, text });
    seq++;
  }

  if (mode === "sync") {
    const outputText = await runIndexGeneration(blockDescriptions, modelId, opts.onKeepalive);
    const assigned = applyIndexOutput(archives, outputText);
    const filled = archives.length - assigned;
    for (const a of archives) {
      if (!a.indexEntry) a.indexEntry = generateFallbackDescription(a.messages);
    }
    if (filled > 0) {
      console.log(`[compaction] ${filled}/${archives.length} index entries used fallback descriptions`);
    }
  } else {
    // Deferred: mechanical descriptions now, LLM enrichment later.
    for (const a of archives) a.indexEntry = generateFallbackDescription(a.messages);
  }

  saveArchives(archives);
  console.log(`[compaction] Archived ${archives.length} blocks for chat ${chatId} (mode=${mode})`);

  const archiveIds = archives.map((a) => a.id);
  const summaryText = buildSummaryText(archives);

  if (mode === "deferred") {
    // Fire-and-forget: upgrade descriptions once the CPU extraction model is free.
    void enrichArchiveDescriptions(chatId, archiveIds, modelId);
  }

  return { summaryText, archiveIds };
}

/**
 * Background task (for `deferred` mode): load archives by ID, call the LLM to
 * generate rich descriptions, and write them back both to the archive rows and
 * to the chat's compaction-summary message (matched by `_archiveIds`).
 *
 * Best-effort — failures log but do not throw. The chat continues to function
 * with the mechanical fallback descriptions if enrichment never runs.
 */
export async function enrichArchiveDescriptions(
  chatId: string,
  archiveIds: string[],
  modelId: string,
): Promise<void> {
  if (archiveIds.length === 0) return;

  const archives: ContextArchive[] = [];
  for (const id of archiveIds) {
    const a = getArchive(id);
    if (a) archives.push(a);
  }
  if (archives.length === 0) {
    console.warn(`[compaction] Enrichment skipped for ${chatId}: no archives found for ${archiveIds.length} IDs`);
    return;
  }

  const blockDescriptions = archives.map((a) => ({ id: a.id, text: blockToText(a.messages) }));
  const outputText = await runIndexGeneration(blockDescriptions, modelId);
  if (!outputText) {
    console.warn(`[compaction] Enrichment produced no output for chat ${chatId} — keeping fallback descriptions`);
    return;
  }

  const assigned = applyIndexOutput(archives, outputText);
  if (assigned === 0) {
    console.warn(`[compaction] Enrichment parsed 0 lines for chat ${chatId} — keeping fallback descriptions`);
    return;
  }

  // Persist upgraded descriptions (INSERT OR REPLACE on primary key).
  saveArchives(archives);
  console.log(`[compaction] Enriched ${assigned}/${archives.length} archives for chat ${chatId}`);

  // Patch the chat's compaction-summary message so future context uses the richer text.
  // Wrapped in the per-chat write lock so a mid-turn saveChat from the agent loop
  // can't interleave between our getChat and saveChat.
  const MAX_PATCH_RETRIES = 3;
  for (let attempt = 0; attempt < MAX_PATCH_RETRIES; attempt++) {
    try {
      await withChatWriteLock(chatId, async () => {
        const chat = await getChat(chatId);
        if (!chat) return;
        const targetKey = [...archiveIds].sort().join(",");
        const summaryIdx = chat.messages.findIndex(
          (m) => m._isCompactionSummary && m._archiveIds && [...m._archiveIds].sort().join(",") === targetKey,
        );
        if (summaryIdx === -1) {
          // Summary may have been compacted further or removed — acceptable drop.
          return;
        }
        const updated = { ...chat.messages[summaryIdx], content: buildSummaryText(archives) };
        chat.messages[summaryIdx] = updated;
        await saveChat(chat);
        console.log(`[compaction] Patched summary message for chat ${chatId} at index ${summaryIdx}`);
      });
      break; // success — exit retry loop
    } catch (err) {
      if (attempt < MAX_PATCH_RETRIES - 1) {
        console.warn(
          `[compaction] Retry ${attempt + 1}/${MAX_PATCH_RETRIES} patching summary for ${chatId}:`,
          (err as Error).message,
        );
        await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
      } else {
        console.error(`[compaction] Failed to patch summary message for chat ${chatId} after ${MAX_PATCH_RETRIES} attempts:`, err);
      }
    }
  }
}

/**
 * Truncate chat history to fit within the context window (post-response).
 *
 * Strategy: keep the first user message (for title/context) and the most recent
 * messages. Uses character-based token estimation (consistent with truncateBeforeSend).
 * Targets 30% of context window to leave headroom for the next exchange.
 * Generates a summary of removed messages to preserve context continuity.
 *
 * @param forceCompact - When true (e.g. stopReason was "length"), skip usage
 *   checks and compact based on character estimation. This handles cases where
 *   the model hit the context limit but usage data is missing or inaccurate.
 */
export async function truncateChatHistory(
  chat: Chat,
  contextWindow: number,
  forceCompact: boolean = false,
  onCompacting?: () => void,
  onKeepalive?: () => void,
  /** Known token usage from the current turn (the message may not be in chat.messages yet). */
  knownUsage?: number,
  /** System prompt for accurate overhead budgeting. */
  systemPrompt?: string,
  /** Tool schemas for accurate overhead budgeting. */
  tools?: unknown,
): Promise<CompactionResult> {
  const noOp: CompactionResult = { truncated: false, removedCount: 0 };
  const messages = chat.messages;
  if (messages.length <= 1) return noOp;  // Need at least 2 total messages

  const targetTokens = contextWindow * COMPACTION_TARGET_RATIO;

  if (!forceCompact) {
    // Use caller-provided usage if available, otherwise search messages
    let lastUsage = knownUsage ?? 0;
    if (!lastUsage) {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]._outOfContext) continue;
        if (messages[i].usage?.totalTokens) {
          lastUsage = messages[i].usage!.totalTokens;
          break;
        }
      }
    }

    if (lastUsage === 0) return noOp;
    if (lastUsage <= targetTokens) return noOp;
  }

  // Truncate any oversized tool results in-place before estimation.
  // This prevents a single bloated error result (e.g., 1MB bash output)
  // from consuming the entire compaction budget and causing all intermediate
  // messages to be removed.
  const MAX_TOOL_RESULT_CHARS = 60_000;
  for (const m of messages) {
    if (m.role === "assistant" && m.toolResults) {
      for (const r of m.toolResults) {
        if (r.content && r.content.length > MAX_TOOL_RESULT_CHARS) {
          console.log(`[compaction] Truncating oversized tool result: ${r.toolName} ${(r.content.length / 1024).toFixed(0)}KB → ${(MAX_TOOL_RESULT_CHARS / 1024).toFixed(0)}KB`);
          r.content = r.content.slice(0, MAX_TOOL_RESULT_CHARS) + `\n[Truncated from ${(r.content.length / 1024).toFixed(0)}KB]`;
        }
      }
    }
  }

  // Build index of in-context messages (skip already out-of-context ones)
  const inContextIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (!messages[i]._outOfContext) inContextIndices.push(i);
  }

  // Need at least 2 in-context messages to compact (unless forcing with very few messages)
  if (inContextIndices.length <= 1) return noOp;
  if (!forceCompact && inContextIndices.length <= 2) return noOp;  // Auto-compaction needs 3+ in-context

  // Estimate tokens for each in-context message
  const inContextEstimates = inContextIndices.map((idx) => estimateMessageContentTokens(messages[idx]));

  // Account for system prompt + tool schema overhead in the budget.
  // When systemPrompt is provided, use the same scale factor approach as
  // truncateBeforeSend so the per-message estimates match the actual payload.
  // Without this, the greedy backfill can keep messages that push the real
  // payload well past the target, since the system prompt alone can be
  // thousands of tokens (persona + user doc + memory blocks + zeitgeist).
  let overheadTokens = 0;
  let effectiveEstimates = inContextEstimates;
  let scaleFactor = 1;
  if (systemPrompt) {
    const charEstimate = charEstimateContextSize(messages, systemPrompt, tools);
    const messageContentTokens = inContextEstimates.reduce((s, t) => s + t, 0);
    const charEstimateTotal = estimateTokens(systemPrompt) + messageContentTokens;
    // Use max of char-estimate and LLM-reported usage as the numerator: when the
    // tokenizer inflates the payload beyond what char estimation predicts (tool
    // schemas, framing, non-ASCII content), char-only scaling under-counts and
    // the budget keeps too many messages — leaving context hot enough to
    // immediately re-trigger pre-send compaction on the next turn.
    const usageForScale = knownUsage && knownUsage > charEstimate ? knownUsage : charEstimate;
    scaleFactor = charEstimateTotal > 0 ? usageForScale / charEstimateTotal : 1;
    overheadTokens = Math.ceil(estimateTokens(systemPrompt) * scaleFactor);
    effectiveEstimates = inContextEstimates.map((t) => Math.ceil(t * scaleFactor));
  }

  // Iterate backwards over in-context messages to find the keep boundary.
  // The first in-context message is no longer pinned: anchoring the original
  // user prompt across compaction cycles derails conversations whose topic has
  // drifted. The inserted compaction summary already captures earlier work.
  let runningTotal = overheadTokens;
  let keepFromICIdx = inContextIndices.length; // sentinel: nothing fit yet

  for (let ic = inContextIndices.length - 1; ic >= 0; ic--) {
    if (runningTotal + effectiveEstimates[ic] <= targetTokens) {
      runningTotal += effectiveEstimates[ic];
      keepFromICIdx = ic;
    } else {
      break;
    }
  }

  // Split optimization: backward-fill stops either because everything fit
  // or because a message was too big. In the latter case, the boundary
  // message at inContextIndices[keepFromICIdx - 1] would be archived whole.
  // If it's an assistant turn with ≥2 tool-call pairs, peel its head off so
  // its tail stays in context.
  const splitInfos: AssistantRetentionSplit[] = [];
  if (keepFromICIdx === inContextIndices.length) {
    // Last-resort: not even the last message fit. Split it.
    const lastOrigIdx = inContextIndices[inContextIndices.length - 1];
    const splitInfo = tryCompactAssistantMessageForRetention(
      messages[lastOrigIdx],
      Math.max(0, targetTokens - overheadTokens),
      scaleFactor,
    );
    if (splitInfo) {
      splitInfos.push(splitInfo);
      keepFromICIdx = inContextIndices.length - 1;
      console.log(
        `[compaction] Mid-message split (tail): chat=${chat.id} msgIdx=${lastOrigIdx} ` +
        `originalPairs=${splitInfo.originalPairs} archivedPairs=${splitInfo.archivedPairs} ` +
        `keptPairs=${splitInfo.keptPairs} archivedTokens=${splitInfo.archivedTokens} mode=${splitInfo.mode}`,
      );
      runningTotal = overheadTokens + scaledMessageContentTokens(messages[lastOrigIdx], scaleFactor);
      const backfill = backfillOlderMessagesAfterSplit(
        messages,
        inContextIndices,
        inContextIndices.length - 2,
        keepFromICIdx,
        runningTotal,
        targetTokens,
        effectiveEstimates,
        scaleFactor,
        splitInfos,
      );
      keepFromICIdx = backfill.keepFromIC;
      runningTotal = backfill.runningTotal;
      if (backfill.backfilled > 0) {
        console.log(
          `[compaction] Backfilled ${backfill.backfilled} compact recent message(s) after tail split; ` +
          `keepFromIC=${keepFromICIdx} runningTotal=${Math.ceil(runningTotal)}/${Math.ceil(targetTokens)}`,
        );
      }
    } else {
      keepFromICIdx = Math.max(0, inContextIndices.length - 1);
    }
  } else if (keepFromICIdx > 0) {
    // Boundary split: backward-fill stopped because the next-older message
    // didn't fit. If that boundary is a tool-call-heavy assistant turn, peel
    // off its head so its tail rides along with the kept window.
    const boundaryICIdx = keepFromICIdx - 1;
    const boundaryOrigIdx = inContextIndices[boundaryICIdx];
    const remainingBudget = Math.max(0, targetTokens - runningTotal);
    const splitInfo = tryCompactAssistantMessageForRetention(
      messages[boundaryOrigIdx],
      remainingBudget,
      scaleFactor,
    );
    if (splitInfo) {
      splitInfos.push(splitInfo);
      keepFromICIdx = boundaryICIdx;
      console.log(
        `[compaction] Mid-message split (boundary): chat=${chat.id} msgIdx=${boundaryOrigIdx} ` +
        `originalPairs=${splitInfo.originalPairs} archivedPairs=${splitInfo.archivedPairs} ` +
        `keptPairs=${splitInfo.keptPairs} archivedTokens=${splitInfo.archivedTokens} mode=${splitInfo.mode}`,
      );
      runningTotal += scaledMessageContentTokens(messages[boundaryOrigIdx], scaleFactor);
      const backfill = backfillOlderMessagesAfterSplit(
        messages,
        inContextIndices,
        boundaryICIdx - 1,
        keepFromICIdx,
        runningTotal,
        targetTokens,
        effectiveEstimates,
        scaleFactor,
        splitInfos,
      );
      keepFromICIdx = backfill.keepFromIC;
      runningTotal = backfill.runningTotal;
      if (backfill.backfilled > 0) {
        console.log(
          `[compaction] Backfilled ${backfill.backfilled} compact recent message(s) after boundary split; ` +
          `keepFromIC=${keepFromICIdx} runningTotal=${Math.ceil(runningTotal)}/${Math.ceil(targetTokens)}`,
        );
      }
    }
  }

  // For forced compaction (manual /compact), if the budget calculation would keep
  // everything, still compact at least half the in-context messages. The user
  // explicitly asked to compact — don't skip just because it all fits.
  if (forceCompact && keepFromICIdx === 0 && splitInfos.length === 0 && inContextIndices.length > 3) {
    keepFromICIdx = Math.ceil(inContextIndices.length / 2);
    console.log(`[compaction] Force compact: budget keeps all, compacting first half (${keepFromICIdx} of ${inContextIndices.length} in-context messages)`);
  }

  const messagesToMarkCount = keepFromICIdx;
  const splitSummary = splitInfos.length
    ? ` + ${splitInfos.length} split head(s) (${splitInfos.reduce((sum, s) => sum + s.archivedPairs, 0)} pair(s))`
    : "";

  console.log(`[compaction] Post-response budget: overhead=${overheadTokens} scale=${scaleFactor.toFixed(2)} target=${targetTokens} keepFromIC=${keepFromICIdx} marking=${messagesToMarkCount}/${inContextIndices.length} in-context${splitSummary}`);

  if (messagesToMarkCount <= 0 && splitInfos.length === 0) return noOp;

  onCompacting?.();

  // Collect the messages being marked out (for archiving and estimation).
  // Deep-copy each message so that subsequent content stripping does not
  // mutate the objects passed to archiveAndIndex or the CompactionResult
  // returned to the caller — the same objects are still referenced from
  // chat.messages, so stripping would otherwise corrupt the in-memory state
  // AND cause preCompactionFlush (memory extraction) to see truncated
  // tool results instead of the original full-fidelity content.
  const removedMessages: ChatMessage[] = [];
  const markedOriginalIndices: number[] = [];
  for (let ic = 0; ic < keepFromICIdx; ic++) {
    const origIdx = inContextIndices[ic];
    removedMessages.push(structuredClone(messages[origIdx]));
    markedOriginalIndices.push(origIdx);
  }
  for (const splitInfo of splitInfos) removedMessages.push(structuredClone(splitInfo.head));

  // Also include any already-`_outOfContext` messages that have been stripped
  // by a previous compaction pass. These messages precede the newly-compacted
  // block and their content in archives may be thin (fallback descriptions
  // or truncated tool results). Re-archiving them alongside the new block
  // ensures the archive has full-fidelity content for the entire region
  // of the conversation that is being pushed out of context.
  const insertionOrigIdx = inContextIndices[keepFromICIdx];
  const alreadyOutOfContextIndices: number[] = [];
  for (let i = insertionOrigIdx - 1; i >= 0; i--) {
    if (messages[i]._outOfContext && !messages[i]._isCompactionSummary) {
      alreadyOutOfContextIndices.unshift(i);
    } else if (!messages[i]._outOfContext) {
      break;
    }
    if (messages[i]._isCompactionSummary) break;
  }
  for (const idx of alreadyOutOfContextIndices) {
    removedMessages.push(structuredClone(messages[idx]));
  }

  // Archive removed messages and generate indexed summary (post-response
  // path uses sync mode — the agent loop may consume the summary immediately).
  const { summaryText: indexedSummary, archiveIds } = await archiveAndIndex(
    chat.id,
    removedMessages,
    chat.modelId,
    { mode: "sync", onKeepalive },
  );

  // Mark messages as out-of-context (preserve for UI, exclude from LLM)
  // Also strip large content to limit storage growth.
  const ARCHIVED_CONTENT_CAP = 500;
  for (const origIdx of markedOriginalIndices) {
    const m = messages[origIdx];
    m._outOfContext = true;
    // Strip tool results to save space (they're archived separately)
    if (m.toolResults) {
      for (const r of m.toolResults) {
        if (r.content && r.content.length > ARCHIVED_CONTENT_CAP) {
          r.content = r.content.slice(0, ARCHIVED_CONTENT_CAP) + "\n[archived]";
        }
      }
    }
    // Strip thinking content
    if (m.thinking && m.thinking.length > ARCHIVED_CONTENT_CAP) {
      m.thinking = m.thinking.slice(0, ARCHIVED_CONTENT_CAP) + "\n[archived]";
    }
    // Strip base64 images from user messages
    if (m.images) {
      m.images = m.images.map(img => ({ ...img, data: "" }));
    }
  }

  // Insert the compaction summary right before the first kept in-context
  // message. When a split happened without full-message removal, treat the
  // split as 1 compacted unit so the UI still renders a compaction indicator
  // (it checks truthiness of _compactedMessageCount).
  const insertionIndex = inContextIndices[keepFromICIdx];
  const summaryMessage: ChatMessage = {
    role: "assistant",
    content: indexedSummary,
    timestamp: Date.now(),
    _isCompactionSummary: true,
    _compactedMessageCount: messagesToMarkCount + splitInfos.length,
    _archiveIds: archiveIds,
  };
  messages.splice(insertionIndex, 0, summaryMessage);
  chat.messages = messages;

  // Mark stale memory-delta messages (role: "system") in the kept tail as
  // out-of-context — see truncateBeforeSend for rationale (post-compaction
  // memory reset moves their content into the new frozen system prompt).
  let strippedDeltas = 0;
  for (let i = insertionIndex + 1; i < messages.length; i++) {
    if (messages[i].role === "system" && !messages[i]._outOfContext) {
      messages[i]._outOfContext = true;
      strippedDeltas++;
    }
  }
  if (strippedDeltas > 0) {
    console.log(`[compaction] Marked ${strippedDeltas} stale system-delta message(s) out-of-context in kept tail`);
  }

  // Calculate estimated token count for logging
  const estimatedRemovedTokens = removedMessages.reduce((sum, m) => sum + estimateMessageContentTokens(m), 0);

  const inContextCount = chat.messages.filter(m => !m._outOfContext).length;
  console.log(
    `[compaction] Compacted chat ${chat.id}: marked ${messagesToMarkCount} messages out-of-context ` +
    `(~${estimatedRemovedTokens} est. tokens) → ${inContextCount} in-context, ${chat.messages.length} total`
  );

  // Regenerate title based on in-context messages to keep it current
  try {
    const inContextMsgs = chat.messages.filter(m => !m._outOfContext);
    const newTitle = await regenerateTitle(inContextMsgs);
    if (newTitle && newTitle !== chat.title) {
      await updateChatTitle(chat.id, newTitle);
      chat.title = newTitle;
      console.log(`[compaction] Title updated: "${chat.title}"`);
    }
  } catch (err) {
    console.warn("[compaction] Title regeneration failed:", err);
  }

  return {
    truncated: true,
    // Count the split (if any) as 1 compacted unit so user-facing messaging
    // ("Removed N messages") doesn't report 0 when a partial compaction happened.
    removedCount: messagesToMarkCount + splitInfos.length,
    removedMessages,
    estimatedTokenCount: estimatedRemovedTokens,
  };
}

/**
 * Trigger a manual compaction of the chat history.
 * This is used for /compact command - it forces compaction regardless of current token usage.
 * Returns the compaction result, or null if compaction was not needed.
 */
export async function triggerCompaction(
  chat: Chat,
  contextWindow: number,
  systemPrompt?: string,
  tools?: unknown,
): Promise<CompactionResult | null> {
  console.log(`[compaction] Manual compaction triggered for chat ${chat.id}`);

  // Use truncateChatHistory with forceCompact=true
  const result = await truncateChatHistory(chat, contextWindow, true, undefined, undefined, undefined, systemPrompt, tools);
  
  if (result.truncated) {
    console.log(`[compaction] Manual compaction complete: removed ${result.removedCount} messages (~${result.estimatedTokenCount} est. tokens)`);
  } else {
    console.log(`[compaction] Manual compaction skipped: not enough messages to compact`);
  }
  
  return result;
}
