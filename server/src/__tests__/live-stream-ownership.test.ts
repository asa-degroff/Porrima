import { afterEach, describe, expect, it } from "vitest";
import {
  activeStreams,
  closeLiveSSEIfCurrent,
  emitToStream,
  endLiveStreamIfCurrent,
  installLiveStream,
  liveStreams,
  pendingTurnIntents,
} from "../services/live-streams.js";

/**
 * Pins the ownership-guarded teardown added after a stale-turn race:
 *
 * A turn can finish its agent loop, send `done`, and then stall for minutes in
 * its completion path (e.g. `await awaitMidTurnPulse` while a slow extraction
 * pulse retries). If the user starts the next turn in that window,
 * installLiveStream replaces the by-then-finished turn's stream with the new
 * turn's stream. When the old turn's finally block eventually runs, an
 * unconditional endLiveStream(chatId) would grab the *newer* turn's stream by
 * chatId, mark it ended, and res.end() its subscribers — closing the client's
 * SSE mid-turn without a done event ("Connection lost — no response received
 * from model") while the newer turn keeps generating headless.
 *
 * endLiveStreamIfCurrent / closeLiveSSEIfCurrent exist so teardown only ever
 * closes the stream the caller owns.
 */

const CHAT_IDS = ["ownership-a", "ownership-b", "ownership-c", "ownership-d"];

function makeRes() {
  const state = { ended: false, chunks: [] as string[] };
  const res: any = {
    writableEnded: false,
    destroyed: false,
    socket: undefined,
    write(chunk: unknown) {
      state.chunks.push(String(chunk));
      return true;
    },
    end() {
      state.ended = true;
      res.writableEnded = true;
    },
    on() {},
  };
  return { res, state };
}

afterEach(() => {
  for (const id of CHAT_IDS) {
    liveStreams.delete(id);
    activeStreams.delete(id);
    pendingTurnIntents.delete(id);
  }
});

describe("endLiveStreamIfCurrent", () => {
  it("does not end a newer stream that replaced the caller's stream", () => {
    const first = makeRes();
    const oldStream = installLiveStream(first.res, {} as any, CHAT_IDS[0]);

    const second = makeRes();
    const newStream = installLiveStream(second.res, {} as any, CHAT_IDS[0]);
    // Takeover semantics: installing the new turn already ended the old stream.
    expect(newStream).not.toBe(oldStream);
    expect(oldStream.ended).toBe(true);

    const ended = endLiveStreamIfCurrent(oldStream);

    expect(ended).toBe(false);
    expect(newStream.ended).toBe(false);
    expect(liveStreams.get(CHAT_IDS[0])).toBe(newStream);
    expect(activeStreams.get(CHAT_IDS[0])).toBe(newStream.abort);
    expect(newStream.subscribers.size).toBe(1);
    expect(second.state.ended).toBe(false);
  });

  it("still ends the stream while it is current", () => {
    const { res } = makeRes();
    const stream = installLiveStream(res, {} as any, CHAT_IDS[1]);

    const ended = endLiveStreamIfCurrent(stream);

    expect(ended).toBe(true);
    expect(stream.ended).toBe(true);
    expect(activeStreams.has(CHAT_IDS[1])).toBe(false);
  });
});

describe("closeLiveSSEIfCurrent", () => {
  it("a superseded request ends only its own response", () => {
    const first = makeRes();
    const oldStream = installLiveStream(first.res, {} as any, CHAT_IDS[2]);

    const second = makeRes();
    const newStream = installLiveStream(second.res, {} as any, CHAT_IDS[2]);

    closeLiveSSEIfCurrent(oldStream, first.res);

    // The stale request's response is closed...
    expect(first.state.ended).toBe(true);
    // ...but the newer turn's stream, subscriber, and response survive.
    expect(newStream.ended).toBe(false);
    expect(liveStreams.get(CHAT_IDS[2])).toBe(newStream);
    expect(second.state.ended).toBe(false);

    emitToStream(newStream, "event: text_delta\ndata: {}\n\n");
    expect(second.state.chunks.join("")).toContain("event: text_delta");
  });

  it("ends both the stream and the response while current", () => {
    const { res, state } = makeRes();
    const stream = installLiveStream(res, {} as any, CHAT_IDS[3]);

    closeLiveSSEIfCurrent(stream, res);

    expect(stream.ended).toBe(true);
    expect(state.ended).toBe(true);
    expect(liveStreams.get(CHAT_IDS[3])).toBe(stream);
    expect(activeStreams.has(CHAT_IDS[3])).toBe(false);
  });
});

describe("installLiveStream idempotent path", () => {
  it("returns the response's own stream even after a newer turn replaced the registry entry", () => {
    const first = makeRes();
    const oldStream = installLiveStream(first.res, {} as any, CHAT_IDS[0]);

    const second = makeRes();
    const newStream = installLiveStream(second.res, {} as any, CHAT_IDS[0]);
    expect(newStream).not.toBe(oldStream);

    // Idempotent path for the first response must not hand back the newer
    // turn's stream — that would defeat the ownership guard.
    expect(installLiveStream(first.res, {} as any, CHAT_IDS[0])).toBe(oldStream);
  });
});
