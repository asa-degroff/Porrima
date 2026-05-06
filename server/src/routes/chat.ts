import { Router } from "express";
import type { Request, Response } from "express";
import { randomUUID, createHash } from "crypto";
import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import type { Message, ToolCall, ToolResultMessage, AssistantMessage, Model } from "@mariozechner/pi-ai";
import type { AgentContext } from "@mariozechner/pi-agent-core";
import { getChat, saveChat, getDb, getSettings, saveSettings, loadPendingState, savePendingState, clearPendingState, getProject } from "../services/chat-storage.js";
import { chatMessagesToPiMessages, mergeSystemContextWithUserContent } from "../services/agent.js";
import { createPiModelFromProvider, discoverAllModels, getEffectiveContextWindow } from "../services/models.js";
import type { OllamaModel } from "../types.js";
import { extractMemories, preCompactionFlush, markChatActive, markChatInactive } from "../services/memory-extraction.js";
import { generateTitle, generateRecap, RECAP_THRESHOLD } from "../services/title-generation.js";
import { truncateChatHistory, truncateBeforeSend, triggerCompaction, hasStrandedToolCall } from "../services/compaction.js";
import { buildMemoryAugmentedPrompt, buildSplitAugmentedPrompt, setCachedAugmentedPrompt, invalidateMemoriesCache, resetMemoryContext } from "../services/memory-context.js";
import { getAgentTools } from "../services/agent-tools.js";
import { getSynthesisLock } from "../services/system-chat.js";
import { getAutomationLock } from "../services/automation-lock.js";
import type { ToolSideEffects } from "../services/agent-tools.js";
import { parseSkillInvocations, buildSkillAugmentedPrompt, discoverSkills } from "../services/skills.js";
import type { Skill } from "../services/skills.js";
import * as messageQueue from "../services/message-queue.js";
import type { QueuedUserMessage } from "../services/message-queue.js";
import type { Artifact, Chat, ChatMessage, ChatToolCall, ChatToolResult, GeneratedImage, ImageAttachment, InlineVisual, Project } from "../types.js";
import { saveUserImage } from "../services/user-image-storage.js";
import { streamTTS, isStreamingCapable } from "../services/tts-streaming.js";
import type { TTSSettings } from "../types/tts.js";
import { log } from "../services/logger.js";
import { createSafeStreamFn } from "../services/llm-stream.js";
import { createAgentLoopConfig, runAgentLoop, stopAgentLoop } from "../services/agent-loop-runner.js";

// Live stream registry lives in services/live-streams.ts so server-internal
// background tasks (synthesis, wake cycle) can also emit through it without
// importing from a route module.
import {
  type LiveStream,
  type LiveStreamSubscriber,
  liveStreams,
  activeStreams,
  emitToStream,
  detachSubscriber,
  endLiveStream,
  closeLiveSSE,
  installLiveStream,
  stampStreamPresence,
} from "../services/live-streams.js";
import { sendPush, truncateForBody } from "../services/push-dispatch.js";

const ARTIFACTS_DIR = join(homedir(), ".quje-agent", "artifacts");
const ARTIFACT_ERROR_REPAIR_TTL_MS = 30 * 60 * 1000;
const artifactErrorRepairAttempts = new Map<string, number>();
const artifactAutoRepairAttempts = new Map<string, number>();

interface ArtifactRuntimeErrorReport {
  chatId: string;
  artifactId: string;
  version: number;
  title?: string;
  url?: string;
  message: string;
  stack?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  sourceExcerpt?: string;
  stream?: boolean;
}

function isSafeArtifactId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id);
}

function clampText(value: unknown, maxChars: number): string {
  if (typeof value !== "string") return "";
  return value.length > maxChars ? value.slice(0, maxChars) + "\n[truncated]" : value;
}

function artifactSourcePath(artifactId: string, version: number): string {
  return join(ARTIFACTS_DIR, artifactId, "versions", String(version), "index.html");
}

async function getArtifactCurrentVersion(artifactId: string): Promise<number | null> {
  try {
    const metadataPath = join(ARTIFACTS_DIR, artifactId, "metadata.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf-8"));
    return typeof metadata.currentVersion === "number" ? metadata.currentVersion : null;
  } catch {
    return null;
  }
}

function messageReferencesArtifact(message: ChatMessage, artifactId: string, version: number): boolean {
  const artifacts = [
    ...(message.artifacts || []),
    ...(message.segments?.flatMap((segment) => segment.artifact ? [segment.artifact] : []) || []),
  ];
  return artifacts.some((artifact) =>
    artifact.id === artifactId &&
    (artifact.version == null || artifact.version === version)
  );
}

function chatReferencesArtifact(chat: Chat, artifactId: string, version: number): boolean {
  return chat.messages.some((message) => messageReferencesArtifact(message, artifactId, version));
}

function makeArtifactRepairDedupKey(report: ArtifactRuntimeErrorReport): string {
  const hash = createHash("sha256")
    .update([
      report.chatId,
      report.artifactId,
      String(report.version),
      report.message || "",
      report.stack || "",
      String(report.lineno ?? ""),
      String(report.colno ?? ""),
    ].join("\n"))
    .digest("hex");
  return `${report.chatId}:${report.artifactId}:${report.version}:${hash}`;
}

function hasRecentArtifactRepairAttempt(key: string): boolean {
  const now = Date.now();
  for (const [attemptKey, createdAt] of artifactErrorRepairAttempts) {
    if (now - createdAt > ARTIFACT_ERROR_REPAIR_TTL_MS) {
      artifactErrorRepairAttempts.delete(attemptKey);
    }
  }
  const existing = artifactErrorRepairAttempts.get(key);
  if (existing && now - existing < ARTIFACT_ERROR_REPAIR_TTL_MS) return true;
  artifactErrorRepairAttempts.set(key, now);
  return false;
}

function hasRecentArtifactAutoRepair(chatId: string, artifactId: string): boolean {
  const now = Date.now();
  for (const [attemptKey, createdAt] of artifactAutoRepairAttempts) {
    if (now - createdAt > ARTIFACT_ERROR_REPAIR_TTL_MS) {
      artifactAutoRepairAttempts.delete(attemptKey);
    }
  }
  const key = `${chatId}:${artifactId}`;
  const existing = artifactAutoRepairAttempts.get(key);
  if (existing && now - existing < ARTIFACT_ERROR_REPAIR_TTL_MS) return true;
  artifactAutoRepairAttempts.set(key, now);
  return false;
}

function buildArtifactRepairPrompt(report: ArtifactRuntimeErrorReport): string {
  const location = [
    typeof report.lineno === "number" ? `line ${report.lineno}` : "",
    typeof report.colno === "number" ? `column ${report.colno}` : "",
  ].filter(Boolean).join(", ");
  const sourcePath = artifactSourcePath(report.artifactId, report.version);
  const parts = [
    "[System context - artifact runtime error]",
    `The browser rendered artifact ${report.artifactId} version ${report.version} and reported a JavaScript runtime error.`,
    report.title ? `Artifact title: ${report.title}` : "",
    report.url ? `Artifact URL: ${report.url}` : "",
    `Stored source path: ${sourcePath}`,
    "",
    "Runtime error:",
    `Message: ${clampText(report.message, 1000) || "Unknown runtime error"}`,
    location ? `Location: ${location}` : "",
    report.filename ? `Filename: ${clampText(report.filename, 500)}` : "",
    report.stack ? `Stack:\n${clampText(report.stack, 3000)}` : "",
    report.sourceExcerpt ? `Relevant source excerpt:\n${clampText(report.sourceExcerpt, 4000)}` : "",
    "",
    "Please repair the existing artifact by calling update_artifact with the complete corrected HTML.",
    "Do not create a new artifact. Preserve the visual intent and existing controls.",
    "If this is a p5.js sketch, prefer p5 instance mode and avoid global callbacks or helper names that shadow p5 APIs.",
    "Keep the final response brief.",
  ];
  return parts.filter((part) => part !== "").join("\n");
}

async function getArtifactSourceExcerpt(report: ArtifactRuntimeErrorReport): Promise<string> {
  const provided = clampText(report.sourceExcerpt, 4000);
  if (provided) return provided;
  if (typeof report.lineno !== "number" || report.lineno < 1) return "";
  try {
    const source = await readFile(artifactSourcePath(report.artifactId, report.version), "utf-8");
    const lines = source.split("\n");
    const start = Math.max(0, report.lineno - 6);
    const end = Math.min(lines.length, report.lineno + 5);
    return lines
      .slice(start, end)
      .map((line, idx) => `${start + idx + 1}: ${line}`)
      .join("\n");
  } catch {
    return "";
  }
}

function queuedMessageToChatMessage(queued: QueuedUserMessage): ChatMessage {
  if (queued.hidden) {
    return {
      role: "system",
      content: queued.message,
      timestamp: queued.timestamp,
      _isSystemMessage: true,
    };
  }
  return {
    role: "user",
    content: queued.message,
    images: queued.images?.length ? queued.images : undefined,
    timestamp: queued.timestamp,
  };
}

/**
 * Initialize an SSE response: write headers, disable Nagle, install the live
 * stream, and emit a keepalive. Idempotent — safe to call before pre-send
 * compaction and again inside handleChatStream.
 */
function ensureSSEStream(res: Response, req: Request, chatId: string) {
  if (!res.headersSent) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
  }
  res.socket?.setNoDelay(true);
  installLiveStream(res, req, chatId);
  res.write(`: connected\n\n`);
}

function attachToLiveStreamResponse(req: Request, res: Response, stream: LiveStream, label: string) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.socket?.setNoDelay(true);
  res.write(`: ${label}\n\n`);

  // Stamp push-presence so a device attached to a live turn does not also get
  // a push notification when that turn completes.
  stampStreamPresence(req);

  for (const chunk of stream.buffer) {
    try { res.write(chunk); } catch { return; }
  }

  const subWrite = res.write.bind(res) as (chunk: string) => boolean;
  const sub: LiveStreamSubscriber = { write: subWrite, res, isPrimary: false };
  stream.subscribers.add(sub);

  res.on("close", () => {
    detachSubscriber(stream, sub);
  });
}

function shouldGenerateInitialTitle(chat: Chat): boolean {
  return chat.messages.filter((m) => m.role === "user").length === 1;
}

// ---------------------------------------------------------------------------
// KV cache prefix diagnostics
// ---------------------------------------------------------------------------
// At end of each completed turn we snapshot a digest of the reconstructed
// pi-message history. On the next turn we compare the new context's digest
// against the snapshot — equality means the prefix llama.cpp cached on the
// previous turn is reusable. Divergence means something invalidated it (a
// compaction rewrite, a retroactive message edit, a replay-shape change).
// This is what would have caught the canonical-row collapse bug at log time.
// ---------------------------------------------------------------------------

interface SentPrefixSnapshot {
  digest: string;
  piMsgCount: number;
}

const lastSentPrefixSnapshot = new Map<string, SentPrefixSnapshot>();

function digestPiMessages(piMessages: Message[]): string {
  const hash = createHash("sha1");
  for (const m of piMessages) {
    hash.update(JSON.stringify(m));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}

function summarizeReplayShape(messages: ChatMessage[]): { lastLoop: string; fragments: number } {
  let fragments = 0;
  let lastLoopId: string | undefined;
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    if (m._toolLoopFragment) fragments++;
    if (m._toolLoopId) lastLoopId = m._toolLoopId;
  }
  return { lastLoop: lastLoopId ? lastLoopId.slice(0, 8) : "-", fragments };
}

function logKvCacheState(opts: {
  chatId: string;
  source: "send" | "edit";
  systemPromptChars: number;
  deltaChars: number;
  newMsgChars: number;
  persistedRows: number;
  contextPiMessages: Message[];
  shape: { lastLoop: string; fragments: number };
}): void {
  const digest = digestPiMessages(opts.contextPiMessages);
  const prev = lastSentPrefixSnapshot.get(opts.chatId);
  let prefixState: string;
  if (!prev) {
    prefixState = "baseline";
  } else if (prev.digest === digest && prev.piMsgCount === opts.contextPiMessages.length) {
    prefixState = "match";
  } else {
    prefixState =
      `diverged(prev_msgs=${prev.piMsgCount},now_msgs=${opts.contextPiMessages.length},` +
      `prev_digest=${prev.digest},now_digest=${digest})`;
  }
  log(
    `[kv-cache] chat=${opts.chatId} src=${opts.source} ` +
    `system_prompt=${opts.systemPromptChars}ch delta=${opts.deltaChars}ch new_msg=${opts.newMsgChars}ch ` +
    `type=${opts.deltaChars > 0 ? "delta" : "stable"} ` +
    `persisted=${opts.persistedRows} pi_msgs=${opts.contextPiMessages.length} ` +
    `last_loop=${opts.shape.lastLoop} frags=${opts.shape.fragments} prefix=${prefixState}`
  );
}

function snapshotSentPrefix(chatId: string, chatMessages: ChatMessage[], modelId: string): void {
  const piMessages = chatMessagesToPiMessages(chatMessages, modelId);
  lastSentPrefixSnapshot.set(chatId, {
    digest: digestPiMessages(piMessages),
    piMsgCount: piMessages.length,
  });
}

/**
 * Run `fn` while periodically emitting SSE keepalive comments to prevent the
 * client's inactivity timeout from firing. Use this to wrap compaction work:
 * preCompactionFlush (CPU-only extraction LLM), buildSplitAugmentedPrompt
 * (embed + rerank), and archive index generation can each take several
 * seconds with no other SSE events flowing. Without this, the client's
 * 95s timeout fires a spurious "Model appears unresponsive" error mid-compaction.
 *
 * Pings every 10s. SSE comment lines (`: text\n\n`) are discarded by the client
 * parser but reset its inactivity timer because bytes arrived on the stream.
 */
async function withSSEKeepalive<T>(res: Response, fn: () => Promise<T>): Promise<T> {
  const interval = setInterval(() => {
    try {
      res.write(`: keepalive\n\n`);
    } catch {
      // Connection closed — the live-stream registry handles fan-out; ignore.
    }
  }, 10_000);
  try {
    return await fn();
  } finally {
    clearInterval(interval);
  }
}

/**
 * Parse /compact command from user message.
 * Returns { compact: true, followUpMessage: string | null } if found.
 * /compact alone → followUpMessage is null
 * /compact [message] → followUpMessage contains the message text
 */
function parseCompactCommand(message: string): { compact: boolean; followUpMessage: string | null } {
  const trimmed = message.trim();
  if (trimmed === "/compact") {
    return { compact: true, followUpMessage: null };
  }
  if (trimmed.startsWith("/compact ")) {
    return { compact: true, followUpMessage: trimmed.slice(9).trim() };
  }
  return { compact: false, followUpMessage: null };
}

/** Truncate a string to maxChars graphemes, preserving emoji and multi-byte characters */
function truncateTitle(text: string, maxChars: number = 50): string {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const segments = segmenter.segment(text);
  let result = "";
  let count = 0;
  for (const { segment } of segments) {
    if (count >= maxChars) return result + "...";
    result += segment;
    count++;
  }
  return result;
}

/** Build a pi-ai Message from user input (text and/or images) */
function buildUserPiMessage(
  message: string,
  images?: ImageAttachment[],
  systemContext?: string
): Message {
  const contentWithSystemContext = mergeSystemContextWithUserContent(systemContext, message);
  if (images?.length) {
    const content: any[] = [];
    if (contentWithSystemContext) content.push({ type: "text", text: contentWithSystemContext });
    for (const img of images) {
      content.push({ type: "image", data: img.data, mimeType: img.mimeType });
    }
    return { role: "user", content, timestamp: Date.now() };
  }
  return { role: "user", content: contentWithSystemContext, timestamp: Date.now() };
}

/** Persist images to disk and enrich attachments with id/url/thumbUrl (fire-and-forget safe) */
async function persistImages(images: ImageAttachment[]): Promise<ImageAttachment[]> {
  return Promise.all(
    images.map(async (img) => {
      if (img.id && img.url && img.thumbUrl) return img; // already persisted
      try {
        const buffer = Buffer.from(img.data, "base64");
        const id = crypto.randomUUID();
        const record = await saveUserImage(id, buffer, img.mimeType, img.name);
        return { ...img, id: record.id, url: record.url, thumbUrl: record.thumbUrl };
      } catch (e) {
        console.error("[user-images] Failed to persist image:", e);
        return img; // keep original base64-only attachment on failure
      }
    })
  );
}

// Keep SSE connections alive while the model or tools are silent.
const SSE_KEEPALIVE_INTERVAL_MS = 30_000; // 30s keepalive pings to prevent client timeout

// Noop side effects just to satisfy getAgentTools' signature when we need
// tool schemas for context-size estimation, not execution.
const NOOP_TOOL_EFFECTS: ToolSideEffects = {
  onArtifact: () => {},
  onVisual: () => {},
  onGeneratedImage: () => {},
  onPendingReviewImage: () => {},
  onAskUser: () => {},
};

// Build a tool schema list suitable for compaction size-estimation only.
// The returned schemas are identical to what execution would use (same
// chatType gating), so estimateToolSchemaTokens sees the real wire cost.
function toolsForEstimate(
  chat: Chat,
  contextWindow: number,
  project?: Project | string,
): unknown {
  if (chat.type === "quick") return undefined;
  return getAgentTools(chat.id, NOOP_TOOL_EFFECTS, contextWindow, project, chat.type);
}

// Post-compaction context size estimate, used to populate the compaction SSE
// event so the client can show a provisional token count instead of
// "context reset" while waiting for the next assistant's real usage.
async function estimatePostCompactionTokens(
  chat: Chat,
  systemPrompt: string,
  tools: unknown,
): Promise<number> {
  try {
    const { estimateContextTokens } = await import("../services/compaction.js");
    return estimateContextTokens(chat.messages, systemPrompt, tools);
  } catch {
    return 0;
  }
}

const router = Router();

async function stampUserActivity(chat: Chat): Promise<void> {
  if (chat.type === "system") return;

  try {
    const settings = await getSettings();
    settings.lastUserActivityAt = new Date().toISOString();
    delete settings.sleepModeTriggeredAt;
    await saveSettings(settings);
  } catch (e) {
    console.warn("[chat] Failed to stamp user activity:", e);
  }
}

async function stampAssistantCompletion(chat: Chat): Promise<void> {
  if (chat.type === "system") return;

  try {
    const settings = await getSettings();
    settings.lastAgentCompletedAt = new Date().toISOString();
    await saveSettings(settings);
  } catch (e) {
    console.warn("[chat] Failed to stamp assistant completion:", e);
  }
}

async function waitForBackgroundAutomation(chatId: string): Promise<void> {
  const pendingAutomation = getAutomationLock();
  if (pendingAutomation) {
    console.log(
      `[chat] Waiting for automation to complete before processing message for chat ${chatId}`,
    );
    await pendingAutomation;
    return;
  }

  // Compatibility for any legacy synthesis dispatch path that did not acquire
  // the general automation lock.
  const pendingSynthesis = getSynthesisLock();
  if (pendingSynthesis) {
    console.log(
      `[chat] Waiting for system synthesis to complete before processing message for chat ${chatId}`,
    );
    await pendingSynthesis;
  }
}

