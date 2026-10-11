import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Chat, ChatMessage } from "../types.js";

// KV slot pinning for headless turns — docs/design/kv-snapshot-parking.md D2.
// The runner must acquire a lease for llamacpp models before the agent loop,
// thread it into createSafeStreamFn, and release it on EVERY exit path
// (clean stop, error, timeout), including the null-lease cases.

const leaseStub = {
  chatId: "chat-lease-1",
  leaseId: "lease-abc",
  baseUrl: "http://localhost:8080",
  modelId: "test-model",
  contextWindow: 131072,
  poolKey: '["http://localhost:8080","test-model",131072]',
  slotId: 2,
  maxInstances: 3,
};

const acquireLlamaSlotLease = vi.fn(async () => leaseStub as unknown as typeof leaseStub | null);
const releaseLlamaSlotLease = vi.fn(async () => {});
const createSafeStreamFn = vi.fn((_lease?: unknown) => vi.fn());
const runAgentLoop = vi.fn(async () => {});

vi.mock("../services/llama-slot-leases.js", () => ({
  acquireLlamaSlotLease,
  releaseLlamaSlotLease,
}));

vi.mock("../services/llm-stream.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/llm-stream.js")>();
  return { ...actual, createSafeStreamFn };
});

vi.mock("../services/agent-loop-runner.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/agent-loop-runner.js")>();
  return { ...actual, runAgentLoop };
});

function makeEmitter() {
  const controller = new AbortController();
  return {
    stream: { abort: controller },
    emitTextDelta: vi.fn(),
    emitThinkingDelta: vi.fn(),
    emitToolCall: vi.fn(),
    emitToolResult: vi.fn(),
    emitWarning: vi.fn(),
    emitIteration: vi.fn(),
    emitDone: vi.fn(),
    setUsage: vi.fn(),
    flushPendingText: vi.fn(async () => {}),
    buildAssistantMessage: (thinking: string, summary: string): ChatMessage => ({
      role: "assistant",
      content: summary,
      thinking,
      timestamp: Date.now(),
    }),
  };
}

function makeOptions(modelOverrides?: Record<string, unknown>) {
  const chat: Chat = {
    id: "chat-lease-1",
    title: "Lease test",
    type: "agent",
    modelId: "test-model",
    messages: [{ role: "user", content: "hello", timestamp: 1 }],
    createdAt: new Date(0).toISOString(),
    lastModified: new Date(0).toISOString(),
  } as unknown as Chat;
  const model = {
    id: "test-model",
    name: "Test Model",
    api: "openai-compat",
    provider: "llamacpp",
    baseUrl: "http://localhost:8080",
    contextWindow: 131072,
    reasoning: true,
    ...(modelOverrides ?? {}),
  };
  return {
    chat,
    modelId: "test-model",
    model: model as never,
    systemPrompt: "You are a test model.",
    tools: [],
    emitter: makeEmitter() as never,
    maxIterations: 4,
    timeoutMs: 5000,
    logPrefix: "kv-lease-test",
    saveChat: vi.fn(async () => {}),
    contextWindow: 131072,
  };
}

async function importRunner() {
  const { runHeadlessChatTurn } = await import("../services/chat-turn-runner.js");
  return runHeadlessChatTurn;
}

beforeEach(() => {
  vi.clearAllMocks();
  acquireLlamaSlotLease.mockImplementation(async () => leaseStub as never);
});

describe("headless llama slot lease (D2)", () => {
  it("acquires a lease with the model identity and releases it on a clean turn", async () => {
    const runHeadlessChatTurn = await importRunner();
    const options = makeOptions();

    await runHeadlessChatTurn(options);

    expect(acquireLlamaSlotLease).toHaveBeenCalledTimes(1);
    expect(acquireLlamaSlotLease).toHaveBeenCalledWith({
      baseUrl: "http://localhost:8080",
      chatId: "chat-lease-1",
      modelId: "test-model",
      contextWindow: 131072,
    });
    expect(createSafeStreamFn).toHaveBeenCalled();
    expect(createSafeStreamFn.mock.calls[0][0]).toBe(leaseStub);
    expect(releaseLlamaSlotLease).toHaveBeenCalledTimes(1);
    expect(releaseLlamaSlotLease).toHaveBeenCalledWith(leaseStub);
  });

  it("releases exactly once when the agent loop throws (error path balance)", async () => {
    const runHeadlessChatTurn = await importRunner();
    runAgentLoop.mockImplementationOnce(async () => {
      throw new Error("boom");
    });

    const result = await runHeadlessChatTurn(makeOptions());

    expect(result.success).toBe(false);
    expect(releaseLlamaSlotLease).toHaveBeenCalledTimes(1);
  });

  it("passes a null lease through when acquire returns null (bindings off)", async () => {
    const runHeadlessChatTurn = await importRunner();
    acquireLlamaSlotLease.mockImplementationOnce(async () => null as never);

    await runHeadlessChatTurn(makeOptions());

    expect(createSafeStreamFn).toHaveBeenCalled();
    expect(createSafeStreamFn.mock.calls[0][0]).toBeNull();
    expect(releaseLlamaSlotLease).toHaveBeenCalledTimes(1);
  });

  it("does not acquire for non-llamacpp providers but still balances release(null)", async () => {
    const runHeadlessChatTurn = await importRunner();

    await runHeadlessChatTurn(makeOptions({ provider: "openai" }));

    expect(acquireLlamaSlotLease).not.toHaveBeenCalled();
    expect(releaseLlamaSlotLease).toHaveBeenCalledTimes(1);
    expect(releaseLlamaSlotLease).toHaveBeenCalledWith(null);
    expect(createSafeStreamFn.mock.calls[0][0]).toBeNull();
  });

  it("does not acquire for llamacpp models without a baseUrl", async () => {
    const runHeadlessChatTurn = await importRunner();

    await runHeadlessChatTurn(makeOptions({ baseUrl: "" }));

    expect(acquireLlamaSlotLease).not.toHaveBeenCalled();
    expect(releaseLlamaSlotLease).toHaveBeenCalledWith(null);
  });

  it("treats acquire failure as non-fatal: turn runs unpinned", async () => {
    const runHeadlessChatTurn = await importRunner();
    acquireLlamaSlotLease.mockRejectedValueOnce(new Error("probe failed"));

    const options = makeOptions();
    const result = await runHeadlessChatTurn(options);

    expect(createSafeStreamFn.mock.calls[0][0]).toBeNull();
    expect(releaseLlamaSlotLease).toHaveBeenCalledTimes(1);
  });
});
