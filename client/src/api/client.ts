import type { Artifact, Chat, ChatListItem, ChatToolCall, ChatToolResult, ChatType, ComfyUIStatus, GeneratedImage, ImageAttachment, ImageGenerationParams, InlineVisual, LlamaPathInfo, LlamaPathUpdateResult, MessageUsage, NotebookEntry, NotebookIndex, NotebookLink, OllamaModel, Settings } from "../types";

const BASE = "/api";

export class OfflineError extends Error {
  constructor(message = "Network unavailable") {
    super(message);
    this.name = "OfflineError";
  }
}

function emitUnauthorized() {
  window.dispatchEvent(new CustomEvent("auth:unauthorized"));
}

async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(input, {
      ...init,
      credentials: "include",
    });
  } catch (e) {
    throw new OfflineError();
  }
  if (res.status === 401) {
    emitUnauthorized();
    throw new Error("Authentication required");
  }
  return res;
}

export async function fetchModels(): Promise<OllamaModel[]> {
  const res = await apiFetch(`${BASE}/models`);
  if (!res.ok) throw new Error("Failed to fetch models");
  return res.json();
}

export interface DiscoveredModel {
  id: string;
  name: string;
}

export async function discoverModels(params: {
  provider: "ollama" | "llamacpp";
  kind: "embedding" | "rerank" | "chat";
  url?: string;
}): Promise<{ models: DiscoveredModel[]; error?: string }> {
  const qs = new URLSearchParams({ provider: params.provider, kind: params.kind });
  if (params.url) qs.set("url", params.url);
  const res = await apiFetch(`${BASE}/models/discover?${qs.toString()}`);
  if (!res.ok) return { models: [], error: `HTTP ${res.status}` };
  return res.json();
}

export async function fetchChats(): Promise<ChatListItem[]> {
  const res = await apiFetch(`${BASE}/chats`);
  if (!res.ok) throw new Error("Failed to fetch chats");
  return res.json();
}

export async function updateChat(
  id: string,
  data: { title?: string; modelId?: string; systemPrompt?: string; contextWindow?: number | null }
): Promise<Chat> {
  const res = await apiFetch(`${BASE}/chats/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error("Failed to update chat");
  return res.json();
}

export async function fetchRenderedPrompt(id: string): Promise<{ systemPrompt: string; tools: { name: string; description: string }[] }> {
  const res = await apiFetch(`${BASE}/chats/${id}/rendered-prompt`);
  if (!res.ok) throw new Error("Failed to fetch rendered prompt");
  return res.json();
}

export async function deleteChat(id: string): Promise<void> {
  const res = await apiFetch(`${BASE}/chats/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete chat");
}

export async function fetchSettings(): Promise<Settings> {
  const res = await apiFetch(`${BASE}/settings`);
  if (!res.ok) throw new Error("Failed to fetch settings");
  return res.json();
}

export async function updateSettings(settings: Settings): Promise<Settings> {
  const res = await apiFetch(`${BASE}/settings`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  if (!res.ok) throw new Error("Failed to save settings");
  return res.json();
}

export interface ToolStatus {
  name: string;
  status: "running" | "done" | "error";
  result?: string;
}

export interface IterationInfo {
  iteration: number;
  stopReason: string;
  toolCount: number;
  usage?: { input: number; output: number; totalTokens: number };
}

export interface StreamWarning {
  type: string;
  message: string;
}

export interface StreamCallbacks {
  onDelta: (delta: string) => void;
  onThinkingDelta: (delta: string) => void;
  onDone: (message: { content?: string; thinking?: string; thinkingDurationMs?: number; usage?: MessageUsage; artifacts?: Artifact[]; generatedImages?: GeneratedImage[]; visuals?: InlineVisual[]; toolCalls?: ChatToolCall[]; toolResults?: ChatToolResult[]; segments?: import("../types").MessageSegment[]; waitingForInput?: boolean; iterations?: number; thinkingPromoted?: boolean }) => void;
  onError: (error: string) => void;
  onToolStatus?: (status: ToolStatus) => void;
  onArtifact?: (artifact: Artifact) => void;
  onVisual?: (visual: InlineVisual) => void;
  onGeneratedImage?: (image: GeneratedImage) => void;
  onSegment?: (segment: import("../types").MessageSegment) => void;
  onAskUser?: (question: string) => void;
  onIteration?: (info: IterationInfo) => void;
  onWarning?: (warning: StreamWarning) => void;
  onCompacting?: () => void;
  onCompaction?: (info: { removedCount: number; remainingCount: number; summaryMessage?: import("../types").ChatMessage | null; midTurn?: boolean; cycle?: number }) => void;
  onAgentOutputComplete?: () => void;
  onTitleUpdate?: (chatId: string, title: string) => void;
  onMessageComplete?: (message: any) => void;
  onFollowUpStart?: (data: any) => void;
  onBackgroundActivity?: (info: { type: string; chatId?: string }) => void;
}

/** Inactivity timeout for SSE streams — server sends keepalive pings every 30s,
 *  so 95s means we tolerate up to two missed pings before timing out. This gives
 *  more headroom for event loop jitter during heavy operations (e.g., SQLite queries,
 *  large context processing, memory extraction). */
const SSE_INACTIVITY_TIMEOUT_MS = 95_000;

/**
 * Read an SSE response body: parse events and forward them to callbacks.
 * Shared by both the POST send path and the GET reconnect path. Handles
 * inactivity timeout (aborting via `controller`), trailing buffer, and the
 * "no done/error event received" safety net.
 */
async function readSSEBody(
  res: Response,
  callbacks: StreamCallbacks,
  controller: AbortController
): Promise<void> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let currentEvent = "";
  let receivedDoneOrError = false;

  let inactivityTimer: ReturnType<typeof setTimeout> | null = null;
  const resetInactivityTimer = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      console.warn("[SSE] inactivity timeout — aborting stream");
      controller.abort();
      callbacks.onError("Model appears unresponsive — try again or switch models");
    }, SSE_INACTIVITY_TIMEOUT_MS);
  };
  resetInactivityTimer();

  const handleLine = (line: string) => {
    if (line.startsWith("event: ")) {
      currentEvent = line.slice(7).trim();
      return;
    }
    if (line.startsWith("data: ")) {
      try {
        const data = JSON.parse(line.slice(6));
        if (currentEvent === "done" || currentEvent === "error") {
          receivedDoneOrError = true;
        }
        if (currentEvent === "description_complete" || currentEvent === "reanalyze_complete") {
          receivedDoneOrError = true;
          console.log("[SSE] Vision completion event received:", currentEvent);
        }
        processSSEEvent(currentEvent, data, callbacks);
      } catch {
        // skip malformed
      }
      currentEvent = "";
      return;
    }
    if (line.trim() === "") {
      currentEvent = "";
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    resetInactivityTimer();
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) handleLine(line);
  }

  if (inactivityTimer) clearTimeout(inactivityTimer);

  if (buffer.trim()) {
    for (const line of buffer.split("\n")) handleLine(line);
  }

  console.log("[SSE] Stream ended, receivedDoneOrError:", receivedDoneOrError);

  if (!receivedDoneOrError) {
    callbacks.onError("Connection lost — no response received from model");
  }
}