/**
 * Shared SSE streaming handler using pi-agent-core's agentLoop.
 * Both POST / (send) and POST /edit call this after their own setup.
 *
 * @param userPiMessage - the user's prompt message for agentLoop, or null for resume (agentLoopContinue)
 * @param contextMessages - conversation history (pi-ai Messages), excluding current user message for fresh, or full pending state for resume
 */
async function handleChatStream(
  chat: Chat,
  userMessage: string,
  contextMessages: Message[],
  systemPrompt: string,
  userPiMessage: Message | null,
  req: Request,
  res: Response,
  options: { hiddenUserMessage?: boolean } = {}
) {
  // Mark chat as active so the scheduler skips extraction for it —
  // compaction cycles already use the extraction server heavily.
  markChatActive(chat.id);

  // Safety check: log if context is unexpectedly empty for non-first messages
  if (contextMessages.length === 0 && chat.messages.length > 1) {
    console.error(`[chat] CRITICAL: context is empty but chat has ${chat.messages.length} messages - agent will respond without conversation history`);
  }

  // Resolve project path once for AGENTS.md loading in memory augmentation
  let projectPath: string | undefined;
  if (chat.projectId) {
    const project = await getProject(chat.projectId);
    projectPath = project?.path;
  }

  // Ensure SSE headers are set and the live-stream registry is wired up.
  // Idempotent: a caller that ran pre-send compaction already installed the
  // live stream; a second call here is a no-op for the registry and just
  // re-flushes a keepalive.
  ensureSSEStream(res, req, chat.id);

  // Reuse the live stream's abort controller so that the grace timer and
  // /stop endpoint share a single cancellation signal. `connectionClosed` is
  // only flipped when the stream is genuinely aborted (grace expired, /stop,
  // or server-initiated), NOT on transient client disconnect — the live
  // stream keeps generation running while a refreshing client reconnects.
  const liveStream = liveStreams.get(chat.id)!;
  const connectionAbortController = liveStream.abort;
  let connectionClosed = false;
  connectionAbortController.signal.addEventListener("abort", () => {
    connectionClosed = true;
  });

  const MAX_ITERATIONS = 500;

  // Track ordering for interleaved display
  interface OutputSegment {
    seq: number;
    type: "text" | "tool_call" | "tool_result" | "artifact" | "generated_image" | "visual" | "compaction_marker";
    content?: string;
    toolCall?: ChatToolCall;
    toolResult?: ChatToolResult;
    artifact?: Artifact;
    generatedImage?: GeneratedImage;
    visual?: InlineVisual;
  }

  // Mutable accumulator state — reset between follow-up turns
  const state = {
    fullText: "",
    thinkingText: "",
    allToolCalls: [] as ChatToolCall[],
    allToolResults: [] as ChatToolResult[],
    allArtifacts: [] as Artifact[],
    allVisuals: [] as InlineVisual[],
    allGeneratedImages: [] as GeneratedImage[],
    segments: [] as OutputSegment[],
    seqCounter: 0,
    pendingText: "",
    finalUsage: undefined as ChatMessage["usage"],
    // Track if last turn ended with toolUse but no final text
    incompleteToolTurn: false,
    // Track if stopReason was "stop" but thinking block had drafted tool-call syntax
    // that never materialized as a structured call — needs continuation to recover.
    strandedToolCall: false,
    // Track if thinking was promoted to content (not useful for previews)
    thinkingPromoted: false,
    // Track thinking duration
    thinkingStartTime: null as number | null,
    thinkingDurationMs: 0,
    // Mid-turn compaction: set when usage > 85% during tool loop
    needsMidTurnCompaction: false,
    // Track last llama.cpp timings for model-stats recording (per-message)
    lastLlamaTimings: null as any,
    // Track llama.cpp prompt-cache metadata for model-stats recording
    lastLlamaCache: null as any,
    toolLoopId: randomUUID(),
    committedTextLength: 0,
    committedThinkingLength: 0,
    committedToolCallCount: 0,
    committedToolResultCount: 0,
    committedArtifactCount: 0,
    committedVisualCount: 0,
    committedGeneratedImageCount: 0,
    committedSegmentCount: 0,
    committedThinkingDurationMs: 0,
    hasCommittedToolLoopRows: false,
    pendingFinalAssistantMessage: null as ChatMessage | null,
    // Dedup guard: count of consecutive iterations whose tool calls were
    // byte-identical to the prior iteration. Breaks loops where the model
    // re-emits the same tool call instead of moving on.
    duplicateToolCallStreak: 0,
    lastIterationToolCallSignature: null as string | null,
  };
  const ttsTextChunks: string[] = [];

  function resetAccumulators() {
    state.fullText = "";
    state.thinkingText = "";
    state.allToolCalls = [];
    state.allToolResults = [];
    state.allArtifacts = [];
    state.allVisuals = [];
    state.allGeneratedImages = [];
    state.segments = [];
    state.seqCounter = 0;
    state.pendingText = "";
    state.finalUsage = undefined;
    state.incompleteToolTurn = false;
    state.thinkingPromoted = false;
    state.thinkingStartTime = null;
    state.thinkingDurationMs = 0;
    state.needsMidTurnCompaction = false;
    state.lastLlamaTimings = null;
    state.lastLlamaCache = null;
    state.toolLoopId = randomUUID();
    state.committedTextLength = 0;
    state.committedThinkingLength = 0;
    state.committedToolCallCount = 0;
    state.committedToolResultCount = 0;
    state.committedArtifactCount = 0;
    state.committedVisualCount = 0;
    state.committedGeneratedImageCount = 0;
    state.committedSegmentCount = 0;
    state.committedThinkingDurationMs = 0;
    state.hasCommittedToolLoopRows = false;
    state.pendingFinalAssistantMessage = null;
    state.duplicateToolCallStreak = 0;
    state.lastIterationToolCallSignature = null;
    ttsTextChunks.length = 0;
  }

  function isPlaceholderEllipsis(text: string | undefined): boolean {
    if (!text) return false;
    const normalized = text.replace(/\s/g, "").replace(/…/g, "...");
    return normalized.length > 0 && /^(\.{3})+$/.test(normalized);
  }

  function stripPlaceholderEllipsisBlocks(text: string): string {
    return text
      .split(/\n{2,}/)
      .filter((block) => !isPlaceholderEllipsis(block))
      .join("\n\n");
  }

  function buildCurrentAssistantMessage(): ChatMessage {
    // Flush any remaining text
    if (state.pendingText.trim() && !isPlaceholderEllipsis(state.pendingText)) {
      state.segments.push({ seq: ++state.seqCounter, type: "text", content: state.pendingText });
    }
    state.pendingText = "";
    const cleanSegments = state.segments.filter((segment) =>
      segment.type !== "text" || !isPlaceholderEllipsis(segment.content)
    );
    const cleanContent = stripPlaceholderEllipsisBlocks(state.fullText);
    const cleanThinking = isPlaceholderEllipsis(state.thinkingText) ? "" : state.thinkingText;

    return {
      role: "assistant",
      content: cleanContent,
      thinking: cleanThinking || undefined,
      thinkingDurationMs: state.thinkingDurationMs > 0 ? state.thinkingDurationMs : undefined,
      usage: state.finalUsage,
      toolCalls: state.allToolCalls.length > 0 ? state.allToolCalls : undefined,
      toolResults: state.allToolResults.length > 0 ? state.allToolResults : undefined,
      artifacts: state.allArtifacts.length > 0 ? state.allArtifacts : undefined,
      visuals: state.allVisuals.length > 0 ? state.allVisuals : undefined,
      generatedImages: state.allGeneratedImages.length > 0 ? state.allGeneratedImages : undefined,
      segments: cleanSegments.length > 0 ? cleanSegments : undefined,
      timestamp: Date.now(),
      _thinkingPromoted: state.thinkingPromoted || undefined,
    };
  }

  function cleanOutputSegments(segments: OutputSegment[]): OutputSegment[] {
    return segments.filter((segment) =>
      segment.type !== "text" || !isPlaceholderEllipsis(segment.content)
    );
  }

  function usageFromAssistantMessage(msg: AssistantMessage): ChatMessage["usage"] | undefined {
    return msg.usage
      ? { input: msg.usage.input, output: msg.usage.output, totalTokens: msg.usage.totalTokens }
      : undefined;
  }

  function extractTextFromAssistantMessage(msg: AssistantMessage): string {
    return stripPlaceholderEllipsisBlocks(
      msg.content
        .filter((block) => block.type === "text" && block.text && !isPlaceholderEllipsis(block.text))
        .map((block) => block.type === "text" ? block.text : "")
        .join("")
    );
  }

  function extractThinkingFromAssistantMessage(msg: AssistantMessage): string {
    return msg.content
      .filter((block) => block.type === "thinking" && block.thinking && !isPlaceholderEllipsis(block.thinking))
      .map((block) => block.type === "thinking" ? block.thinking : "")
      .join("\n");
  }

  function extractToolCallsFromAssistantMessage(msg: AssistantMessage): ChatToolCall[] {
    return msg.content
      .filter((block) => block.type === "toolCall")
      .map((block) => ({
        id: block.id,
        name: block.name,
        arguments: block.arguments,
      }));
  }

  function applyToolLoopMetadata(message: ChatMessage): ChatMessage {
    if (message.toolCalls?.length || state.hasCommittedToolLoopRows) {
      message._toolLoopId = state.toolLoopId;
    }
    if (message.toolCalls?.length) {
      message._toolLoopFragment = true;
    }
    return message;
  }

  function buildUncommittedAssistantMessage(): ChatMessage {
    flushTextSegment();
    const content = stripPlaceholderEllipsisBlocks(state.fullText.slice(state.committedTextLength));
    const thinking = isPlaceholderEllipsis(state.thinkingText)
      ? ""
      : state.thinkingText.slice(state.committedThinkingLength);
    const toolCalls = state.allToolCalls.slice(state.committedToolCallCount);
    const toolCallIds = new Set(toolCalls.map((tc) => tc.id));
    const toolResults = state.allToolResults
      .slice(state.committedToolResultCount)
      .filter((tr) => toolCallIds.size === 0 || toolCallIds.has(tr.toolCallId));
    const artifacts = state.allArtifacts.slice(state.committedArtifactCount);
    const visuals = state.allVisuals.slice(state.committedVisualCount);
    const generatedImages = state.allGeneratedImages.slice(state.committedGeneratedImageCount);
    const segments = cleanOutputSegments(state.segments.slice(state.committedSegmentCount));

    return applyToolLoopMetadata({
      role: "assistant",
      content,
      thinking: state.thinkingPromoted ? undefined : (thinking || undefined),
      thinkingDurationMs: state.thinkingDurationMs > state.committedThinkingDurationMs
        ? state.thinkingDurationMs - state.committedThinkingDurationMs
        : undefined,
      usage: state.finalUsage,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      toolResults: toolResults.length > 0 ? toolResults : undefined,
      artifacts: artifacts.length > 0 ? artifacts : undefined,
      visuals: visuals.length > 0 ? visuals : undefined,
      generatedImages: generatedImages.length > 0 ? generatedImages : undefined,
      segments: segments.length > 0 ? segments : undefined,
      timestamp: Date.now(),
      _thinkingPromoted: state.thinkingPromoted || undefined,
    });
  }

  function buildAssistantMessageFromTurn(msg: AssistantMessage): ChatMessage {
    flushTextSegment();
    const toolCalls = extractToolCallsFromAssistantMessage(msg);
    const toolCallIds = new Set(toolCalls.map((tc) => tc.id));
    const toolResults = state.allToolResults
      .slice(state.committedToolResultCount)
      .filter((tr) => toolCallIds.has(tr.toolCallId));
    const artifacts = state.allArtifacts.slice(state.committedArtifactCount);
    const visuals = state.allVisuals.slice(state.committedVisualCount);
    const generatedImages = state.allGeneratedImages.slice(state.committedGeneratedImageCount);
    const segments = cleanOutputSegments(state.segments.slice(state.committedSegmentCount));
    const textFromMessage = extractTextFromAssistantMessage(msg);
    const uncommittedText = stripPlaceholderEllipsisBlocks(state.fullText.slice(state.committedTextLength));
    const content = textFromMessage || uncommittedText;
    const thinkingFromMessage = extractThinkingFromAssistantMessage(msg);

    return applyToolLoopMetadata({
      role: "assistant",
      content,
      thinking: state.thinkingPromoted ? undefined : (thinkingFromMessage || undefined),
      thinkingDurationMs: state.thinkingDurationMs > state.committedThinkingDurationMs
        ? state.thinkingDurationMs - state.committedThinkingDurationMs
        : undefined,
      usage: usageFromAssistantMessage(msg),
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      toolResults: toolResults.length > 0 ? toolResults : undefined,
      artifacts: artifacts.length > 0 ? artifacts : undefined,
      visuals: visuals.length > 0 ? visuals : undefined,
      generatedImages: generatedImages.length > 0 ? generatedImages : undefined,
      segments: segments.length > 0 ? segments : undefined,
      timestamp: msg.timestamp || Date.now(),
      _thinkingPromoted: state.thinkingPromoted || undefined,
    });
  }

  function upsertAssistantMessage(message: ChatMessage, inProgress = false): ChatMessage {
    const row = inProgress ? { ...message, _inProgress: true } : message;
    let inProgressIdx = -1;
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      const candidate = chat.messages[i];
      if (
        candidate.role === "assistant" &&
        candidate._inProgress &&
        (!message._toolLoopId || !candidate._toolLoopId || candidate._toolLoopId === message._toolLoopId)
      ) {
        inProgressIdx = i;
        break;
      }
    }
    if (inProgressIdx >= 0) chat.messages[inProgressIdx] = row;
    else chat.messages.push(row);
    return row;
  }

  function markUncommittedAssistantMessageCommitted(message: ChatMessage) {
    state.committedTextLength = state.fullText.length;
    state.committedThinkingLength = state.thinkingText.length;
    state.committedToolCallCount = state.allToolCalls.length;
    state.committedToolResultCount = state.allToolResults.length;
    state.committedArtifactCount = state.allArtifacts.length;
    state.committedVisualCount = state.allVisuals.length;
    state.committedGeneratedImageCount = state.allGeneratedImages.length;
    state.committedSegmentCount = state.segments.length;
    state.committedThinkingDurationMs = state.thinkingDurationMs;
    if (message._toolLoopId) state.hasCommittedToolLoopRows = true;
    state.pendingFinalAssistantMessage = null;
  }

  function hasAssistantMessageContent(message: ChatMessage): boolean {
    return !!(message.content.trim() || message.thinking || message.toolCalls?.length);
  }

  function finalizeUncommittedAssistantMessage(): ChatMessage | null {
    const message = state.pendingFinalAssistantMessage ?? buildUncommittedAssistantMessage();
    if (!hasAssistantMessageContent(message)) return null;
    upsertAssistantMessage(message);
    markUncommittedAssistantMessageCommitted(message);
    return message;
  }

  function hasUncommittedAssistantActivity(): boolean {
    return (
      state.pendingFinalAssistantMessage !== null ||
      state.fullText.length > state.committedTextLength ||
      state.thinkingText.length > state.committedThinkingLength ||
      state.allToolCalls.length > state.committedToolCallCount ||
      state.allToolResults.length > state.committedToolResultCount ||
      state.segments.length > state.committedSegmentCount
    );
  }

  /** Flush any active thinking timer into accumulated duration */
  function flushThinkingTimer() {
    if (state.thinkingStartTime !== null) {
      state.thinkingDurationMs += Date.now() - state.thinkingStartTime;
      state.thinkingStartTime = null;
    }
  }

  /** Flush any accumulated text into a text segment */
  function flushTextSegment() {
    if (state.pendingText.trim() && !isPlaceholderEllipsis(state.pendingText)) {
      state.segments.push({ seq: ++state.seqCounter, type: "text", content: state.pendingText });
    }
    state.pendingText = "";
  }

  function appendTextDelta(delta: string): boolean {
    if (isPlaceholderEllipsis(delta)) return false;
    flushThinkingTimer();
    state.fullText += delta;
    state.pendingText += delta;
    ttsTextChunks.push(delta);
    res.write(`event: text_delta\ndata: ${JSON.stringify({ delta })}\n\n`);
    return true;
  }

  function appendThinkingDelta(delta: string): boolean {
    if (isPlaceholderEllipsis(delta)) return false;
    if (state.thinkingStartTime === null) {
      state.thinkingStartTime = Date.now();
    }
    state.thinkingText += delta;
    res.write(`event: thinking_delta\ndata: ${JSON.stringify({ delta })}\n\n`);
    return true;
  }

  // Create a turn-level abort controller to prevent signal bleeding across iterations
  // Also abort the turn when the client disconnects (SSE close)
  const turnAbortController = new AbortController();
  connectionAbortController.signal.addEventListener("abort", () => {
    turnAbortController.abort();
  });

  // ask_user state — owned by the route, set via callback.
  // Uses a ref object so TypeScript can track mutations through closures.
  const askUserRef: { current: { question: string; toolCallId: string } | null } = { current: null };

  // SSE keepalive interval — prevents client timeout during gaps in SSE output
  // (model loading, long tool execution, between tool results and next LLM call).
  // Any real SSE event (text_delta, tool_status, etc.) also resets the client timer,
  // so this only fires during silent gaps.
  let sseKeepaliveInterval: ReturnType<typeof setInterval> | null = null;

  const startSSEKeepalive = () => {
    if (sseKeepaliveInterval) return;
    sseKeepaliveInterval = setInterval(() => {
      if (!connectionClosed) {
        try {
          const ok = res.write(`: keepalive\n\n`);
          if (!ok) {
            console.warn("[chat] keepalive write returned false — connection may be stalled");
          }
        } catch (e) {
          console.warn("[chat] keepalive write failed — connection likely closed");
          connectionClosed = true;
          stopSSEKeepalive();
          connectionAbortController.abort();
        }
      }
    }, SSE_KEEPALIVE_INTERVAL_MS);
  };

  const stopSSEKeepalive = () => {
    if (sseKeepaliveInterval) {
      clearInterval(sseKeepaliveInterval);
      sseKeepaliveInterval = null;
    }
  };

  // Start SSE keepalive immediately — model discovery, memory augmentation,
  // and other setup can take significant time before the agent loop begins.
  // Without early keepalive, the client's inactivity timer could fire during setup.
  startSSEKeepalive();

  // Side-effects bridge between tool execution and SSE output
  const effects: ToolSideEffects = {
    onArtifact: (artifact) => {
      state.allArtifacts.push(artifact);
      state.segments.push({ seq: ++state.seqCounter, type: "artifact", artifact });
      res.write(`event: artifact\ndata: ${JSON.stringify(artifact)}\n\n`);
    },
    onVisual: (visual) => {
      state.allVisuals.push(visual);
      state.segments.push({ seq: ++state.seqCounter, type: "visual", visual });
      res.write(`event: visual\ndata: ${JSON.stringify(visual)}\n\n`);
    },
    onGeneratedImage: (image) => {
      state.allGeneratedImages.push(image);
      state.segments.push({ seq: ++state.seqCounter, type: "generated_image", generatedImage: image });
      res.write(`event: generated_image\ndata: ${JSON.stringify(image)}\n\n`);
    },
    onPendingReviewImage: () => {
      // No-op: native Ollama API handles images in tool results directly
    },
    onAskUser: (question, toolCallId) => {
      askUserRef.current = { question, toolCallId };
      turnAbortController.abort(); // Only abort the current turn, not the SSE connection
    },
  };

  const isAgent = chat.type === "agent" || chat.type === "bluesky" || chat.type === "system";

  // Load TTS settings
  const settings = await getSettings();
  const ttsSettings: TTSSettings = (settings as any).tts || { enabled: false, backend: "kokoro" };
  const ttsEnabled = ttsSettings.enabled && ttsSettings.streamingEnabled && isStreamingCapable(ttsSettings.backend);

  // TTS pause controller - aborts TTS stream on tool execution
  let ttsPauseController: AbortController | null = null;

  let iterations = 0;
  let waitingForInput = false;
  let hitContextLimit = false;
  // Defer memory extractions until the agent loop finishes to avoid concurrent
  // LLM calls that can interfere with the active tool loop (e.g., model unload/reload)
  const deferredExtractions: Array<{ userMsg: string; assistantMsg: string }> = [];
  let lastUserMessage = userMessage; // tracks the current user message text for title gen / memory
  let currentTurnIsHidden = options.hiddenUserMessage === true;

  console.log(`[chat] type=${chat.type} isAgent=${isAgent} tts=${ttsEnabled}`);

  try {
    // Discover model with timeout protection
    let allModels: OllamaModel[];
    let ollamaModel: OllamaModel | undefined;
    let piModel: Model<string>;

    try {
      allModels = await discoverAllModels();
      ollamaModel = allModels.find(m => m.id === chat.modelId);
      if (!ollamaModel) throw new Error(`Model not found: ${chat.modelId}`);
      piModel = await createPiModelFromProvider(ollamaModel);
      // Override contextWindow with effective value so num_ctx sent to Ollama
      // respects per-chat and per-model settings. Without this, Ollama receives
      // the full detected context window (e.g. 128k) and may overflow VRAM.
      piModel.contextWindow = getEffectiveContextWindow(chat, ollamaModel, settings);
    } catch (modelError: any) {
      console.error("[chat] model discovery failed:", modelError.message);
      // Send error event and end response cleanly
      res.write(`event: error\ndata: ${JSON.stringify({ error: `Model unavailable: ${modelError.message}` })}\n\n`);
      res.end();
      return;
    }

    // Create tools AFTER model discovery so we can pass the effective context window
    const project = chat.projectId ? await getProject(chat.projectId) : null;
    const agentTools = isAgent ? getAgentTools(chat.id, effects, piModel.contextWindow, project || undefined, chat.type) : undefined;

    // Build agent context
    const context: AgentContext = {
      systemPrompt,
      messages: [...contextMessages],
      tools: agentTools,
    };

    // Pass per-chat Ollama runtime options to the stream function
    const safeStreamFn = createSafeStreamFn(chat.ollamaOptions);

    // Build config
    const config = createAgentLoopConfig({
      model: piModel,
      getSteeringMessages: async () => {
        if (askUserRef.current) {
          return [{ role: "user" as const, content: "[paused for user input]", timestamp: Date.now() }];
        }
        // Check for queued messages — these are sent by the user while the agent
        // is working (tool loop in progress). Injecting them as steering messages
        // means the agent sees them between tool executions and can adjust.
        const queued = await messageQueue.drainOne(chat.id);
        if (!queued) return [];

        // Save any uncommitted assistant row and the steering user message.
        // Tool-use fragments may already have been committed at turn_end.
        const assistantMsg = finalizeUncommittedAssistantMessage();
        chat.messages.push(queuedMessageToChatMessage(queued));
        await saveChat(chat);

        // Emit events so client can finalize current response and start the steered turn
        if (assistantMsg) {
          res.write(`event: message_complete\ndata: ${JSON.stringify({ message: assistantMsg })}\n\n`);
        }
        res.write(`event: follow_up_start\ndata: ${JSON.stringify({ queuedMessageId: queued.id })}\n\n`);

        // Defer memory extraction for the completed turn
        if (assistantMsg && !currentTurnIsHidden && (chat.type === "agent" || chat.type === "bluesky")) {
          deferredExtractions.push({ userMsg: lastUserMessage, assistantMsg: assistantMsg.content });
        }

        // Reset accumulators for the new response
        resetAccumulators();
        currentTurnIsHidden = queued.hidden === true;
        lastUserMessage = queued.message;

        console.log(`[chat] steering: injecting queued message ${queued.id} mid-loop`);

        return [{ role: "user" as const, content: queued.message, timestamp: queued.timestamp }];
      },
      getFollowUpMessages: async () => {
        const queued = await messageQueue.drainOne(chat.id);
        if (!queued) return [];

        // Save any uncommitted assistant row and the queued user message.
        const assistantMsg = finalizeUncommittedAssistantMessage();
        chat.messages.push(queuedMessageToChatMessage(queued));
        await saveChat(chat);

        // Emit events so client can finalize current response and start next
        if (assistantMsg) {
          res.write(`event: message_complete\ndata: ${JSON.stringify({ message: assistantMsg })}\n\n`);
        }
        res.write(`event: follow_up_start\ndata: ${JSON.stringify({ queuedMessageId: queued.id })}\n\n`);

        // Defer memory extraction until after the agent loop finishes
        // to avoid concurrent LLM calls that can interfere with the active tool loop
        if (assistantMsg && !currentTurnIsHidden && chat.type === "agent") {
          deferredExtractions.push({ userMsg: lastUserMessage, assistantMsg: assistantMsg.content });
        }

        // Title generation for first exchange
        if (assistantMsg && !currentTurnIsHidden && shouldGenerateInitialTitle(chat)) {
          generateTitle(lastUserMessage, assistantMsg.content)
            .then(title => {
              if (title) {
                chat.title = title;
                saveChat(chat).catch(() => {});
                res.write(`event: title_update\ndata: ${JSON.stringify({ chatId: chat.id, title })}\n\n`);
              }
            })
            .catch(err => console.warn("[title] generation failed:", err));
        }

        // Reset accumulators for the new response
        resetAccumulators();
        currentTurnIsHidden = queued.hidden === true;
        lastUserMessage = queued.message;

        console.log(`[chat] follow-up: draining queued message ${queued.id}`);

        return [{ role: "user" as const, content: queued.message, timestamp: queued.timestamp }];
      },
    });

    // Start the agent loop (uses turnAbortController declared earlier)
    console.log(`[chat] Starting agent loop: userPiMessage=${!!userPiMessage}, context.messages.length=${context.messages.length}, tools=${context.tools?.length || 0}`);
    console.log(`[chat] Context messages: ${context.messages.map(m => {
      const c: any = m.content;
      if (typeof c === "string") return `${m.role}:${c.length}ch`;
      if (Array.isArray(c)) {
        let chars = 0;
        let imgs = 0;
        for (const b of c) {
          if (b?.type === "text" && typeof b.text === "string") chars += b.text.length;
          else if (b?.type === "thinking" && typeof b.thinking === "string") chars += b.thinking.length;
          else if (b?.type === "image") imgs++;
          else if (b?.type === "toolCall") chars += JSON.stringify(b.arguments ?? {}).length;
        }
        return `${m.role}:${chars}ch${imgs ? `+${imgs}img` : ""}`;
      }
      return `${m.role}:?`;
    }).join(", ")}`);
    console.log("[chat] Agent loop started, waiting for events...");

    // Extract token stream for TTS (if enabled). The shared loop callback
    // accumulates text deltas into ttsTextChunks; TTS is still emitted after
    // the main model stream, matching the route's previous lifecycle.
    async function* extractTokenStream() {
      for (const token of ttsTextChunks) {
        yield token;
      }
    }

    // Create TTS audio stream if enabled
    const audioStream = ttsEnabled ? streamTTS(extractTokenStream(), {
      ...ttsSettings,
      chunkSize: ttsSettings.streamingChunkSize ?? 50,
      boundaryTier: ttsSettings.streamingBoundaryTier ?? 'clause',
    }) : null;

    // Process LLM events -> SSE (main loop)
    await runAgentLoop({
      mode: userPiMessage ? "start" : "continue",
      prompts: userPiMessage ? [userPiMessage] : undefined,
      context,
      config,
      signal: turnAbortController.signal,
      streamFn: safeStreamFn,
      logPrefix: "chat",
      onEvent: async (event) => {
      switch (event.type) {
        case "message_start": {
          // Mirror user prompts and steering messages into the outer context —
          // these don't get a turn_end push, so this is the only chance to
          // capture them. Skip assistant and toolResult roles: turn_end pushes
          // the final, complete versions, and pushing here would create a
          // duplicate per turn, gradually inflating the outer context that
          // recovery paths read from.
          if (event.message?.role === "user") {
            context.messages.push(event.message);
          }
          break;
        }

        case "message_update": {
          const ame = event.assistantMessageEvent;
          if (ame.type === "text_delta") {
            appendTextDelta(ame.delta);
          } else if (ame.type === "thinking_delta") {
            appendThinkingDelta(ame.delta);
          }
          break;
        }

        case "tool_execution_start": {
          flushThinkingTimer();
          flushTextSegment();
          const toolCall: ChatToolCall = {
            id: event.toolCallId,
            name: event.toolName,
            arguments: event.args,
          };
          state.allToolCalls.push(toolCall);
          if (event.toolName !== "ask_user") {
            console.log(`[tool] Executing ${event.toolName}:`, event.args);
            const segment: OutputSegment = { seq: ++state.seqCounter, type: "tool_call", toolCall };
            state.segments.push(segment);
            res.write(`event: segment\ndata: ${JSON.stringify(segment)}\n\n`);
            res.write(`event: tool_status\ndata: ${JSON.stringify({ name: event.toolName, status: "running" })}\n\n`);

            // Pause TTS on tool execution
            if (ttsEnabled) {
              ttsPauseController?.abort();
              ttsPauseController = new AbortController();
            }

            // CRITICAL: Pre-execution checkpoint for tools that can restart the server
            // If the agent modifies its own source code, tsx watch will restart the server
            // We must flush accumulators to disk BEFORE execution to survive the restart
            const isSelfModifyingTool =
              event.toolName === "write_file" ||
              event.toolName === "edit_file" ||
              (event.toolName === "bash" && typeof event.args?.command === "string" && (
                event.args.command.includes("npm run") ||
                event.args.command.includes("tsx") ||
                event.args.command.includes("node") ||
                event.args.command.includes("/server/")
              ));

            if (isSelfModifyingTool) {
              console.log(`[tool] Pre-execution checkpoint for self-modifying tool: ${event.toolName}`);
              try {
                const partialMsg = buildUncommittedAssistantMessage();
                upsertAssistantMessage(partialMsg, true);
                await saveChat(chat);
                await savePendingState(chat.id, {
                  agentMessages: context.messages as any[],
                  systemPrompt,
                  askToolCallId: askUserRef.current?.toolCallId || "",
                  fullText: state.fullText,
                  thinkingText: state.thinkingText,
                  toolCalls: state.allToolCalls,
                  toolResults: state.allToolResults,
                  iterations,
                  lastUserMessage,
                });
                console.log(`[tool] Checkpoint saved: ${partialMsg.toolCalls?.length || 0} tools, ${partialMsg.content.length}ch`);
              } catch (saveErr) {
                console.error(`[tool] Failed to save pre-execution checkpoint:`, saveErr);
                // Continue anyway - better to execute the tool than to block
              }
            }
          }
          break;
        }

        case "tool_execution_end": {
          console.log(`[chat] tool_execution_end: ${event.toolName} (toolCallId: ${event.toolCallId}, isError: ${event.isError})`);

          // ask_user gets a dedicated SSE event, not tool_status
          if (event.toolName !== "ask_user") {
            const resultText = event.result?.content?.[0]?.text || "";

            const images: ImageAttachment[] | undefined = event.result?.content
                ?.filter((c: any) => c.type === "image")
                .map((c: any) => ({ data: c.data, mimeType: c.mimeType, name: `generated-${event.toolCallId}.jxl` }));

            if (images?.length) {
              console.log(`[chat] Extracted ${images.length} image(s) from tool result ${event.toolCallId} (${event.toolName})`);
              console.log(`[chat] Image sizes: ${images.map(img => `${(img.data.length / 1024).toFixed(1)}KB`).join(", ")}`);
            }

            const toolResult: ChatToolResult = {
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              content: resultText,
              isError: event.isError,
              images: images?.length ? images : undefined,
            };
            state.allToolResults.push(toolResult);
            console.log(`[chat] Tool result accumulated: ${state.allToolResults.length} total`);

            // Insert tool_result immediately after its tool_call segment (not at the end),
            // so that visual/artifact segments emitted during tool execution stay after the pair.
            const callIdx = state.segments.findIndex(
              s => s.type === "tool_call" && s.toolCall?.id === event.toolCallId
            );
            const resultSegment: OutputSegment = { seq: ++state.seqCounter, type: "tool_result", toolResult };
            if (callIdx >= 0) {
              state.segments.splice(callIdx + 1, 0, resultSegment);
            } else {
              state.segments.push(resultSegment);
            }
            res.write(`event: segment\ndata: ${JSON.stringify(resultSegment)}\n\n`);
            res.write(`event: tool_status\ndata: ${JSON.stringify({
              name: event.toolName,
              status: event.isError ? "error" : "done",
              result: resultText,
            })}\n\n`);
            console.log(`[chat] Tool result segment emitted, waiting for next agent turn...`);
          }
          break;
        }

        case "turn_end": {
          const msg = event.message as AssistantMessage;
          const stopReason = msg.stopReason || "stop";
          flushThinkingTimer();

          // Mirror the completed turn into outer context.messages so recovery
          // paths (stranded recovery, incomplete-tool-turn continuation) have a
          // live history to pass back into agentLoopContinue. Order matches
          // pi-agent-core's internal runLoop: assistant message, then each
          // tool result message.
          context.messages.push(msg);
          if (event.toolResults?.length) {
            for (const tr of event.toolResults) {
              context.messages.push(tr);
            }
          }

          console.log(`[chat] turn_end: stopReason=${stopReason}, toolResults=${event.toolResults?.length || 0}, content=${state.fullText.length}ch`);
          if (stopReason === "error") {
            const errMsg = msg.errorMessage || "(no error message)";
            console.error(`[chat] LLM error: ${errMsg}`);
            // Surface a user-visible warning so transient provider errors don't leave the UI silently truncated.
            // Parse common HTTP status codes for a friendlier message.
            const statusMatch = errMsg.match(/\b(5\d{2}|429|408)\b/);
            const status = statusMatch?.[1];
            let friendly: string;
            if (status === "503") friendly = "Model provider is temporarily unavailable — response cut short";
            else if (status === "502" || status === "504") friendly = "Model provider gateway error — response cut short";
            else if (status === "429") friendly = "Model provider rate limited — response cut short";
            else if (status === "408") friendly = "Model provider request timed out — response cut short";
            else if (status) friendly = `Model provider error (${status}) — response cut short`;
            else friendly = "Response cut short — model provider returned an error";
            res.write(`event: warning\ndata: ${JSON.stringify({
              type: "provider_error",
              message: friendly,
            })}\n\n`);
          }
          console.log(`[chat] turn_end event details:`, {
            stopReason,
            toolResults: event.toolResults?.length || 0,
            hasToolCalls: !!event.toolResults?.length,
          });

          // Handle aborted turns gracefully - they're expected from ask_user
          if (stopReason === "aborted") {
            console.log(`[chat] turn aborted (expected from ask_user or disconnect)`);
            break;
          }

          iterations++;

          // Track incomplete tool turns: if stopReason is "toolUse" but no text content followed
          const hasToolCalls = event.toolResults && event.toolResults.length > 0;
          const hasTextContent = state.fullText.trim().length > 0;
          if (stopReason === "toolUse" && hasToolCalls && !hasTextContent) {
            state.incompleteToolTurn = true;
            console.log(`[chat] turn ended with toolUse but no final text - marking incomplete`);
            console.log(`[chat] Agent loop should continue to next iteration with tool results...`);
            console.log(`[chat] Accumulated state before continuation: ${state.allToolCalls.length} calls, ${state.allToolResults.length} results`);
            console.log(`[chat] Tool results:`, state.allToolResults.map(tr => ({
              toolName: tr.toolName,
              hasImages: !!tr.images?.length,
              contentLength: tr.content.length,
            })));
          } else {
            state.incompleteToolTurn = false;
          }

          // Detect stranded tool calls: stopReason is "stop" but thinking block contains
          // tool-call-like syntax that never materialized as a structured call.
          // This happens when the model drafts tool calls in its thinking stream (e.g.
          // `<tool_call><function=read_file>...</function></tool_call>`) but stops before emitting the actual
          // structured tool call. We need to continue the turn to let the model recover.
          if (stopReason === "stop" && state.thinkingText.trim().length > 0 && hasStrandedToolCall(state.thinkingText)) {
            state.strandedToolCall = true;
            console.log(`[chat] STRANDED TOOL CALL DETECTED: stopReason="stop" but thinking contains <function=...> syntax (${state.thinkingText.length}ch thinking)`);
            // Do NOT promote thinking to content — it's incomplete reasoning that led to
            // a tool call. The continuation will let the model finish properly.
            // If thinking was already promoted above (thinking-only path), undo it.
            if (state.thinkingPromoted) {
              state.thinkingText = state.fullText;
              state.fullText = "";
              state.thinkingPromoted = false;
            }
          } else if (stopReason === "stop" && !hasTextContent && state.thinkingText.trim().length > 0) {
            // No stranded tool call — safe to promote thinking to content
            state.fullText = state.thinkingText;
            state.thinkingText = "";
            state.thinkingPromoted = true;
            console.log(`[chat] promoted thinking to content (${state.fullText.length}ch) - model output thinking only`);
          }

          console.log(
            `[chat] iter=${iterations} stop=${stopReason} tools=${event.toolResults?.length || 0}` +
            ` content=${state.fullText.length}ch thinking=${state.thinkingText.length}ch` +
            ` tokens=${msg.usage?.totalTokens || "?"} incomplete=${state.incompleteToolTurn} stranded=${state.strandedToolCall}`,
          );

          // Debug: log tool results if present
          if (event.toolResults?.length) {
            console.log(`[chat] Tool results in turn_end:`, event.toolResults.map(tr => ({
              toolCallId: tr.toolCallId,
              toolName: tr.toolName,
              hasImage: tr.content?.some((c: any) => c.type === "image"),
            })));
          }

          // If stopReason is toolUse, the agent loop should automatically continue
          if (stopReason === "toolUse") {
            console.log(`[chat] stopReason is toolUse - agent loop will continue to next iteration automatically`);
            console.log(`[chat] Accumulated state: ${state.allToolCalls.length} tool calls, ${state.allToolResults.length} tool results`);
          }

          // Preserve prior usage on error: the provider initializes msg.usage
          // to all-zeros and never updates it when the stream errors before
          // reporting tokens. Overwriting state.finalUsage with that would
          // wipe the token indicator even though the context is unchanged.
          if (msg.usage && (msg.usage.totalTokens > 0 || stopReason !== "error")) {
            state.finalUsage = {
              input: msg.usage.input,
              output: msg.usage.output,
              totalTokens: msg.usage.totalTokens,
            };
          }
          // Capture llama.cpp timings for model-stats recording
          if ((msg as any).llamaTimings) {
            state.lastLlamaTimings = (msg as any).llamaTimings;
          }
          if ((msg as any).llamaCache) {
            state.lastLlamaCache = (msg as any).llamaCache;
          }

          // Snapshot this iteration's new tool calls before the commit below
          // advances committedToolCallCount — the dedup check further down
          // needs the per-iteration slice.
          const newToolCallsThisIter = state.allToolCalls.slice(state.committedToolCallCount);

          // Materialize the just-finished assistant turn using the same shape
          // that the live LLM context saw. Tool-use stops are committed
          // immediately so the next iteration and future replays both see:
          // assistant(tool call) -> tool result -> assistant(tool call) -> ...
          // rather than one collapsed assistant row with every tool call.
          let persistedTurnMsg: ChatMessage | null = null;
          if (stopReason === "toolUse") {
            persistedTurnMsg = buildAssistantMessageFromTurn(msg);
            upsertAssistantMessage(persistedTurnMsg);
            markUncommittedAssistantMessageCommitted(persistedTurnMsg);
          } else {
            state.pendingFinalAssistantMessage = buildAssistantMessageFromTurn(msg);
          }

          // Compute a current-context estimate that accounts for accumulated
          // tool results. Raw usage.totalTokens reflects iter=N's (input+output)
          // and does NOT include the tool result generated between iter=N and
          // iter=N+1 — that tool result is part of iter=N+1's input, and a
          // single large one (e.g. read_file on a 50 KB source file) can push
          // past the hard context cap before the next iteration even starts.
          const { estimateContextTokens } = await import("../services/compaction.js");
          const effectiveCWForCheck = getEffectiveContextWindow(chat, ollamaModel, settings);
          const estimatedTokens = estimateContextTokens(chat.messages, systemPrompt, agentTools);

          // Send iteration event with usage AND estimate so client can update
          // token indicators mid-loop with a number that reflects next-call size.
          res.write(`event: iteration\ndata: ${JSON.stringify({
            iteration: iterations,
            stopReason,
            toolCount: event.toolResults?.length || 0,
            usage: state.finalUsage || undefined,
            estimatedTokens,
          })}\n\n`);

          if (stopReason === "length") {
            hitContextLimit = true;
            console.warn(`[chat] stopped due to context length at iteration ${iterations}`);
            res.write(`event: warning\ndata: ${JSON.stringify({
              type: "context_length",
              message: "Response stopped — context window full",
            })}\n\n`);
          }

          // Detect implicit context overflow: model errored without usage data.
          // Ollama often returns a stream error (not "length") when the context is exhausted.
          // If we have prior usage near the limit or high iteration count with no usage, treat as context limit.
          if (!hitContextLimit && !msg.usage && (stopReason as string) !== "stop" && (stopReason as string) !== "toolUse" && (stopReason as string) !== "length") {
            // Check if the last known usage was already high
            const lastKnown = state.finalUsage?.totalTokens ?? 0;
            if (effectiveCWForCheck > 0 && (lastKnown / effectiveCWForCheck > 0.8 || iterations > 3)) {
              hitContextLimit = true;
              console.warn(`[chat] model error with no usage data at iteration ${iterations} (last known: ${lastKnown}/${effectiveCWForCheck}) — treating as context overflow`);
              res.write(`event: warning\ndata: ${JSON.stringify({
                type: "context_length",
                message: "Response may have been cut short — context window likely full",
              })}\n\n`);
            }
          }

          // Mid-turn context protection. Uses the estimator (not raw usage) so
          // tool results added since the last usage anchor are counted. Trigger
          // at 80% to match truncateBeforeSend and leave room for compaction
          // instead of tipping over the hard cap on the next iteration.
          if (stopReason === "toolUse" && !hitContextLimit) {
            if (effectiveCWForCheck > 0 && estimatedTokens > 0) {
              const usageRatio = estimatedTokens / effectiveCWForCheck;
              if (usageRatio > 0.80) {
                const rawUsage = state.finalUsage?.totalTokens ?? 0;
                console.warn(`[chat] Mid-turn context overflow: est ${estimatedTokens}/${effectiveCWForCheck} (${(usageRatio * 100).toFixed(0)}%) at iteration ${iterations} [rawUsage=${rawUsage}] — breaking for compaction`);
                turnAbortController.abort();
                state.needsMidTurnCompaction = true;
              }
            }
          }

          // Dedup guard: detect when the model is stuck re-emitting the same
          // tool call. Compare this iteration's new tool calls against the
          // prior iteration's signature. After DUPLICATE_TOOL_CALL_LIMIT
          // consecutive identical iterations, abort the loop so the user
          // isn't stuck watching the same call run.
          const DUPLICATE_TOOL_CALL_LIMIT = 3;
          if (newToolCallsThisIter.length > 0) {
            const sig = JSON.stringify(newToolCallsThisIter.map(c => ({ name: c.name, args: c.arguments })));
            if (sig === state.lastIterationToolCallSignature) {
              state.duplicateToolCallStreak++;
            } else {
              state.duplicateToolCallStreak = 1;
            }
            state.lastIterationToolCallSignature = sig;

            if (state.duplicateToolCallStreak >= DUPLICATE_TOOL_CALL_LIMIT) {
              const dupNames = newToolCallsThisIter.map(c => c.name).join(", ");
              console.warn(`[chat] duplicate tool call streak hit ${state.duplicateToolCallStreak} (${dupNames}) at iteration ${iterations}, aborting`);
              res.write(`event: warning\ndata: ${JSON.stringify({
                type: "duplicate_tool_call",
                message: `Stopped — model called the same tool ${state.duplicateToolCallStreak} times in a row (${dupNames})`,
              })}\n\n`);
              turnAbortController.abort();
            }
          } else {
            state.duplicateToolCallStreak = 0;
            state.lastIterationToolCallSignature = null;
          }

          // Guard against runaway tool loops
          if (iterations >= MAX_ITERATIONS) {
            console.warn(`[chat] hit iteration limit (${MAX_ITERATIONS}), aborting`);
            res.write(`event: warning\ndata: ${JSON.stringify({
              type: "iteration_limit",
              message: `Stopped — reached ${MAX_ITERATIONS} iteration limit`,
            })}\n\n`);
            turnAbortController.abort();
          }

          // Incremental persistence: save progress after each iteration.
          // The chat.messages mutation already happened above; here we just
          // persist to disk and record pending state for crash recovery.
          try {
            await saveChat(chat);

            // ALSO save in-flight accumulators to pending_states for crash recovery
            // This allows resume from mid-turn, not just ask_user
            await savePendingState(chat.id, {
              agentMessages: context.messages as any[],
              systemPrompt,
              askToolCallId: askUserRef.current?.toolCallId || "",
              fullText: state.fullText,
              thinkingText: state.thinkingText,
              toolCalls: state.allToolCalls,
              toolResults: state.allToolResults,
              iterations,
              lastUserMessage,
            });

            if (persistedTurnMsg) {
              res.write(`event: message_complete\ndata: ${JSON.stringify({ message: persistedTurnMsg, continues: true })}\n\n`);
            }
            console.log(`[chat] iteration ${iterations}: saved progress (${persistedTurnMsg?.toolCalls?.length || 0} tools, ${persistedTurnMsg?.content.length || 0}ch, est ${estimatedTokens} tokens)`);
          } catch (saveErr) {
            console.error(`[chat] failed to save iteration ${iterations}:`, saveErr);
          }

          break;
        }
      }
      },
    });

    // Parallel: Stream audio chunks if TTS enabled
    if (audioStream) {
      console.log("[TTS] Starting audio stream");
      (async () => {
        try {
          for await (const wavChunk of audioStream) {
            // Check if connection is still open
            if (res.writableEnded) break;

            res.write(`event: audio_chunk\ndata: ${JSON.stringify({
              chunkId: crypto.randomUUID(),
              data: wavChunk.toString('base64'),
              mimeType: 'audio/wav',
              sampleRate: 24000,
            })}\n\n`);
          }
          console.log("[TTS] Audio stream completed");
        } catch (err) {
          console.error("[TTS] Streaming error:", err);
        }
      })();
    }

    // --- Post-loop: compaction check, then handle incomplete tool turns, ask_user, build message ---

    // Signal that the agent's output is complete before any post-loop work
    // (compaction, incomplete tool turns, etc.) so the client can stop the
    // streaming indicator immediately rather than waiting for the `done` event
    // which only fires after compaction finishes.
    // Only emit when the agent is truly done — no pending continuation or mid-turn work.
    if (!state.needsMidTurnCompaction && !askUserRef.current && !waitingForInput && !state.incompleteToolTurn && !state.strandedToolCall) {
      res.write(`event: agent_output_complete\ndata: {}\n\n`);
    }

    // Make the final assistant row visible to end-of-turn compaction without
    // committing it yet. The shared final handler below replaces this
    // in-progress row, attaches recap metadata, and emits the done payload.
    if (state.pendingFinalAssistantMessage && hasAssistantMessageContent(state.pendingFinalAssistantMessage)) {
      upsertAssistantMessage(state.pendingFinalAssistantMessage, true);
      await saveChat(chat);
    }

    // End-of-turn compaction: if we crossed the 80% threshold during this turn,
    // compact NOW before building the final message. This prevents the user from
    // waiting on compaction after their response appears complete.
    // Mid-turn compaction (95% during tool loops) is handled separately above.
    // Skip if we have a stranded tool call — we need to continue the turn first,
    // not compact away the context the model was working with.
    if (!state.needsMidTurnCompaction && !askUserRef.current && !waitingForInput && !state.strandedToolCall) {
      try {
        const model = allModels.find((m: OllamaModel) => m.id === chat.modelId);
        if (model) {
          const effectiveContextWindow = getEffectiveContextWindow(chat, model, settings);
          const lastUsage = state.finalUsage?.totalTokens ?? 0;
          const usageRatio = lastUsage > 0 ? lastUsage / effectiveContextWindow : 0;

          // Check if we crossed the 80% threshold
          let needsCompaction = hitContextLimit || usageRatio > 0.80;

          // Fallback to character estimation if usage is missing
          if (!needsCompaction && lastUsage === 0 && chat.messages.length > 4) {
            const { estimateContextTokens } = await import("../services/compaction.js");
            const estimatedTokens = estimateContextTokens(chat.messages, systemPrompt, agentTools);
            const estimatedRatio = estimatedTokens / effectiveContextWindow;
            if (estimatedRatio > 0.80) {
              console.log(`[compaction] End-of-turn: usage missing but estimation shows ${estimatedTokens} tokens (${(estimatedRatio * 100).toFixed(0)}%) — forcing compaction`);
              needsCompaction = true;
            }
          }

          if (needsCompaction) {
            console.log(`[compaction] End-of-turn compaction triggered: ${lastUsage}/${effectiveContextWindow} (${(usageRatio * 100).toFixed(0)}%)`);
            const emitCompacting = () => res.write(`event: compacting\ndata: {}\n\n`);
            const emitKeepalive = () => res.write(`: keepalive\n\n`);
            // Wrap in keepalive loop so the client's 95s inactivity timeout
            // doesn't fire during slow extraction/embed/rerank steps.
            await withSSEKeepalive(res, async () => {
              const compaction = await truncateChatHistory(chat, effectiveContextWindow, hitContextLimit || (lastUsage === 0 && needsCompaction), emitCompacting, emitKeepalive, lastUsage, systemPrompt, agentTools);
              if (compaction.truncated) {
                // Extract memories from removed messages (agent chats only)
                if ((chat.type === "agent" || chat.type === "bluesky") && compaction.removedMessages?.length) {
                  await preCompactionFlush(chat.modelId, chat.id, compaction.removedMessages, chat.projectId);
                }
                await saveChat(chat, { allowTruncation: true });

                // Full reset of memory context after compaction — rebuild with
                // fresh retrieval, all memories frozen into the new system prompt.
                if (chat.type === "agent" || chat.type === "bluesky") {
                  resetMemoryContext(chat.id);
                  const split = await buildSplitAugmentedPrompt(
                    chat.systemPrompt || "You are a helpful assistant.",
                    chat.messages, chat.id, chat.projectId, chat.type, projectPath
                  );
                  systemPrompt = split.systemPrompt;

                  // Reinjected skills after compaction — they were lost when
                  // buildSplitAugmentedPrompt rebuilt from the base systemPrompt.
                  if (chat.activeSkills?.length) {
                    const skillsCache = new Map<string, Skill>();
                    const allSkills = await discoverSkills(chat.projectId);
                    for (const s of allSkills) skillsCache.set(s.name, s);
                    systemPrompt = buildSkillAugmentedPrompt(systemPrompt, chat.activeSkills, skillsCache);
                    console.log(`[skills] Reinjected ${chat.activeSkills.length} skills after end-of-turn compaction`);
                  }
                }

                // Find the summary message that was inserted. Emit AFTER the
                // systemPrompt rebuild so the estimate reflects the prompt the
                // next turn will actually use. The client uses `estimatedTokens`
                // to refresh the token indicator to the compacted state — we
                // keep `state.finalUsage` intact so the final assistant message
                // (saved below at buildCurrentAssistantMessage) retains its
                // real pre-compaction usage value, which next turn's PathA uses
                // as the anchor for estimateContextSize.
                const summaryMsg = chat.messages.find(m => m._isCompactionSummary);
                const estimatedTokens = await estimatePostCompactionTokens(chat, systemPrompt, agentTools);
                res.write(`event: compaction\ndata: ${JSON.stringify({
                  removedCount: compaction.removedCount,
                  remainingCount: chat.messages.filter(m => !m._outOfContext).length,
                  summaryMessage: summaryMsg || null,
                  phase: "end_turn",
                  continues: false,
                  estimatedTokens,
                })}\n\n`);
              }
            });
          }
        }
      } catch (err) {
        console.error("[compaction] End-of-turn compaction failed:", err);
      }
    }

    // If the last turn ended with toolUse but no final text, continue the loop
    // This handles cases where the LLM signaled tool use but didn't produce the final text response
    if (state.incompleteToolTurn && !askUserRef.current && iterations < MAX_ITERATIONS) {
      console.log(`[chat] incomplete tool turn detected - continuing loop for final text`);

      // Continue the agent loop from current context (no new user message, just resume)
      const continueAbortController = new AbortController();

      // Track if continuation produces any content
      let continuationProducedContent = false;

      try {
        // Decouple from the outer context — see comment in stranded recovery below.
        const continueContext: AgentContext = {
          ...context,
          messages: [...context.messages],
        };

        // Process the continuation events
        await runAgentLoop({
          mode: "continue",
          context: continueContext,
          config,
          signal: continueAbortController.signal,
          streamFn: safeStreamFn,
          logPrefix: "chat:continuation",
          onEvent: async (event) => {
          if (event.type === "message_update") {
            const ame = event.assistantMessageEvent;
            if (ame.type === "text_delta") {
              continuationProducedContent = appendTextDelta(ame.delta) || continuationProducedContent;
            } else if (ame.type === "thinking_delta") {
              continuationProducedContent = appendThinkingDelta(ame.delta) || continuationProducedContent;
            }
          } else if (event.type === "turn_end") {
            const msg = event.message as AssistantMessage;
            const stopReason = msg.stopReason || "stop";
            console.log(`[chat] continuation turn_end: stop=${stopReason} content=${state.fullText.length}ch`);

            // Also handle thinking-only in continuation
            if (stopReason === "stop" && !state.fullText.trim() && state.thinkingText.trim().length > 0) {
              state.fullText = state.thinkingText;
              state.thinkingText = "";
              state.thinkingPromoted = true;
              continuationProducedContent = true;
              console.log(`[chat] continuation: promoted thinking to content (${state.fullText.length}ch)`);
            }

            // Incremental persistence in continuation loop
            try {
              const partialMsg = buildCurrentAssistantMessage();
              await saveChat(chat);
              console.log(`[chat] continuation: saved progress (${partialMsg.content.length}ch)`);
            } catch (saveErr) {
              console.error(`[chat] continuation save failed:`, saveErr);
            }

            if (stopReason !== "toolUse") {
              continueAbortController.abort(); // Got final text, exit continuation loop
              stopAgentLoop();
            }
          }
          },
        });
      } catch (contErr: any) {
        console.error(`[chat] continuation loop crashed: ${contErr.message}`);
        // Don't let a crash in the continuation loop take down the server.
        // The partial state from the main loop is still valid — we'll persist
        // whatever was accumulated before the crash.
      }

      continueAbortController.abort(); // Clean up

      // If continuation produced nothing, log a warning and don't persist empty message
      if (!continuationProducedContent && !state.fullText.trim() && !state.thinkingText.trim()) {
        console.error(`[chat] continuation produced NO CONTENT - model may have failed silently. Not persisting empty message.`);
        // Don't continue to message persistence - we'll handle this below
        state.finalUsage = { input: 0, output: 0, totalTokens: 0 }; // Mark as failed
      }
    }

    // Stranded tool call recovery: if the model stopped with stopReason="stop" but
    // its thinking block contained drafted tool-call syntax that never materialized
    // as a structured call, continue the turn to let the model emit the real calls.
    if (state.strandedToolCall && !askUserRef.current && iterations < MAX_ITERATIONS) {
      console.log(`[chat] stranded tool call recovery: continuing turn to let model emit structured tool calls`);
      console.log(`[chat] stranded thinking preview: ${state.thinkingText.slice(0, 200).replace(/\n/g, ' ')}...`);

      const strandedAbortController = new AbortController();
      let strandedProducedSomething = false;

      // agentLoopContinue rejects contexts ending with an assistant message.
      // The stranded assistant (stopReason=stop with no structured call) is
      // exactly what we want to drop — continuation should pick up from the
      // last user or toolResult so the model gets another shot at emitting
      // the real tool call.
      while (context.messages.length > 0 && context.messages[context.messages.length - 1].role === "assistant") {
        context.messages.pop();
      }

      try {
        // Decouple the recovery's internal messages array from the outer context.
        // pi-agent-core's agentLoopContinue does `{ ...context }` (shallow spread),
        // which shares the messages array. Without this copy, pi-ai's pushes and
        // chat.ts's event-handler pushes both mutate the same array — every
        // recovery iteration triples each message and breaks KV cache reuse.
        const strandedContext: AgentContext = {
          ...context,
          messages: [...context.messages],
        };

        await runAgentLoop({
          mode: "continue",
          context: strandedContext,
          config,
          signal: strandedAbortController.signal,
          streamFn: safeStreamFn,
          logPrefix: "chat:stranded-recovery",
          onEvent: async (event) => {
          if (event.type === "message_update") {
            const ame = event.assistantMessageEvent;
            if (ame.type === "text_delta") {
              strandedProducedSomething = appendTextDelta(ame.delta) || strandedProducedSomething;
            } else if (ame.type === "thinking_delta") {
              strandedProducedSomething = appendThinkingDelta(ame.delta) || strandedProducedSomething;
            }
          } else if (event.type === "tool_execution_start") {
            strandedProducedSomething = true;
            // Tool call was recovered — reset the flag and let the normal tool loop continue
            state.strandedToolCall = false;
            console.log(`[chat] stranded recovery SUCCESS: model emitted structured tool call: ${event.toolName}`);

            const toolCall: ChatToolCall = {
              id: event.toolCallId,
              name: event.toolName,
              arguments: event.args,
            };
            state.allToolCalls.push(toolCall);

            if (event.toolName !== "ask_user") {
              console.log(`[tool] Executing ${event.toolName}:`, event.args);
              const segment: OutputSegment = { seq: ++state.seqCounter, type: "tool_call", toolCall };
              state.segments.push(segment);
              res.write(`event: segment\ndata: ${JSON.stringify(segment)}\n\n`);
              res.write(`event: tool_status\ndata: ${JSON.stringify({ name: event.toolName, status: "running" })}\n\n`);
            }
          } else if (event.type === "tool_execution_end") {
            if (event.toolName !== "ask_user") {
              const resultText = event.result?.content?.[0]?.text || "";
              const toolResult: ChatToolResult = {
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                content: resultText,
                isError: event.isError,
              };
              state.allToolResults.push(toolResult);

              const callIdx = state.segments.findIndex(
                s => s.type === "tool_call" && s.toolCall?.id === event.toolCallId
              );
              const resultSegment: OutputSegment = { seq: ++state.seqCounter, type: "tool_result", toolResult };
              if (callIdx >= 0) {
                state.segments.splice(callIdx + 1, 0, resultSegment);
              } else {
                state.segments.push(resultSegment);
              }
              res.write(`event: segment\ndata: ${JSON.stringify(resultSegment)}\n\n`);
              res.write(`event: tool_status\ndata: ${JSON.stringify({
                name: event.toolName,
                status: event.isError ? "error" : "done",
                result: resultText,
              })}\n\n`);
            }
          } else if (event.type === "turn_end") {
            const msg = event.message as AssistantMessage;
            const stopReason = msg.stopReason || "stop";
            console.log(`[chat] stranded recovery turn_end: stop=${stopReason} text=${state.fullText.length}ch tools=${event.toolResults?.length || 0}`);

            // If the model stopped again without producing anything useful, bail
            if (!strandedProducedSomething && !state.fullText.trim() && state.thinkingText.trim().length === 0) {
              console.error(`[chat] stranded recovery produced NOTHING — giving up`);
              strandedAbortController.abort();
              stopAgentLoop();
            }

            // If model is now on a proper tool loop, let the main for-await pick it up
            if (stopReason === "toolUse") {
              console.log(`[chat] stranded recovery: model entered tool loop — continuing main iteration`);
              // Don't break — let the main event loop continue processing
            } else {
              strandedAbortController.abort();
              stopAgentLoop();
            }
          }
          },
        });
      } catch (err: any) {
        console.error(`[chat] stranded recovery loop crashed: ${err.message}`);
      }

      strandedAbortController.abort();

      if (state.strandedToolCall && !strandedProducedSomething) {
        // Recovery failed — model didn't produce structured calls. Fall back to treating
        // the thinking content as the final response.
        console.warn(`[chat] stranded recovery failed to produce structured calls — promoting thinking to content as fallback`);
        if (state.thinkingText.trim().length > 0) {
          state.fullText = state.thinkingText;
          state.thinkingText = "";
          state.thinkingPromoted = true;
        }
      }
      state.strandedToolCall = false;
    }

    // Mid-turn compaction loop: compact and resume as many times as needed.
    // Long-running tool chains can exceed the context window multiple times within
    // a single user turn. Each cycle archives the overflow, compacts, and resumes.
    const MAX_COMPACTION_CYCLES = 5;
    let compactionCycle = 0;

    while (state.needsMidTurnCompaction && !askUserRef.current && !waitingForInput && compactionCycle < MAX_COMPACTION_CYCLES) {
      compactionCycle++;
      state.needsMidTurnCompaction = false;
      console.log(`[chat] Mid-turn compaction cycle ${compactionCycle}: saving progress and compacting`);

      // 1. Save current progress and build progress summary for the resumed agent.
      // Memory fetch happens AFTER compaction+flush so it includes newly extracted memories.
      flushThinkingTimer();
      const partialAssistant = buildCurrentAssistantMessage();

      // Build progress summary (content + tools) — memory section added after flush below
      const progressParts: string[] = [];
      progressParts.push("[System: Context was compacted mid-turn. Here is a summary of your work so far — continue from where you left off.]");
      if (partialAssistant.content) {
        progressParts.push(`Your progress so far:\n${partialAssistant.content.slice(0, 5000)}`);
      }
      if (partialAssistant.toolCalls?.length) {
        const toolSummary = partialAssistant.toolCalls.map((tc) => {
          const result = partialAssistant.toolResults?.find((r) => r.toolCallId === tc.id);
          const resultPreview = result ? result.content.slice(0, 200) : "no result";
          return `- ${tc.name}(${JSON.stringify(tc.arguments).slice(0, 100)}) → ${resultPreview}`;
        }).join("\n");
        progressParts.push(`Tools you already called (${partialAssistant.toolCalls.length} total):\n${toolSummary}`);
      }

      finalizeUncommittedAssistantMessage();
      await saveChat(chat);

      // 2. Run compaction to free context space
      const effectiveCW = getEffectiveContextWindow(chat, ollamaModel, settings);
      const emitCompacting = () => res.write(`event: compacting\ndata: {}\n\n`);
      const emitKeepalive = () => res.write(`: keepalive\n\n`);
      // Wrap all compaction work in a keepalive ping loop so the client's
      // 95s inactivity timeout doesn't fire during slow LLM/embed steps.
      let compactionAborted = false;
      await withSSEKeepalive(res, async () => {
        try {
          const compaction = await truncateChatHistory(chat, effectiveCW, true, emitCompacting, emitKeepalive, undefined, systemPrompt, agentTools);
          if (compaction?.truncated) {
            await saveChat(chat, { allowTruncation: true });
            console.log(`[chat] Mid-turn compaction cycle ${compactionCycle}: removed ${compaction.removedCount} messages, estimated ${compaction.estimatedTokenCount} tokens remaining`);

            // Extract memories from removed messages and await completion so they're
            // available for the system prompt rebuild below. Without awaiting, the
            // rebuilt prompt would miss the freshly extracted memories from removed context.
            if (isAgent && compaction.removedMessages?.length) {
              try {
                await preCompactionFlush(chat.modelId, chat.id, compaction.removedMessages, chat.projectId);
              } catch (err) {
                console.error("[compaction] pre-flush failed:", err);
              }
            }

            // Emit compaction completion event AFTER all compaction work is done
            // (memory extraction, save) so the client can safely sync state.
            const summaryMsg = chat.messages.find(m => m._isCompactionSummary && !m._outOfContext);
            const estimatedTokens = await estimatePostCompactionTokens(chat, systemPrompt, agentTools);
            res.write(`event: compaction\ndata: ${JSON.stringify({
              removedCount: compaction.removedCount,
              remainingCount: chat.messages.filter(m => !m._outOfContext).length,
              summaryMessage: summaryMsg || null,
              phase: "mid_turn",
              continues: true,
              midTurn: true,
              cycle: compactionCycle,
              estimatedTokens,
            })}\n\n`);
          }
        } catch (compErr) {
          console.error(`[chat] Mid-turn compaction cycle ${compactionCycle} failed:`, compErr);
          compactionAborted = true;
          return;
        }

        // 3. Rebuild system prompt and context
        // Full reset of memory context — compaction reshapes the entire context,
        // so we need fresh retrieval with all memories (including newly extracted
        // ones from preCompactionFlush) frozen into the new system prompt.
        // Using buildSplitAugmentedPrompt (not legacy buildMemoryAugmentedPrompt) so that
        // the frozen context state is set up properly for subsequent turns.
        if (isAgent) {
          resetMemoryContext(chat.id);
          const split = await buildSplitAugmentedPrompt(
            chat.systemPrompt || "You are a helpful assistant.",
            chat.messages, chat.id, chat.projectId, chat.type, projectPath
          );
          systemPrompt = split.systemPrompt;
        }
      });
      if (compactionAborted) break;

      // Build handoff message with progress summary + freshly extracted memories.
      // This runs AFTER preCompactionFlush so memories from removed context are included.
      const handoffParts = [...progressParts];
      try {
        const { getMemoriesFromChat } = await import("../services/memory-storage.js");
        const chatMemories = getMemoriesFromChat(chat.id, 10);
        if (chatMemories.length > 0) {
          const memoryLines = chatMemories.map(
            (m) => `- ${m.text} [${m.category}]`
          ).join("\n");
          handoffParts.push(`Key context from this conversation (${chatMemories.length} memories):\n${memoryLines}`);
        }
      } catch { /* non-critical */ }
      handoffParts.push("Continue the task from where you left off. Do not repeat work already done.");
      const handoffText = handoffParts.join("\n\n");

      // Strip trailing assistant messages (in-progress + compaction summaries).
      // agentLoopContinue requires the last message to be user or toolResult.
      let resumeEndIndex = chat.messages.length;
      while (resumeEndIndex > 0 && chat.messages[resumeEndIndex - 1].role === "assistant") {
        resumeEndIndex--;
      }
      // Ensure we have at least one message
      if (resumeEndIndex === 0 && chat.messages.length > 0) {
        resumeEndIndex = 1; // Keep at least the first user message
      }
      const messagesForResume = chat.messages.slice(0, resumeEndIndex);
      const resumeMessages = chatMessagesToPiMessages(messagesForResume, chat.modelId);

      // Append the handoff message so the resumed agent has continuity
      resumeMessages.push({ role: "user", content: handoffText, timestamp: Date.now() });

      // Persist the handoff as a hidden message so future turns reconstruct
      // the same token sequence that llama.cpp caches during this continuation.
      // Without this, reconstruction places compaction summaries at a position
      // where the cache has the transient handoff, breaking KV cache prefix
      // matching and forcing a 66K+ token reprocess on the next turn.
      //
      // Also mark any compaction summaries as out-of-context — the handoff
      // plus rebuilt frozen memories already capture the pre-compaction state.
      for (const m of chat.messages) {
        if (m._isCompactionSummary && !m._outOfContext) {
          m._outOfContext = true;
        }
      }
      chat.messages.splice(resumeEndIndex, 0, {
        role: "user",
        content: handoffText,
        timestamp: Date.now(),
        _isSystemMessage: true,
      });
      await saveChat(chat);

      // 4. Resume the agent loop with compacted context
      const resumeContext: AgentContext = {
        systemPrompt,
        messages: resumeMessages,
        tools: agentTools,
      };
      const resumeAbortController = new AbortController();
      connectionAbortController.signal.addEventListener("abort", () => resumeAbortController.abort());

      console.log(`[chat] Mid-turn compaction cycle ${compactionCycle}: resuming agent loop with ${resumeMessages.length} messages`);

      // Emit a compaction marker segment so the client can display where compaction happened
      flushTextSegment();
      const compactionSegment: OutputSegment = {
        seq: ++state.seqCounter,
        type: "compaction_marker" as any,
        content: `Context compacted (cycle ${compactionCycle})`,
      };
      state.segments.push(compactionSegment);
      res.write(`event: segment\ndata: ${JSON.stringify(compactionSegment)}\n\n`);

      try {
        await runAgentLoop({
          mode: "continue",
          context: resumeContext,
          config,
          signal: resumeAbortController.signal,
          streamFn: safeStreamFn,
          logPrefix: "chat:mid-turn-resume",
          onEvent: async (event) => {
          if (event.type === "message_update") {
            const ame = event.assistantMessageEvent;
            if (ame.type === "text_delta") {
              appendTextDelta(ame.delta);
            } else if (ame.type === "thinking_delta") {
              appendThinkingDelta(ame.delta);
            }
          } else if (event.type === "tool_execution_start") {
            flushThinkingTimer();
            flushTextSegment();
            const toolCall: ChatToolCall = {
              id: event.toolCallId,
              name: event.toolName,
              arguments: event.args,
            };
            state.allToolCalls.push(toolCall);
            if (event.toolName !== "ask_user") {
              const segment: OutputSegment = { seq: ++state.seqCounter, type: "tool_call", toolCall };
              state.segments.push(segment);
              res.write(`event: segment\ndata: ${JSON.stringify(segment)}\n\n`);
              res.write(`event: tool_status\ndata: ${JSON.stringify({ name: event.toolName, status: "running" })}\n\n`);
            }
          } else if (event.type === "tool_execution_end") {
            if (event.toolName !== "ask_user") {
              const resultText = event.result?.content?.[0]?.text || "";
              const toolResult: ChatToolResult = {
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                content: resultText,
                isError: event.isError,
              };
              state.allToolResults.push(toolResult);
              const resultSegment: OutputSegment = { seq: ++state.seqCounter, type: "tool_result", toolResult };
              state.segments.push(resultSegment);
              res.write(`event: segment\ndata: ${JSON.stringify(resultSegment)}\n\n`);
              res.write(`event: tool_status\ndata: ${JSON.stringify({ name: event.toolName, status: event.isError ? "error" : "done", result: resultText })}\n\n`);
            }
          } else if (event.type === "turn_end") {
            const msg = event.message as AssistantMessage;
            const sr = msg.stopReason || "stop";
            flushThinkingTimer();
            if (msg.usage) {
              state.finalUsage = { input: msg.usage.input, output: msg.usage.output, totalTokens: msg.usage.totalTokens };
            }
            // Capture llama.cpp timings from resume loop too
            if ((msg as any).llamaTimings) {
              state.lastLlamaTimings = (msg as any).llamaTimings;
            }
            if ((msg as any).llamaCache) {
              state.lastLlamaCache = (msg as any).llamaCache;
            }
            iterations++;
            console.log(`[chat] resume turn_end (cycle ${compactionCycle}): stop=${sr} content=${state.fullText.length}ch tokens=${msg.usage?.totalTokens || "?"}`);

            let persistedResumeMsg: ChatMessage | null = null;
            if (sr === "toolUse") {
              persistedResumeMsg = buildAssistantMessageFromTurn(msg);
              upsertAssistantMessage(persistedResumeMsg);
              markUncommittedAssistantMessageCommitted(persistedResumeMsg);
              try {
                await saveChat(chat);
                res.write(`event: message_complete\ndata: ${JSON.stringify({ message: persistedResumeMsg, continues: true })}\n\n`);
              } catch (saveErr) {
                console.error(`[chat] resume save failed:`, saveErr);
              }
            } else {
              state.pendingFinalAssistantMessage = buildAssistantMessageFromTurn(msg);
            }

            // Emit iteration event so client updates token indicator in real-time
            res.write(`event: iteration\ndata: ${JSON.stringify({
              iteration: iterations,
              stopReason: sr,
              toolCount: event.toolResults?.length || 0,
              usage: state.finalUsage || undefined,
            })}\n\n`);

            if (sr !== "toolUse") {
              resumeAbortController.abort();
              stopAgentLoop();
            }

            // Check for overflow — if hit, set flag and break to trigger another compaction cycle
            const resumeEffectiveCW = getEffectiveContextWindow(chat, ollamaModel, settings);
            let resumeTokens = state.finalUsage?.totalTokens ?? 0;
            if (!resumeTokens) {
              const { estimateContextTokens } = await import("../services/compaction.js");
              resumeTokens = estimateContextTokens(chat.messages, systemPrompt, agentTools);
            }
            if (resumeEffectiveCW > 0 && resumeTokens > 0 && resumeTokens / resumeEffectiveCW > 0.85) {
              console.warn(`[chat] Resume loop overflow (cycle ${compactionCycle}): ${resumeTokens}/${resumeEffectiveCW} (${((resumeTokens / resumeEffectiveCW) * 100).toFixed(0)}%) — triggering another compaction cycle`);
              state.needsMidTurnCompaction = true;
              resumeAbortController.abort();
              stopAgentLoop();
            }
          }
          },
        });
      } catch (resumeErr: any) {
        console.error(`[chat] resume loop failed (cycle ${compactionCycle}): ${resumeErr.message}`);
        break;
      }

      // Do not stage an aggregate in-progress assistant here. Tool-use rows
      // are committed as each resume iteration finishes, and any final row is
      // held in pendingFinalAssistantMessage for the shared final handler.
    }

    if (compactionCycle >= MAX_COMPACTION_CYCLES) {
      console.warn(`[chat] Hit max compaction cycles (${MAX_COMPACTION_CYCLES}) — stopping to prevent infinite loop`);
    }

    // Check for queued follow-up messages even if loop exited early (e.g., due to abort)
    // This ensures messages aren't lost when agent-loop.js returns early on abort/error
    const queuedFollowUp = await messageQueue.drainOne(chat.id);
    if (queuedFollowUp && !askUserRef.current && !waitingForInput) {
      console.log(`[chat] post-loop: found queued follow-up message ${queuedFollowUp.id}, processing`);

      // Build current message first. Tool-use fragments may already be
      // committed; only persist an uncommitted final/partial row if present.
      const currentAssistantMsg = finalizeUncommittedAssistantMessage();

      chat.messages.push(queuedMessageToChatMessage(queuedFollowUp));
      await saveChat(chat);

      // Emit events to finalize current and start follow-up
      if (currentAssistantMsg) {
        res.write(`event: message_complete\ndata: ${JSON.stringify({ message: currentAssistantMsg })}\n\n`);
      }
      res.write(`event: follow_up_start\ndata: ${JSON.stringify({ queuedMessageId: queuedFollowUp.id })}\n\n`);

      // Defer memory extraction until after the follow-up loop finishes
      if (currentAssistantMsg && !currentTurnIsHidden && chat.type === "agent") {
        deferredExtractions.push({ userMsg: lastUserMessage, assistantMsg: currentAssistantMsg.content });
      }

      // Title generation for first exchange
      if (currentAssistantMsg && !currentTurnIsHidden && shouldGenerateInitialTitle(chat)) {
        generateTitle(lastUserMessage, currentAssistantMsg.content)
          .then(title => {
            if (title) {
              chat.title = title;
              saveChat(chat).catch(() => {});
              res.write(`event: title_update\ndata: ${JSON.stringify({ chatId: chat.id, title })}\n\n`);
            }
          })
          .catch(err => console.warn("[title] generation failed:", err));
      }

      // Continue processing the follow-up by recursively calling handleChatStream
      // Reset accumulators and update state
      resetAccumulators();
      currentTurnIsHidden = queuedFollowUp.hidden === true;
      lastUserMessage = queuedFollowUp.message;

      // Build new context for follow-up (all messages including the queued one)
      const followUpContextMessages = chatMessagesToPiMessages(chat.messages, chat.modelId);

      // Safety check: ensure context is not empty
      if (followUpContextMessages.length === 0 && chat.messages.length > 1) {
        console.error(`[chat] follow-up context is empty despite ${chat.messages.length} messages - this indicates a conversion bug`);
      }

      const followUpSystemPrompt = (chat.type === "agent" || chat.type === "bluesky")
        ? (await buildSplitAugmentedPrompt(chat.systemPrompt || "You are a helpful assistant.", chat.messages, chat.id, chat.projectId, chat.type, projectPath)).systemPrompt
        : chat.systemPrompt || "You are a helpful assistant.";

      // Recursively handle the follow-up with a fresh turn abort controller
      await handleChatStream(chat, queuedFollowUp.message, followUpContextMessages, followUpSystemPrompt, null, req, res, {
        hiddenUserMessage: queuedFollowUp.hidden === true,
      });
      return; // Exit early since we've recursively handled the follow-up
    }

    if (askUserRef.current) {
      waitingForInput = true;

      // Save pending state for resume. Trim context.messages to keep
      // everything through the assistant message with ask_user, but drop
      // the placeholder tool result and any aborted assistant message.
      const savedMessages = [...context.messages];
      let foundAskUser = false;
      while (savedMessages.length > 0) {
        const last = savedMessages[savedMessages.length - 1] as any;
        if (
          last.role === "assistant" &&
          last.content?.some?.((c: any) => c.type === "toolCall" && c.name === "ask_user")
        ) {
          foundAskUser = true;
          break; // Keep this assistant message
        }
        savedMessages.pop();
      }

      // Safety: if no ask_user message was found, keep the original context
      // to avoid losing all conversation history due to malformed message structure
      if (!foundAskUser && context.messages.length > 0) {
        console.warn(`[chat] ask_user message not found in context, preserving full context (${context.messages.length} messages)`);
        savedMessages.push(...context.messages);
      }

      await savePendingState(chat.id, {
        agentMessages: savedMessages,
        systemPrompt,
        askToolCallId: askUserRef.current.toolCallId,
      });

      res.write(`event: ask_user\ndata: ${JSON.stringify({ question: askUserRef.current.question })}\n\n`);
    }

    // Flush any remaining thinking timer before building the final message
    flushThinkingTimer();

    // Build the final assistant row. If the last LLM turn already produced a
    // concrete assistant message, use that exact row; otherwise fall back to
    // the uncommitted accumulators for abort/recovery paths.
    const assistantMsg = state.pendingFinalAssistantMessage ?? buildUncommittedAssistantMessage();
    const logicalAssistantContent = stripPlaceholderEllipsisBlocks(state.fullText) || assistantMsg.content;

    // Check if the message has any actual content
    const hasContent = hasAssistantMessageContent(assistantMsg);

    if (hasContent) {
      upsertAssistantMessage(assistantMsg);
      markUncommittedAssistantMessageCommitted(assistantMsg);
      await saveChat(chat);
      // Capture what we just sent + got back so the next turn's kv-cache log
      // can detect prefix divergence. Recap/title mutations after this point
      // don't affect pi messages, so this snapshot stays accurate.
      snapshotSentPrefix(chat.id, chat.messages, chat.modelId);
      console.log(`[chat] finished: iterations=${iterations} waitingForInput=${waitingForInput} content=${assistantMsg.content.length}ch`);

      // Generate a brief recap for long assistant messages (agent/project/system chats only)
      if ((chat.type === "agent" || chat.type === "system") && logicalAssistantContent.length > RECAP_THRESHOLD && !assistantMsg.recap) {
        try {
          const recap = await generateRecap(logicalAssistantContent);
          if (recap) {
            const msgIdx = chat.messages.length - 1;
            chat.messages[msgIdx] = { ...chat.messages[msgIdx], recap };
            await saveChat(chat);
            assistantMsg.recap = recap;
          }
        } catch (err) {
          console.warn("[recap] generation failed:", err);
        }
      }

      // Fire-and-forget push notification to the user's other devices. The
      // device that initiated this turn (if any deviceId was supplied) is
      // suppressed; presence-tracked devices are also skipped server-side.
      // System chats (synthesis, wake) are never user-facing — skip them.
      // Use the generated recap as the notification body when available,
      // falling back to truncated content.
      if (chat.id !== "system" && !currentTurnIsHidden && !waitingForInput && logicalAssistantContent.trim()) {
        const initiatingDeviceId = (req.body as any)?.deviceId;
        const pushBody = assistantMsg.recap || truncateForBody(logicalAssistantContent);
        sendPush(
          "owner",
          {
            type: "message_complete",
            title: chat.title || "qu.je",
            body: pushBody || "Reply ready.",
            url: `/?chat=${chat.id}`,
            chatId: chat.id,
            tag: `chat:${chat.id}`,
          },
          {
            suppressDeviceIds: typeof initiatingDeviceId === "string" ? [initiatingDeviceId] : [],
          }
        ).catch((err) => console.warn("[push] message_complete dispatch failed:", err));
      }
    } else {
      // Remove the in-progress placeholder if present
      const lastMsg = chat.messages[chat.messages.length - 1];
      if (lastMsg?.role === "assistant" && lastMsg._inProgress) {
        chat.messages.pop();
        await saveChat(chat);
      }
      console.error(`[chat] NO CONTENT produced after ${iterations} iterations - model failure or context issue. Not persisting empty message.`);
      // Clean up stale pending state so the next message doesn't trigger a spurious resume
      await clearPendingState(chat.id);
    }

    // Used by the sleep cycle to measure inactivity from when the assistant
    // finished, not from when the user sent. System chats are autonomous and
    // should not reset the user-idle window.
    await stampAssistantCompletion(chat);

    if (waitingForInput) {
      res.write(
        `event: done\ndata: ${JSON.stringify({ message: assistantMsg, waitingForInput: true, iterations })}\n\n`
      );
    } else {
      // Clean up pending state — turn completed normally, no need for crash recovery
      await clearPendingState(chat.id);

      res.write(
        `event: done\ndata: ${JSON.stringify({ message: assistantMsg, iterations })}\n\n`
      );

      // Generate LLM title after the first exchange (2 messages = 1 user + 1 assistant).
      // Fire-and-forget so slow title generation doesn't delay the done event reaching
      // the client (which would cause a spurious "Connection lost" error).
      if (!currentTurnIsHidden && shouldGenerateInitialTitle(chat) && hasContent) {
        generateTitle(lastUserMessage, logicalAssistantContent)
          .then(async (title) => {
            if (title) {
              chat.title = title;
              await saveChat(chat);
              res.write(`event: title_update\ndata: ${JSON.stringify({ chatId: chat.id, title })}\n\n`);
            }
          })
          .catch((err) => console.warn("[title] post-stream generation failed:", err));
      }

      // Record model performance stats for llama.cpp models (per-message, not per-turn)
      if (ollamaModel?.provider === "llamacpp" && state.lastLlamaTimings) {
        try {
          const { recordModelStats } = await import("../services/model-stats.js");
          const stats = recordModelStats(ollamaModel.id, "llamacpp", state.lastLlamaTimings, state.lastLlamaCache ?? undefined);
          const cacheText = stats.inferredCachedTokens !== undefined
            ? ` cache=${stats.inferredCachedTokens}/${stats.reportedPromptTokens ?? "?"}`
            : "";
          console.log(`[model-stats] recorded: ${ollamaModel.id} decode=${state.lastLlamaTimings.predicted_per_second.toFixed(1)} tok/s${cacheText}`);
        } catch (err) {
          console.warn("[model-stats] recording failed:", err);
        }
      }

      // Memory extraction — runs after agent loop is fully complete (no concurrent LLM interference)
      if (!currentTurnIsHidden && (chat.type === "agent" || chat.type === "bluesky") && hasContent) {
        extractMemories(chat.modelId, chat.id, lastUserMessage, logicalAssistantContent)
          .catch((err) => console.error("[memory] extraction failed:", err));
      }
      // Run any deferred extractions from mid-loop follow-ups
      for (const deferred of deferredExtractions) {
        extractMemories(chat.modelId, chat.id, deferred.userMsg, deferred.assistantMsg)
          .catch((err) => console.error("[memory] deferred extraction failed:", err));
      }
      deferredExtractions.length = 0;
    }
  } catch (e: any) {
    // ask_user abort is expected — handle it gracefully
    if (askUserRef.current) {
      waitingForInput = true;

      // Build partial assistant message with whatever remains uncommitted.
      const assistantMsg = finalizeUncommittedAssistantMessage() ?? buildUncommittedAssistantMessage();

      // Save immediately - this is critical for durability
      try {
        await saveChat(chat);
        console.log(`[chat] error path: saved partial message before ask_user`);
      } catch (saveErr) {
        console.error(`[chat] failed to save on ask_user error path:`, saveErr);
      }

      // Best-effort save of pending state
      try {
        const savedMessages = [...(contextMessages as any[])];
        // On error path, context may not have been fully populated.
        // Save what we have — the assistant message with ask_user should be present.
        await savePendingState(chat.id, {
          agentMessages: savedMessages,
          systemPrompt,
          askToolCallId: askUserRef.current.toolCallId,
        });
      } catch (saveErr) {
        console.error("[ask_user] failed to save pending state:", saveErr);
      }

      res.write(`event: ask_user\ndata: ${JSON.stringify({ question: askUserRef.current.question })}\n\n`);
      res.write(
        `event: done\ndata: ${JSON.stringify({ message: assistantMsg, waitingForInput: true, iterations })}\n\n`
      );
    } else if (e.name === "AbortError") {
      // AbortError from client disconnect or inactivity timeout
      // Save whatever we've accumulated before the connection dropped
      if (hasUncommittedAssistantActivity()) {
        const assistantMsg = finalizeUncommittedAssistantMessage();
        try {
          await saveChat(chat);
          console.log(`[chat] abort: saved partial response (${assistantMsg?.content.length || 0}ch, ${assistantMsg?.toolCalls?.length || 0} tools)`);
        } catch (saveErr) {
          console.error(`[chat] abort: failed to save partial response:`, saveErr);
        }
      }
      console.log(`[chat] stream aborted: ${connectionClosed ? "client disconnected" : "signal aborted"}`);
    } else {
      // Unexpected error - save what we have before reporting
      if (hasUncommittedAssistantActivity()) {
        const assistantMsg = finalizeUncommittedAssistantMessage();
        try {
          await saveChat(chat);
          console.log(`[chat] error: saved partial state before error (${assistantMsg?.content.length || 0}ch)`);
        } catch (saveErr) {
          console.error(`[chat] error: failed to save partial state:`, saveErr);
        }
      }

      // Only write error if the connection is still open
      if (!connectionClosed) {
        res.write(
          `event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`
        );
      }
    }
  } finally {
    markChatInactive(chat.id);
    stopSSEKeepalive();
    endLiveStream(chat.id);
    res.end();
  }
}

