import type { Chat, ChatMessage } from "../types.js";
import { appendChatMessageRow, getChat, getChatTitle, getDb, listChats } from "./chat-storage.js";
import { buildTimeAnchor } from "./memory-context.js";

export interface ResolvedCrossChatTarget {
  id: string;
  title: string;
  type: Chat["type"];
}

export type CrossChatTargetResolution =
  | { ok: true; target: ResolvedCrossChatTarget }
  | { ok: false; error: string };

function isPostableType(type: Chat["type"]): boolean {
  return type === "agent" || type === "system";
}

/**
 * Resolve `targetChat` to a postable chat: an exact chat id first, else a
 * unique case-insensitive title fragment. Quick chats are not valid targets.
 */
export async function resolveCrossChatTarget(targetChat: string): Promise<CrossChatTargetResolution> {
  const trimmed = (targetChat ?? "").trim();
  if (!trimmed) {
    return { ok: false, error: "targetChat is required — pass a chat id or a unique title fragment." };
  }

  const direct = await getChat(trimmed);
  if (direct) {
    if (!isPostableType(direct.type)) {
      return {
        ok: false,
        error: `"${direct.title}" is a ${direct.type} chat — posts can target agent and system chats only.`,
      };
    }
    return { ok: true, target: { id: direct.id, title: direct.title, type: direct.type } };
  }

  const chats = await listChats();
  const needle = trimmed.toLowerCase();
  const matches = chats.filter((chat) => chat.title.toLowerCase().includes(needle));

  if (matches.length === 0) {
    return {
      ok: false,
      error: `No chat matches "${trimmed}". Use list_chats to enumerate chats and their ids.`,
    };
  }
  if (matches.length > 1) {
    const candidates = matches
      .slice(0, 12)
      .map((chat) => `- ${chat.title} (${chat.id}) [${chat.type}]`)
      .join("\n");
    return {
      ok: false,
      error: `"${trimmed}" matches ${matches.length} chats — pass a chat id or a more specific title:\n${candidates}`,
    };
  }

  const match = matches[0];
  if (!isPostableType(match.type)) {
    return {
      ok: false,
      error: `"${match.title}" is a ${match.type} chat — posts can target agent and system chats only.`,
    };
  }
  return { ok: true, target: { id: match.id, title: match.title, type: match.type } };
}

/** Local "MM-DD HH:mm" stamp used in the provenance envelope. */
export function formatCrossChatStamp(atIso: string): string {
  const date = new Date(atIso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * Envelope + subject + body. The model sees an ordinary user message; the
 * bracketed header carries attribution so a user-role row never impersonates
 * the user silently. `formatCrossChatStamp(metadata.at)` is pinned to the
 * header stamp by test.
 */
export function formatCrossChatEnvelope(
  fromChatTitle: string,
  atIso: string,
  subject: string,
  body: string,
): string {
  const header = `[quje from ${fromChatTitle} — ${formatCrossChatStamp(atIso)}]`;
  const subjectPart = subject.trim() ? ` ${subject.trim()}` : "";
  return `${header}${subjectPart}\n\n${body.trim()}`;
}

export function buildCrossChatPostRow(input: {
  targetChat: Chat;
  fromChatId: string;
  fromChatTitle: string;
  subject: string;
  body: string;
  at?: string;
  originTaskId?: string;
  originRunId?: string;
}): ChatMessage {
  const at = input.at ?? new Date().toISOString();
  return {
    role: "user",
    content: formatCrossChatEnvelope(input.fromChatTitle, at, input.subject, input.body),
    timestamp: Date.now(),
    // Frozen against the target's tail at append time so later replays carry
    // the exact tokens this row's delivery used.
    timeAnchor: buildTimeAnchor(input.targetChat.messages),
    _crossChatPost: {
      fromChatId: input.fromChatId,
      fromChatTitle: input.fromChatTitle,
      subject: input.subject.trim(),
      at,
      ...(input.originTaskId ? { originTaskId: input.originTaskId } : {}),
      ...(input.originRunId ? { originRunId: input.originRunId } : {}),
    },
  };
}

/** Idempotency probe: has this task already delivered a row to this chat? */
export function findCrossChatPostByTask(chatId: string, originTaskId: string): ChatMessage | null {
  const row = getDb().prepare(`
    SELECT sequence, payload_json
    FROM chat_message_rows
    WHERE chat_id = ?
      AND json_valid(payload_json)
      AND json_extract(payload_json, '$._crossChatPost.originTaskId') = ?
    LIMIT 1
  `).get(chatId, originTaskId) as { sequence: number; payload_json: string } | undefined;
  if (!row) return null;
  try {
    const message = JSON.parse(row.payload_json) as ChatMessage;
    message._rowSequence = row.sequence;
    return message;
  } catch {
    return null;
  }
}

export interface CrossChatDeliveryResult {
  /** False when the row already existed for this task (idempotent no-op). */
  delivered: boolean;
  chatId: string;
  chatTitle: string;
  rowSequence: number;
}

/**
 * Append a cross-chat post to its target. Validates the target still exists
 * (no resurrection), checks `originTaskId` idempotency, and appends under the
 * per-chat write lock. No LLM.
 */
export async function deliverCrossChatPost(input: {
  targetChatId: string;
  fromChatId: string;
  fromChatTitle: string;
  subject: string;
  body: string;
  at?: string;
  originTaskId?: string;
  originRunId?: string;
}): Promise<CrossChatDeliveryResult> {
  const target = await getChat(input.targetChatId);
  if (!target) {
    throw new Error(`Target chat ${input.targetChatId} no longer exists`);
  }
  if (!isPostableType(target.type)) {
    throw new Error(`Target chat "${target.title}" is a ${target.type} chat — posts can target agent and system chats only.`);
  }

  if (input.originTaskId) {
    const existing = findCrossChatPostByTask(input.targetChatId, input.originTaskId);
    if (existing) {
      return {
        delivered: false,
        chatId: target.id,
        chatTitle: target.title,
        rowSequence: existing._rowSequence ?? -1,
      };
    }
  }

  const row = buildCrossChatPostRow({
    targetChat: target,
    fromChatId: input.fromChatId,
    fromChatTitle: input.fromChatTitle,
    subject: input.subject,
    body: input.body,
    at: input.at,
    originTaskId: input.originTaskId,
    originRunId: input.originRunId,
  });
  const stored = await appendChatMessageRow(input.targetChatId, row);
  return {
    delivered: true,
    chatId: target.id,
    chatTitle: target.title,
    rowSequence: stored._rowSequence ?? -1,
  };
}

/** Origin chat title for the envelope, falling back to the id. */
export function crossChatOriginTitle(fromChatId: string): string {
  return getChatTitle(fromChatId) ?? fromChatId;
}
