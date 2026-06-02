import { Router } from "express";
import type { Request, Response } from "express";
import { randomUUID, createHash } from "crypto";
import { readFile } from "fs/promises";
import { join } from "path";
import type { Message, ToolCall, ToolResultMessage, AssistantMessage, Model } from "@mariozechner/pi-ai";
import type { AgentContext } from "@mariozechner/pi-agent-core";
import { getChat, saveChat, getDb, getSettings, saveSettings, loadPendingState, savePendingState, clearPendingState, getProject } from "../services/chat-storage.js";
import { chatMessagesToHydratedPiMessages, mergeSystemContextWithUserContent, type ReplayModelIdentity } from "../services/agent.js";
import { createPiModelFromProvider, discoverAllModels, getEffectiveContextWindow } from "../services/models.js";
import type { InferenceModel } from "../types.js";
import { extractMemories, preCompactionFlush, markChatActive, markChatInactive } from "../services/memory-extraction.js";
import { generateTitle, generateRecap, RECAP_THRESHOLD } from "../services/title-generation.js";
import {
  COMPACTION_TRIGGER_RATIO,
  estimateContextTokens,
  estimateContextTokensWithExactToolResults,
  truncateChatHistory,
  truncateBeforeSend,
  triggerCompaction,
  hasStrandedToolCall,
} from "../services/compaction.js";
import { buildMemoryAugmentedPrompt, buildSplitAugmentedPrompt, setCachedAugmentedPrompt, invalidateMemoriesCache, resetMemoryContext } from "../services/memory-context.js";
import { getAgentTools } from "../services/agent-tools.js";
import { getSynthesisLock } from "../services/system-chat.js";
import { getAutomationLock } from "../services/automation-lock.js";
import type { ToolSideEffects } from "../services/agent-tools.js";
import { parseSkillInvocations, buildSkillAugmentedPrompt, discoverSkills } from "../services/skills.js";
import type { Skill } from "../services/skills.js";
import * as messageQueue from "../services/message-queue.js";
import type { QueuedUserMessage } from "../services/message-queue.js";
import type { Artifact, Chat, ChatMessage, ChatToolCall, ChatToolResult, ImageAttachment, InlineVisual, Project } from "../types.js";
import { hydrateUserImageAttachments, saveUserImage, stripImageAttachmentData } from "../services/user-image-storage.js";
import { saveToolResultImage, stripToolResultImageData } from "../services/tool-result-image-storage.js";
import { streamTTS, isStreamingCapable, TTS_FLUSH_SIGNAL, type StreamingTTSTextInput } from "../services/tts-streaming.js";
import type { TTSSettings } from "../types/tts.js";
import { getCurrentTTSSettings } from "./tts.js";
import { log } from "../services/logger.js";
import { createSafeStreamFn } from "../services/llm-stream.js";
import { createAgentLoopConfig, runAgentLoop, stopAgentLoop } from "../services/agent-loop-runner.js";
import { PassiveMemoryRecallController } from "../services/passive-memory-recall.js";
import { acquireLlamaSlotLease, releaseLlamaSlotLease, type LlamaSlotLease } from "../services/llama-slot-leases.js";
import type { ModelProgressEvent } from "../services/model-progress.js";
import {
  markLlamaCachePrefillComplete,
  markLlamaCacheResidencyFinished,
  markLlamaCacheResidencyStarted,
  recordLlamaCacheResidencyRun,
  type LlamaCacheBindingMode,
} from "../services/llama-cache-residency.js";

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
import { appDataPath } from "../services/paths.js";
import { getDefaultLlamaServerUrl } from "../services/llama-ports.js";
import { recordContextEstimateObservation } from "../services/token-estimate-observability.js";

const DEFAULT_LLAMACPP_URL = getDefaultLlamaServerUrl("inference");
const ARTIFACTS_DIR = appDataPath("artifacts");
const VISUALS_DIR = appDataPath("visuals");
const ARTIFACT_ERROR_REPAIR_TTL_MS = 30 * 60 * 1000;
const artifactErrorRepairAttempts = new Map<string, number>();
const artifactAutoRepairAttempts = new Map<string, number>();

function isMemoryAugmentedChatType(type: Chat["type"] | undefined): boolean {
  return type === "agent" || type === "system";
}

function isChatDeleted(chatId: string): boolean {
  const row = getDb().prepare("SELECT 1 FROM chats WHERE id = ?").get(chatId);
  return !row;
}

function writeDeletedChatEvent(res: Response): void {
  if (!res.headersSent) {
    res.status(404).json({ error: "Chat deleted" });
    return;
  }
  try {
    res.write(`event: error\ndata: ${JSON.stringify({ error: "Chat deleted" })}\n\n`);
  } catch {}
}

