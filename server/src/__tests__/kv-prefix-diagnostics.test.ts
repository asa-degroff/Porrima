import { describe, expect, it } from "vitest";
import {
  digestPiMessages,
  digestToolSurface,
  digestWireShape,
  getPrefixSnapshot,
  recordReplaySnapshot,
  recordWireSnapshot,
} from "../services/kv-prefix-diagnostics.js";

const tool = (name: string) => ({
  type: "function",
  function: { name, description: `${name} tool`, parameters: { type: "object" } },
});

describe("kv-prefix-diagnostics", () => {
  it("digestToolSurface changes when a tool is added/removed and preserves order", () => {
    const both = digestToolSurface([tool("bash"), tool("ask_user")]);
    const without = digestToolSurface([tool("bash")]);
    const reordered = digestToolSurface([tool("ask_user"), tool("bash")]);

    expect(both).not.toBeNull();
    expect(both!.digest).not.toBe(without!.digest);
    expect(both!.digest).not.toBe(reordered!.digest);
    expect(both!.names).toEqual(["bash", "ask_user"]);

    expect(digestToolSurface(undefined)).toBeNull();
    // An empty tool array is a distinct surface from "no tools".
    expect(digestToolSurface([])!.digest).not.toBe(without!.digest);
  });

  it("recordWireSnapshot reports a tool-surface change once, then stabilizes", () => {
    const chatId = "test-chat-tools";
    const messages = [{ role: "system", content: "hi" }];

    const first = recordWireSnapshot(chatId, messages, [tool("bash"), tool("ask_user")]);
    expect(first.toolsChanged).toBe(false);
    expect(first.toolSurface!.names).toEqual(["bash", "ask_user"]);

    const same = recordWireSnapshot(chatId, messages, [tool("bash"), tool("ask_user")]);
    expect(same.toolsChanged).toBe(false);

    // The 10-05 regression: automations dropped ask_user, the send path kept it.
    const dropped = recordWireSnapshot(chatId, messages, [tool("bash")]);
    expect(dropped.toolsChanged).toBe(true);
    expect(dropped.previousToolNames).toEqual(["bash", "ask_user"]);
    expect(dropped.toolSurface!.names).toEqual(["bash"]);
  });

  it("replay snapshots round-trip without clobbering the recorded wire", () => {
    const chatId = "test-chat-replay";
    recordWireSnapshot(chatId, [{ role: "user", content: "x" }], [tool("bash")]);
    const wire = getPrefixSnapshot(chatId)!;

    recordReplaySnapshot(chatId, "abc123def456", 7);
    const snap = getPrefixSnapshot(chatId)!;

    expect(snap.replayDigest).toBe("abc123def456");
    expect(snap.replayMsgCount).toBe(7);
    expect(snap.wireDigest).toBe(wire.wireDigest);
    expect(snap.wireMsgCount).toBe(wire.wireMsgCount);
    expect(snap.wireToolDigest).toBe(wire.wireToolDigest);
  });

  it("digestWireShape ignores non-token fields but catches content changes", () => {
    const base = digestWireShape([{ role: "user", content: "hello" }]);
    const extraFields = digestWireShape([{ role: "user", content: "hello", usage: { input: 1 } } as any]);
    const changed = digestWireShape([{ role: "user", content: "hello!" }]);

    expect(base).toBe(extraFields);
    expect(base).not.toBe(changed);
  });

  it("digestPiMessages hashes the full message payload", () => {
    const base = digestPiMessages([{ role: "user", content: "hi" } as any]);
    const extra = digestPiMessages([{ role: "user", content: "hi", usage: { input: 1 } } as any]);
    expect(base).not.toBe(extra);
  });
});
