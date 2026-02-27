import type { Artifact, Chat, ChatListItem, ChatType, MessageUsage, OllamaModel, Settings } from "../types";

const BASE = "/api";

function emitUnauthorized() {
  window.dispatchEvent(new CustomEvent("auth:unauthorized"));
}

async function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(input, {
    ...init,
    credentials: "include",
  });
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

export interface StreamCallbacks {
  onDelta: (delta: string) => void;
  onThinkingDelta: (delta: string) => void;
  onDone: (message: { thinking?: string; usage?: MessageUsage; artifacts?: Artifact[]; waitingForInput?: boolean }) => void;
  onError: (error: string) => void;
  onToolStatus?: (status: ToolStatus) => void;
  onArtifact?: (artifact: Artifact) => void;
  onAskUser?: (question: string) => void;
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
        const err = await res.json();
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
      if (e.name !== "AbortError") {
        callbacks.onError(e.message);
      }
    });

  return controller;
}

export function sendMessage(
  chatId: string,
  message: string,
  callbacks: StreamCallbacks
): AbortController {
  return streamSSE(`${BASE}/chat`, { chatId, message }, callbacks);
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
        waitingForInput: data.waitingForInput,
      });
      break;
    case "tool_status":
      callbacks.onToolStatus?.(data);
      break;
    case "artifact":
      callbacks.onArtifact?.(data);
      break;
    case "ask_user":
      callbacks.onAskUser?.(data.question);
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