function streamSSE(
  url: string,
  body: Record<string, unknown>,
  callbacks: StreamCallbacks
): AbortController {
  const controller = new AbortController();

  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: controller.signal,
    credentials: "include",
  })
    .then(async (res) => {
      if (res.status === 401) {
        emitUnauthorized();
        callbacks.onError("Authentication required");
        return;
      }
      if (!res.ok) {
        const errText = await res.text();
        let err: any = {};
        try {
          err = JSON.parse(errText);
        } catch {
          err = { error: errText || res.statusText };
        }
        callbacks.onError(err.error || "Request failed");
        return;
      }
      await readSSEBody(res, callbacks, controller);
    })
    .catch((e) => {
      if (e.name === "AbortError") return;
      if (e instanceof TypeError || e.name === "TypeError") {
        callbacks.onError("__OFFLINE__:" + e.message);
      } else {
        callbacks.onError(e.message);
      }
    });

  return controller;
}

export function sendMessage(
  chatId: string,
  message: string,
  callbacks: StreamCallbacks,
  images?: ImageAttachment[]
): AbortController {
  return streamSSE(`${BASE}/chat`, { chatId, message, images: images?.length ? images : undefined }, callbacks);
}

/**
 * Check whether the server has an in-flight stream for a chat. Used on mount /
 * page reload to decide whether to reconnect to a live stream.
 */
export async function getChatStatus(
  chatId: string
): Promise<{ active: boolean; bufferedChunks: number; subscribers: number }> {
  try {
    const res = await apiFetch(`${BASE}/chat/status/${encodeURIComponent(chatId)}`);
    if (!res.ok) return { active: false, bufferedChunks: 0, subscribers: 0 };
    return res.json();
  } catch {
    return { active: false, bufferedChunks: 0, subscribers: 0 };
  }
}

/**
 * Attach to a server-side in-flight stream via the reconnect endpoint. The
 * server replays buffered SSE events then streams live events until the turn
 * ends. Returns the AbortController the caller can use to disconnect early.
 *
 * 404 responses (no active stream) are silent — the caller should check
 * getChatStatus first, but races are expected.
 */
