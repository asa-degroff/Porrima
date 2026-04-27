import type { Request, Response } from "express";

// ---------------------------------------------------------------------------
// Live stream registry — supports reconnect and runs to completion regardless
// of subscriber count.
//
// Every chat turn (and every server-internal background task that wants to
// stream output to the system chat — synthesis, wake cycle) gets a LiveStream
// keyed by chatId. For HTTP-driven turns, res.write() is patched to route
// through emitToStream, which fans out to all attached subscribers AND appends
// to a bounded replay buffer. For server-internal tasks, there's no primary
// res — the stream starts headless, and any subscriber attaching via
// /reconnect/:chatId picks up the buffered events and continues live.
//
// Streams are never aborted just because subscribers disconnected. The model
// keeps generating in the background; reconnects replay the buffer; the next
// turn on the same chat replaces the stream; explicit /stop aborts via
// activeStreams. At end-of-turn the stream is closed and kept briefly so late
// reconnecters can see the final events.
// ---------------------------------------------------------------------------

export interface LiveStreamSubscriber {
  /** Native write captured before res.write was patched. */
  write: (chunk: string) => boolean;
  res: Response;
  isPrimary: boolean;
}

export interface LiveStream {
  chatId: string;
  abort: AbortController;
  /** Bounded replay buffer — chunks are SSE frames already formatted. */
  buffer: string[];
  bufferBytes: number;
  subscribers: Set<LiveStreamSubscriber>;
  ended: boolean;
  /** Headless streams have no primary subscriber — they outlive disconnect by design. */
  headless: boolean;
}

export const liveStreams: Map<string, LiveStream> =
  (globalThis as any)._liveStreams || new Map();
(globalThis as any)._liveStreams = liveStreams;

// Legacy alias so /stop and other callers keep working without churn.
// Points at the same map but exposes the AbortController per chat.
export const activeStreams: Map<string, AbortController> =
  (globalThis as any)._activeChatStreams || new Map<string, AbortController>();
(globalThis as any)._activeChatStreams = activeStreams;

const LIVE_BUFFER_MAX_BYTES = 10 * 1024 * 1024; // 10MB cap per chat
const LIVE_END_RETENTION_MS = 60_000;

export function emitToStream(stream: LiveStream, chunk: string): void {
  if (stream.ended) return;
  // Use UTF-8 byte length, not chunk.length (UTF-16 code units): tool results
  // and segment payloads can carry multi-byte content (CJK, emoji, escaped
  // unicode), and the cap is denominated in bytes.
  const byteLen = Buffer.byteLength(chunk);
  stream.buffer.push(chunk);
  stream.bufferBytes += byteLen;
  while (stream.bufferBytes > LIVE_BUFFER_MAX_BYTES && stream.buffer.length > 1) {
    stream.bufferBytes -= Buffer.byteLength(stream.buffer.shift()!);
  }
  for (const sub of stream.subscribers) {
    if (sub.res.writableEnded || sub.res.destroyed) {
      stream.subscribers.delete(sub);
      continue;
    }
    try {
      sub.write(chunk);
    } catch {
      stream.subscribers.delete(sub);
    }
  }
}

export function detachSubscriber(stream: LiveStream, sub: LiveStreamSubscriber): void {
  stream.subscribers.delete(sub);
  // Streams run to completion regardless of subscriber count. The model keeps
  // generating in the background; reconnects replay the buffer; the next turn
  // on this chat replaces the stream; explicit /stop aborts via activeStreams.
}

export function endLiveStream(chatId: string): void {
  const stream = liveStreams.get(chatId);
  if (!stream || stream.ended) return;
  stream.ended = true;
  for (const sub of stream.subscribers) {
    try { sub.res.end(); } catch {}
  }
  stream.subscribers.clear();
  // Retain briefly so late reconnecters get the final buffer + close signal.
  setTimeout(() => {
    if (liveStreams.get(chatId) === stream) {
      liveStreams.delete(chatId);
      activeStreams.delete(chatId);
    }
  }, LIVE_END_RETENTION_MS);
}

export function closeLiveSSE(chatId: string, res: Response): void {
  endLiveStream(chatId);
  if (!res.writableEnded) {
    try { res.end(); } catch {}
  }
}

/**
 * Install the live-stream plumbing on a response. Patches res.write to route
 * through emitToStream (buffer + fan-out), registers a primary subscriber,
 * and sets up grace-on-disconnect. Replaces any existing live stream for this
 * chat (fresh turn = new stream). Idempotent per response object.
 */
export function installLiveStream(res: Response, _req: Request, chatId: string): LiveStream {
  if ((res as any)._liveStreamInstalled) {
    return liveStreams.get(chatId)!;
  }

  // If a prior live stream exists for this chat (e.g., a dropped connection
  // whose grace timer hasn't fired, or a headless synthesis stream running),
  // abort it so the new turn takes over.
  const existing = liveStreams.get(chatId);
  if (existing && !existing.ended) {
    console.warn(`[chat] replacing existing live stream for chat ${chatId} (new turn starting)`);
    existing.abort.abort();
    endLiveStream(chatId);
  }

  const abort = new AbortController();
  const primaryWrite = res.write.bind(res) as (chunk: string) => boolean;

  const stream: LiveStream = {
    chatId,
    abort,
    buffer: [],
    bufferBytes: 0,
    subscribers: new Set(),
    ended: false,
    headless: false,
  };
  liveStreams.set(chatId, stream);
  activeStreams.set(chatId, abort);

  const primarySub: LiveStreamSubscriber = { write: primaryWrite, res, isPrimary: true };
  stream.subscribers.add(primarySub);

  // Patch res.write to route everything through the stream. Callers keep
  // writing to res as before; we fan out + buffer transparently.
  (res as any).write = ((chunk: any, encoding?: any, cb?: any) => {
    const str = typeof chunk === "string" ? chunk : chunk?.toString?.() ?? "";
    emitToStream(stream, str);
    if (typeof encoding === "function") encoding();
    else if (typeof cb === "function") cb();
    return true;
  }) as any;

  res.on("close", () => {
    detachSubscriber(stream, primarySub);
  });

  (res as any)._liveStreamInstalled = true;
  return stream;
}

/**
 * Install a headless live stream — no primary res, no patching. The stream
 * exists as a buffer + fan-out target that server-internal tasks (synthesis,
 * wake cycle) emit into. Clients that open the corresponding chat connect via
 * /reconnect/:chatId and replay the buffered events, then receive live ones.
 *
 * The caller drives the stream by calling emitToStream() and endLiveStream()
 * directly. abort.signal is exposed so the caller can wire it to its work
 * (e.g., AbortSignal.any() with an already-existing turn timeout) — but
 * headless streams ignore subscriber-count drops, so the abort fires only on
 * explicit caller request.
 */
export function installHeadlessLiveStream(chatId: string): LiveStream {
  // If a prior stream exists, abort + end it. New synthesis takes precedence.
  const existing = liveStreams.get(chatId);
  if (existing && !existing.ended) {
    console.warn(`[live-streams] replacing existing live stream for chat ${chatId} (headless takeover)`);
    existing.abort.abort();
    endLiveStream(chatId);
  }

  const abort = new AbortController();
  const stream: LiveStream = {
    chatId,
    abort,
    buffer: [],
    bufferBytes: 0,
    subscribers: new Set(),
    ended: false,
    headless: true,
  };
  liveStreams.set(chatId, stream);
  activeStreams.set(chatId, abort);
  return stream;
}

export function getLiveStream(chatId: string): LiveStream | undefined {
  return liveStreams.get(chatId);
}
