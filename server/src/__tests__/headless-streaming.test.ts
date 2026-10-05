import { describe, expect, it } from "vitest";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import {
  partialToolText,
  toolCallDeltaFrame,
  toolCallStartFrame,
  toolPartialFrame,
  SynthesisEmitter,
} from "../services/synthesis-stream.js";
import { forwardHeadlessStreamEvent } from "../services/chat-turn-runner.js";

/**
 * Headless turns stream text/thinking deltas via the emitter already; these
 * tests pin the preview parity added for tool calls and in-flight tool output
 * (`tool_execution_update`) so automated turns render the same live frames the
 * HTTP route emits.
 */

function captureFrames(emitter: SynthesisEmitter): string[] {
  const frames: string[] = [];
  emitter.stream.subscribers.add({
    write: (chunk: string) => {
      frames.push(chunk);
      return true;
    },
    res: {} as any,
    isPrimary: false,
  });
  return frames;
}

const message = (content: any[]) => ({ role: "assistant", content }) as any;

describe("forwardHeadlessStreamEvent", () => {
  it("forwards text and thinking deltas", () => {
    const emitter = new SynthesisEmitter("preview-deltas");
    try {
      const frames = captureFrames(emitter);
      const assistant = message([{ type: "text", text: "" }]);

      forwardHeadlessStreamEvent(emitter, {
        type: "message_update",
        message: assistant,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello", partial: assistant },
      } as AgentEvent);
      forwardHeadlessStreamEvent(emitter, {
        type: "message_update",
        message: assistant,
        assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "hmm", partial: assistant },
      } as AgentEvent);

      expect(frames).toEqual([
        `event: text_delta\ndata: ${JSON.stringify({ delta: "hello" })}\n\n`,
        `event: thinking_delta\ndata: ${JSON.stringify({ delta: "hmm" })}\n\n`,
      ]);
    } finally {
      emitter.end();
    }
  });

  it("forwards tool-call argument previews from the assistant message block", () => {
    const emitter = new SynthesisEmitter("preview-toolcall");
    try {
      const frames = captureFrames(emitter);
      const assistant = message([{ type: "toolCall", id: "call-1", name: "run_python", arguments: {} }]);

      forwardHeadlessStreamEvent(emitter, {
        type: "message_update",
        message: assistant,
        assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: assistant },
      } as AgentEvent);
      forwardHeadlessStreamEvent(emitter, {
        type: "message_update",
        message: assistant,
        assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: '{"code":', partial: assistant },
      } as AgentEvent);

      expect(frames).toEqual([
        toolCallStartFrame(0, "run_python", "call-1"),
        toolCallDeltaFrame(0, '{"code":'),
      ]);
    } finally {
      emitter.end();
    }
  });

  it("forwards in-flight tool output as a tool_partial frame", () => {
    const emitter = new SynthesisEmitter("preview-tool-output");
    try {
      const frames = captureFrames(emitter);

      forwardHeadlessStreamEvent(emitter, {
        type: "tool_execution_update",
        toolCallId: "call-1",
        toolName: "run_python",
        args: {},
        partialResult: { content: [{ type: "text", text: "line 1\nline 2" }] },
      } as AgentEvent);

      expect(frames).toEqual([toolPartialFrame("call-1", "run_python", "line 1\nline 2")]);
    } finally {
      emitter.end();
    }
  });

  it("drops tool updates that carry no text (images only)", () => {
    const emitter = new SynthesisEmitter("preview-no-text");
    try {
      const frames = captureFrames(emitter);

      forwardHeadlessStreamEvent(emitter, {
        type: "tool_execution_update",
        toolCallId: "call-1",
        toolName: "run_python",
        args: {},
        partialResult: { content: [{ type: "image", data: "aGk=", mimeType: "image/png" }] },
      } as AgentEvent);

      expect(frames).toEqual([]);
    } finally {
      emitter.end();
    }
  });

  it("starts tool-call previews with no id when the block has none yet", () => {
    const emitter = new SynthesisEmitter("preview-no-id");
    try {
      const frames = captureFrames(emitter);
      const assistant = message([{ type: "toolCall", name: "bash", arguments: {} }]);

      forwardHeadlessStreamEvent(emitter, {
        type: "message_update",
        message: assistant,
        assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: assistant },
      } as AgentEvent);

      expect(frames).toEqual([toolCallStartFrame(0, "bash")]);
    } finally {
      emitter.end();
    }
  });
});

describe("partialToolText", () => {
  it("joins text items and accepts a bare-string content", () => {
    expect(
      partialToolText({ content: [{ type: "text", text: "a" }, { type: "image", data: "x" }, { type: "text", text: "b" }] }),
    ).toBe("ab");
    expect(partialToolText({ content: "raw output" })).toBe("raw output");
  });

  it("returns empty for missing or non-text content", () => {
    expect(partialToolText(undefined)).toBe("");
    expect(partialToolText({ content: 42 })).toBe("");
    expect(partialToolText({ content: [{ type: "image", data: "x" }] })).toBe("");
  });
});