export function reconnectChat(chatId: string, callbacks: StreamCallbacks): AbortController {
  const controller = new AbortController();

  fetch(`${BASE}/chat/reconnect/${encodeURIComponent(chatId)}`, {
    method: "GET",
    signal: controller.signal,
    credentials: "include",
  })
    .then(async (res) => {
      if (res.status === 401) {
        emitUnauthorized();
        callbacks.onError("Authentication required");
        return;
      }
      if (res.status === 404) {
        // No active stream — normal case when the turn ended between status
        // check and reconnect. Silent no-op.
        return;
      }
      if (!res.ok) {
        callbacks.onError(`Reconnect failed: HTTP ${res.status}`);
        return;
      }
      await readSSEBody(res, callbacks, controller);
    })
    .catch((e) => {
      if (e.name === "AbortError") return;
      if (e instanceof TypeError || e.name === "TypeError") {
        callbacks.onError("__OFFLINE__:" + e.message);
      } else {
        callbacks.onError(e.message);
      }
    });

  return controller;
}

export async function enqueueMessage(
  chatId: string,
  message: string,
  images?: ImageAttachment[]
): Promise<{ queued: boolean }> {
  const res = await apiFetch(`${BASE}/chat/enqueue`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatId, message, images: images?.length ? images : undefined }),
  });
  if (!res.ok) throw new Error("Failed to enqueue message");
  return res.json();
}

export function editMessage(
  chatId: string,
  messageIndex: number,
  message: string,
  callbacks: StreamCallbacks,
  images?: ImageAttachment[]
): AbortController {
  return streamSSE(`${BASE}/chat/edit`, { chatId, messageIndex, message, images: images?.length ? images : undefined }, callbacks);
}

export async function stopChat(chatId: string): Promise<{ stopped: boolean; reason?: string }> {
  const res = await apiFetch(`${BASE}/chat/stop`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chatId }),
  });
  if (!res.ok) throw new Error("Failed to stop chat");
  return res.json();
}

function processSSEEvent(
  eventType: string,
  data: any,
  callbacks: StreamCallbacks
) {
  switch (eventType) {
    case "text_delta":
      if (data.delta !== undefined) callbacks.onDelta(data.delta);
      break;
    case "thinking_delta":
      if (data.delta !== undefined) callbacks.onThinkingDelta(data.delta);
      break;
    case "done":
      callbacks.onDone({
        content: data.message?.content,
        thinking: data.message?.thinking,
        thinkingDurationMs: data.message?.thinkingDurationMs,
        usage: data.message?.usage,
        artifacts: data.message?.artifacts,
        generatedImages: data.message?.generatedImages,
        visuals: data.message?.visuals,
        toolCalls: data.message?.toolCalls,
        toolResults: data.message?.toolResults,
        segments: data.message?.segments,
        waitingForInput: data.waitingForInput,
        iterations: data.iterations,
        thinkingPromoted: data.message?._thinkingPromoted,
      });
      break;
    case "tool_status":
      callbacks.onToolStatus?.(data);
      break;
    case "segment":
      callbacks.onSegment?.(data);
      break;
    case "artifact":
      callbacks.onArtifact?.(data);
      break;
    case "visual":
      callbacks.onVisual?.(data);
      break;
    case "generated_image":
      callbacks.onGeneratedImage?.(data);
      break;
    case "ask_user":
      callbacks.onAskUser?.(data.question);
      break;
    case "description_complete":
    case "reanalyze_complete":
      // Vision stream completion — forward the raw data as the done payload
      callbacks.onDone(data);
      break;
    case "iteration":
      callbacks.onIteration?.(data);
      break;
    case "warning":
      callbacks.onWarning?.(data);
      break;
    case "compacting":
      callbacks.onCompacting?.();
      break;
    case "compaction":
      callbacks.onCompaction?.(data);
      break;
    case "agent_output_complete":
      callbacks.onAgentOutputComplete?.();
      break;
    case "title_update":
      callbacks.onTitleUpdate?.(data.chatId, data.title);
      break;
    case "message_complete":
      callbacks.onMessageComplete?.(data.message);
      break;
    case "follow_up_start":
      callbacks.onFollowUpStart?.(data);
      break;
    case "background_activity":
      callbacks.onBackgroundActivity?.(data);
      break;
    case "error":
      callbacks.onError(data.error || "Unknown error");
      break;
    default:
      // Fallback for untyped events
      if (data.delta !== undefined) callbacks.onDelta(data.delta);
      else if (data.message) callbacks.onDone({ thinking: data.message?.thinking, usage: data.message?.usage });
      else if (data.error) callbacks.onError(data.error);
  }
}