// Send message and stream response via SSE
router.post("/", async (req, res) => {
  const { chatId, message: messageText, images } = req.body as {
    chatId: string;
    message: string;
    images?: ImageAttachment[];
  };

  if (!chatId || (!messageText && (!images || images.length === 0))) {
    return res.status(400).json({ error: "chatId and message (or images) are required" });
  }

  const chat = await getChat(chatId);
  if (!chat) return res.status(404).json({ error: "Chat not found" });

  // Stamp user activity before waiting on synthesis so sleep mode clears as
  // soon as the user starts a turn, even if processing is temporarily queued.
  await stampUserActivity(chat);

  // Wait for any running scheduled automation before processing user messages.
  // This prevents system-chat maintenance from contending with the user's turn
  // or mutating memories/context while prompt construction is starting.
  await waitForBackgroundAutomation(chatId);

  // Restore any queued messages from a previous SSE drop
  await messageQueue.loadFromDisk(chatId);

  // Persist images to disk and enrich with thumbnail URLs
  const persistedImages = images?.length ? await persistImages(images) : undefined;

  let message = messageText;

  // Check for /compact command (before skill parsing, as it's a reserved command)
  const compactResult = parseCompactCommand(message);
  if (compactResult.compact) {
    console.log(`[chat] /compact command detected for chat ${chatId}`);

    // Get settings for context window resolution
    const settings = await getSettings();
    const { getEffectiveContextWindow, discoverAllModels } = await import("../services/models.js");
    const allModels = await discoverAllModels();
    const ollamaModel = allModels.find(m => m.id === chat.modelId);
    const contextWindow = getEffectiveContextWindow(chat, ollamaModel, settings);

    // Set up SSE stream BEFORE triggering compaction so keepalive pings can
    // flow while the (CPU) extraction model runs index generation. Without
    // this, the client's fetch() would hang until the first byte, and its
    // subsequent SSE inactivity timer could fire during preCompactionFlush.
    ensureSSEStream(res, req, chat.id);
    res.write(`event: compacting\ndata: {}\n\n`);

    // Wrap the whole compaction + flush in a keepalive ping loop.
    const compaction = await withSSEKeepalive(res, async () => {
      const result = await triggerCompaction(chat, contextWindow);
      if (result && result.truncated) {
        // Extract memories from removed messages and await completion so they're
        // available when the next buildSplitAugmentedPrompt runs (either in this
        // handler's follow-up path or in the main handler).
        if ((chat.type === "agent" || chat.type === "bluesky") && result.removedMessages?.length) {
          try {
            await preCompactionFlush(chat.modelId, chat.id, result.removedMessages, chat.projectId);
          } catch (err) {
            console.error("[compaction] /compact flush failed:", err);
          }
        }

        // Full reset of memory context — compaction reshapes the entire context,
        // so the next buildSplitAugmentedPrompt call will do a full retrieval with
        // all memories frozen into the new system prompt. No need to rebuild here
        // because the main handler (or follow-up path) will call buildSplitAugmentedPrompt.
        if (chat.type === "agent" || chat.type === "bluesky") {
          resetMemoryContext(chat.id);
        }
      }
      return result;
    });

    if (compaction && compaction.truncated) {

      // Build and save a confirmation assistant message
      const confirmText = `Context compacted. Removed ${compaction.removedCount} messages (~${compaction.estimatedTokenCount} tokens).`;
      const confirmMsg: ChatMessage = {
        role: "assistant",
        content: confirmText,
        timestamp: Date.now(),
        _isSystemMessage: true,
      };
      chat.messages.push(confirmMsg);
      await saveChat(chat);

      // If there's a follow-up message, process it; otherwise send confirmation
      if (compactResult.followUpMessage) {
        console.log(`[chat] /compact with follow-up: "${compactResult.followUpMessage.slice(0, 50)}..."`);
        const summaryMsg = chat.messages.find(m => m._isCompactionSummary && !m._outOfContext);
        const estimatedTokens = await estimatePostCompactionTokens(
          chat,
          chat.systemPrompt || "",
          toolsForEstimate(chat, contextWindow),
        );
        res.write(`event: compaction\ndata: ${JSON.stringify({
          removedCount: compaction.removedCount,
          remainingCount: chat.messages.filter(m => !m._outOfContext).length,
          summaryMessage: summaryMsg || null,
          phase: "manual",
          continues: true,
          estimatedTokens,
        })}\n\n`);
        message = compactResult.followUpMessage;
        // Continue with normal message processing below
      } else {
        console.log(`[chat] /compact complete: removed ${compaction.removedCount} messages`);
        const summaryMsg = chat.messages.find(m => m._isCompactionSummary && !m._outOfContext);
        const estimatedTokens = await estimatePostCompactionTokens(
          chat,
          chat.systemPrompt || "",
          toolsForEstimate(chat, contextWindow),
        );
        res.write(`event: compaction\ndata: ${JSON.stringify({
          removedCount: compaction.removedCount,
          remainingCount: chat.messages.filter(m => !m._outOfContext).length,
          summaryMessage: summaryMsg || null,
          phase: "manual",
          continues: false,
          estimatedTokens,
        })}\n\n`);
        res.write(`event: text_delta\ndata: ${JSON.stringify({ delta: confirmText })}\n\n`);
        await stampAssistantCompletion(chat);
        res.write(`event: done\ndata: ${JSON.stringify({ message: confirmMsg })}\n\n`);
        closeLiveSSE(chat.id, res);
        return;
      }
    } else {
      // Compaction was not needed
      const skipMsg: ChatMessage = {
        role: "assistant",
        content: "Compaction skipped: not enough messages to compact.",
        timestamp: Date.now(),
        _isSystemMessage: true,
      };
      chat.messages.push(skipMsg);
      await saveChat(chat);
      res.write(`event: text_delta\ndata: ${JSON.stringify({ delta: skipMsg.content })}\n\n`);
      await stampAssistantCompletion(chat);
      res.write(`event: done\ndata: ${JSON.stringify({ message: skipMsg })}\n\n`);
      closeLiveSSE(chat.id, res);
      return;
    }
  }

  // Check for skill invocations anywhere in the message
  const invokedSkills = parseSkillInvocations(message);
  const activatedSkillNames: string[] = [];

  // Always discover skills (global + project if applicable)
  const allSkills = await discoverSkills(chat.projectId);
  console.log(`[skills] Chat ${chatId} (type=${chat.type}, projectId=${chat.projectId}): discovered ${allSkills.length} skills: ${allSkills.map(s => s.name).join(", ")}`);

  if (invokedSkills.length > 0) {
    for (const invokedSkill of invokedSkills) {
      const skill = allSkills.find(s => s.name.toLowerCase() === invokedSkill.toLowerCase());

      if (skill) {
        // Add skill to active skills if not already present
        if (!chat.activeSkills) {
          chat.activeSkills = [];
        }
        if (!chat.activeSkills.includes(skill.name)) {
          chat.activeSkills.push(skill.name);
          activatedSkillNames.push(skill.name);
          console.log(`[skills] Activated skill "${skill.name}" for chat ${chatId}`);
        } else {
          console.log(`[skills] Skill "${skill.name}" already active in chat ${chatId}`);
        }
      } else {
        console.warn(`[skills] Invoked skill "${invokedSkill}" not found in discovered skills`);
      }
    }

    // Keep skill invocations in the message for display (they're already activated)
    // No need to strip them - they serve as visual indicators of activated skills
  }

  // Check for pending state (ask_user OR mid-turn crash recovery)
  const pendingState = await loadPendingState(chatId);

  // Check if this is a mid-turn crash recovery (has accumulators but no ask_user)
  const isMidTurnRecovery = pendingState && !pendingState.askToolCallId && pendingState.fullText !== undefined;

  if (isMidTurnRecovery) {
    // MID-TURN CRASH RECOVERY: The agent was mid-tool-loop when the process died.
    // The in-progress assistant message (with tool calls and partial text) should
    // already be in chat.messages from incremental persistence. If not, reconstruct
    // it from the pending state accumulators. Then fall through to the normal path
    // so the user's new message is sent as a fresh prompt with full context.
    console.log(`[chat] mid-turn crash recovery: ${pendingState!.iterations} iterations, ${pendingState!.fullText?.length || 0}ch text, ${pendingState!.toolCalls?.length || 0} tools`);

    const lastMsg = chat.messages[chat.messages.length - 1];
    const hasInProgressMsg = lastMsg?.role === "assistant" && (lastMsg._inProgress || lastMsg.toolCalls?.length);

    if (!hasInProgressMsg && pendingState!.toolCalls?.length) {
      // No in-progress message saved (pre-fix crash) — reconstruct from accumulators
      const partialMsg: ChatMessage = {
        role: "assistant",
        content: pendingState!.fullText || "",
        thinking: pendingState!.thinkingText || undefined,
        toolCalls: pendingState!.toolCalls?.length ? pendingState!.toolCalls : undefined,
        toolResults: pendingState!.toolResults?.length ? pendingState!.toolResults : undefined,
        timestamp: Date.now(),
      };
      if (lastMsg?.role === "assistant") {
        chat.messages[chat.messages.length - 1] = partialMsg;
      } else {
        chat.messages.push(partialMsg);
      }
      await saveChat(chat);
      console.log(`[chat] reconstructed in-progress message from pending state accumulators`);
    } else if (hasInProgressMsg) {
      // Strip _inProgress flag — the message is now finalized (partial)
      delete lastMsg._inProgress;
      await saveChat(chat);
    }

    // Fall through to the normal path below — the in-progress assistant message
    // is now part of chat.messages, so context will include it.
    // pendingState is already consumed (deleted) by loadPendingState.
  }

  if (pendingState && !isMidTurnRecovery) {
    // ASK_USER RESUME: the user's message is the answer to ask_user
    let systemPrompt = pendingState.systemPrompt;

    // Load settings for context window resolution
    const settings = await getSettings();

    // Check for new skill invocations in resume message
    const invokedSkills = parseSkillInvocations(message);
    if (invokedSkills.length > 0) {
      const allSkills = await discoverSkills(chat.projectId);
      for (const invokedSkill of invokedSkills) {
        const skill = allSkills.find(s => s.name.toLowerCase() === invokedSkill.toLowerCase());
        if (skill && chat.activeSkills && !chat.activeSkills.includes(skill.name)) {
          chat.activeSkills.push(skill.name);
          console.log(`[skills] Activated skill "${skill.name}" for chat ${chatId} (resume)`);
        }
      }
      // Keep skill invocations in the message for display
    }

    // Inject active skills into the resumed system prompt
    if (chat.activeSkills?.length) {
      const skillsCache = new Map<string, Skill>();
      const allSkills = await discoverSkills(chat.projectId);
      for (const s of allSkills) {
        skillsCache.set(s.name, s);
      }
      systemPrompt = buildSkillAugmentedPrompt(systemPrompt, chat.activeSkills, skillsCache);
    }

    const contextMessages = pendingState.agentMessages as Message[];

    // Safety check: if context is empty, rebuild from chat.messages to avoid
    // losing conversation history due to corrupted or empty pending state
    if (contextMessages.length === 0 && chat.messages.length > 0) {
      console.warn(`[chat] pending state has empty context, rebuilding from chat.messages (${chat.messages.length} messages)`);
      // Exclude the last message (current user message) from context
      const rebuiltContext = chatMessagesToPiMessages(chat.messages.slice(0, -1), chat.modelId);
      contextMessages.push(...rebuiltContext);
    }

    // Inject the user's answer as a ToolResultMessage for the pending ask_user call
    const toolResultMsg: ToolResultMessage = {
      role: "toolResult",
      toolCallId: pendingState.askToolCallId,
      toolName: "ask_user",
      content: [{ type: "text", text: message }],
      isError: false,
      timestamp: Date.now(),
    };
    contextMessages.push(toolResultMsg);

    // Show the answer in the UI as a user message
    chat.messages.push({
      role: "user",
      content: message,
      images: images?.length ? images : undefined,
      timestamp: Date.now(),
    });
    await saveChat(chat);

    // Discover model for pre-send truncation
    let model: OllamaModel | undefined;
    try {
      const allModels = await discoverAllModels();
      model = allModels.find((m) => m.id === chat.modelId);
    } catch (err: any) {
      console.error("[compaction] model discovery failed (resume):", err.message);
      model = undefined; // Skip truncation if providers are unreachable
    }

    // Pre-send context protection for resume path.
    // Initialize SSE stream BEFORE compaction so `compacting` and keepalive
    // events reach the client while the (CPU) extraction model is generating.
    ensureSSEStream(res, req, chat.id);
    if (model) {
      // Wrap compaction + post-compaction rebuild in a keepalive loop so the
      // client's 95s inactivity timeout doesn't fire during slow extraction/
      // embed/rerank steps.
      await withSSEKeepalive(res, async () => {
        try {
          const effectiveContextWindow = getEffectiveContextWindow(chat, model, settings);
          const emitKeepalive = () => res.write(`: keepalive\n\n`);
          const compaction = await truncateBeforeSend(
            chat,
            effectiveContextWindow,
            systemPrompt,
            () => res.write(`event: compacting\ndata: {}\n\n`),
            emitKeepalive,
            toolsForEstimate(chat, effectiveContextWindow),
          );
          if (compaction && compaction.truncated) {
            // Extract memories from removed messages and await completion so they're
            // available for the system prompt rebuild below. Without awaiting, the
            // rebuilt prompt would miss freshly extracted memories from removed context.
            if ((chat.type === "agent" || chat.type === "bluesky") && compaction.removedMessages?.length) {
              try {
                await preCompactionFlush(chat.modelId, chat.id, compaction.removedMessages, chat.projectId);
              } catch (err) {
                console.error("[compaction] pre-send flush failed (resume):", err);
              }
            }

            await saveChat(chat, { allowTruncation: true });
            // Rebuild system prompt after truncation with full memory reset
            resetMemoryContext(chat.id);
            if (chat.type === "agent" || chat.type === "bluesky") {
              let resumeProjectPath: string | undefined;
              if (chat.projectId) {
                const project = await getProject(chat.projectId);
                resumeProjectPath = project?.path;
              }
              const split = await buildSplitAugmentedPrompt(
                chat.systemPrompt || "You are a helpful assistant.",
                chat.messages,
                chat.id,
                chat.projectId,
                chat.type,
                resumeProjectPath
              );
              systemPrompt = split.systemPrompt;
            }
            // Find the summary message that was inserted
            const summaryMsg = chat.messages.find(m => m._isCompactionSummary);
            // Emit compaction event for UI indicator
            const estimatedTokens = await estimatePostCompactionTokens(
              chat,
              systemPrompt,
              toolsForEstimate(chat, effectiveContextWindow),
            );
            res.write(`event: compaction\ndata: ${JSON.stringify({
              removedCount: compaction.removedCount,
              remainingCount: chat.messages.filter(m => !m._outOfContext).length,
              summaryMessage: summaryMsg || null,
              phase: "pre_send",
              continues: true,
              estimatedTokens,
            })}\n\n`);
          }
        } catch (err) {
          console.error("[compaction] pre-send truncation failed (resume):", err);
        }
      });
    }

    // Safety check: warn if context is empty for resume
    if (contextMessages.length === 0 && chat.messages.length > 1) {
      console.error(`[chat] CRITICAL: resume context is empty despite ${chat.messages.length} messages in chat`);
    }

    // Safety check: detect catastrophic context loss from compaction
    if (chat.messages.length <= 3 && chat.messages.length > 1) {
      console.warn(`[chat] WARNING: resume chat has only ${chat.messages.length} messages after compaction - possible catastrophic context loss`);
    }

    // Resume: userPiMessage=null triggers agentLoopContinue
    await handleChatStream(chat, message, contextMessages, systemPrompt, null, req, res);
  } else {
    // NORMAL: add user message and build fresh context
    // Deduplication: if any recent message in chat is an identical user message
    // (same content, sent within 60s), this is likely a retry from a timed-out
    // client or a server restart. Skip adding the duplicate and reuse the existing
    // message. We check the last several messages (not just the last one) because
    // after a server restart, the last message may be an assistant response
    // (partial or in-progress) that was persisted before the crash.
    const recentMessages = chat.messages.slice(-5);
    const incomingImageCount = persistedImages?.length ?? images?.length ?? 0;
    const isLikelyDuplicate = recentMessages.some(m =>
      m.role === "user" &&
      m.content === message &&
      (m.images?.length ?? 0) === incomingImageCount &&
      (Date.now() - (m.timestamp || 0)) < 60_000
    );

    if (isLikelyDuplicate) {
      console.warn(`[chat] Deduplicating user message for chat ${chatId} — identical message found in recent history within 60s`);
      const stream = liveStreams.get(chatId);
      if (stream && !stream.ended && !stream.abort.signal.aborted) {
        console.warn(`[chat] duplicate POST for active chat ${chatId}; attaching to existing live stream`);
        attachToLiveStreamResponse(req, res, stream, "duplicate-attached");
        return;
      }
    } else {
      const userMsg: ChatMessage = {
        role: "user",
        content: message,
        images: persistedImages?.length ? persistedImages : (images?.length ? images : undefined),
        timestamp: Date.now(),
      };
      chat.messages.push(userMsg);
    }

    // Auto-generate title from first message
    if (chat.messages.length === 1) {
      chat.title = truncateTitle(message);
    }

    await saveChat(chat);

    // Load settings for context window resolution
    const settings = await getSettings();

    // Build system prompt with delta-based memory injection for KV cache optimization.
    // Frozen memories live in the system prompt (byte-identical between turns).
    // When extraction adds new memories, only the delta is appended at end of context.
    // For the system chat, skip memory augmentation — context is injected directly
    // as messages during synthesis runs.
    let systemPrompt = chat.systemPrompt || "You are a helpful assistant.";
    let memoriesDelta = "";
    if (chat.type === "agent" || chat.type === "bluesky") {
      // Get project path for AGENTS.md loading
      let projectPath: string | undefined;
      if (chat.projectId) {
        const project = await getProject(chat.projectId);
        projectPath = project?.path;
      }
      const split = await buildSplitAugmentedPrompt(
        systemPrompt,
        chat.messages,
        chat.id,
        chat.projectId,
        chat.type,
        projectPath
      );
      systemPrompt = split.systemPrompt;
      memoriesDelta = split.memoriesMessage;
    }

    // Inject active skills into system prompt
    if (chat.activeSkills?.length) {
      const skillsCache = new Map<string, Skill>();
      const allSkills = await discoverSkills(chat.projectId);
      console.log(`[skills] Chat ${chatId}: projectId=${chat.projectId}, discovered ${allSkills.length} skills, activeSkills=${chat.activeSkills.join(",")}`);
      for (const s of allSkills) {
        skillsCache.set(s.name, s);
      }
      systemPrompt = buildSkillAugmentedPrompt(systemPrompt, chat.activeSkills, skillsCache);
      console.log(`[skills] Injected ${chat.activeSkills.length} skills into system prompt`);
    } else {
      console.log(`[skills] Chat ${chatId}: no activeSkills set (projectId=${chat.projectId})`);
    }

    // Discover model for pre-send truncation
    let model: OllamaModel | undefined;
    try {
      const allModels = await discoverAllModels();
      model = allModels.find((m) => m.id === chat.modelId);
    } catch (err: any) {
      console.error("[compaction] model discovery failed:", err.message);
      model = undefined; // Skip truncation if providers are unreachable
    }

    // Pre-send context protection: truncate BEFORE sending if >75% of context window.
    // Initialize SSE stream early so compaction progress events (and the extraction
    // model's 10s keepalive) reach the client while pre-send compaction is running.
    ensureSSEStream(res, req, chat.id);
    if (model) {
      // Wrap compaction + post-compaction rebuild in a keepalive loop so the
      // client's 95s inactivity timeout doesn't fire during slow extraction/
      // embed/rerank steps.
      await withSSEKeepalive(res, async () => {
        try {
          const effectiveContextWindow = getEffectiveContextWindow(chat, model, settings);
          const emitKeepalive = () => res.write(`: keepalive\n\n`);
          const compaction = await truncateBeforeSend(
            chat,
            effectiveContextWindow,
            systemPrompt,
            () => res.write(`event: compacting\ndata: {}\n\n`),
            emitKeepalive,
            toolsForEstimate(chat, effectiveContextWindow),
          );
          if (compaction && compaction.truncated) {
            // Extract memories from removed messages and await completion so they're
            // available for the system prompt rebuild below. Without awaiting, the
            // rebuilt prompt would miss freshly extracted memories from removed context.
            if ((chat.type === "agent" || chat.type === "bluesky") && compaction.removedMessages?.length) {
              try {
                await preCompactionFlush(chat.modelId, chat.id, compaction.removedMessages, chat.projectId);
              } catch (err) {
                console.error("[compaction] pre-send flush failed:", err);
              }
            }

            await saveChat(chat, { allowTruncation: true });
            // Full reset of memory context — compaction reshapes the entire context,
            // so we need fresh retrieval with all memories frozen into the new system prompt.
            // Using buildSplitAugmentedPrompt (not legacy buildMemoryAugmentedPrompt) so that
            // the frozen context state is set up immediately, avoiding a redundant retrieval
            // on the next turn.
            resetMemoryContext(chat.id);
            if (chat.type === "agent" || chat.type === "bluesky") {
              let projectPath: string | undefined;
              if (chat.projectId) {
                const project = await getProject(chat.projectId);
                projectPath = project?.path;
              }
              const split = await buildSplitAugmentedPrompt(
                chat.systemPrompt || "You are a helpful assistant.",
                chat.messages,
                chat.id,
                chat.projectId,
                chat.type,
                projectPath
              );
              systemPrompt = split.systemPrompt;
              // split.memoriesMessage is always empty after reset (case 1: full retrieval)

              // Reinject skills after compaction — they were lost when
              // buildSplitAugmentedPrompt rebuilt from the base systemPrompt.
              if (chat.activeSkills?.length) {
                const skillsCache = new Map<string, Skill>();
                const allSkills = await discoverSkills(chat.projectId);
                for (const s of allSkills) skillsCache.set(s.name, s);
                systemPrompt = buildSkillAugmentedPrompt(systemPrompt, chat.activeSkills, skillsCache);
                console.log(`[skills] Reinjected ${chat.activeSkills.length} skills after pre-send compaction`);
              }
            }
            // Find the summary message that was inserted
            const summaryMsg = chat.messages.find(m => m._isCompactionSummary);
            // Emit compaction event for UI indicator
            const estimatedTokens = await estimatePostCompactionTokens(
              chat,
              systemPrompt,
              toolsForEstimate(chat, effectiveContextWindow),
            );
            res.write(`event: compaction\ndata: ${JSON.stringify({
              removedCount: compaction.removedCount,
              remainingCount: chat.messages.filter(m => !m._outOfContext).length,
              summaryMessage: summaryMsg || null,
              phase: "pre_send",
              continues: true,
              estimatedTokens,
            })}\n\n`);
          }
        } catch (err) {
          console.error("[compaction] pre-send truncation failed:", err);
        }
      });
    }

    setCachedAugmentedPrompt(chat.id, systemPrompt);

    const memoryDeltaContext = memoriesDelta
      ? `[System context — updated memories]\n${memoriesDelta}`
      : "";

    // Persist the memory delta as a system-role message immediately before the
    // user's new message. Persisting (rather than injecting transiently) keeps
    // every previous turn's delta at a stable position in chat history so the
    // KV cache prefix matches across turns — only the new delta + user msg are
    // reprocessed each turn instead of the entire prior turn. Replay merges
    // this hidden row into the following user message, so llama.cpp never sees
    // a mid-transcript system role.
    if (memoryDeltaContext) {
      const insertAt = Math.max(0, chat.messages.length - 1);
      chat.messages.splice(insertAt, 0, {
        role: "system",
        content: memoryDeltaContext,
        timestamp: Date.now(),
      });
      await saveChat(chat);
    }

    // Context = all messages before the current user prompt. If this turn has
    // a fresh memory delta, exclude that hidden row here and merge it into the
    // current user message below. Future replays reconstruct the same shape by
    // merging the persisted system row with the following persisted user row.
    const currentUserIndex = chat.messages.length - 1;
    const persistedHistoryEnd =
      memoryDeltaContext &&
      currentUserIndex > 0 &&
      chat.messages[currentUserIndex - 1]?.role === "system" &&
      chat.messages[currentUserIndex - 1]?.content === memoryDeltaContext
        ? currentUserIndex - 1
        : currentUserIndex;
    const persistedHistory = chat.messages.slice(0, persistedHistoryEnd);
    const contextMessages = chatMessagesToPiMessages(persistedHistory, chat.modelId);

    // Safety check: warn if context is empty for non-first messages
    if (contextMessages.length === 0 && chat.messages.length > 1) {
      console.error(`[chat] CRITICAL: context conversion produced empty array for chat with ${chat.messages.length} messages`);
    }

    // Diagnose missing recent turns: compare in-context messages against total.
    // If the last 2+ in-context messages were dropped, log the state for diagnosis.
    const inContextCount = chat.messages.filter(m => !m._outOfContext).length;
    const outOfContextCount = chat.messages.length - inContextCount;
    if (outOfContextCount > 0 && chat.messages.length > 4) {
      const lastInContext = (() => {
        for (let i = chat.messages.length - 1; i >= 0; i--) {
          if (!chat.messages[i]._outOfContext) return i;
        }
        return -1;
      })();
      const lastMsg = chat.messages[chat.messages.length - 1];
      const secondLastMsg = chat.messages[chat.messages.length - 2];
      const lastOoc = chat.messages.length - 1 - lastInContext;
      if (lastOoc > 2) {
        console.warn(
          `[chat] ${chatId.slice(0,8)}: ${lastOoc} messages after last in-context (total ${chat.messages.length}, ${inContextCount} in-context, ${outOfContextCount} OOC). ` +
          `Last msg: ${lastMsg?.role}/${(lastMsg?.content || '').slice(0,50).replace(/\n/g,' ')} ` +
          `Second-last: ${secondLastMsg?.role}/${(secondLastMsg?.content || '').slice(0,50).replace(/\n/g,' ')} ` +
          `Last in-context idx=${lastInContext}: ${chat.messages[lastInContext]?.role}/${(chat.messages[lastInContext]?.content || '').slice(0,50).replace(/\n/g,' ')}`
        );
      }
    }

    // Safety check: detect catastrophic context loss from compaction
    if (chat.messages.length <= 3 && chat.messages.length > 1) {
      console.warn(`[chat] WARNING: chat has only ${chat.messages.length} messages after compaction - possible catastrophic context loss`);
    }

    // KV cache efficiency logging — compares the reconstructed pi-message
    // prefix against the previous turn's snapshot so silent invalidations
    // (replay-shape changes, mid-history rewrites) are visible at log time.
    logKvCacheState({
      chatId,
      source: "send",
      systemPromptChars: systemPrompt.length,
      deltaChars: memoriesDelta.length,
      newMsgChars: message.length,
      persistedRows: persistedHistory.length,
      contextPiMessages: contextMessages,
      shape: summarizeReplayShape(persistedHistory),
    });

    const userPiMessage = buildUserPiMessage(message, images, memoryDeltaContext);

    await handleChatStream(chat, message, contextMessages, systemPrompt, userPiMessage, req, res);
  }
});

