import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../types.js";

vi.mock("../services/chat-storage.js", () => ({
  getSettings: vi.fn(async () => ({
    titleGenerationEnabled: true,
    titleGenerationUrl: "http://localhost:32104",
    titleGenerationModelId: "qwen3.5-0.8b",
  })),
}));

vi.mock("../services/llama-router-client.js", () => ({
  ensureRouterModelLoaded: vi.fn(async () => "not-router"),
  normalizeRouterModelId: vi.fn((id: string) => id),
}));

vi.mock("../services/llama-ports.js", () => ({
  getDefaultLlamaServerUrl: vi.fn(() => "http://localhost:32104"),
}));

import { regenerateTitle, generateTitle } from "../services/title-generation.js";

function lastUserContent(fetchMock: ReturnType<typeof vi.fn>): string {
  const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  const body = JSON.parse(String(call[1].body));
  // messages: [system, user]
  return body.messages[1].content;
}

function makeFetchReply(title: string) {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ choices: [{ message: { content: title } }] }),
  }));
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("regenerateTitle visible-text extraction", () => {
  it("falls back to thinking when tool-loop fragments have empty content", async () => {
    const fetchMock = makeFetchReply("Live-Replay Divergence Debug");
    vi.stubGlobal("fetch", fetchMock);

    const messages: ChatMessage[] = [
      { role: "user", content: "why is the deployed unit not picking up my change?", timestamp: 1 },
      // A run of tool-loop fragments: persisted content is "" but thinking is present.
      { role: "assistant", content: "", thinking: "Green. Commit the promotion gate.", timestamp: 2, toolCalls: [{ id: "c1", name: "bash", arguments: {} }] },
      { role: "assistant", content: "", thinking: "Confirmed: there is no live trace of my new code.", timestamp: 3, toolCalls: [{ id: "c2", name: "bash", arguments: {} }] },
      { role: "assistant", content: "", thinking: "The deployed unit runs from a symlink path.", timestamp: 4, toolCalls: [{ id: "c3", name: "bash", arguments: {} }] },
    ];

    const title = await regenerateTitle(messages);
    expect(title).toBe("Live-Replay Divergence Debug");

    const prompt = lastUserContent(fetchMock);
    // The prompt must carry the user question and the fragment thinking, not blank lines.
    expect(prompt).toContain("deployed unit not picking up");
    expect(prompt).toContain("no live trace of my new code");
    // It must not be the degenerate all-empty prompt that produced the bug.
    expect(prompt).not.toMatch(/Assistant: *($|\n)/);
  });

  it("uses text segments when content is empty", async () => {
    const fetchMock = makeFetchReply("Color Picker Notes");
    vi.stubGlobal("fetch", fetchMock);

    const messages: ChatMessage[] = [
      { role: "assistant", content: "", segments: [{ seq: 1, type: "text", content: "Mixed the gradient in OKLab space." }], timestamp: 1 },
    ];

    await regenerateTitle(messages);
    expect(lastUserContent(fetchMock)).toContain("OKLab space");
  });

  it("skips system context-delta rows", async () => {
    const fetchMock = makeFetchReply("Relevant Title");
    vi.stubGlobal("fetch", fetchMock);

    const messages: ChatMessage[] = [
      { role: "system", content: "A large injected memory delta that is not conversation.", timestamp: 1 },
      { role: "user", content: "real question", timestamp: 2 },
    ];

    await regenerateTitle(messages);
    const prompt = lastUserContent(fetchMock);
    expect(prompt).toContain("real question");
    expect(prompt).not.toContain("injected memory delta");
  });

  it("returns null without calling the model when nothing has visible text", async () => {
    const fetchMock = makeFetchReply("Should Not Be Used");
    vi.stubGlobal("fetch", fetchMock);

    const messages: ChatMessage[] = [
      { role: "assistant", content: "", thinking: "", timestamp: 1 },
      { role: "assistant", content: "", segments: [{ seq: 1, type: "tool_call", toolCall: { id: "x", name: "bash", arguments: {} } }], timestamp: 2 },
    ];

    const title = await regenerateTitle(messages);
    expect(title).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("discards a missing-input complaint so the existing title survives", async () => {
    const fetchMock = makeFetchReply("No conversation provided");
    vi.stubGlobal("fetch", fetchMock);

    const messages: ChatMessage[] = [
      { role: "user", content: "anything at all", timestamp: 1 },
    ];

    const title = await regenerateTitle(messages);
    expect(title).toBeNull();
  });
});

describe("generateTitle empty-conversation guard", () => {
  it("returns null when both sides are blank", async () => {
    const fetchMock = makeFetchReply("Should Not Be Used");
    vi.stubGlobal("fetch", fetchMock);

    const title = await generateTitle("", "   ");
    expect(title).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still titles when only the assistant reply is blank (tool-loop first turn)", async () => {
    const fetchMock = makeFetchReply("Reranker Query Review");
    vi.stubGlobal("fetch", fetchMock);

    const title = await generateTitle("how do I construct the rerank query?", "");
    expect(title).toBe("Reranker Query Review");
    expect(lastUserContent(fetchMock)).toContain("rerank query");
  });
});
