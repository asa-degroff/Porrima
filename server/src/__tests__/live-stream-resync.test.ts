import { describe, expect, it, vi } from "vitest";
import { buildAttachFrames, type LiveStream } from "../services/live-streams.js";
import { SynthesisEmitter } from "../services/synthesis-stream.js";
import type { TurnResyncPayload } from "../types.js";

/**
 * Pins the attach-frame selection used by /chat/reconnect: attaching clients
 * receive the owner's resync snapshot (never event-history replay — the
 * buffer was retired with the replay design). All stream owners install a
 * builder: chat turns, turn-gate waiters, and headless synthesis runs.
 */

function makeStream(overrides: Partial<LiveStream> = {}): LiveStream {
  return {
    chatId: "chat-1",
    abort: new AbortController(),
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
  it("emits the resync snapshot when the owner installs a builder", () => {
    const buildResync = vi.fn(() => payload);
    const frames = buildAttachFrames(makeStream({ buildResync }));

    expect(buildResync).toHaveBeenCalledTimes(1);
    expect(frames).toEqual([resyncFrame(payload)]);
  });

  it("attaches bare (no frames) when no builder is installed", () => {
    expect(buildAttachFrames(makeStream())).toEqual([]);
  });

  it("attaches bare when the builder returns null instead of failing", () => {
    expect(buildAttachFrames(makeStream({ buildResync: () => null }))).toEqual([]);
  });

  it("attaches bare when the builder throws instead of failing the attach", () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const frames = buildAttachFrames(
      makeStream({
        buildResync: () => {
          throw new Error("snapshot exploded");
        },
      })
    );
    expect(frames).toEqual([]);
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

describe("SynthesisEmitter resync snapshot", () => {
  it("reports the whole accumulated state as the uncommitted tail", () => {
    const emitter = new SynthesisEmitter("system");
    try {
      emitter.emitTextDelta("hello ");
      emitter.emitTextDelta("world");
      emitter.emitToolCall({ id: "t1", name: "read_file", arguments: {} });
      emitter.emitToolResult({ toolCallId: "t1", toolName: "read_file", content: "ok", isError: false });
      emitter.emitIteration({ iteration: 1, toolCount: 1, usage: { input: 10, output: 5, totalTokens: 15 } });

      const snapshot = emitter.stream.buildResync!();
      expect(snapshot).not.toBeNull();
      const message = snapshot!.message!;
      expect(message.content).toBe("hello world");
      expect(message.toolCalls?.map((tc) => tc.id)).toEqual(["t1"]);
      expect(message.toolResults?.map((tr) => tr.toolCallId)).toEqual(["t1"]);
      // Segments: the streamed text run (flushed by the tool call), then the
      // tool_call / tool_result pair.
      expect(message.segments?.map((s) => s.type)).toEqual(["text", "tool_call", "tool_result"]);
      expect(message._isSystemMessage).toBe(true);
      expect(snapshot!.iteration).toMatchObject({ iteration: 1, stopReason: "stop", toolCount: 1 });
    } finally {
      emitter.end();
    }
  });

  it("keeps pendingText out of persisted segments (non-mutating read)", () => {
    const emitter = new SynthesisEmitter("system");
    try {
      emitter.emitTextDelta("streaming tail");
      const snapshot = emitter.stream.buildResync!();
      // The snapshot carries the pending text as a synthetic segment...
      expect(snapshot!.message!.segments?.at(-1)?.content).toBe("streaming tail");
      // ...without flushing it into the emitter's real segment list.
      expect(emitter.state.segments).toHaveLength(0);
      expect(emitter.state.pendingText).toBe("streaming tail");
    } finally {
      emitter.end();
    }
  });

  it("returns a null message before any output exists", () => {
    const emitter = new SynthesisEmitter("system");
    try {
      const snapshot = emitter.stream.buildResync!();
      expect(snapshot!.message).toBeNull();
    } finally {
      emitter.end();
    }
  });
});
