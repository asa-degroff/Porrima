import type { Request, Response } from "express";
import type { TurnResyncPayload } from "../types.js";
import { markPresence } from "./push-storage.js";

/**
 * Pull a deviceId from a request — checks query string first, then request
 * body. The client stamps both: SSE GETs go on the URL, POSTs are also in JSON.
 * Returns null if absent.
 */
function readDeviceId(req: Request | undefined): string | null {
  if (!req) return null;
  const fromQuery = (req.query?.deviceId as string | undefined) ?? null;
  if (fromQuery && typeof fromQuery === "string") return fromQuery;
  const body = (req as any).body;
  if (body && typeof body === "object" && typeof body.deviceId === "string") {
    return body.deviceId;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Live stream registry — supports reconnect and runs to completion regardless
// of subscriber count.
//
// Every chat turn (and every server-internal background task that wants to
// stream output to the system chat — synthesis, wake cycle) gets a LiveStream
// keyed by chatId. For HTTP-driven turns, res.write() is patched to route
// through emitToStream, which fans out to all attached subscribers. For
// server-internal tasks, there's no primary res — the stream starts headless,
// and any subscriber attaching via /reconnect/:chatId receives a resync
// snapshot of the owner's live accumulators and then continues live.
//
// Streams are never aborted just because subscribers disconnected. The model
// keeps generating in the background; reconnects resync from the owner's
// state; the next turn on the same chat replaces the stream; explicit /stop
// aborts via activeStreams. At end-of-turn the stream is closed and kept
// briefly so in-flight reconnect requests still see the stream object.
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
  subscribers: Set<LiveStreamSubscriber>;
  ended: boolean;
  /** Headless streams have no primary subscriber — they outlive disconnect by design. */
  headless: boolean;
  /**
   * State-snapshot builder installed by the stream owner. An attaching
   * client (e.g. /reconnect) is sent a single synthetic `resync` event built
   * from the owner's live accumulators — it hydrates from authoritative
   * state and never reprocesses event history. Must be a pure read: it runs
   * on the request path of an attaching client and must not mutate turn
   * state. Owners: handleChatStream (chat turns), SynthesisEmitter
   * (synthesis / wake cycles / automations), acquireTurnGate (queued turns).
   */
  buildResync?: () => TurnResyncPayload | null;
}

export const liveStreams: Map<string, LiveStream> =
  (globalThis as any)._liveStreams || new Map();
(globalThis as any)._liveStreams = liveStreams;

// Legacy alias so /stop and other callers keep working without churn.
// Points at the same map but exposes the AbortController per chat.
export const activeStreams: Map<string, AbortController> =
  (globalThis as any)._activeChatStreams || new Map<string, AbortController>();
(globalThis as any)._activeChatStreams = activeStreams;

/**
 * Turn intents — registered synchronously at request entry (before the live
 * stream exists) so /stop can abort a turn that is still doing pre-stream work:
 * prompt construction, memory retrieval, pre-send compaction. Without this,
 * stopping during that window found no controller, the client disconnected its
 * SSE fetch (which by design does not stop a turn), and the model ran headless
 * to completion.
 *
 * The controller is handed from the intent to installLiveStream, so the same
 * signal covers the whole request. /stop aborts both the pending intent and the
 * installed stream's controller.
 */
export interface PendingTurnIntent {
  chatId: string;
  abort: AbortController;
  createdAt: number;
}

export const pendingTurnIntents: Map<string, PendingTurnIntent> =
  (globalThis as any)._pendingChatTurnIntents || new Map<string, PendingTurnIntent>();
(globalThis as any)._pendingChatTurnIntents = pendingTurnIntents;

/**
 * Register a turn intent for a chat. Call synchronously at the top of a route
 * handler. When `res` is provided the intent is released when the response
 * closes, so failed/early-return requests don't leave a stale entry behind.
 */
export function beginTurnIntent(chatId: string, res?: Response): PendingTurnIntent {
  const intent: PendingTurnIntent = { chatId, abort: new AbortController(), createdAt: Date.now() };
  // A newer request for the same chat supersedes an earlier still-pending one
  // (mirrors installLiveStream replacing an existing stream). Without this the
  // earlier request would keep working while /stop targeted only the newer
  // intent.
  const existing = pendingTurnIntents.get(chatId);
  if (existing && !existing.abort.signal.aborted) {
    existing.abort.abort();
  }
  pendingTurnIntents.set(chatId, intent);
  if (res) {
    (res as any)._turnIntent = intent;
    res.on("close", () => {
      if (pendingTurnIntents.get(chatId) === intent) {
        pendingTurnIntents.delete(chatId);
      }
    });
  }
  return intent;
}

/** Abort the pending turn intent for a chat (used by /stop). */
export function abortPendingTurnIntent(chatId: string): boolean {
  const intent = pendingTurnIntents.get(chatId);
  if (!intent) return false;
  intent.abort.abort();
  return true;
}

const LIVE_END_RETENTION_MS = 60_000;

export function emitToStream(stream: LiveStream, chunk: string): void {
  if (stream.ended) return;
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
  // generating in the background; reconnects resync from the owner's state;
  // the next turn on this chat replaces the stream; explicit /stop aborts
  // via activeStreams.
}

export function endLiveStream(chatId: string): void {
  const stream = liveStreams.get(chatId);
  if (!stream || stream.ended) return;
  stream.ended = true;
  // Drop the abort alias immediately — retaining it through the reconnect
  // retention window let /stop target a finished turn's controller (no-op) and
  // report `stopped: true` while the next turn was still starting up.
  if (activeStreams.get(chatId) === stream.abort) {
    activeStreams.delete(chatId);
  }
  for (const sub of stream.subscribers) {
    try { sub.res.end(); } catch {}
  }
  stream.subscribers.clear();
  // Retain briefly so in-flight reconnect requests still find (and 404
  // cleanly against) the stream object instead of racing its removal.
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
 * End a live stream only if it is still the one registered for its chat.
 *
 * The registry is keyed by chatId, so a superseded turn's late teardown must
 * not call endLiveStream(chatId) unconditionally: if a newer turn has taken
 * over the chat, that would mark the newer turn's stream ended and close its
 * subscribers without a done event — the client reports "Connection lost — no
 * response received from model" while the newer turn keeps generating headless.
 * Owners that hold a specific stream (a turn's finally, a synthesis emitter)
 * should use this instead.
 *
 * Returns true when the stream was still current and got ended.
 */
export function endLiveStreamIfCurrent(stream: LiveStream): boolean {
  if (liveStreams.get(stream.chatId) !== stream) return false;
  endLiveStream(stream.chatId);
  return true;
}

/**
 * Close this request's SSE response: end the live stream only when it is
 * still current, then end the response itself. A superseded request ends only
 * its own response — the new turn's stream and subscribers are left alone.
 */
export function closeLiveSSEIfCurrent(stream: LiveStream, res: Response): void {
  endLiveStreamIfCurrent(stream);
  if (!res.writableEnded) {
    try { res.end(); } catch {}
  }
}

/**
 * Install the live-stream plumbing on a response. Patches res.write to route
 * through emitToStream (fan-out), registers a primary subscriber, and sets up
 * grace-on-disconnect. Replaces any existing live stream for this chat
 * (fresh turn = new stream). Idempotent per response object.
 */
export function installLiveStream(res: Response, _req: Request, chatId: string): LiveStream {
  if ((res as any)._liveStreamInstalled) {
    // Even on the idempotent path, refresh presence — the caller may have
    // arrived after a reconnect or a second installLiveStream invocation.
    const dev = readDeviceId(_req);
    if (dev) markPresence(dev, "sse");
    // Return the stream this response installed, not whatever is currently
    // registered — a newer turn may already have replaced the registry entry,
    // and callers use the return value for ownership-guarded teardown.
    return ((res as any)._liveStream as LiveStream | undefined) ?? liveStreams.get(chatId)!;
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

  // Prefer the turn intent registered at request entry (see beginTurnIntent)
  // so an early /stop lands on the same controller this stream will expose.
  const intent = (res as any)._turnIntent as PendingTurnIntent | undefined;
  const abort = intent?.abort ?? new AbortController();
  if (intent && pendingTurnIntents.get(chatId) === intent) {
    pendingTurnIntents.delete(chatId);
  }
  const primaryWrite = res.write.bind(res) as (chunk: string) => boolean;

  const stream: LiveStream = {
    chatId,
    abort,
    subscribers: new Set(),
    ended: false,
    headless: false,
  };
  liveStreams.set(chatId, stream);
  activeStreams.set(chatId, abort);

  const primarySub: LiveStreamSubscriber = { write: primaryWrite, res, isPrimary: true };
  stream.subscribers.add(primarySub);

  // Patch res.write to route everything through the stream. Callers keep
  // writing to res as before; we fan out to subscribers transparently.
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
  (res as any)._liveStream = stream;

  // Stamp push-presence so message-complete dispatch knows this device is
  // currently watching the stream and should be suppressed.
  const dev = readDeviceId(_req);
  if (dev) markPresence(dev, "sse");

  return stream;
}

/**
 * Stamp push-presence for a request that's attaching to an existing live
 * stream (e.g. /reconnect). Safe to call on any request — no-op if no
 * deviceId is present.
 */
export function stampStreamPresence(req: Request): void {
  const dev = readDeviceId(req);
  if (dev) markPresence(dev, "sse");
}

/**
 * Install a headless live stream — no primary res, no patching. The stream
 * exists as a fan-out target that server-internal tasks (synthesis, wake
 * cycle) emit into. Clients that open the corresponding chat connect via
 * /reconnect/:chatId, receive a resync snapshot from the emitter's
 * accumulators, then live events.
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

/**
 * Build the SSE frames an attaching client (e.g. /reconnect) should receive
 * before going live: the owner's resync snapshot. Every stream owner
 * installs a builder (chat turns, turn-gate waiters, headless synthesis);
 * without one the attach goes live with no history — the owner's state
 * can't be reconstructed any other way.
 *
 * Pure (no res I/O) so the selection logic is unit-testable. A throwing
 * builder degrades to a bare attach instead of failing it.
 */
export function buildAttachFrames(stream: LiveStream): string[] {
  if (!stream.buildResync) return [];
  try {
    const payload = stream.buildResync();
    if (payload) {
      return [`event: resync\ndata: ${JSON.stringify(payload)}\n\n`];
    }
  } catch (err) {
    console.error(`[live-streams] buildResync failed for ${stream.chatId}:`, err);
  }
  return [];
}