// --- Image Generation API ---

export interface GenerationState {
  id: string;
  chatId?: string;
  promptId?: string;
  clientId: string;
  params: ImageGenerationParams;
  status: "queued" | "processing" | "completed" | "error";
  progress: { step: number; total: number } | null;
  imageUrl?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export async function fetchComfyUIStatus(): Promise<ComfyUIStatus> {
  const res = await apiFetch(`${BASE}/images/status`);
  if (!res.ok) return { available: false, queueSize: 0, models: [] };
  return res.json();
}

export async function fetchImageModels(): Promise<string[]> {
  const res = await apiFetch(`${BASE}/images/models`);
  if (!res.ok) return [];
  return res.json();
}

export async function fetchGeneratedImages(): Promise<GeneratedImage[]> {
  const res = await apiFetch(`${BASE}/images/list`);
  if (!res.ok) return [];
  return res.json();
}

export async function searchImages(query: string, limit?: number): Promise<Array<GeneratedImage & { score: number }>> {
  const res = await apiFetch(`${BASE}/images/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, limit }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error || "Failed to search images");
  }
  return res.json();
}

export async function deleteGeneratedImage(id: string): Promise<void> {
  const res = await apiFetch(`${BASE}/images/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error || "Failed to delete image");
  }
}

export async function toggleImageFavorite(id: string): Promise<boolean> {
  const res = await apiFetch(`${BASE}/images/${id}/favorite`, { method: "POST" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error || "Failed to toggle favorite");
  }
  const data = await res.json();
  return data.isFavorite;
}

export async function fetchGenerations(): Promise<GenerationState[]> {
  const res = await apiFetch(`${BASE}/images/generations`);
  if (!res.ok) return [];
  return res.json();
}

export interface GenerationCallbacks {
  onState: (state: GenerationState) => void;
  onError: (error: string) => void;
}

/** Inactivity timeout for generation SSE streams (65s — matches chat stream timeout) */
const GENERATION_SSE_INACTIVITY_TIMEOUT_MS = 65_000;

export function subscribeToGeneration(
  generationId: string,
  callbacks: GenerationCallbacks
): AbortController {
  const controller = new AbortController();
  let inactivityTimer: ReturnType<typeof setTimeout> | null = null;

  const resetInactivityTimer = () => {
    if (inactivityTimer) clearTimeout(inactivityTimer);
    inactivityTimer = setTimeout(() => {
      console.warn(`[generation-sse] inactivity timeout for ${generationId}`);
      controller.abort();
      callbacks.onError("Generation stream timed out — try again");
    }, GENERATION_SSE_INACTIVITY_TIMEOUT_MS);
  };

  fetch(`${BASE}/images/generation/${generationId}/events`, {
    signal: controller.signal,
    credentials: "include",
  })
    .then(async (res) => {
      if (res.status === 401) {
        emitUnauthorized();
        callbacks.onError("Authentication required");
        return;
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        callbacks.onError((err as any).error || "Request failed");
        return;
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let currentEvent = "";
      let receivedState = false;

      resetInactivityTimer();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        resetInactivityTimer();
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));
              if (currentEvent === "state") {
                receivedState = true;
                callbacks.onState(data);
              }
            } catch {}
            currentEvent = "";
          }
        }
      }

      if (inactivityTimer) clearTimeout(inactivityTimer);

      // Stream ended naturally — only report error if we never received any state
      // (indicates the generation doesn't exist or is already complete)
      if (!receivedState) {
        console.warn(`[generation-sse] stream ended without state for ${generationId}`);
        callbacks.onError("Generation not found or already completed");
      }
    })
    .catch((e) => {
      if (inactivityTimer) clearTimeout(inactivityTimer);
      if (e.name === "AbortError") return;
      callbacks.onError(e.message);
    });

  return controller;
}

export interface ImageGenerateCallbacks {
  onStarted: (generationId: string) => void;
  onProgress: (step: number, totalSteps: number) => void;
  onDone: (image: GeneratedImage) => void;
  onError: (error: string) => void;
}

