import type { Artifact, Chat, ChatListItem, ChatToolCall, ChatToolResult, ChatType, ComfyUIStatus, GeneratedImage, ImageAttachment, ImageGenerationParams, MessageUsage, OllamaModel, Settings } from "../types";

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

export async function fetchChats(): Promise<ChatListItem[]> {
  const res = await apiFetch(`${BASE}/chats`);
  if (!res.ok) throw new Error("Failed to fetch chats");
  return res.json();
}

export async function createChat(modelId: string, type: ChatType = "quick"): Promise<Chat> {
  const res = await apiFetch(`${BASE}/chats`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ modelId, type }),
  });
  if (!res.ok) throw new Error("Failed to create chat");
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
}

export interface StreamWarning {
  type: string;
  message: string;
}

export interface StreamCallbacks {
  onDelta: (delta: string) => void;
  onThinkingDelta: (delta: string) => void;
  onDone: (message: { thinking?: string; usage?: MessageUsage; artifacts?: Artifact[]; generatedImages?: GeneratedImage[]; toolCalls?: ChatToolCall[]; toolResults?: ChatToolResult[]; segments?: import("../types").MessageSegment[]; waitingForInput?: boolean; iterations?: number }) => void;
  onError: (error: string) => void;
  onToolStatus?: (status: ToolStatus) => void;
  onArtifact?: (artifact: Artifact) => void;
  onGeneratedImage?: (image: GeneratedImage) => void;
  onAskUser?: (question: string) => void;
  onIteration?: (info: IterationInfo) => void;
  onWarning?: (warning: StreamWarning) => void;
  onCompaction?: (info: { removedCount: number; remainingCount: number }) => void;
  onTitleUpdate?: (chatId: string, title: string) => void;
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
          // Response wasn't JSON (e.g., HTML error page)
          err = { error: errText || res.statusText };
        }
        callbacks.onError(err.error || "Request failed");
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
            continue;
          }
          if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));
              processSSEEvent(currentEvent, data, callbacks);
            } catch {
              // skip malformed
            }
            currentEvent = "";
            continue;
          }
          // Empty line resets event type
          if (line.trim() === "") {
            currentEvent = "";
          }
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        for (const line of buffer.split("\n")) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim();
          } else if (line.startsWith("data: ")) {
            try {
              const data = JSON.parse(line.slice(6));
              processSSEEvent(currentEvent, data, callbacks);
            } catch {}
            currentEvent = "";
          }
        }
      }
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

export function editMessage(
  chatId: string,
  messageIndex: number,
  message: string,
  callbacks: StreamCallbacks
): AbortController {
  return streamSSE(`${BASE}/chat/edit`, { chatId, messageIndex, message }, callbacks);
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
        thinking: data.message?.thinking,
        usage: data.message?.usage,
        artifacts: data.message?.artifacts,
        generatedImages: data.message?.generatedImages,
        toolCalls: data.message?.toolCalls,
        toolResults: data.message?.toolResults,
        segments: data.message?.segments,
        waitingForInput: data.waitingForInput,
        iterations: data.iterations,
      });
      break;
    case "tool_status":
      callbacks.onToolStatus?.(data);
      break;
    case "artifact":
      callbacks.onArtifact?.(data);
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
    case "compaction":
      callbacks.onCompaction?.(data);
      break;
    case "title_update":
      callbacks.onTitleUpdate?.(data.chatId, data.title);
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

export async function deleteGeneratedImage(id: string): Promise<void> {
  const res = await apiFetch(`${BASE}/images/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error || "Failed to delete image");
  }
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

export function subscribeToGeneration(
  generationId: string,
  callbacks: GenerationCallbacks
): AbortController {
  const controller = new AbortController();

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
              if (currentEvent === "state") {
                callbacks.onState(data);
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

// --- Skills API ---

export interface SkillInfo {
  name: string;
  description: string;
}

export async function fetchSkills(): Promise<SkillInfo[]> {
  const res = await apiFetch(`${BASE}/skills`);
  if (!res.ok) throw new Error("Failed to fetch skills");
  return res.json();
}