// Report an artifact runtime error and ask the agent to repair it as a hidden follow-up.
router.post("/artifact-error", async (req, res) => {
  const body = req.body as Partial<ArtifactRuntimeErrorReport>;
  const report: ArtifactRuntimeErrorReport = {
    chatId: typeof body.chatId === "string" ? body.chatId : "",
    artifactId: typeof body.artifactId === "string" ? body.artifactId : "",
    version: Number(body.version),
    title: typeof body.title === "string" ? body.title : undefined,
    url: typeof body.url === "string" ? body.url : undefined,
    message: typeof body.message === "string" ? body.message : "",
    stack: typeof body.stack === "string" ? body.stack : undefined,
    filename: typeof body.filename === "string" ? body.filename : undefined,
    lineno: typeof body.lineno === "number" ? body.lineno : undefined,
    colno: typeof body.colno === "number" ? body.colno : undefined,
    sourceExcerpt: typeof body.sourceExcerpt === "string" ? body.sourceExcerpt : undefined,
    stream: body.stream === true,
  };

  if (!report.chatId || !report.artifactId || !Number.isInteger(report.version) || report.version < 1 || !report.message) {
    return res.status(400).json({ error: "chatId, artifactId, version, and message are required" });
  }
  if (!isSafeArtifactId(report.artifactId)) {
    return res.status(400).json({ error: "Invalid artifactId" });
  }

  const chat = await getChat(report.chatId);
  if (!chat) return res.status(404).json({ error: "Chat not found" });
  if (!(chat.type === "agent" || chat.type === "bluesky" || chat.type === "system")) {
    return res.status(400).json({ error: "Artifact repair requires a tool-capable chat" });
  }

  const currentVersion = await getArtifactCurrentVersion(report.artifactId);
  if (!currentVersion) return res.status(404).json({ error: "Artifact not found" });
  if (report.version !== currentVersion) {
    return res.status(409).json({ error: "Only the latest artifact version can be auto-repaired" });
  }

  const stream = liveStreams.get(report.chatId);
  const active = !!stream && !stream.ended && !stream.abort.signal.aborted;
  if (!active && !chatReferencesArtifact(chat, report.artifactId, report.version)) {
    return res.status(400).json({ error: "Artifact is not associated with this chat" });
  }

  const dedupKey = makeArtifactRepairDedupKey(report);
  if (hasRecentArtifactRepairAttempt(dedupKey)) {
    if (report.stream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(`event: error\ndata: ${JSON.stringify({ error: "Artifact repair already requested for this error" })}\n\n`);
      res.end();
      return;
    }
    return res.json({ accepted: false, duplicate: true });
  }
  if (hasRecentArtifactAutoRepair(report.chatId, report.artifactId)) {
    if (report.stream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(`event: error\ndata: ${JSON.stringify({ error: "Automatic artifact repair was already attempted for this artifact" })}\n\n`);
      res.end();
      return;
    }
    return res.json({ accepted: false, repairLimit: true });
  }

  report.sourceExcerpt = await getArtifactSourceExcerpt(report);
  const repairPrompt = buildArtifactRepairPrompt(report);
  const metadata = {
    artifactId: report.artifactId,
    version: report.version,
    errorMessage: report.message,
    errorHash: dedupKey.split(":").pop(),
  };

  if (active || !report.stream) {
    await messageQueue.enqueue(report.chatId, repairPrompt, undefined, {
      hidden: true,
      kind: "artifact_repair",
      metadata,
    });
    console.log(`[artifact-repair] queued repair for ${report.artifactId} v${report.version} in chat ${report.chatId}`);
    return res.json({ accepted: true, queued: true, active });
  }

  await waitForBackgroundAutomation(report.chatId);

  chat.messages.push({
    role: "system",
    content: repairPrompt,
    timestamp: Date.now(),
    _isSystemMessage: true,
  });
  await saveChat(chat);

  let systemPrompt = chat.systemPrompt || "You are a helpful assistant.";
  let memoriesDelta = "";
  if (chat.type === "agent" || chat.type === "bluesky") {
    let projectPath: string | undefined;
    if (chat.projectId) {
      const project = await getProject(chat.projectId);
      projectPath = project?.path;
    }
    const split = await buildSplitAugmentedPrompt(
      systemPrompt,
      chat.messages,
      chat.id,
      chat.projectId,
      chat.type,
      projectPath
    );
    systemPrompt = split.systemPrompt;
    memoriesDelta = split.memoriesMessage;
  }

  if (chat.activeSkills?.length) {
    const skillsCache = new Map<string, Skill>();
    const allSkills = await discoverSkills(chat.projectId);
    for (const s of allSkills) skillsCache.set(s.name, s);
    systemPrompt = buildSkillAugmentedPrompt(systemPrompt, chat.activeSkills, skillsCache);
  }

  const memoryDeltaContext = memoriesDelta
    ? `[System context — updated memories]\n${memoriesDelta}`
    : "";
  if (memoryDeltaContext) {
    const insertAt = Math.max(0, chat.messages.length - 1);
    chat.messages.splice(insertAt, 0, {
      role: "system",
      content: memoryDeltaContext,
      timestamp: Date.now(),
    });
    await saveChat(chat);
  }

  setCachedAugmentedPrompt(chat.id, systemPrompt);

  const currentPromptIndex = chat.messages.length - 1;
  const persistedHistoryEnd =
    memoryDeltaContext &&
    currentPromptIndex > 0 &&
    chat.messages[currentPromptIndex - 1]?.role === "system" &&
    chat.messages[currentPromptIndex - 1]?.content === memoryDeltaContext
      ? currentPromptIndex - 1
      : currentPromptIndex;
  const contextMessages = chatMessagesToPiMessages(chat.messages.slice(0, persistedHistoryEnd), chat.modelId);
  const userPiMessage = buildUserPiMessage("", undefined, mergeSystemContextWithUserContent(memoryDeltaContext, repairPrompt));

  console.log(`[artifact-repair] starting repair for ${report.artifactId} v${report.version} in chat ${report.chatId}`);
  await handleChatStream(chat, repairPrompt, contextMessages, systemPrompt, userPiMessage, req, res, {
    hiddenUserMessage: true,
  });
});