export function generateImage(
  params: ImageGenerationParams,
  callbacks: ImageGenerateCallbacks
): AbortController {
  const controller = new AbortController();

  fetch(`${BASE}/images/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
    signal: controller.signal,
    credentials: "include",
  })
    .then(async (res) => {
      if (res.status === 401) {
        emitUnauthorized();
        callbacks.onError("Authentication required");
        return;
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        callbacks.onError((err as any).error || "Request failed");
        return;
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let currentEvent = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));
              if (currentEvent === "started") {
                callbacks.onStarted(data.id);
              } else if (currentEvent === "progress") {
                callbacks.onProgress(data.step, data.totalSteps);
              } else if (currentEvent === "done") {
                callbacks.onDone(data.image);
              } else if (currentEvent === "error") {
                callbacks.onError(data.error);
              }
            } catch {}
            currentEvent = "";
          }
        }
      }
    })
    .catch((e) => {
      if (e.name === "AbortError") return;
      callbacks.onError(e.message);
    });

  return controller;
}

// --- Vision Analysis API ---

export interface VisionPreset {
  key: string;
  name: string;
  prompt: string;
  markdown: boolean;
}

export interface VisionMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

export interface AnalyzedImage {
  id: string;
  filename: string;
  url: string;
  description: string;
  preset: string;
  model: string;
  conversation: VisionMessage[];
  createdAt: string;
}

export async function fetchVisionPresets(): Promise<VisionPreset[]> {
  const res = await apiFetch(`${BASE}/vision/presets`);
  if (!res.ok) return [];
  return res.json();
}

export async function fetchAnalyzedImages(): Promise<AnalyzedImage[]> {
  const res = await apiFetch(`${BASE}/vision/images`);
  if (!res.ok) return [];
  return res.json();
}

export async function fetchAnalyzedImage(id: string): Promise<AnalyzedImage> {
  const res = await apiFetch(`${BASE}/vision/images/${id}`);
  if (!res.ok) throw new Error("Failed to fetch analyzed image");
  return res.json();
}

export async function analyzeImage(
  imageData: string,
  preset: string,
  model?: string
): Promise<AnalyzedImage> {
  const res = await apiFetch(`${BASE}/vision/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageData, preset, model }),
  });
  if (!res.ok) {
    const errText = await res.text();
    let err: any = {};
    try {
      err = JSON.parse(errText);
    } catch {
      err = { error: errText || res.statusText };
    }
    throw new Error((err as any).error || "Failed to analyze image");
  }
  return res.json();
}

export async function saveAnalyzedImage(
  imageData: string,
  description: string,
  preset: string,
  model: string
): Promise<AnalyzedImage> {
  const res = await apiFetch(`${BASE}/vision/save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageData, description, preset, model }),
  });
  if (!res.ok) {
    const errText = await res.text();
    let err: any = {};
    try {
      err = JSON.parse(errText);
    } catch {
      err = { error: errText || res.statusText };
    }
    throw new Error((err as any).error || "Failed to save analyzed image");
  }
  return res.json();
}

export interface VisionAnalyzeCallbacks {
  onDelta: (delta: string) => void;
  onDone: (result: { description: string; preset: string; model: string }) => void;
  onError: (error: string) => void;
}

export function streamAnalyzeImage(
  imageData: string,
  preset: string,
  model: string | undefined,
  callbacks: VisionAnalyzeCallbacks
): AbortController {
  return streamSSE(`${BASE}/vision/analyze-stream`, { imageData, preset, model }, {
    onDelta: callbacks.onDelta,
    onThinkingDelta: () => {},
    onDone: (msg) => {
      const m = msg as any;
      if (m?.description) {
        callbacks.onDone({ description: m.description, preset: m.preset, model: m.model });
      }
    },
    onError: callbacks.onError,
  });
}

export async function chatAboutImage(
  id: string,
  message: string
): Promise<{ response: string }> {
  const res = await apiFetch(`${BASE}/vision/images/${id}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error || "Failed to chat about image");
  }
  return res.json();
}

export async function reanalyzeImage(
  id: string,
  preset: string
): Promise<AnalyzedImage> {
  const res = await apiFetch(`${BASE}/vision/images/${id}/reanalyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ preset }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error || "Failed to re-analyze image");
  }
  return res.json();
}

export interface ReanalyzeCallbacks {
  onDelta: (delta: string) => void;
  onDone: (image: AnalyzedImage) => void;
  onError: (error: string) => void;
}

export function streamReanalyzeImage(
  id: string,
  preset: string,
  callbacks: ReanalyzeCallbacks
): AbortController {
  return streamSSE(`${BASE}/vision/images/${id}/reanalyze`, { preset, stream: true }, {
    onDelta: callbacks.onDelta,
    onThinkingDelta: () => {},
    onDone: (msg) => {
      const m = msg as any;
      if (m?.id) {
        callbacks.onDone(m);
      }
    },
    onError: callbacks.onError,
  });
}

export async function deleteAnalyzedImage(id: string): Promise<void> {
  const res = await apiFetch(`${BASE}/vision/images/${id}`, {
    method: "DELETE",
  });
  if (!res.ok) throw new Error("Failed to delete analyzed image");
}

// --- Memory API ---

export async function searchMemories(query: string, topK = 10): Promise<(import("../types").MemorySummary & { score: number })[]> {
  const res = await apiFetch(`${BASE}/memory/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, topK }),
  });
  if (!res.ok) throw new Error("Failed to search memories");
  return res.json();
}

