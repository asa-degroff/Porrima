import { beforeEach, describe, expect, it, vi } from "vitest";

// Continue-mode array ownership — the HTTP route's loops mirror every
// `turn_end` message and its tool results into their own
// `context.messages` array. pi's `agentLoopContinue` spreads the context
// shallowly (`{ ...context }`) and pushes each generated message and tool
// result into that same array. With both pushers mutating one array, every
// tool-loop fragment after mid-turn compaction double-appends: the wire
// carries each fragment twice, the canonical-row replay can never rebuild
// that shape, and the turn's KV-cache prefix plus its parked snapshot are
// lost (issue #10 class; docs/design/kv-snapshot-parking.md §5.2, §5.4).
// runAgentLoop must therefore never let continue mode mutate the caller's
// messages array. `agentLoop` (mode "start") copies internally; continue
// mode must be detached here, at the shared choke point.

const { agentLoop, agentLoopContinue } = vi.hoisted(() => ({
  agentLoop: vi.fn(),
  agentLoopContinue: vi.fn(),
}));

vi.mock("@earendil-works/pi-agent-core", () => ({
  agentLoop,
  agentLoopContinue,
}));

import { runAgentLoop } from "../services/agent-loop-runner.js";

function fakeStream(events: any[] = [], result: any[] = []) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
    result: async () => result,
  };
}

const config = { model: { id: "test-model" } } as any;

describe("runAgentLoop continue-mode context ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("detaches the caller's messages array from the loop's mutations", async () => {
    // Emulate pi's behavior: the loop pushes each assistant message into the
    // context array it received (streamAssistantResponse in agent-loop.js).
    // Capture the received array and its contents at dispatch time, because
    // the loop mutates that array as it runs.
    let receivedContext: any = null;
    let receivedInitialContents: string[] | null = null;
    agentLoopContinue.mockImplementation((ctx: any) => {
      receivedContext = ctx;
      receivedInitialContents = ctx.messages.map((m: any) => m.content);
      ctx.messages.push({ role: "assistant", content: "iteration-1" });
      ctx.messages.push({ role: "toolResult", content: "result-1" });
      return fakeStream();
    });

    const callerMessages = [{ role: "user", content: "go" } as any];
    const context = { messages: callerMessages, tools: [] } as any;

    await runAgentLoop({ mode: "continue", context, config });

    // The caller's array must hold exactly what the caller put there — the
    // route's turn_end mirror push is the only sanctioned appender.
    expect(callerMessages.map((m: any) => m.content)).toEqual(["go"]);

    // The loop ran on a detached copy with the same initial shape, and its
    // pushes landed there instead of on the caller's array.
    expect(receivedContext.messages).not.toBe(callerMessages);
    expect(receivedInitialContents).toEqual(["go"]);
    expect(receivedContext.messages.map((m: any) => m.content)).toEqual([
      "go",
      "iteration-1",
      "result-1",
    ]);
  });

  it("start mode passes the caller's context through (pi copies internally)", async () => {
    agentLoop.mockImplementation((_prompts: any, ctx: any) => fakeStream());

    const context = { messages: [{ role: "user", content: "go" } as any], tools: [] } as any;
    await runAgentLoop({
      mode: "start",
      context,
      config,
      prompts: [{ role: "user", content: "next" } as any],
    });

    expect(agentLoop.mock.calls[0][1]).toBe(context);
  });

  it("streams events to onEvent and returns the loop result", async () => {
    const assistant = { role: "assistant", content: "done" } as any;
    agentLoopContinue.mockImplementation(() =>
      fakeStream([{ type: "turn_end", message: assistant, toolResults: [] }], [assistant]),
    );
    const onEvent = vi.fn();

    const result = await runAgentLoop({
      mode: "continue",
      context: { messages: [{ role: "user", content: "go" } as any], tools: [] } as any,
      config,
      onEvent,
    });

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(result.events).toBe(1);
    expect(result.messages).toEqual([assistant]);
  });
});
