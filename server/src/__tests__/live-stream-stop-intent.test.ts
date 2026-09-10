import { afterEach, describe, expect, it } from "vitest";
import {
  abortPendingTurnIntent,
  activeStreams,
  beginTurnIntent,
  endLiveStream,
  installLiveStream,
  liveStreams,
  pendingTurnIntents,
} from "../services/live-streams.js";

/**
 * Pins the /stop fixes for the pre-stream window:
 *
 *  - a turn registers an intent synchronously at request entry, before prompt
 *    construction / memory retrieval / pre-send compaction run, so /stop can
 *    abort it while `activeStreams` still has no entry for the chat;
 *  - installLiveStream adopts that controller instead of creating a fresh one,
 *    so a stop that landed before install reaches the running turn;
 *  - endLiveStream drops the `activeStreams` alias immediately, so /stop can
 *    no longer "succeed" against a finished turn during the 60s reconnect
 *    retention window while a new turn is starting.
 */

const CHAT_IDS = ["intent-a", "intent-b", "intent-c", "intent-d"];

function makeRes() {
  const handlers = new Map<string, Array<() => void>>();
  return {
    write: () => true,
    on(event: string, cb: () => void) {
      const list = handlers.get(event) ?? [];
      list.push(cb);
      handlers.set(event, list);
    },
    emit(event: string) {
      for (const cb of handlers.get(event) ?? []) cb();
    },
    socket: undefined,
  } as any;
}

afterEach(() => {
  for (const id of CHAT_IDS) {
    liveStreams.delete(id);
    activeStreams.delete(id);
    pendingTurnIntents.delete(id);
  }
});

describe("pending turn intents", () => {
  it("registers at request entry and /stop aborts it before any stream exists", () => {
    const intent = beginTurnIntent(CHAT_IDS[0], makeRes());

    expect(pendingTurnIntents.get(CHAT_IDS[0])).toBe(intent);
    expect(activeStreams.has(CHAT_IDS[0])).toBe(false);
    expect(abortPendingTurnIntent(CHAT_IDS[0])).toBe(true);
    expect(intent.abort.signal.aborted).toBe(true);
    // Returns false when there is nothing to stop.
    expect(abortPendingTurnIntent("no-such-chat")).toBe(false);
  });

  it("hands the intent controller to the installed live stream", () => {
    const res = makeRes();
    const intent = beginTurnIntent(CHAT_IDS[1], res);

    const stream = installLiveStream(res, {} as any, CHAT_IDS[1]);

    expect(stream.abort).toBe(intent.abort);
    expect(activeStreams.get(CHAT_IDS[1])).toBe(intent.abort);
    // The intent is claimed, not left around to be aborted twice.
    expect(pendingTurnIntents.has(CHAT_IDS[1])).toBe(false);
  });

  it("propagates a pre-install stop into the installed stream", () => {
    const res = makeRes();
    beginTurnIntent(CHAT_IDS[2], res);
    abortPendingTurnIntent(CHAT_IDS[2]);

    const stream = installLiveStream(res, {} as any, CHAT_IDS[2]);

    expect(stream.abort.signal.aborted).toBe(true);
  });

  it("releases the intent when the request ends without installing a stream", () => {
    const res = makeRes();
    beginTurnIntent(CHAT_IDS[3], res);

    res.emit("close");

    expect(pendingTurnIntents.has(CHAT_IDS[3])).toBe(false);
  });

  it("supersedes an earlier pending intent for the same chat", () => {
    const first = beginTurnIntent(CHAT_IDS[3], makeRes());
    const second = beginTurnIntent(CHAT_IDS[3], makeRes());

    expect(first.abort.signal.aborted).toBe(true);
    expect(second.abort.signal.aborted).toBe(false);
    expect(pendingTurnIntents.get(CHAT_IDS[3])).toBe(second);
  });
});

describe("endLiveStream", () => {
  it("drops the active alias immediately (no stale /stop target)", () => {
    const res = makeRes();
    const stream = installLiveStream(res, {} as any, CHAT_IDS[0]);
    expect(activeStreams.get(CHAT_IDS[0])).toBe(stream.abort);

    endLiveStream(CHAT_IDS[0]);

    expect(activeStreams.has(CHAT_IDS[0])).toBe(false);
    // The stream object itself is retained for reconnect lookups.
    expect(liveStreams.get(CHAT_IDS[0])).toBe(stream);
    expect(stream.ended).toBe(true);
  });
});