export async function fetchAllMemories(sortBy?: string): Promise<import("../types").MemorySummary[]> {
  const params = sortBy ? `?sortBy=${sortBy}` : "";
  const res = await apiFetch(`${BASE}/memory${params}`);
  if (!res.ok) throw new Error("Failed to fetch memories");
  return res.json();
}

export async function deleteMemory(id: string): Promise<void> {
  const res = await apiFetch(`${BASE}/memory/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete memory");
}

export async function fetchMemoryLineage(id: string): Promise<import("../types").MemoryLineage> {
  const res = await apiFetch(`${BASE}/memory/${id}/lineage`);
  if (!res.ok) throw new Error("Failed to fetch memory lineage");
  return res.json();
}

// Memory Blocks API

export async function fetchMemoryBlocks(scope?: string, projectId?: string): Promise<import("../types").MemoryBlock[]> {
  const params = new URLSearchParams();
  if (scope) params.set("scope", scope);
  if (projectId) params.set("projectId", projectId);
  const qs = params.toString();
  const res = await apiFetch(`${BASE}/memory/blocks${qs ? `?${qs}` : ""}`);
  if (!res.ok) throw new Error("Failed to fetch memory blocks");
  return res.json();
}

export async function createMemoryBlockApi(block: { name: string; description: string; content: string; scope?: string; projectId?: string }): Promise<import("../types").MemoryBlock> {
  const res = await apiFetch(`${BASE}/memory/blocks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(block),
  });
  if (!res.ok) throw new Error("Failed to create memory block");
  return res.json();
}

export async function updateMemoryBlockApi(id: string, updates: { content?: string; description?: string; name?: string }): Promise<import("../types").MemoryBlock> {
  const res = await apiFetch(`${BASE}/memory/blocks/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!res.ok) throw new Error("Failed to update memory block");
  return res.json();
}

export async function deleteMemoryBlockApi(id: string): Promise<void> {
  const res = await apiFetch(`${BASE}/memory/blocks/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete memory block");
}

export async function fetchBlockHistory(id: string): Promise<import("../types").MemoryBlock[]> {
  const res = await apiFetch(`${BASE}/memory/blocks/${id}/history`);
  if (!res.ok) throw new Error("Failed to fetch block history");
  return res.json();
}

export async function searchConversations(query: string, chatId?: string, limit?: number): Promise<import("../types").ConversationSearchResult[]> {
  const res = await apiFetch(`${BASE}/memory/conversations/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, chatId, limit }),
  });
  if (!res.ok) throw new Error("Failed to search conversations");
  return res.json();
}

// --- Synthesis API ---

export interface SynthesisStatus {
  lastSynthesis: string | null;
  memoryCount: number;
  isSynthesizing: boolean;
}

// Response from POST /synthesis/run and /synthesis/sleep. Synthesis is
// dispatched asynchronously (202 Accepted); completion is observed via
// /synthesis/status polling.
export interface SynthesisDispatchResult {
  started: boolean;
  sleepModeTriggeredAt?: string;
}

export async function fetchSynthesisStatus(): Promise<SynthesisStatus> {
  const res = await apiFetch(`${BASE}/memory/synthesis/status`);
  if (!res.ok) throw new Error("Failed to fetch synthesis status");
  return res.json();
}

export async function triggerSynthesis(): Promise<SynthesisDispatchResult> {
  const res = await apiFetch(`${BASE}/memory/synthesis/run`, {
    method: "POST",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to trigger synthesis");
  }
  return res.json();
}

export async function triggerSleepMode(): Promise<SynthesisDispatchResult> {
  const res = await apiFetch(`${BASE}/memory/synthesis/sleep`, {
    method: "POST",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to trigger sleep mode");
  }
  return res.json();
}

// --- Skills API ---

export interface SkillInfo {
  name: string;
  description: string;
  source?: "global" | "project";
  projectId?: string;
}

export async function fetchSkills(projectId?: string): Promise<SkillInfo[]> {
  const url = `${BASE}/skills` + (projectId ? `?projectId=${encodeURIComponent(projectId)}` : "");
  const res = await apiFetch(url);
  if (!res.ok) throw new Error("Failed to fetch skills");
  return res.json();
}

export async function installSkill(url: string, name?: string): Promise<{ name: string; path: string; message: string }> {
  const res = await apiFetch(`${BASE}/skills/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, name }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error || "Failed to install skill");
  }
  return res.json();
}