// Enqueue a message while the agent is streaming
router.post("/enqueue", async (req, res) => {
  const { chatId, message, images } = req.body as {
    chatId: string;
    message: string;
    images?: ImageAttachment[];
  };

  if (!chatId || !message) {
    return res.status(400).json({ error: "chatId and message are required" });
  }

  const chat = await getChat(chatId);
  if (!chat) return res.status(404).json({ error: "Chat not found" });

  await stampUserActivity(chat);

  // Persist images to disk
  const persistedImages = images?.length ? await persistImages(images) : undefined;

  // Enqueue for the streaming handler to pick up.
  // Don't add to chat.messages here — getFollowUpMessages does that
  // when it drains the queue, avoiding duplication on SSE reconnect.
  try {
    await messageQueue.enqueue(chatId, message, persistedImages);
  } catch (e: any) {
    return res.status(429).json({ error: e.message });
  }

  console.log(`[chat] enqueued message for chat ${chatId}`);
  res.json({ queued: true });
});

// Stop an in-progress chat stream
router.post("/stop", async (req, res) => {
  const { chatId } = req.body as { chatId: string };

  if (!chatId) {
    return res.status(400).json({ error: "chatId is required" });
  }

  const controller = activeStreams.get(chatId);

  if (controller) {
    controller.abort();
    console.log(`[chat] stop: aborted stream for chat ${chatId}`);
    res.json({ stopped: true });
  } else {
    console.log(`[chat] stop: no active stream found for chat ${chatId}`);
    res.json({ stopped: false, reason: "no_active_stream" });
  }
});

