import { createHash } from "crypto";
import type { Message } from "@earendil-works/pi-ai";

/**
 * Cross-request KV-prefix diagnostics.
 *
 * The prompt that llama.cpp caches is: system prompt (which embeds the tool
 * schemas) + message transcript. Two independent things can silently change
 * the token stream between requests:
 *
 *   1. The message transcript — caught by replay-vs-replay and wire-vs-replay
 *      digests below.
 *   2. The tool surface — tool definitions render into the system prompt, but
 *      they are not part of any ChatMessage, so message digests cannot see
 *      them. `wireToolDigest` closes that blind spot.
 *
 * Snapshots are recorded per chat:
 *   - `recordWireSnapshot` runs in the provider on every real turn request
 *     (HTTP and headless), so the snapshot always reflects the ACTUAL last
 *     wire — not just the last HTTP turn.
 *   - `recordReplaySnapshot` runs at HTTP turn end with the digest of what
 *     `chatMessagesToPiMessages` rebuilds from persisted rows.
 *
 * The next send compares its rebuilt history against both. A live-vs-replay
 * mismatch means the cached prefix cannot be reused; a tool-surface change
 * means the rendered prompt head diverges before the transcript even matters.
 */

export interface ToolSurface {
  digest: string;
  names: string[];
}

export interface PrefixSnapshot {
  /** Digest of the replayed persisted prefix (chatMessagesToPiMessages). */
  replayDigest: string;
  replayMsgCount: number;
  /** Digest of the role+content shape of the last actual wire request. */
  wireDigest: string | null;
  wireMsgCount: number | null;
  /** Digest + names of the tool surface on the last actual wire request. */
  wireToolDigest: string | null;
  wireToolNames: string[] | null;
  wireAt: number | null;
}

type WireMessage = { role: string; content?: unknown };

const prefixSnapshots = new Map<string, PrefixSnapshot>();

export function digestPiMessages(piMessages: Message[]): string {
  const hash = createHash("sha1");
  for (const m of piMessages) {
    hash.update(JSON.stringify(m));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}

/** Token-relevant shape digest: role + content only (no usage/timestamps). */
export function digestWireShape(messages: WireMessage[]): string {
  const hash = createHash("sha1");
  for (const m of messages) {
    hash.update(String(m.role));
    hash.update("\0");
    hash.update(JSON.stringify((m as { content?: unknown }).content ?? null));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}

/**
 * Digest the serialized tool array exactly as it will be sent (order + all
 * fields). Undefined means "no tools array"; an empty array is a distinct,
 * valid surface.
 */
export function digestToolSurface(tools: unknown[] | undefined): ToolSurface | null {
  if (!Array.isArray(tools)) return null;
  const names = tools.map((tool) => {
    const fn = (tool as { function?: { name?: unknown } } | null)?.function;
    const direct = (tool as { name?: unknown } | null)?.name;
    const name = fn?.name ?? direct;
    return typeof name === "string" ? name : "?";
  });
  const hash = createHash("sha1");
  hash.update(JSON.stringify(tools));
  return { digest: hash.digest("hex").slice(0, 12), names };
}

export function recordReplaySnapshot(chatId: string, replayDigest: string, replayMsgCount: number): void {
  const previous = prefixSnapshots.get(chatId);
  prefixSnapshots.set(chatId, {
    replayDigest,
    replayMsgCount,
    wireDigest: previous?.wireDigest ?? null,
    wireMsgCount: previous?.wireMsgCount ?? null,
    wireToolDigest: previous?.wireToolDigest ?? null,
    wireToolNames: previous?.wireToolNames ?? null,
    wireAt: previous?.wireAt ?? null,
  });
}

export function recordWireSnapshot(
  chatId: string,
  wireMessages: WireMessage[],
  tools: unknown[] | undefined,
): { toolsChanged: boolean; previousToolNames: string[] | null; toolSurface: ToolSurface | null } {
  const previous = prefixSnapshots.get(chatId);
  const toolSurface = digestToolSurface(tools);
  const toolsChanged =
    previous?.wireToolDigest != null &&
    toolSurface != null &&
    previous.wireToolDigest !== toolSurface.digest;

  prefixSnapshots.set(chatId, {
    replayDigest: previous?.replayDigest ?? "",
    replayMsgCount: previous?.replayMsgCount ?? 0,
    wireDigest: digestWireShape(wireMessages),
    wireMsgCount: wireMessages.length,
    wireToolDigest: toolSurface?.digest ?? null,
    wireToolNames: toolSurface?.names ?? null,
    wireAt: Date.now(),
  });

  return {
    toolsChanged,
    previousToolNames: previous?.wireToolNames ?? null,
    toolSurface,
  };
}

export function getPrefixSnapshot(chatId: string): PrefixSnapshot | undefined {
  return prefixSnapshots.get(chatId);
}