export async function deleteSkill(name: string): Promise<{ success: boolean; message: string }> {
  const res = await apiFetch(`${BASE}/skills/${encodeURIComponent(name)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error || "Failed to delete skill");
  }
  return res.json();
}

// --- Projects API ---

export interface Project {
  id: string;
  name: string;
  path: string;
  color: string;
  pinned: boolean;
  createdAt: string;
  lastModified: string;
}

export async function fetchProjects(): Promise<Project[]> {
  const res = await apiFetch(`${BASE}/projects`);
  if (!res.ok) throw new Error("Failed to fetch projects");
  return res.json();
}

export async function createProject(name: string, path: string): Promise<Project> {
  const res = await apiFetch(`${BASE}/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, path }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error || "Failed to create project");
  }
  return res.json();
}

export async function updateProject(id: string, updates: { name?: string; path?: string }): Promise<Project> {
  const res = await apiFetch(`${BASE}/projects/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error || "Failed to update project");
  }
  return res.json();
}

export async function deleteProject(id: string): Promise<void> {
  const res = await apiFetch(`${BASE}/projects/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete project");
}

export async function getProjectAgentsMd(id: string): Promise<{ content: string | null; path: string }> {
  const res = await apiFetch(`${BASE}/projects/${id}/agents-md`);
  if (!res.ok) throw new Error("Failed to fetch AGENTS.md");
  return res.json();
}

// --- Notebook API ---

export async function fetchUserNotebooks(): Promise<NotebookIndex> {
  const res = await apiFetch(`${BASE}/notebooks/user`);
  if (!res.ok) throw new Error("Failed to fetch user notebooks");
  return res.json();
}

export async function fetchAgentNotebooks(): Promise<NotebookIndex> {
  const res = await apiFetch(`${BASE}/notebooks/agent`);
  if (!res.ok) throw new Error("Failed to fetch agent notebooks");
  return res.json();
}

export async function fetchNotebookEntry(author: 'user' | 'agent', id: string): Promise<NotebookEntry> {
  const res = await apiFetch(`${BASE}/notebooks/${author}/${id}`);
  if (!res.ok) throw new Error("Failed to fetch notebook entry");
  return res.json();
}

export async function fetchNotebookEntriesBulk(entries: { author: 'user' | 'agent'; id: string }[]): Promise<Record<string, NotebookEntry | null>> {
  const res = await apiFetch(`${BASE}/notebooks/bulk`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entries }),
  });
  if (!res.ok) throw new Error("Failed to fetch notebook entries");
  return res.json();
}

export async function createNotebookEntry(author: 'user' | 'agent', content: string, images?: ImageAttachment[]): Promise<NotebookEntry> {
  const res = await apiFetch(`${BASE}/notebooks/${author}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content, images: images?.length ? images : undefined }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error || "Failed to create notebook entry");
  }
  return res.json();
}

export async function updateNotebookEntry(
  author: 'user' | 'agent',
  id: string,
  updates: { content?: string; links?: NotebookLink }
): Promise<NotebookEntry> {
  const res = await apiFetch(`${BASE}/notebooks/${author}/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error || "Failed to update notebook entry");
  }
  return res.json();
}

export async function deleteNotebookEntry(author: 'user' | 'agent', id: string): Promise<void> {
  const res = await apiFetch(`${BASE}/notebooks/${author}/${id}`, { method: "DELETE" });
  if (!res.ok) throw new Error("Failed to delete notebook entry");
}

export async function triggerAgentNotebookReview(): Promise<{ skipped?: boolean; reason?: string } | NotebookEntry> {
  const res = await apiFetch(`${BASE}/notebooks/agent/trigger`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error || "Failed to trigger agent review");
  }
  return res.json();
}

export async function createChat(id: string, modelId: string, type: ChatType = "quick", projectId?: string): Promise<Chat> {
  const res = await apiFetch(`${BASE}/chats`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, modelId, type, projectId }),
  });
  if (!res.ok) throw new Error("Failed to create chat");
  return res.json();
}

// ---------------------------------------------------------------------------
// User UI State Persistence
// ---------------------------------------------------------------------------

export interface UserUIState {
  sidebarState?: {
    projectsExpanded: boolean;
    agentExpanded: boolean;
    quickExpanded: boolean;
    projectStates: Record<string, boolean>;
  };
  notebookLastSeen?: string | null;
  activeChatId?: string | null;
  activeView?: 'chats' | 'notebooks' | 'image-sandbox';
}