// Check whether a chat has a live in-flight stream (used by clients to decide
// whether to reconnect on mount or page refresh).
router.get("/status/:chatId", async (req, res) => {
  const { chatId } = req.params;
  const stream = liveStreams.get(chatId);
  const active = !!stream && !stream.ended && !stream.abort.signal.aborted;
  res.json({
    active,
    bufferedChunks: stream?.buffer.length ?? 0,
    subscribers: stream?.subscribers.size ?? 0,
  });
});

// Reconnect to a live in-flight chat stream. Replays the buffered SSE events
// and then streams subsequent events until the turn ends. Responds 404 if no
// live stream exists (caller should fall back to normal chat load).
router.get("/reconnect/:chatId", async (req, res) => {
  const { chatId } = req.params;
  const stream = liveStreams.get(chatId);
  if (!stream || stream.ended) {
    return res.status(404).json({ error: "no_active_stream" });
  }

  attachToLiveStreamResponse(req, res, stream, "reconnected");

  console.log(`[chat] reconnect: attached to live stream for ${chatId} (replayed ${stream.buffer.length} chunks)`);
});

// Edit message at index and regenerate response via SSE
router.post("/edit", async (req, res) => {
  const { chatId, messageIndex, message, images } = req.body as {
    chatId: string;
    messageIndex: number;
    message: string;
    images?: ImageAttachment[];
  };

  if (!chatId || messageIndex == null || !message) {
    return res.status(400).json({ error: "chatId, messageIndex, and message are required" });
  }

  const chat = await getChat(chatId);
  if (!chat) return res.status(404).json({ error: "Chat not found" });

  if (messageIndex < 0 || messageIndex >= chat.messages.length) {
    return res.status(400).json({ error: "messageIndex out of bounds" });
  }

  // Resolve the target index: if the client's index is off (e.g. due to a stale
  // empty assistant message from a prior provider error), scan backwards to find
  // the actual user message and clean up the orphaned assistant.
  let targetIndex = messageIndex;
  if (chat.messages[targetIndex].role !== "user") {
    // Scan backwards from the given index to find the nearest user message
    let scanIdx = targetIndex;
    while (scanIdx >= 0 && chat.messages[scanIdx].role !== "user") {
      scanIdx--;
    }
    if (scanIdx < 0) {
      return res.status(400).json({ error: "messageIndex must point to a user message" });
    }
    console.log(`[chat] edit: client index ${targetIndex} points to ${chat.messages[targetIndex].role}, resolved to user message at index ${scanIdx}`);
    targetIndex = scanIdx;

    // Remove any empty assistant messages after the resolved user message
    // These are orphaned from prior provider errors where the server didn't persist
    // but the client kept a local placeholder, causing index drift.
    const afterUser = chat.messages.slice(targetIndex + 1);
    const firstNonEmptyAssistant = afterUser.findIndex(m =>
      m.role === "assistant" && (m.content?.trim() || m.toolCalls?.length || m.thinking?.trim())
    );
    if (firstNonEmptyAssistant === 0) {
      // The first message after the user is a valid assistant — nothing to clean
    } else if (firstNonEmptyAssistant > 0) {
      // Remove empty assistant(s) between the user and the first valid assistant
      const messagesToRemove = firstNonEmptyAssistant;
      chat.messages.splice(targetIndex + 1, messagesToRemove);
      console.log(`[chat] edit: removed ${messagesToRemove} empty assistant message(s) after user message at ${targetIndex}`);
    } else if (afterUser.length > 0) {
      // All messages after the user are assistants but none have content — remove them all
      const messagesToRemove = afterUser.length;
      chat.messages.splice(targetIndex + 1, messagesToRemove);
      console.log(`[chat] edit: removed ${messagesToRemove} empty assistant message(s) after user message at ${targetIndex}`);
    }
  }

  await stampUserActivity(chat);
  await waitForBackgroundAutomation(chatId);

  // Get the original message to preserve images BEFORE truncating
  const originalMessage = chat.messages[targetIndex];

  // Safety guard: verify that the in-memory chat.messages count matches the
  // database row count. This protects against a corrupted in-memory state
  // (e.g. after a model error or server restart where some rows were lost)
  // from overwriting the database with a truncated history.
  //
  // Crucially, this guard must NOT block legitimate edits where the user
  // retries from a mid-conversation point (e.g. retrying after a model error
  // that left partial assistant messages in the DB). In that case,
  // chat.messages.length === dbRowCount (both reflect the full state including
  // the partial response), and the user intentionally wants to truncate from
  // targetIndex. Only when the in-memory state is genuinely out of sync
  // (fewer messages than DB rows) should we refuse the edit.
  const db = getDb();
  const dbRowCount = (db.prepare(
    "SELECT COUNT(*) as cnt FROM chat_message_rows WHERE chat_id = ?"
  ).get(chat.id) as { cnt: number })?.cnt ?? 0;

  if (chat.messages.length < dbRowCount) {
    console.error(
      `[chat] CRITICAL: in-memory state has ${chat.messages.length} messages but database has ${dbRowCount} rows — ` +
      `possible corruption. Refusing to edit from index ${targetIndex}.`
    );
    return res.status(500).json({
      error: "Chat state is corrupted — the in-memory message history doesn't match the database. Please reload the page and try again."
    });
  }

  // Truncate everything from targetIndex onwards
  chat.messages = chat.messages.slice(0, targetIndex);

  // Add edited user message — use new images if provided, otherwise preserve originals
  const editImages = images?.length ? images : (originalMessage.images?.length ? originalMessage.images : undefined);
  const userMsg: ChatMessage = {
    role: "user",
    content: message,
    images: editImages,
    timestamp: Date.now(),
  };
  chat.messages.push(userMsg);

  // Update title if editing the first message
  if (targetIndex === 0) {
    chat.title = truncateTitle(message);
  }

  await saveChat(chat, { allowTruncation: true });

  // Build context with skills (using delta-aware prompt builder for agent chats)
  let systemPrompt = chat.systemPrompt || "You are a helpful assistant.";
  let editMemoriesDelta = "";
  if (chat.type === "agent" || chat.type === "bluesky") {
    let editProjectPath: string | undefined;
    if (chat.projectId) {
      const project = await getProject(chat.projectId);
      editProjectPath = project?.path;
    }
    const split = await buildSplitAugmentedPrompt(
      systemPrompt, chat.messages, chat.id, chat.projectId, chat.type, editProjectPath
    );
    systemPrompt = split.systemPrompt;
    editMemoriesDelta = split.memoriesMessage;
  }

  // Load settings for context window resolution
  const settings = await getSettings();

  // Inject active skills into system prompt
  if (chat.activeSkills?.length) {
    const skillsCache = new Map<string, Skill>();
    const allSkills = await discoverSkills(chat.projectId);
    for (const s of allSkills) {
      skillsCache.set(s.name, s);
    }
    systemPrompt = buildSkillAugmentedPrompt(systemPrompt, chat.activeSkills, skillsCache);
  }

  // Discover model for pre-send truncation
  let model: OllamaModel | undefined;
  try {
    const allModels = await discoverAllModels();
    model = allModels.find((m) => m.id === chat.modelId);
  } catch (err: any) {
    console.error("[compaction] model discovery failed (edit):", err.message);
    model = undefined; // Skip truncation if providers are unreachable
  }

  // Pre-send context protection for edit path.
  // Initialize SSE stream BEFORE compaction so `compacting` and keepalive
  // events reach the client while the (CPU) extraction model is generating.
  ensureSSEStream(res, req, chat.id);
  if (model) {
    // Wrap compaction + post-compaction rebuild in a keepalive loop so the
    // client's 95s inactivity timeout doesn't fire during slow extraction/
    // embed/rerank steps.
    await withSSEKeepalive(res, async () => {
      try {
        const effectiveContextWindow = getEffectiveContextWindow(chat, model, settings);
        const emitKeepalive = () => res.write(`: keepalive\n\n`);
        const compaction = await truncateBeforeSend(chat, effectiveContextWindow, systemPrompt, () => res.write(`event: compacting\ndata: {}\n\n`), emitKeepalive);
        if (compaction && compaction.truncated) {
          // Extract memories from removed messages and await completion so they're
          // available for the system prompt rebuild below.
          if ((chat.type === "agent" || chat.type === "bluesky") && compaction.removedMessages?.length) {
            try {
              await preCompactionFlush(chat.modelId, chat.id, compaction.removedMessages, chat.projectId);
            } catch (err) {
              console.error("[compaction] pre-send flush failed (edit):", err);
            }
          }

          await saveChat(chat, { allowTruncation: true });
          // Rebuild system prompt after truncation with full memory reset
          resetMemoryContext(chat.id);
          if (chat.type === "agent" || chat.type === "bluesky") {
            let editProjectPath: string | undefined;
            if (chat.projectId) {
              const project = await getProject(chat.projectId);
              editProjectPath = project?.path;
            }
            const split = await buildSplitAugmentedPrompt(
              chat.systemPrompt || "You are a helpful assistant.",
              chat.messages,
              chat.id,
              chat.projectId,
              chat.type,
              editProjectPath
            );
            systemPrompt = split.systemPrompt;
            editMemoriesDelta = split.memoriesMessage;

            // Reinject skills after compaction — they were lost when
            // buildSplitAugmentedPrompt rebuilt from the base systemPrompt.
            if (chat.activeSkills?.length) {
              const skillsCache = new Map<string, Skill>();
              const allSkills = await discoverSkills(chat.projectId);
              for (const s of allSkills) skillsCache.set(s.name, s);
              systemPrompt = buildSkillAugmentedPrompt(systemPrompt, chat.activeSkills, skillsCache);
              console.log(`[skills] Reinjected ${chat.activeSkills.length} skills after edit pre-send compaction`);
            }
          }
          // Emit compaction event for UI indicator
          const estimatedTokens = await estimatePostCompactionTokens(
            chat,
            systemPrompt,
            toolsForEstimate(chat, effectiveContextWindow),
          );
          res.write(`event: compaction\ndata: ${JSON.stringify({
            removedCount: compaction.removedCount,
            remainingCount: chat.messages.length,
            phase: "pre_send",
            continues: true,
            estimatedTokens,
          })}\n\n`);
        }
      } catch (err) {
        console.error("[compaction] pre-send truncation failed (edit):", err);
      }
    });
  }

  setCachedAugmentedPrompt(chat.id, systemPrompt);

  const editMemoryDeltaContext = editMemoriesDelta
    ? `[System context — updated memories]\n${editMemoriesDelta}`
    : "";

  // Persist the memory delta as a system-role message immediately before the
  // user's edited message — see chat.ts:/api/chat for the rationale (stable
  // KV cache prefix across turns). Replay merges this hidden row into the
  // following user message, so llama.cpp never sees a mid-transcript system role.
  if (editMemoryDeltaContext) {
    const insertAt = Math.max(0, chat.messages.length - 1);
    chat.messages.splice(insertAt, 0, {
      role: "system",
      content: editMemoryDeltaContext,
      timestamp: Date.now(),
    });
    await saveChat(chat);
  }

  // Context = all messages before the current edited user prompt. If this edit
  // has a fresh memory delta, merge that delta into the current user message
  // instead of sending it as a standalone mid-transcript system message.
  const currentEditUserIndex = chat.messages.length - 1;
  const editPersistedHistoryEnd =
    editMemoryDeltaContext &&
    currentEditUserIndex > 0 &&
    chat.messages[currentEditUserIndex - 1]?.role === "system" &&
    chat.messages[currentEditUserIndex - 1]?.content === editMemoryDeltaContext
      ? currentEditUserIndex - 1
      : currentEditUserIndex;
  const editPersistedHistory = chat.messages.slice(0, editPersistedHistoryEnd);
  const contextMessages = chatMessagesToPiMessages(editPersistedHistory, chat.modelId);

  // Safety check: warn if context is empty for non-first messages
  if (contextMessages.length === 0 && chat.messages.length > 1) {
    console.error(`[chat] CRITICAL: context conversion produced empty array for edit with ${chat.messages.length} messages`);
  }

  // /edit truncates history before the edit point, so a divergence here is
  // expected and tells us how far back the rewrite reaches.
  logKvCacheState({
    chatId: chat.id,
    source: "edit",
    systemPromptChars: systemPrompt.length,
    deltaChars: editMemoriesDelta.length,
    newMsgChars: message.length,
    persistedRows: editPersistedHistory.length,
    contextPiMessages: contextMessages,
    shape: summarizeReplayShape(editPersistedHistory),
  });

  // Safety check: detect catastrophic context loss from compaction
  if (chat.messages.length <= 3 && chat.messages.length > 1) {
    console.warn(`[chat] WARNING: edit chat has only ${chat.messages.length} messages after compaction - possible catastrophic context loss`);
  }

  const userPiMessage = buildUserPiMessage(message, editImages, editMemoryDeltaContext);

  await handleChatStream(chat, message, contextMessages, systemPrompt, userPiMessage, req, res);
});

export default router;