interface ArtifactRuntimeErrorReport {
  chatId: string;
  artifactId: string;
  version: number;
  objectKind?: "artifact" | "visual";
  title?: string;
  url?: string;
  diagnosticKind?: "js-error" | "promise-rejection" | "webgpu-shader" | "webgpu-validation";
  message: string;
  stack?: string;
  filename?: string;
  lineno?: number;
  colno?: number;
  sourceExcerpt?: string;
  shaderLabel?: string;
  shaderSource?: string;
  shaderLine?: number;
  shaderColumn?: number;
  shaderExcerpt?: string;
  pipelineLabel?: string;
  entryPoint?: string;
  compilationMessages?: Array<{
    type?: string;
    message?: string;
    lineNum?: number;
    linePos?: number;
    offset?: number;
    length?: number;
  }>;
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

function visualSourcePath(visualId: string, version: number): string {
  return join(VISUALS_DIR, visualId, "versions", String(version), "index.html");
}

function reportSourcePath(report: ArtifactRuntimeErrorReport): string {
  return report.objectKind === "visual"
    ? visualSourcePath(report.artifactId, report.version)
    : artifactSourcePath(report.artifactId, report.version);
}

async function getVersionedObjectCurrentVersion(
  id: string,
  preferredKind?: "artifact" | "visual"
): Promise<{ currentVersion: number; objectKind: "artifact" | "visual" } | null> {
  const candidates = preferredKind === "visual"
    ? [{ dir: VISUALS_DIR, objectKind: "visual" as const }, { dir: ARTIFACTS_DIR, objectKind: "artifact" as const }]
    : [{ dir: ARTIFACTS_DIR, objectKind: "artifact" as const }, { dir: VISUALS_DIR, objectKind: "visual" as const }];

  for (const candidate of candidates) {
    try {
      const metadataPath = join(candidate.dir, id, "metadata.json");
      const metadata = JSON.parse(await readFile(metadataPath, "utf-8"));
      if (typeof metadata.currentVersion === "number") {
        return { currentVersion: metadata.currentVersion, objectKind: candidate.objectKind };
      }
    } catch {
      // Try the other store.
    }
  }
  return null;
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

function messageReferencesVisual(message: ChatMessage, visualId: string, version: number): boolean {
  const visuals = [
    ...(message.visuals || []),
    ...(message.segments?.flatMap((segment) => segment.visual ? [segment.visual] : []) || []),
  ];
  return visuals.some((visual) =>
    visual.id === visualId &&
    (visual.version == null || visual.version === version)
  );
}

function chatReferencesVersionedObject(
  chat: Chat,
  id: string,
  version: number,
  objectKind: "artifact" | "visual"
): boolean {
  return chat.messages.some((message) =>
    objectKind === "visual"
      ? messageReferencesVisual(message, id, version)
      : messageReferencesArtifact(message, id, version)
  );
}

function makeArtifactRepairDedupKey(report: ArtifactRuntimeErrorReport): string {
  const hash = createHash("sha256")
    .update([
      report.chatId,
      report.artifactId,
      String(report.version),
      report.diagnosticKind || "",
      report.message || "",
      report.stack || "",
      String(report.lineno ?? ""),
      String(report.colno ?? ""),
      report.shaderLabel || "",
      String(report.shaderLine ?? ""),
      String(report.shaderColumn ?? ""),
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

function hasRecentArtifactAutoRepair(report: ArtifactRuntimeErrorReport, dedupKey: string): boolean {
  const now = Date.now();
  for (const [attemptKey, createdAt] of artifactAutoRepairAttempts) {
    if (now - createdAt > ARTIFACT_ERROR_REPAIR_TTL_MS) {
      artifactAutoRepairAttempts.delete(attemptKey);
    }
  }
  const scopedPrefix = `${report.chatId}:${report.artifactId}:`;
  const recentForArtifact = Array.from(artifactAutoRepairAttempts.keys())
    .filter((key) => key.startsWith(scopedPrefix)).length;
  const key = `${report.chatId}:${report.artifactId}:${report.version}:${dedupKey.split(":").pop()}`;
  const existing = artifactAutoRepairAttempts.get(key);
  if (existing && now - existing < ARTIFACT_ERROR_REPAIR_TTL_MS) return true;
  if (recentForArtifact >= 3) return true;
  artifactAutoRepairAttempts.set(key, now);
  return false;
}

function buildArtifactRepairPrompt(report: ArtifactRuntimeErrorReport): string {
  const location = [
    typeof report.lineno === "number" ? `line ${report.lineno}` : "",
    typeof report.colno === "number" ? `column ${report.colno}` : "",
  ].filter(Boolean).join(", ");
  const shaderLocation = [
    typeof report.shaderLine === "number" ? `line ${report.shaderLine}` : "",
    typeof report.shaderColumn === "number" ? `column ${report.shaderColumn}` : "",
  ].filter(Boolean).join(", ");
  const diagnosticLabel =
    report.diagnosticKind === "webgpu-shader" ? "WebGPU shader compilation error" :
    report.diagnosticKind === "webgpu-validation" ? "WebGPU validation error" :
    report.diagnosticKind === "promise-rejection" ? "Promise rejection" :
    "JavaScript runtime error";
  const compilationMessages = report.compilationMessages?.length
    ? report.compilationMessages
      .slice(0, 12)
      .map((message) => {
        const msgLocation = [
          typeof message.lineNum === "number" ? `line ${message.lineNum}` : "",
          typeof message.linePos === "number" ? `column ${message.linePos}` : "",
        ].filter(Boolean).join(", ");
        return `- ${message.type || "message"}${msgLocation ? ` (${msgLocation})` : ""}: ${clampText(message.message, 500)}`;
      })
      .join("\n")
    : "";
  const objectLabel = report.objectKind === "visual" ? "visual" : "artifact";
  const sourcePath = reportSourcePath(report);
  const parts = [
    "[System context - artifact runtime error]",
    `The browser rendered ${objectLabel} ${report.artifactId} version ${report.version} and reported a ${diagnosticLabel}.`,
    report.title ? `Artifact title: ${report.title}` : "",
    report.url ? `Artifact URL: ${report.url}` : "",
    `Stored source path: ${sourcePath}`,
    "",
    "Runtime error:",
    `Message: ${clampText(report.message, 1000) || "Unknown runtime error"}`,
    location ? `Location: ${location}` : "",
    report.filename ? `Filename: ${clampText(report.filename, 500)}` : "",
    report.pipelineLabel ? `WebGPU pipeline label: ${clampText(report.pipelineLabel, 200)}` : "",
    report.shaderLabel ? `WebGPU shader label: ${clampText(report.shaderLabel, 200)}` : "",
    report.entryPoint ? `WebGPU entry point: ${clampText(report.entryPoint, 200)}` : "",
    shaderLocation ? `WebGPU shader location: ${shaderLocation}` : "",
    compilationMessages ? `WebGPU compilation messages:\n${compilationMessages}` : "",
    report.stack ? `Stack:\n${clampText(report.stack, 3000)}` : "",
    report.shaderExcerpt ? `Relevant WGSL source excerpt:\n${clampText(report.shaderExcerpt, 4000)}` : "",
    report.shaderSource ? `Full WGSL shader source:\n${clampText(report.shaderSource, 12000)}` : "",
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
    const source = await readFile(reportSourcePath(report), "utf-8");
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

function attachToLiveStreamResponse(req: Request, res: Response, stream: LiveStream, label: string, replay = true) {
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

  if (replay) {
    for (const chunk of stream.buffer) {
      try { res.write(chunk); } catch { return; }
    }
  }

  const subWrite = res.write.bind(res) as (chunk: string) => boolean;
  const sub: LiveStreamSubscriber = { write: subWrite, res, isPrimary: false };
  stream.subscribers.add(sub);

  res.on("close", () => {
    detachSubscriber(stream, sub);
  });
}

function createAsyncTextQueue(): AsyncIterable<StreamingTTSTextInput> & { push: (value: StreamingTTSTextInput) => void; flush: () => void; close: () => void; fail: (err: unknown) => void } {
  const values: StreamingTTSTextInput[] = [];
  const waiters: Array<(result: IteratorResult<StreamingTTSTextInput>) => void> = [];
  let closed = false;
  let error: unknown = null;

  const next = (): Promise<IteratorResult<StreamingTTSTextInput>> => {
    if (values.length > 0) {
      return Promise.resolve({ value: values.shift()!, done: false });
    }
    if (error) {
      return Promise.reject(error);
    }
    if (closed) {
      return Promise.resolve({ value: undefined, done: true });
    }
    return new Promise((resolve) => waiters.push(resolve));
  };

  const close = () => {
    if (closed) return;
    closed = true;
    while (waiters.length > 0) {
      waiters.shift()!({ value: undefined, done: true });
    }
  };

  const push = (value: StreamingTTSTextInput) => {
    if (closed || error) return;
    const waiter = waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
    } else {
      values.push(value);
    }
  };

  return {
    push,
    flush() {
      push(TTS_FLUSH_SIGNAL);
    },
    close,
    fail(err: unknown) {
      error = err;
      close();
    },
    [Symbol.asyncIterator]() {
      return { next };
    },
  };
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

function replayIdentityForModel(modelId: string, model?: InferenceModel | null): ReplayModelIdentity {
  // All models now go through llama.cpp (openai-compat). Legacy ollama models
  // are mapped to openai-compat for backward compatibility.
  if (model?.provider === "llamacpp") {
    return { api: "openai-compat", provider: "llamacpp", model: modelId };
  }
  // Fallback: treat unknown/legacy models as openai-compat
  return { api: "openai-compat", provider: "llamacpp", model: modelId };
}

function replayIdentityFromPiModel(model: Model<string>): ReplayModelIdentity {
  return {
    api: String(model.api),
    provider: String(model.provider),
    model: model.id,
  };
}

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
    // Warn on divergence — this usually means the KV cache prefix won't match,
    // causing full re-evaluation of tokens after the divergence point. Common causes:
    // - Tool result truncation on replay (MAX_TOOL_RESULT_CHARS in agent.ts)
    // - Thinking promotion changing assistant response structure
    // - Memory insertions or edits between turns
    // - Image hydration differences between turns
    const toolResultChars = opts.contextPiMessages
      .filter((m): m is ToolResultMessage => m.role === 'toolResult')
      .reduce((sum, m) => sum + m.content.reduce((s: number, c: any) => s + (c.type === 'text' ? c.text?.length ?? 0 : 0), 0), 0);
    if (toolResultChars > 30_000) {
      console.warn(`[kv-cache] Divergence with large tool results (${(toolResultChars / 1024).toFixed(0)}KB). ` +
        `If KV cache hit rate drops, check for tool result truncation in agent.ts chatMessagesToPiMessages.`);
    }
  }
  log(
    `[kv-cache] chat=${opts.chatId} src=${opts.source} ` +
    `system_prompt=${opts.systemPromptChars}ch delta=${opts.deltaChars}ch new_msg=${opts.newMsgChars}ch ` +
    `type=${opts.deltaChars > 0 ? "delta" : "stable"} ` +
    `persisted=${opts.persistedRows} pi_msgs=${opts.contextPiMessages.length} ` +
    `last_loop=${opts.shape.lastLoop} frags=${opts.shape.fragments} prefix=${prefixState}`
  );
}

async function snapshotSentPrefix(
  chatId: string,
  chatMessages: ChatMessage[],
  modelId: string,
  fallbackIdentity?: ReplayModelIdentity,
): Promise<void> {
  const piMessages = await chatMessagesToHydratedPiMessages(chatMessages, modelId, fallbackIdentity);
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
  systemContext?: string | string[]
): Message {
  const contentWithSystemContext = mergeSystemContextWithUserContent(systemContext, message);
  if (images?.length) {
    const content: any[] = [];
    if (contentWithSystemContext) content.push({ type: "text", text: contentWithSystemContext });
    for (const img of images) {
      if (!img.data) continue;
      content.push({ type: "image", data: img.data, mimeType: img.mimeType });
    }
    return { role: "user", content, timestamp: Date.now() };
  }
  return { role: "user", content: contentWithSystemContext, timestamp: Date.now() };
}

function isPendingNextUserContextMessage(message: ChatMessage | undefined): message is ChatMessage {
  return (
    !!message &&
    message.role === "system" &&
    (message._mergeIntoNextUserMessage === true || message._isPassiveMemoryRecall === true) &&
    typeof message.content === "string" &&
    message.content.trim().length > 0
  );
}

function splitNextUserContext(opts: {
  messages: ChatMessage[];
  currentUserIndex: number;
  memoryDeltaContext: string;
}): { persistedHistoryEnd: number; systemContexts: string[] } {
  let persistedHistoryEnd = opts.currentUserIndex;
  const systemContexts: string[] = [];

  const takeContextRow = (row: ChatMessage) => {
    systemContexts.unshift(row.content);
    persistedHistoryEnd--;
  };

  const rowBeforeUser = opts.messages[persistedHistoryEnd - 1];
  if (
    opts.memoryDeltaContext &&
    rowBeforeUser?.role === "system" &&
    rowBeforeUser.content === opts.memoryDeltaContext
  ) {
    takeContextRow(rowBeforeUser);
  }

  while (persistedHistoryEnd > 0 && isPendingNextUserContextMessage(opts.messages[persistedHistoryEnd - 1])) {
    takeContextRow(opts.messages[persistedHistoryEnd - 1]);
  }

  return { persistedHistoryEnd, systemContexts };
}

/** Persist images to disk and enrich attachments with id/url/thumbUrl (fire-and-forget safe) */
async function persistImages(images: ImageAttachment[]): Promise<ImageAttachment[]> {
  return Promise.all(
    images.map(async (img) => {
      if (img.id && img.url && img.thumbUrl) return stripImageAttachmentData(img); // already persisted
      try {
        if (!img.data) return img;
        const buffer = Buffer.from(img.data, "base64");
        const id = randomUUID();
        const record = await saveUserImage(id, buffer, img.mimeType, img.name);
        return {
          mimeType: img.mimeType,
          name: img.name,
          id: record.id,
          url: record.url,
          thumbUrl: record.thumbUrl,
        };
      } catch (e) {
        console.error("[user-images] Failed to persist image:", e);
        return img; // keep original base64-only attachment on failure
      }
    })
  );
}

async function persistToolResultImages(images: ImageAttachment[]): Promise<ImageAttachment[]> {
  return Promise.all(
    images.map(async (img) => {
      if (img.id && img.url) return stripToolResultImageData(img);
      try {
        if (!img.data) return img;
        const record = await saveToolResultImage(
          randomUUID(),
          Buffer.from(img.data, "base64"),
          img.mimeType,
          img.name,
        );
        return {
          mimeType: img.mimeType,
          name: img.name,
          id: record.id,
          url: record.url,
        };
      } catch (e) {
        console.error("[tool-result-images] Failed to persist image:", e);
        return img;
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
    settings.sleepModeTriggeredAt = undefined;
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
  if (isChatDeleted(chat.id)) {
    writeDeletedChatEvent(res);
    return;
  }

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
    type: "text" | "tool_call" | "tool_result" | "artifact" | "visual" | "compaction_marker";
    content?: string;
    toolCall?: ChatToolCall;
    toolResult?: ChatToolResult;
    artifact?: Artifact;
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
    llamaRuns: [] as Array<{ timings: any; cache?: any }>,
    toolLoopId: randomUUID(),
    committedTextLength: 0,
    committedThinkingLength: 0,
    committedToolCallCount: 0,
    committedToolResultCount: 0,
    committedArtifactCount: 0,
    committedVisualCount: 0,
    committedSegmentCount: 0,
    committedThinkingDurationMs: 0,
    hasCommittedToolLoopRows: false,
    pendingFinalAssistantMessage: null as ChatMessage | null,
    pendingPassiveRecallRows: [] as ChatMessage[],
    // Dedup guard: count of consecutive iterations whose tool calls were
    // byte-identical to the prior iteration. Breaks loops where the model
    // re-emits the same tool call instead of moving on.
    duplicateToolCallStreak: 0,
    lastIterationToolCallSignature: null as string | null,
    pendingTokenEstimateObservation: null as null | {
      sourceIteration: number;
      sourceStopReason: string;
      estimatedInputTokens: number;
      displayEstimatedInputTokens: number;
      approximateTokens: number;
      approximateDisplayTokens?: number;
      exactToolResultCount: number;
      exactDelta: number;
      signedExactDelta: number;
      selectedEstimatePath?: "usage_anchor" | "char_estimate";
      displayEstimatePath?: "usage_anchor" | "char_estimate";
      pathAEstimateTokens?: number;
      pathBEstimateTokens?: number;
      lastUsageInputTokens?: number;
      lastUsageOutputTokens?: number;
      lastUsageTotalTokens?: number;
      postUsageAdditionalTokens?: number;
      contextWindow: number;
      toolCallCount: number;
      toolResultCount: number;
    },
  };
  const ttsTextQueue = createAsyncTextQueue();
  let audioStreamTask: Promise<void> | null = null;

  function resetAccumulators() {
    state.fullText = "";
    state.thinkingText = "";
    state.allToolCalls = [];
    state.allToolResults = [];
    state.allArtifacts = [];
    state.allVisuals = [];
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
    state.llamaRuns = [];
    state.toolLoopId = randomUUID();
    state.committedTextLength = 0;
    state.committedThinkingLength = 0;
    state.committedToolCallCount = 0;
    state.committedToolResultCount = 0;
    state.committedArtifactCount = 0;
    state.committedVisualCount = 0;
    state.committedSegmentCount = 0;
    state.committedThinkingDurationMs = 0;
    state.hasCommittedToolLoopRows = false;
    state.pendingFinalAssistantMessage = null;
    state.pendingPassiveRecallRows = [];
    state.duplicateToolCallStreak = 0;
    state.lastIterationToolCallSignature = null;
    state.pendingTokenEstimateObservation = null;
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
      segments: cleanSegments.length > 0 ? cleanSegments : undefined,
      timestamp: Date.now(),
      _thinkingPromoted: state.thinkingPromoted || undefined,
      ...assistantProviderFields(),
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
      segments: segments.length > 0 ? segments : undefined,
      timestamp: Date.now(),
      _thinkingPromoted: state.thinkingPromoted || undefined,
      ...assistantProviderFields(),
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
      segments: segments.length > 0 ? segments : undefined,
      timestamp: msg.timestamp || Date.now(),
      _thinkingPromoted: state.thinkingPromoted || undefined,
      ...assistantProviderFields(msg),
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

  function clearPendingAssistantUsageAfterCompaction() {
    state.finalUsage = undefined;
    if (state.pendingFinalAssistantMessage) {
      state.pendingFinalAssistantMessage = {
        ...state.pendingFinalAssistantMessage,
        usage: undefined,
      };
    }
    for (let i = chat.messages.length - 1; i >= 0; i--) {
      const candidate = chat.messages[i];
      if (candidate.role === "assistant" && candidate._inProgress) {
        chat.messages[i] = { ...candidate, usage: undefined };
        break;
      }
    }
  }

  function markUncommittedAssistantMessageCommitted(message: ChatMessage) {
    state.committedTextLength = state.fullText.length;
    state.committedThinkingLength = state.thinkingText.length;
    state.committedToolCallCount = state.allToolCalls.length;
    state.committedToolResultCount = state.allToolResults.length;
    state.committedArtifactCount = state.allArtifacts.length;
    state.committedVisualCount = state.allVisuals.length;
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

  function flushPendingPassiveRecallRows(): void {
    if (state.pendingPassiveRecallRows.length === 0) return;
    chat.messages.push(...state.pendingPassiveRecallRows);
    state.pendingPassiveRecallRows = [];
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
    if (ttsEnabled) {
      ttsTextQueue.push(delta);
    }
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

    onAskUser: (question, toolCallId) => {
      askUserRef.current = { question, toolCallId };
      turnAbortController.abort(); // Only abort the current turn, not the SSE connection
    },
  };

  const isAgent = chat.type === "agent" || chat.type === "system";

  const settings = await getSettings();
  const ttsSettings: TTSSettings = await getCurrentTTSSettings();
  const ttsEnabled = ttsSettings.enabled && ttsSettings.autoReadEnabled && isStreamingCapable(ttsSettings.backend);

  // TTS pause controller - aborts TTS stream on tool execution
  let ttsPauseController: AbortController | null = null;

  let iterations = 0;
  let waitingForInput = false;
  let hitContextLimit = false;
  let llamaSlotLease: LlamaSlotLease | null = null;
  let llamaCacheContext: {
    baseUrl: string;
    modelId: string;
    contextWindow?: number;
    bindingMode: LlamaCacheBindingMode;
    slotId?: number;
  } | null = null;
  // Defer memory extractions until the agent loop finishes to avoid concurrent
  // LLM calls that can interfere with the active tool loop (e.g., model unload/reload)
  const deferredExtractions: Array<{ userMsg: string; assistantMsg: string }> = [];
  let lastUserMessage = userMessage; // tracks the current user message text for title gen / memory
  /** Pending title generation — awaited before closing the live stream so the
   *  title_update SSE event is never dropped by a race with endLiveStream. */
  let titleGenerationPromise: Promise<void> | null = null;
  let currentTurnIsHidden = options.hiddenUserMessage === true;
  let activeAssistantIdentity: ReplayModelIdentity | undefined;

  function assistantProviderFields(msg?: AssistantMessage): Pick<ChatMessage, "_api" | "_provider" | "_model"> {
    const identity = msg
      ? {
          api: String((msg as any).api),
          provider: String((msg as any).provider),
          model: String((msg as any).model),
        }
      : activeAssistantIdentity;
    return identity
      ? { _api: identity.api, _provider: identity.provider, _model: identity.model }
      : {};
  }

  function captureLlamaRun(msg: AssistantMessage, iterationLabel: number, phase: string): void {
    const timings = (msg as any).llamaTimings;
    if (!timings) return;
    const cache = (msg as any).llamaCache;
    state.lastLlamaTimings = timings;
    state.lastLlamaCache = cache;
    state.llamaRuns.push({ timings, cache });

    const reported = cache?.reportedPromptTokens;
    const hitRatio = typeof cache?.inferredCacheHitRatio === "number"
      ? `${(cache.inferredCacheHitRatio * 100).toFixed(1)}%`
      : "n/a";
    const digest = cache?.requestDigest ?? "-";
    const slot = typeof cache?.slotId === "number" ? String(cache.slotId) : "auto";
    console.log(
      `[llama-cache] chat=${chat.id} iter=${iterationLabel} phase=${phase} ` +
      `slot=${slot} ` +
      `prompt_eval=${timings.prompt_n}/${reported ?? "?"} ` +
      `prompt_ms=${timings.prompt_ms?.toFixed?.(0) ?? timings.prompt_ms} ` +
      `hit=${hitRatio} digest=${digest} ` +
      `messages=${cache?.requestMessageCount ?? "?"} chars=${cache?.requestCharCount ?? "?"}`,
    );

    if (llamaCacheContext) {
      recordLlamaCacheResidencyRun({
        chatId: chat.id,
        ...llamaCacheContext,
        timings,
        cache,
        phase,
        iteration: iterationLabel,
      });
    }
  }

  console.log(`[chat] type=${chat.type} isAgent=${isAgent} tts=${ttsEnabled}`);

  try {
    // Discover model with timeout protection
    let allModels: InferenceModel[];
    let inferenceModel: InferenceModel | undefined;
    let piModel: Model<string>;

    try {
      allModels = await discoverAllModels();
      inferenceModel = allModels.find(m => m.id === chat.modelId);
      if (!inferenceModel) throw new Error(`Model not found: ${chat.modelId}`);
      piModel = await createPiModelFromProvider(inferenceModel);
      // Override contextWindow with effective value so the context window size sent to llama.cpp
      // respects per-chat and per-model settings. Without this, llama.cpp receives
      // the full detected context window (e.g. 128k) and may overflow VRAM.
      piModel.contextWindow = getEffectiveContextWindow(chat, inferenceModel);
      activeAssistantIdentity = replayIdentityFromPiModel(piModel);
      if (inferenceModel.provider === "llamacpp" && piModel.baseUrl) {
        llamaSlotLease = await acquireLlamaSlotLease({
          baseUrl: piModel.baseUrl,
          chatId: chat.id,
          modelId: piModel.id,
          contextWindow: piModel.contextWindow,
        });
        llamaCacheContext = {
          baseUrl: piModel.baseUrl,
          modelId: piModel.id,
          contextWindow: piModel.contextWindow,
          bindingMode: llamaSlotLease ? "enforced" : "auto",
          slotId: llamaSlotLease?.slotId,
        };
        markLlamaCacheResidencyStarted({
          chatId: chat.id,
          ...llamaCacheContext,
        });
      }
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
    const passiveRecall =
      isMemoryAugmentedChatType(chat.type)
        ? new PassiveMemoryRecallController(chat.id, {
            // Post-turn injection: when the agent stops without tool use,
            // the search runs in the background and injects after the turn ends.
            // The injection row is pushed to chat.messages and persisted so
            // the next user turn sees it.
            onReady: async (content: string, memoryIds: string[]) => {
              const row: ChatMessage = {
                role: "system",
                content,
                timestamp: Date.now(),
                _isSystemMessage: true,
                _isPassiveMemoryRecall: true,
                _recalledMemoryIds: memoryIds,
                _mergeIntoNextUserMessage: true,
              };
              chat.messages.push(row);
              await saveChat(chat);
            },
          })
        : null;

    const persistActivePendingState = async (agentMessages: any[] = context.messages as any[]) => {
      await savePendingState(chat.id, {
        agentMessages,
        systemPrompt,
        askToolCallId: askUserRef.current?.toolCallId || "",
        fullText: state.fullText,
        thinkingText: state.thinkingText,
        toolCalls: state.allToolCalls,
        toolResults: state.allToolResults,
        iterations,
        lastUserMessage,
      });
    };

    // Track phase transitions so we can mark prefill complete immediately
    // rather than waiting for the full LLM call to finish. This prevents the
    // sidebar cache indicator from lingering during generation.
    let prevProgressPhase: string | undefined;
    const emitModelProgress = (progress: ModelProgressEvent) => {
      if (connectionClosed) return;
      if (prevProgressPhase === "prefill" && progress.phase === "generating" && llamaCacheContext) {
        markLlamaCachePrefillComplete(chat.id);
      }
      prevProgressPhase = progress.phase;
      res.write(`event: model_progress\ndata: ${JSON.stringify({
        chatId: chat.id,
        ...progress,
      })}\n\n`);
    };

    // Gate the prefill indicator:
    //   - First turns, first iteration: always show (expected slow)
    //   - Non-first turns, first iteration: auto-show only if the slot probe sees a cold prefill
    //   - Tool iterations (iteration > 1): always hide
    const isFirstTurn = chat.messages.length === 1;

    // Pass llamacpp slot lease and hooks to the stream function
    const safeStreamFn = createSafeStreamFn(llamaSlotLease, {
      promptDebugChatId: chat.id,
      onModelProgress: emitModelProgress,
      modelProgressShowIndicator: (iteration) => {
        if (iteration > 1) return false;
        if (isFirstTurn) return true;
        return undefined;
      },
    });

    // Build config
    const config = createAgentLoopConfig({
      model: piModel,
      transformContext: passiveRecall
        ? async (messages) => {
            const injection = passiveRecall.peekReady(iterations);
            if (!injection) return messages;

            const timestamp = Date.now();
            const row: ChatMessage = {
              role: "system",
              content: injection.content,
              timestamp,
              _isSystemMessage: true,
              _isPassiveMemoryRecall: true,
              _recalledMemoryIds: injection.memoryIds,
            };
            const agentMessage = passiveRecall.toReplayUserMessage({
              ...injection,
              createdAt: timestamp,
            });
            if (!agentMessage) return messages;

            try {
              const deferPersistence = hasUncommittedAssistantActivity();
              if (deferPersistence) {
                // The live pi-agent context already contains the just-finished
                // tool fragment, but chat.messages may not have persisted it
                // yet. Defer the hidden row until turn_end commits that
                // fragment so replay preserves the live KV-cache prompt order.
                state.pendingPassiveRecallRows.push(row);
              } else {
                chat.messages.push(row);
                await saveChat(chat);
              }
              messages.push(agentMessage);
              if (messages !== context.messages) {
                context.messages.push(agentMessage);
              }
              passiveRecall.markApplied(injection, iterations);
              try {
                await persistActivePendingState(messages as any[]);
              } catch (pendingErr) {
                console.warn("[passive-memory] failed to update pending state after recall injection:", pendingErr);
              }
              console.log(
                `[passive-memory] injected ${injection.memoryIds.length} recalled memor${
                  injection.memoryIds.length === 1 ? "y" : "ies"
                } before provider call at iteration ${iterations} (${deferPersistence ? "deferred persistence" : "persisted"})`,
              );
            } catch (err) {
              const idx = chat.messages.indexOf(row);
              if (idx >= 0) chat.messages.splice(idx, 1);
              state.pendingPassiveRecallRows = state.pendingPassiveRecallRows.filter((pending) => pending !== row);
              console.warn("[passive-memory] failed to persist recalled memories:", err);
            }
            return messages;
          }
        : undefined,
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
        if (assistantMsg && !currentTurnIsHidden && isMemoryAugmentedChatType(chat.type)) {
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
        if (assistantMsg && !currentTurnIsHidden && isMemoryAugmentedChatType(chat.type)) {
          deferredExtractions.push({ userMsg: lastUserMessage, assistantMsg: assistantMsg.content });
        }

        // Title generation for first exchange
        if (assistantMsg && !currentTurnIsHidden && shouldGenerateInitialTitle(chat)) {
          titleGenerationPromise = generateTitle(lastUserMessage, assistantMsg.content)
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

    if (ttsEnabled) {
      console.log("[TTS] Starting live audio stream");
      audioStreamTask = (async () => {
        try {
          const audioStream = streamTTS(ttsTextQueue, {
            ...ttsSettings,
            chunkSize: ttsSettings.streamingChunkSize ?? 50,
            boundaryTier: ttsSettings.streamingBoundaryTier ?? 'clause',
          });

          for await (const wavChunk of audioStream) {
            if (connectionClosed || res.writableEnded) break;

            res.write(`event: audio_chunk\ndata: ${JSON.stringify({
              chunkId: crypto.randomUUID(),
              data: wavChunk.toString('base64'),
              mimeType: 'audio/wav',
              sampleRate: ttsSettings.backend === "supertonic-3" ? 44100 : 24000,
            })}\n\n`);
          }

          if (!connectionClosed && !res.writableEnded) {
            res.write(`event: audio_done\ndata: {}\n\n`);
          }
          console.log("[TTS] Audio stream completed");
        } catch (err) {
          console.error("[TTS] Streaming error:", err);
          if (!connectionClosed && !res.writableEnded) {
            res.write(`event: audio_error\ndata: ${JSON.stringify({ error: err instanceof Error ? err.message : String(err) })}\n\n`);
          }
        }
      })();
    }

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
          if (ttsEnabled) {
            ttsTextQueue.flush();
          }
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

            const extractedImages: ImageAttachment[] | undefined = event.result?.content
                ?.filter((c: any) => c.type === "image")
                .map((c: any) => ({ data: c.data, mimeType: c.mimeType, name: `generated-${event.toolCallId}.jxl` }));
            const images = extractedImages?.length ? await persistToolResultImages(extractedImages) : undefined;

            if (images?.length) {
              console.log(`[chat] Extracted ${images.length} image(s) from tool result ${event.toolCallId} (${event.toolName})`);
              console.log(`[chat] Image sizes: ${images.map(img => `${((img.data?.length ?? 0) / 1024).toFixed(1)}KB`).join(", ")}`);
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
          captureLlamaRun(msg, iterations + 1, "main");

          const pendingTokenEstimateObservation = state.pendingTokenEstimateObservation;
          state.pendingTokenEstimateObservation = null;
          if (pendingTokenEstimateObservation && msg.usage?.input && msg.usage.input > 0) {
            recordContextEstimateObservation({
              chatId: chat.id,
              modelId: piModel.id,
              sourceIteration: pendingTokenEstimateObservation.sourceIteration,
              observedIteration: iterations,
              sourceStopReason: pendingTokenEstimateObservation.sourceStopReason,
              observedStopReason: stopReason,
              estimatedInputTokens: pendingTokenEstimateObservation.estimatedInputTokens,
              displayEstimatedInputTokens: pendingTokenEstimateObservation.displayEstimatedInputTokens,
              approximateTokens: pendingTokenEstimateObservation.approximateTokens,
              approximateDisplayTokens: pendingTokenEstimateObservation.approximateDisplayTokens,
              exactToolResultCount: pendingTokenEstimateObservation.exactToolResultCount,
              exactDelta: pendingTokenEstimateObservation.exactDelta,
              signedExactDelta: pendingTokenEstimateObservation.signedExactDelta,
              selectedEstimatePath: pendingTokenEstimateObservation.selectedEstimatePath,
              displayEstimatePath: pendingTokenEstimateObservation.displayEstimatePath,
              pathAEstimateTokens: pendingTokenEstimateObservation.pathAEstimateTokens,
              pathBEstimateTokens: pendingTokenEstimateObservation.pathBEstimateTokens,
              lastUsageInputTokens: pendingTokenEstimateObservation.lastUsageInputTokens,
              lastUsageOutputTokens: pendingTokenEstimateObservation.lastUsageOutputTokens,
              lastUsageTotalTokens: pendingTokenEstimateObservation.lastUsageTotalTokens,
              postUsageAdditionalTokens: pendingTokenEstimateObservation.postUsageAdditionalTokens,
              toolCallCount: pendingTokenEstimateObservation.toolCallCount,
              toolResultCount: pendingTokenEstimateObservation.toolResultCount,
              contextWindow: pendingTokenEstimateObservation.contextWindow,
              observedInputTokens: msg.usage.input,
              observedOutputTokens: msg.usage.output,
              observedTotalTokens: msg.usage.totalTokens,
            });
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
          flushPendingPassiveRecallRows();

          // Compute a current-context estimate that accounts for accumulated
          // tool results. Raw usage.totalTokens reflects iter=N's (input+output)
          // and does NOT include the tool result generated between iter=N and
          // iter=N+1 — that tool result is part of iter=N+1's input, and a
          // single large one (e.g. read_file on a 50 KB source file) can push
          // past the hard context cap before the next iteration even starts.
          const effectiveCWForCheck = getEffectiveContextWindow(chat, inferenceModel);
          let estimatedTokens = estimateContextTokens(chat.messages, systemPrompt, agentTools);
          let displayEstimatedTokens = estimatedTokens;
          const approximateTokens = estimatedTokens;
          let approximateDisplayTokens: number | undefined;
          let exactToolResultCount = 0;
          let exactDelta = 0;
          let signedExactDelta = 0;
          let selectedEstimatePath: "usage_anchor" | "char_estimate" | undefined;
          let displayEstimatePath: "usage_anchor" | "char_estimate" | undefined;
          let pathAEstimateTokens: number | undefined;
          let pathBEstimateTokens: number | undefined;
          let lastUsageInputTokens: number | undefined;
          let lastUsageOutputTokens: number | undefined;
          let lastUsageTotalTokens: number | undefined;
          let postUsageAdditionalTokens: number | undefined;
          if (stopReason === "toolUse" && inferenceModel?.provider === "llamacpp" && piModel.baseUrl) {
            const exactEstimate = await estimateContextTokensWithExactToolResults(
              chat.messages,
              systemPrompt,
              agentTools,
              {
                baseUrl: piModel.baseUrl,
                modelId: piModel.id,
                chatId: chat.id,
                phase: "tool_loop",
                contextWindow: effectiveCWForCheck,
              },
            );
            estimatedTokens = exactEstimate.estimatedTokens;
            displayEstimatedTokens = exactEstimate.refinedTokens;
            approximateDisplayTokens = exactEstimate.approximateDisplayTokens;
            exactToolResultCount = exactEstimate.exactToolResultCount;
            exactDelta = exactEstimate.exactDelta;
            signedExactDelta = exactEstimate.signedExactDelta;
            selectedEstimatePath = exactEstimate.contextBreakdown.selectedPath;
            displayEstimatePath = exactEstimate.contextBreakdown.displayPath;
            pathAEstimateTokens = exactEstimate.contextBreakdown.pathATokens;
            pathBEstimateTokens = exactEstimate.contextBreakdown.pathBTokens;
            lastUsageInputTokens = exactEstimate.contextBreakdown.lastUsageInput;
            lastUsageOutputTokens = exactEstimate.contextBreakdown.lastUsageOutput;
            lastUsageTotalTokens = exactEstimate.contextBreakdown.lastUsageTotal;
            postUsageAdditionalTokens = exactEstimate.contextBreakdown.postUsageAdditionalTokens;
            if (exactEstimate.exactToolResultCount > 0 || exactEstimate.errors.length > 0) {
              console.log(
                `[token-estimate] chat=${chat.id} iter=${iterations} approx=${approximateTokens} ` +
                `estimated=${estimatedTokens} exactToolResults=${exactEstimate.exactToolResultCount} ` +
                `delta=${exactEstimate.exactDelta} signedDelta=${exactEstimate.signedExactDelta} ` +
                `display=${displayEstimatedTokens} elapsedMs=${exactEstimate.exactElapsedMs}` +
                (exactEstimate.errors.length ? ` errors=${exactEstimate.errors.length}` : ""),
              );
            }
          }

          // Send iteration event with usage AND estimate so client can update
          // token indicators mid-loop with a number that reflects next-call size.
          res.write(`event: iteration\ndata: ${JSON.stringify({
            iteration: iterations,
            stopReason,
            toolCount: event.toolResults?.length || 0,
            usage: state.finalUsage || undefined,
            estimatedTokens,
            displayEstimatedTokens,
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
          // llama.cpp often returns a stream error (not "length") when the context is exhausted.
          // If we have prior usage near the limit or high iteration count with no usage, treat as context limit.
          if (!hitContextLimit && !msg.usage && (stopReason as string) !== "stop" && (stopReason as string) !== "toolUse" && (stopReason as string) !== "length") {
            // Check if the last known usage was already high
            const lastKnown = state.finalUsage?.totalTokens ?? 0;
            if (effectiveCWForCheck > 0 && (lastKnown / effectiveCWForCheck > COMPACTION_TRIGGER_RATIO || iterations > 3)) {
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
          // at the same ratio as truncateBeforeSend and leave room for compaction
          // instead of tipping over the hard cap on the next iteration.
          if (stopReason === "toolUse" && !hitContextLimit) {
            if (effectiveCWForCheck > 0 && estimatedTokens > 0) {
              const usageRatio = estimatedTokens / effectiveCWForCheck;
              if (usageRatio > COMPACTION_TRIGGER_RATIO) {
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

          if (
            stopReason === "toolUse" &&
            !state.needsMidTurnCompaction &&
            !hitContextLimit &&
            !turnAbortController.signal.aborted
          ) {
            state.pendingTokenEstimateObservation = {
              sourceIteration: iterations,
              sourceStopReason: stopReason,
              estimatedInputTokens: estimatedTokens,
              displayEstimatedInputTokens: displayEstimatedTokens,
              approximateTokens,
              approximateDisplayTokens,
              exactToolResultCount,
              exactDelta,
              signedExactDelta,
              selectedEstimatePath,
              displayEstimatePath,
              pathAEstimateTokens,
              pathBEstimateTokens,
              lastUsageInputTokens,
              lastUsageOutputTokens,
              lastUsageTotalTokens,
              postUsageAdditionalTokens,
              contextWindow: effectiveCWForCheck,
              toolCallCount: state.allToolCalls.length,
              toolResultCount: state.allToolResults.length,
            };
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
            if (!turnAbortController.signal.aborted && !state.needsMidTurnCompaction) {
              passiveRecall?.schedule({
                iteration: iterations,
                stopReason,
                chatMessages: chat.messages,
                chatType: chat.type,
                projectId: chat.projectId,
              });
            }
          } catch (saveErr) {
            console.error(`[chat] failed to save iteration ${iterations}:`, saveErr);
          }

          break;
        }
      }
      },
    });

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

    // End-of-turn compaction: if we crossed the compaction threshold during this turn,
    // compact NOW before building the final message. This prevents the user from
    // waiting on compaction after their response appears complete.
    // Mid-turn compaction during tool loops is handled separately above.
    // Skip if we have a stranded tool call — we need to continue the turn first,
    // not compact away the context the model was working with.
    if (!state.needsMidTurnCompaction && !askUserRef.current && !waitingForInput && !state.strandedToolCall) {
      try {
        const model = allModels.find((m: InferenceModel) => m.id === chat.modelId);
        if (model) {
          const effectiveContextWindow = getEffectiveContextWindow(chat, model);
          const lastUsage = state.finalUsage?.totalTokens ?? 0;
          const usageRatio = lastUsage > 0 ? lastUsage / effectiveContextWindow : 0;

          // Check if we crossed the compaction threshold
          let needsCompaction = hitContextLimit || usageRatio > COMPACTION_TRIGGER_RATIO;

          // Fallback to character estimation if usage is missing
          if (!needsCompaction && lastUsage === 0 && chat.messages.length > 4) {
            const estimatedTokens = estimateContextTokens(chat.messages, systemPrompt, agentTools);
            const estimatedRatio = estimatedTokens / effectiveContextWindow;
            if (estimatedRatio > COMPACTION_TRIGGER_RATIO) {
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
                // Extract memories from removed messages before rebuilding the memory prompt.
                if (isMemoryAugmentedChatType(chat.type) && compaction.removedMessages?.length) {
                  await preCompactionFlush(chat.modelId, chat.id, compaction.removedMessages, chat.projectId);
                }
                await saveChat(chat, { allowTruncation: true });

                // Full reset of memory context after compaction — rebuild with
                // fresh retrieval, all memories frozen into the new system prompt.
                if (isMemoryAugmentedChatType(chat.type)) {
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
                setCachedAugmentedPrompt(chat.id, systemPrompt);

                // The current assistant usage was measured against the
                // pre-compaction prompt. Once a summary is inserted before the
                // final assistant row, that usage becomes stale; if persisted,
                // the next pre-send estimate treats the compacted chat as still
                // near the old limit and immediately compacts again.
                clearPendingAssistantUsageAfterCompaction();

                // Find the summary message that was inserted. Emit AFTER the
                // systemPrompt rebuild so the estimate reflects the prompt the
                // next turn will actually use. The client uses `estimatedTokens`
                // to refresh the token indicator to the compacted state.
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
      // The main loop staged the stranded assistant row as a possible final
      // message. Once recovery begins that row is known-stale; the recovered
      // turn_end events below must replace it, otherwise final persistence can
      // save the pre-recovery text while the UI saw the recovered response.
      state.pendingFinalAssistantMessage = null;

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
            if (ttsEnabled) {
              ttsTextQueue.flush();
            }

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
            flushThinkingTimer();

            if (msg.usage && (msg.usage.totalTokens > 0 || stopReason !== "error")) {
              state.finalUsage = {
                input: msg.usage.input,
                output: msg.usage.output,
                totalTokens: msg.usage.totalTokens,
              };
            }
            captureLlamaRun(msg, iterations + 1, "stranded-recovery");
            iterations++;
            console.log(`[chat] stranded recovery turn_end: stop=${stopReason} text=${state.fullText.length}ch tools=${event.toolResults?.length || 0}`);

            let persistedRecoveryMsg: ChatMessage | null = null;
            if (stopReason === "toolUse") {
              persistedRecoveryMsg = buildAssistantMessageFromTurn(msg);
              upsertAssistantMessage(persistedRecoveryMsg);
              markUncommittedAssistantMessageCommitted(persistedRecoveryMsg);
            } else {
              state.pendingFinalAssistantMessage = buildAssistantMessageFromTurn(msg);
              if (hasAssistantMessageContent(state.pendingFinalAssistantMessage)) {
                upsertAssistantMessage(state.pendingFinalAssistantMessage, true);
              }
            }

            try {
              await saveChat(chat);
              const recoveryAgentMessages = await chatMessagesToHydratedPiMessages(chat.messages, chat.modelId, activeAssistantIdentity);
              await savePendingState(chat.id, {
                agentMessages: recoveryAgentMessages as any[],
                systemPrompt,
                askToolCallId: askUserRef.current?.toolCallId || "",
                fullText: state.fullText,
                thinkingText: state.thinkingText,
                toolCalls: state.allToolCalls,
                toolResults: state.allToolResults,
                iterations,
                lastUserMessage,
              });
              if (persistedRecoveryMsg) {
                res.write(`event: message_complete\ndata: ${JSON.stringify({ message: persistedRecoveryMsg, continues: true })}\n\n`);
              }
            } catch (saveErr) {
              console.error(`[chat] stranded recovery save failed:`, saveErr);
            }

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
          state.pendingFinalAssistantMessage = null;
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
      progressParts.push("[System: Context was compacted mid-turn. Here is a summary of your messages so far — continue from where you left off.]");
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
      const effectiveCW = getEffectiveContextWindow(chat, inferenceModel);
      const emitCompacting = () => res.write(`event: compacting\ndata: {}\n\n`);
      const emitKeepalive = () => res.write(`: keepalive\n\n`);
      // Wrap all compaction work in a keepalive ping loop so the client's
      // 95s inactivity timeout doesn't fire during slow LLM/embed steps.
      let compactionAborted = false;
      let compaction: Awaited<ReturnType<typeof truncateChatHistory>> | undefined;
      await withSSEKeepalive(res, async () => {
        try {
          const preCompactionEstimate = estimateContextTokens(chat.messages, systemPrompt, agentTools);
          compaction = await truncateChatHistory(
            chat,
            effectiveCW,
            true,
            emitCompacting,
            emitKeepalive,
            preCompactionEstimate,
            systemPrompt,
            agentTools,
          );
          if (compaction?.truncated) {
            console.log(
              `[chat] Mid-turn compaction cycle ${compactionCycle}: removed ${compaction.removedCount} messages, ` +
              `estimated ${compaction.estimatedTokenCount} tokens removed`
            );

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

            await saveChat(chat, { allowTruncation: true });
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
        if (compaction?.truncated && isAgent) {
          resetMemoryContext(chat.id);
          const split = await buildSplitAugmentedPrompt(
            chat.systemPrompt || "You are a helpful assistant.",
            chat.messages, chat.id, chat.projectId, chat.type, projectPath
          );
          systemPrompt = split.systemPrompt;
          if (chat.activeSkills?.length) {
            const skillsCache = new Map<string, Skill>();
            const allSkills = await discoverSkills(chat.projectId);
            for (const s of allSkills) skillsCache.set(s.name, s);
            systemPrompt = buildSkillAugmentedPrompt(systemPrompt, chat.activeSkills, skillsCache);
            console.log(`[skills] Reinjected ${chat.activeSkills.length} skills after mid-turn compaction`);
          }
        }
        setCachedAugmentedPrompt(chat.id, systemPrompt);
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
      handoffParts.push("You're now ready to pick up where you left off.");
      const handoffText = handoffParts.join("\n\n");

      // Keep the same tail selected by truncateChatHistory. The handoff user
      // message appended below satisfies agentLoopContinue's "last message is
      // not assistant" requirement, so stripping trailing assistant/tool rows
      // here would discard exactly the recent context compaction preserved.
      const resumeEndIndex = chat.messages.length;

      const messagesForResume = chat.messages.slice(0, resumeEndIndex);
      const resumeMessages = await chatMessagesToHydratedPiMessages(messagesForResume, chat.modelId, activeAssistantIdentity);

      // Append the handoff message so the resumed agent has continuity
      resumeMessages.push({ role: "user", content: handoffText, timestamp: Date.now() });

      // Persist the handoff as a hidden message so future turns reconstruct
      // the same token sequence that llama.cpp caches during this continuation.
      // Without this, future replay lacks the transient handoff at this
      // boundary, breaking KV cache prefix matching on the next turn.
      chat.messages.splice(resumeEndIndex, 0, {
        role: "user",
        content: handoffText,
        timestamp: Date.now(),
        _isSystemMessage: true,
        _isMidTurnCompaction: true,
        _compactionRemovedCount: compaction?.removedCount,
        _compactionCycle: compactionCycle,
      });
      await saveChat(chat);

      if (compaction?.truncated) {
        // Emit after prompt rebuild and handoff persistence so the estimated
        // token count reflects the actual prompt used for the resumed call.
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

      // 4. Resume the agent loop with compacted context
      const resumeContext: AgentContext = {
        systemPrompt,
        messages: resumeMessages,
        tools: agentTools,
      };
      const resumeAbortController = new AbortController();
      connectionAbortController.signal.addEventListener("abort", () => resumeAbortController.abort());

      console.log(`[chat] Mid-turn compaction cycle ${compactionCycle}: resuming agent loop with ${resumeMessages.length} messages`);

      flushTextSegment();

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
            if (ttsEnabled) {
              ttsTextQueue.flush();
            }
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
              const callIdx = state.segments.findIndex(
                s => s.type === "tool_call" && s.toolCall?.id === event.toolCallId
              );
              if (callIdx >= 0) {
                state.segments.splice(callIdx + 1, 0, resultSegment);
              } else {
                state.segments.push(resultSegment);
              }
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
            captureLlamaRun(msg, iterations + 1, `resume-${compactionCycle}`);
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
            const resumeEffectiveCW = getEffectiveContextWindow(chat, inferenceModel);
            let resumeTokens = state.finalUsage?.totalTokens ?? 0;
            if (!resumeTokens) {
              resumeTokens = estimateContextTokens(chat.messages, systemPrompt, agentTools);
            }
            if (resumeEffectiveCW > 0 && resumeTokens > 0 && resumeTokens / resumeEffectiveCW > COMPACTION_TRIGGER_RATIO) {
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
    if (isChatDeleted(chat.id)) {
      await messageQueue.clear(chat.id);
      writeDeletedChatEvent(res);
      return;
    }

    const queuedFollowUp = await messageQueue.drainOne(chat.id);
    if (queuedFollowUp && !askUserRef.current && !waitingForInput) {
      console.log(`[chat] post-loop: found queued follow-up message ${queuedFollowUp.id}, processing`);
      if (isChatDeleted(chat.id)) {
        await messageQueue.clear(chat.id);
        writeDeletedChatEvent(res);
        return;
      }

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
      if (currentAssistantMsg && !currentTurnIsHidden && isMemoryAugmentedChatType(chat.type)) {
        deferredExtractions.push({ userMsg: lastUserMessage, assistantMsg: currentAssistantMsg.content });
      }

      // Title generation for first exchange
      if (currentAssistantMsg && !currentTurnIsHidden && shouldGenerateInitialTitle(chat)) {
        titleGenerationPromise = generateTitle(lastUserMessage, currentAssistantMsg.content)
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
      const followUpContextMessages = await chatMessagesToHydratedPiMessages(chat.messages, chat.modelId, activeAssistantIdentity);

      // Safety check: ensure context is not empty
      if (followUpContextMessages.length === 0 && chat.messages.length > 1) {
        console.error(`[chat] follow-up context is empty despite ${chat.messages.length} messages - this indicates a conversion bug`);
      }

      let followUpSystemPrompt = isMemoryAugmentedChatType(chat.type)
        ? (await buildSplitAugmentedPrompt(chat.systemPrompt || "You are a helpful assistant.", chat.messages, chat.id, chat.projectId, chat.type, projectPath)).systemPrompt
        : chat.systemPrompt || "You are a helpful assistant.";

      // Reinjected skills on follow-up turn — buildSplitAugmentedPrompt builds
      // from the base system prompt which doesn't include active skills.
      if (chat.activeSkills?.length) {
        const skillsCache = new Map<string, Skill>();
        const allSkills = await discoverSkills(chat.projectId);
        for (const s of allSkills) skillsCache.set(s.name, s);
        followUpSystemPrompt = buildSkillAugmentedPrompt(followUpSystemPrompt, chat.activeSkills, skillsCache);
      }

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
      await snapshotSentPrefix(chat.id, chat.messages, chat.modelId, activeAssistantIdentity);
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

      // Post-turn passive recall: for conversational stops (non-toolUse),
      // the agent's final response may have traveled to territory the initial
      // explicit retrieval didn't cover. Schedule after assistant-row mutations
      // like recap so the async hidden-row save cannot become the last-message
      // target for those updates.
      // state.pendingFinalAssistantMessage is only set for non-toolUse stops,
      // so this naturally excludes tool-use iterations (already handled mid-turn).
      if (state.pendingFinalAssistantMessage && !waitingForInput && !state.needsMidTurnCompaction) {
        passiveRecall?.schedule({
          iteration: iterations,
          stopReason: "stop",
          chatMessages: chat.messages,
          chatType: chat.type,
          projectId: chat.projectId,
        });
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
            title: chat.title || "Porrima",
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

    const assistantSequence = hasContent ? chat.messages.length - 1 : undefined;
    let userMessageSequence: number | undefined;
    if (assistantSequence !== undefined) {
      for (let i = assistantSequence - 1; i >= 0; i--) {
        if (chat.messages[i]?.role === "user") {
          userMessageSequence = i;
          break;
        }
      }
    }
    const doneAssistantMsg =
      assistantSequence === undefined
        ? assistantMsg
        : { ...assistantMsg, _rowSequence: assistantSequence };

    if (waitingForInput) {
      res.write(
        `event: done\ndata: ${JSON.stringify({ message: doneAssistantMsg, userMessageSequence, waitingForInput: true, iterations })}\n\n`
      );
    } else {
      // Clean up pending state — turn completed normally, no need for crash recovery
      await clearPendingState(chat.id);

      res.write(
        `event: done\ndata: ${JSON.stringify({ message: doneAssistantMsg, userMessageSequence, iterations })}\n\n`
      );

      // Generate LLM title after the first exchange (2 messages = 1 user + 1 assistant).
      // Kick off title generation immediately so it can run in parallel with
      // model-stats recording and memory extraction below, but capture the promise
      // so we can await it before endLiveStream closes the SSE connection.
      if (!currentTurnIsHidden && shouldGenerateInitialTitle(chat) && hasContent) {
        titleGenerationPromise = generateTitle(lastUserMessage, logicalAssistantContent)
          .then(async (title) => {
            if (title) {
              chat.title = title;
              await saveChat(chat);
              res.write(`event: title_update\ndata: ${JSON.stringify({ chatId: chat.id, title })}\n\n`);
            }
          })
          .catch((err) => console.warn("[title] post-stream generation failed:", err));
      }

      // Record model performance stats for every llama.cpp provider call in
      // this visible turn. A tool loop can make multiple model calls, and a
      // slow first prefill must not be hidden by a later tiny follow-up call.
      if (inferenceModel?.provider === "llamacpp" && state.llamaRuns.length > 0) {
        try {
          const { recordModelStats } = await import("../services/model-stats.js");
          state.llamaRuns.forEach((run, idx) => {
            const stats = recordModelStats(inferenceModel.id, "llamacpp", run.timings, run.cache ?? undefined);
            const cacheText = stats.inferredCachedTokens !== undefined
              ? ` cache=${stats.inferredCachedTokens}/${stats.reportedPromptTokens ?? "?"}`
              : "";
            const digestText = stats.requestDigest ? ` digest=${stats.requestDigest}` : "";
            console.log(
              `[model-stats] recorded: ${inferenceModel.id} run=${idx + 1}/${state.llamaRuns.length} ` +
              `decode=${run.timings.predicted_per_second.toFixed(1)} tok/s${cacheText}${digestText}`,
            );
          });
        } catch (err) {
          console.warn("[model-stats] recording failed:", err);
        }
      }

      // Memory extraction — runs after agent loop is fully complete (no concurrent LLM interference)
      if (!currentTurnIsHidden && isMemoryAugmentedChatType(chat.type) && hasContent) {
        extractMemories(chat.modelId, chat.id, lastUserMessage, logicalAssistantContent, chat.projectId)
          .catch((err) => console.error("[memory] extraction failed:", err));
      }
      // Run any deferred extractions from mid-loop follow-ups
      for (const deferred of deferredExtractions) {
        extractMemories(chat.modelId, chat.id, deferred.userMsg, deferred.assistantMsg, chat.projectId)
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
      await stampAssistantCompletion(chat);

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
        await stampAssistantCompletion(chat);
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
        await stampAssistantCompletion(chat);
      }

      // Only write error if the connection is still open
      if (!connectionClosed) {
        res.write(
          `event: error\ndata: ${JSON.stringify({ error: e.message })}\n\n`
        );
      }
    }
  } finally {
    try {
      await releaseLlamaSlotLease(llamaSlotLease);
    } catch (err) {
      console.warn("[llama-slot] release failed:", err instanceof Error ? err.message : err);
    }
    markLlamaCacheResidencyFinished(chat.id);
    markChatInactive(chat.id);
    stopSSEKeepalive();
    ttsTextQueue.close();
    if (audioStreamTask) {
      try {
        await audioStreamTask;
      } catch (err) {
        console.warn("[TTS] audio stream task failed during shutdown:", err instanceof Error ? err.message : err);
      }
    }

    // Wait for any in-flight title generation so the title_update SSE event
    // reaches the client before we close the live stream.
    if (titleGenerationPromise) {
      try { await titleGenerationPromise; } catch { /* logged upstream */ }
    }

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

    // Set up SSE stream BEFORE triggering compaction so keepalive pings can
    // flow while model discovery, memory retrieval, index generation, and the
    // (CPU) extraction model run. Without this, the client's fetch() could hang
    // without bytes long enough to trip its inactivity timeout.
    ensureSSEStream(res, req, chat.id);
    res.write(`event: compacting\ndata: {}\n\n`);

    let contextWindow = 0;
    let compactSystemPrompt = chat.systemPrompt || "You are a helpful assistant.";
    let compactTools: unknown;

    // Wrap the whole compaction + flush in a keepalive ping loop.
    const compaction = await withSSEKeepalive(res, async () => {
      // Get settings for context window resolution.
      const settings = await getSettings();
      const { getEffectiveContextWindow, discoverAllModels } = await import("../services/models.js");
      const allModels = await discoverAllModels();
      const inferenceModel = allModels.find(m => m.id === chat.modelId);
      contextWindow = getEffectiveContextWindow(chat, inferenceModel);

      let compactProject: Project | undefined;
      let compactProjectPath: string | undefined;
      if (chat.projectId) {
        compactProject = (await getProject(chat.projectId)) ?? undefined;
        compactProjectPath = compactProject?.path;
      }

      // Manual compaction must budget for the real prompt shape. Passing no
      // system prompt/tools makes the compactor think overhead is zero, which
      // can leave an oversized post-compact prompt that fails on the next turn.
      if (isMemoryAugmentedChatType(chat.type)) {
        const split = await buildSplitAugmentedPrompt(
          chat.systemPrompt || "You are a helpful assistant.",
          chat.messages,
          chat.id,
          chat.projectId,
          chat.type,
          compactProjectPath,
        );
        compactSystemPrompt = split.systemPrompt;
      }
      if (chat.activeSkills?.length) {
        const skillsCache = new Map<string, Skill>();
        const allSkills = await discoverSkills(chat.projectId);
        for (const s of allSkills) skillsCache.set(s.name, s);
        compactSystemPrompt = buildSkillAugmentedPrompt(compactSystemPrompt, chat.activeSkills, skillsCache);
      }
      compactTools = toolsForEstimate(chat, contextWindow, compactProject);

      const result = await triggerCompaction(chat, contextWindow, compactSystemPrompt, compactTools);
      if (result && result.truncated) {
        // Extract memories from removed messages and await completion so they're
        // available when the next buildSplitAugmentedPrompt runs (either in this
        // handler's follow-up path or in the main handler).
        if (isMemoryAugmentedChatType(chat.type) && result.removedMessages?.length) {
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
        if (isMemoryAugmentedChatType(chat.type)) {
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
          compactSystemPrompt,
          compactTools,
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
          compactSystemPrompt,
          compactTools,
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
      let resumeModel: InferenceModel | undefined;
      try {
        resumeModel = (await discoverAllModels()).find((m) => m.id === chat.modelId);
      } catch {
        resumeModel = undefined;
      }
      const rebuiltContext = await chatMessagesToHydratedPiMessages(
        chat.messages.slice(0, -1),
        chat.modelId,
        replayIdentityForModel(chat.modelId, resumeModel),
      );
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
      images: persistedImages?.length ? persistedImages : undefined,
      timestamp: Date.now(),
    });
    await saveChat(chat);

    // Discover model for pre-send truncation
    let model: InferenceModel | undefined;
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
          const effectiveContextWindow = getEffectiveContextWindow(chat, model);
          const emitKeepalive = () => res.write(`: keepalive\n\n`);
          const compaction = await truncateBeforeSend(
            chat,
            effectiveContextWindow,
            systemPrompt,
            () => res.write(`event: compacting\ndata: {}\n\n`),
            emitKeepalive,
            toolsForEstimate(chat, effectiveContextWindow),
            { baseUrl: settings.llamacppUrl?.trim() || DEFAULT_LLAMACPP_URL, modelId: chat.modelId },
          );
          if (compaction && compaction.truncated) {
            // Extract memories from removed messages and await completion so they're
            // available for the system prompt rebuild below. Without awaiting, the
            // rebuilt prompt would miss freshly extracted memories from removed context.
            if (isMemoryAugmentedChatType(chat.type) && compaction.removedMessages?.length) {
              try {
                await preCompactionFlush(chat.modelId, chat.id, compaction.removedMessages, chat.projectId);
              } catch (err) {
                console.error("[compaction] pre-send flush failed (resume):", err);
              }
            }

            await saveChat(chat, { allowTruncation: true });
            // Rebuild system prompt after truncation with full memory reset
            resetMemoryContext(chat.id);
            if (isMemoryAugmentedChatType(chat.type)) {
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
              // Reinjected skills after compaction — they were lost when
              // buildSplitAugmentedPrompt rebuilt from the base systemPrompt.
              if (chat.activeSkills?.length) {
                const skillsCache = new Map<string, Skill>();
                const allSkills = await discoverSkills(chat.projectId);
                for (const s of allSkills) skillsCache.set(s.name, s);
                systemPrompt = buildSkillAugmentedPrompt(systemPrompt, chat.activeSkills, skillsCache);
                console.log(`[skills] Reinjected ${chat.activeSkills.length} skills after resume pre-send compaction`);
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
    // User-initiated system-chat turns use the same memory prompt path as
    // automation-initiated system turns so both entry points have recall parity.
    let systemPrompt = chat.systemPrompt || "You are a helpful assistant.";
    let memoriesDelta = "";
    if (isMemoryAugmentedChatType(chat.type)) {
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
    let model: InferenceModel | undefined;
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
          const effectiveContextWindow = getEffectiveContextWindow(chat, model);
          const emitKeepalive = () => res.write(`: keepalive\n\n`);
          const compaction = await truncateBeforeSend(
            chat,
            effectiveContextWindow,
            systemPrompt,
            () => res.write(`event: compacting\ndata: {}\n\n`),
            emitKeepalive,
            toolsForEstimate(chat, effectiveContextWindow),
            { baseUrl: settings.llamacppUrl?.trim() || DEFAULT_LLAMACPP_URL, modelId: chat.modelId },
          );
          if (compaction && compaction.truncated) {
            // Extract memories from removed messages and await completion so they're
            // available for the system prompt rebuild below. Without awaiting, the
            // rebuilt prompt would miss freshly extracted memories from removed context.
            if (isMemoryAugmentedChatType(chat.type) && compaction.removedMessages?.length) {
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
            if (isMemoryAugmentedChatType(chat.type)) {
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
    // pending next-user context (post-turn passive recall and/or fresh memory
    // delta), exclude those hidden rows here and merge them into the current
    // user message below. Future replays reconstruct the same shape by merging
    // the persisted system rows with the following persisted user row.
    const currentUserIndex = chat.messages.length - 1;
    const nextUserContext = splitNextUserContext({
      messages: chat.messages,
      currentUserIndex,
      memoryDeltaContext,
    });
    const nextUserContextChars = nextUserContext.systemContexts.reduce((sum, content) => sum + content.length, 0);
    const persistedHistoryEnd = nextUserContext.persistedHistoryEnd;
    const persistedHistory = chat.messages.slice(0, persistedHistoryEnd);
    const replayIdentity = replayIdentityForModel(chat.modelId, model);
    const contextMessages = await chatMessagesToHydratedPiMessages(persistedHistory, chat.modelId, replayIdentity);

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
      deltaChars: nextUserContextChars,
      newMsgChars: message.length,
      persistedRows: persistedHistory.length,
      contextPiMessages: contextMessages,
      shape: summarizeReplayShape(persistedHistory),
    });

    const userImagesForModel = await hydrateUserImageAttachments(images?.length ? images : persistedImages);
    const userPiMessage = buildUserPiMessage(message, userImagesForModel, nextUserContext.systemContexts);

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
    objectKind: body.objectKind === "visual" ? "visual" : (body.objectKind === "artifact" ? "artifact" : undefined),
    title: typeof body.title === "string" ? body.title : undefined,
    url: typeof body.url === "string" ? body.url : undefined,
    diagnosticKind: (
      body.diagnosticKind === "js-error" ||
      body.diagnosticKind === "promise-rejection" ||
      body.diagnosticKind === "webgpu-shader" ||
      body.diagnosticKind === "webgpu-validation"
    ) ? body.diagnosticKind : undefined,
    message: typeof body.message === "string" ? body.message : "",
    stack: typeof body.stack === "string" ? body.stack : undefined,
    filename: typeof body.filename === "string" ? body.filename : undefined,
    lineno: typeof body.lineno === "number" ? body.lineno : undefined,
    colno: typeof body.colno === "number" ? body.colno : undefined,
    sourceExcerpt: typeof body.sourceExcerpt === "string" ? body.sourceExcerpt : undefined,
    shaderLabel: typeof body.shaderLabel === "string" ? body.shaderLabel : undefined,
    shaderSource: typeof body.shaderSource === "string" ? body.shaderSource : undefined,
    shaderLine: typeof body.shaderLine === "number" ? body.shaderLine : undefined,
    shaderColumn: typeof body.shaderColumn === "number" ? body.shaderColumn : undefined,
    shaderExcerpt: typeof body.shaderExcerpt === "string" ? body.shaderExcerpt : undefined,
    pipelineLabel: typeof body.pipelineLabel === "string" ? body.pipelineLabel : undefined,
    entryPoint: typeof body.entryPoint === "string" ? body.entryPoint : undefined,
    compilationMessages: Array.isArray(body.compilationMessages)
      ? body.compilationMessages.slice(0, 24).map((message) => ({
        type: typeof message?.type === "string" ? message.type : undefined,
        message: typeof message?.message === "string" ? message.message : undefined,
        lineNum: typeof message?.lineNum === "number" ? message.lineNum : undefined,
        linePos: typeof message?.linePos === "number" ? message.linePos : undefined,
        offset: typeof message?.offset === "number" ? message.offset : undefined,
        length: typeof message?.length === "number" ? message.length : undefined,
      }))
      : undefined,
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
  if (!(chat.type === "agent" || chat.type === "system")) {
    return res.status(400).json({ error: "Artifact repair requires a tool-capable chat" });
  }

  const current = await getVersionedObjectCurrentVersion(report.artifactId, report.objectKind);
  if (!current) return res.status(404).json({ error: "Artifact or visual not found" });
  report.objectKind = current.objectKind;

  // Check dedup guards before version check — prevents spurious errors when a
  // previously-repaired artifact fires the same error on page reload.
  const dedupKey = makeArtifactRepairDedupKey(report);
  if (hasRecentArtifactRepairAttempt(dedupKey)) {
    if (report.stream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(`event: done\ndata: ${JSON.stringify({ skipped: "duplicate" })}\n\n`);
      res.end();
      return;
    }
    return res.json({ accepted: false, duplicate: true });
  }

  // If the reported version is older than current, a repair already produced
  // a newer version — silently skip rather than surfacing a spurious error.
  if (report.version < current.currentVersion) {
    if (report.stream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(`event: done\ndata: ${JSON.stringify({ skipped: "superseded" })}\n\n`);
      res.end();
      return;
    }
    return res.json({ accepted: false, superseded: true });
  }
  if (hasRecentArtifactAutoRepair(report, dedupKey)) {
    if (report.stream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(`event: done\ndata: ${JSON.stringify({ skipped: "repairLimit" })}\n\n`);
      res.end();
      return;
    }
    return res.json({ accepted: false, repairLimit: true });
  }

  const stream = liveStreams.get(report.chatId);
  const active = !!stream && !stream.ended && !stream.abort.signal.aborted;
  if (!active && !chatReferencesVersionedObject(chat, report.artifactId, report.version, report.objectKind)) {
    return res.status(400).json({ error: "Artifact or visual is not associated with this chat" });
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
  if (isMemoryAugmentedChatType(chat.type)) {
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
  let repairModel: InferenceModel | undefined;
  try {
    repairModel = (await discoverAllModels()).find((m) => m.id === chat.modelId);
  } catch {
    repairModel = undefined;
  }
  const repairReplayIdentity = replayIdentityForModel(chat.modelId, repairModel);
  const contextMessages = await chatMessagesToHydratedPiMessages(
    chat.messages.slice(0, persistedHistoryEnd),
    chat.modelId,
    repairReplayIdentity,
  );
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

  const replay = req.query.replay !== "0";
  attachToLiveStreamResponse(req, res, stream, "reconnected", replay);

  console.log(`[chat] reconnect: attached to live stream for ${chatId} (replayed ${replay ? stream.buffer.length : 0} chunks)`);
});

// Edit message at index and regenerate response via SSE
function isEmptyAssistantPlaceholder(message: ChatMessage | undefined): boolean {
  return Boolean(
    message?.role === "assistant" &&
    !message.content?.trim() &&
    !message.thinking?.trim() &&
    !message.toolCalls?.length &&
    !message.toolResults?.length &&
    !message.artifacts?.length &&
    !message.generatedImages?.length &&
    !message.visuals?.length &&
    !message.segments?.length
  );
}

router.post("/edit", async (req, res) => {
  const { chatId, messageIndex, messageSequence, message, images } = req.body as {
    chatId: string;
    messageIndex?: number;
    messageSequence?: number;
    message: string;
    images?: ImageAttachment[];
  };

  if (!chatId || (messageIndex == null && messageSequence == null) || !message) {
    return res.status(400).json({ error: "chatId, messageIndex/messageSequence, and message are required" });
  }

  const chat = await getChat(chatId);
  if (!chat) return res.status(404).json({ error: "Chat not found" });

  if (messageIndex != null && (messageIndex < 0 || messageIndex >= chat.messages.length)) {
    return res.status(400).json({ error: "messageIndex out of bounds" });
  }

  const hasStableSequence = Number.isInteger(messageSequence);
  let targetIndex = hasStableSequence
    ? chat.messages.findIndex((m, index) => (m._rowSequence ?? index) === messageSequence)
    : messageIndex!;

  if (targetIndex < 0) {
    return res.status(400).json({ error: "messageSequence not found" });
  }

  // Edits are destructive truncations, so fail closed if the client target is
  // ambiguous. The only tolerated drift is the local empty assistant placeholder
  // immediately after a user message.
  if (chat.messages[targetIndex].role !== "user") {
    if (
      isEmptyAssistantPlaceholder(chat.messages[targetIndex]) &&
      targetIndex > 0 &&
      chat.messages[targetIndex - 1]?.role === "user"
    ) {
      console.log(`[chat] edit: resolved empty assistant placeholder at index ${targetIndex} to user message at index ${targetIndex - 1}`);
      targetIndex = targetIndex - 1;
    } else {
      console.warn(
        `[chat] edit rejected: target index ${targetIndex} is ${chat.messages[targetIndex].role}; ` +
        `messageSequence=${messageSequence ?? "none"} messageIndex=${messageIndex ?? "none"}`
      );
      return res.status(400).json({ error: "Edit target must be a user message" });
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
  const editImages = images?.length
    ? await persistImages(images)
    : (originalMessage.images?.length ? originalMessage.images : undefined);
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

  // Build context with skills (using delta-aware prompt builder for memory-augmented chats)
  let systemPrompt = chat.systemPrompt || "You are a helpful assistant.";
  let editMemoriesDelta = "";
  if (isMemoryAugmentedChatType(chat.type)) {
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
  let model: InferenceModel | undefined;
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
        const effectiveContextWindow = getEffectiveContextWindow(chat, model);
        const emitKeepalive = () => res.write(`: keepalive\n\n`);
        const compaction = await truncateBeforeSend(
          chat,
          effectiveContextWindow,
          systemPrompt,
          () => res.write(`event: compacting\ndata: {}\n\n`),
          emitKeepalive,
          undefined,
          { baseUrl: settings.llamacppUrl?.trim() || DEFAULT_LLAMACPP_URL, modelId: chat.modelId },
        );
        if (compaction && compaction.truncated) {
          // Extract memories from removed messages and await completion so they're
          // available for the system prompt rebuild below.
          if (isMemoryAugmentedChatType(chat.type) && compaction.removedMessages?.length) {
            try {
              await preCompactionFlush(chat.modelId, chat.id, compaction.removedMessages, chat.projectId);
            } catch (err) {
              console.error("[compaction] pre-send flush failed (edit):", err);
            }
          }

          await saveChat(chat, { allowTruncation: true });
          // Rebuild system prompt after truncation with full memory reset
          resetMemoryContext(chat.id);
          if (isMemoryAugmentedChatType(chat.type)) {
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
  const editReplayIdentity = replayIdentityForModel(chat.modelId, model);
  const contextMessages = await chatMessagesToHydratedPiMessages(editPersistedHistory, chat.modelId, editReplayIdentity);

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

  const editImagesForModel = await hydrateUserImageAttachments(images?.length ? images : editImages);
  const userPiMessage = buildUserPiMessage(message, editImagesForModel, editMemoryDeltaContext);

  await handleChatStream(chat, message, contextMessages, systemPrompt, userPiMessage, req, res);
});

export default router;
