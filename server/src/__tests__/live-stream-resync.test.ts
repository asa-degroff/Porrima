import { describe, expect, it, vi } from "vitest";
import { buildAttachFrames, type LiveStream } from "../services/live-streams.js";
import type { TurnResyncPayload } from "../types.js";

/**
 * Pins the attach-frame selection used by /chat/reconnect and the
 * duplicate-POST attach path: resync snapshot preferred when the stream
 * owner installs a builder, buffered replay as the fallback, and the
 * duplicate-attach opt-out (its client has no persisted-row baseline and
 * needs the full history reconstructed).
 */

function makeStream(overrides: Partial<LiveStream> = {}): LiveStream {
  return {
    chatId: "chat-1",
    abort: new AbortController(),
    buffer: [],
    bufferBytes: 0,
    subscribers: new Set(),
    ended: false,
    headless: false,
    ...overrides,
  };
}

const payload: TurnResyncPayload = {
  message: { role: "assistant", content: "partial tail", timestamp: 1 },
  waitingForInput: false,
};

const resyncFrame = (p: TurnResyncPayload) => `event: resync\ndata: ${JSON.stringify(p)}\n\n`;

describe("buildAttachFrames", () => {
  it("prefers the resync snapshot over buffer replay when a builder is installed", () => {
    const buildResync = vi.fn(() => payload);
    const stream = makeStream({
      buildResync,
      buffer: ["event: text_delta\ndata: {\"delta\":\"a\"}\n\n", "event: iteration\ndata: {}\n\n"],
    });

    const frames = buildAttachFrames(stream);

    expect(buildResync).toHaveBeenCalledTimes(1);
    expect(frames).toEqual([resyncFrame(payload)]);
  });

  it("falls back to buffer replay when the builder returns null (no snapshot available)", () => {
    const stream = makeStream({
      buildResync: () => null,
      buffer: ["frame-a", "frame-b"],
    });

    expect(buildAttachFrames(stream)).toEqual(["frame-a", "frame-b"]);
  });

  it("falls back to buffer replay when no builder is installed (headless streams)", () => {
    const stream = makeStream({ buffer: ["frame-a"], headless: true });
    expect(buildAttachFrames(stream)).toEqual(["frame-a"]);
  });

  it("falls back to buffer replay when the builder throws instead of failing the attach", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const stream = makeStream({
      buildResync: () => {
        throw new Error("snapshot exploded");
      },
      buffer: ["frame-a"],
    });

    expect(buildAttachFrames(stream)).toEqual(["frame-a"]);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("skips the resync builder entirely when the caller opts out (duplicate-attach path)", () => {
    const buildResync = vi.fn(() => payload);
    const stream = makeStream({ buildResync, buffer: ["frame-a"] });

    const frames = buildAttachFrames(stream, { resync: false, replay: true });

    expect(buildResync).not.toHaveBeenCalled();
    expect(frames).toEqual(["frame-a"]);
  });

  it("returns nothing when both resync and replay are unavailable/disabled", () => {
    const stream = makeStream({ buffer: ["frame-a"] });
    expect(buildAttachFrames(stream, { resync: false, replay: false })).toEqual([]);
  });

  it("still resyncs with replay disabled — the snapshot replaces history rather than repeating it", () => {
    const stream = makeStream({ buildResync: () => payload, buffer: ["frame-a"] });
    expect(buildAttachFrames(stream, { replay: false })).toEqual([resyncFrame(payload)]);
  });

  it("replays a defensive copy of the buffer (mutating the result cannot corrupt the stream)", () => {
    const stream = makeStream({ buffer: ["frame-a"] });
    const frames = buildAttachFrames(stream, { resync: false });
    frames.push("injected");
    expect(stream.buffer).toEqual(["frame-a"]);
  });
});