export async function fetchUserUIState(): Promise<UserUIState> {
  const res = await apiFetch(`${BASE}/ui-state`);
  if (!res.ok) throw new Error("Failed to fetch UI state");
  return res.json();
}

export async function saveUserUIState(state: Partial<UserUIState>): Promise<UserUIState> {
  const res = await apiFetch(`${BASE}/ui-state`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state),
  });
  if (!res.ok) throw new Error("Failed to save UI state");
  return res.json();
}

export async function fetchChat(id: string): Promise<Chat> {
  const res = await apiFetch(`${BASE}/chats/${id}`);
  if (!res.ok) throw new Error("Failed to fetch chat");
  return res.json();
}

// --- Inference Server Health ---

export type ServerHealth = "ok" | "unavailable";
export interface ServerHealthMap {
  inference: ServerHealth;
  extraction: ServerHealth;
  reranker: ServerHealth;
  embedding: ServerHealth;
  ollama: ServerHealth;
}

export async function getAllServerHealth(): Promise<ServerHealthMap> {
  const res = await apiFetch(`${BASE}/models/health-all`);
  if (!res.ok) throw new Error("Failed to fetch server health");
  return res.json();
}

// --- Llama.cpp Path Management ---

export async function getLlamaPath(): Promise<LlamaPathInfo> {
  const res = await apiFetch(`${BASE}/settings/llama-path`);
  if (!res.ok) throw new Error("Failed to fetch llama.cpp path info");
  return res.json();
}

export async function updateLlamaPathApi(newPath: string): Promise<LlamaPathUpdateResult> {
  const res = await apiFetch(`${BASE}/settings/llama-path`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: newPath }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to update llama.cpp path");
  }
  return res.json();
}

export async function validateLlamaPathApi(candidatePath: string): Promise<{ valid: boolean; error?: string }> {
  const res = await apiFetch(`${BASE}/settings/llama-path/validate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: candidatePath }),
  });
  if (!res.ok) throw new Error("Failed to validate path");
  return res.json();
}

// --- Embedding Migration ---

export interface EmbeddingBackup {
  id: string;
  createdAt: string;
  label?: string;
  embedding: { provider: string; url: string; model: string; dimension?: number };
  counts: { memories: number; corpus: number };
  sourceSizes: { memoriesBytes: number; corpusBytes: number };
}

export interface MigrationProgressEvent {
  phase: "probe" | "memories" | "corpus" | "commit" | "done" | "error";
  processed?: number;
  total?: number;
  message?: string;
}

export async function listEmbeddingBackups(): Promise<EmbeddingBackup[]> {
  const res = await apiFetch(`${BASE}/embedding/backups`);
  if (!res.ok) throw new Error("Failed to list backups");
  const data = await res.json();
  return data.backups || [];
}

export async function createEmbeddingBackup(label?: string): Promise<EmbeddingBackup> {
  const res = await apiFetch(`${BASE}/embedding/backup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to create backup");
  }
  const data = await res.json();
  return data.manifest;
}

export async function deleteEmbeddingBackup(id: string): Promise<void> {
  const res = await apiFetch(`${BASE}/embedding/backup/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to delete backup");
  }
}

export async function restoreEmbeddingBackup(id: string): Promise<void> {
  const res = await apiFetch(`${BASE}/embedding/restore/${encodeURIComponent(id)}`, {
    method: "POST",
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Failed to restore backup");
  }
}

export interface EmbeddingMigrationCallbacks {
  onProgress: (ev: MigrationProgressEvent) => void;
  onComplete: (result: { memories: number; corpus: number; dimension: number }) => void;
  onError: (message: string) => void;
}

export function runEmbeddingMigration(cb: EmbeddingMigrationCallbacks): () => void {
  const controller = new AbortController();
  (async () => {
    try {
      const res = await apiFetch(`${BASE}/embedding/migrate`, {
        method: "POST",
        signal: controller.signal,
      });
      if (!res.ok || !res.body) {
        cb.onError(`Failed to start migration (${res.status})`);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const lines = block.split("\n");
          let event = "message";
          let data = "";
          for (const line of lines) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            else if (line.startsWith("data:")) data = line.slice(5).trim();
          }
          if (!data) continue;
          try {
            const payload = JSON.parse(data);
            if (event === "progress") cb.onProgress(payload);
            else if (event === "complete") cb.onComplete(payload);
            else if (event === "error") cb.onError(payload.message || "Migration failed");
          } catch {
            // ignore malformed
          }
        }
      }
    } catch (e: any) {
      if (e?.name !== "AbortError") cb.onError(e?.message || String(e));
    }
  })();
  return () => controller.abort();
}
