import { describe, expect, it } from "vitest";
import type { AgentTurnContext } from "@earendil-works/pi-agent-core";
import { createAgentLoopConfig } from "./agent-loop-runner.js";

const model = {
  id: "test-model",
  api: "openai-completions",
  provider: "openai-completions",
  reasoning: false,
} as any;

function turn(stopReason: string): AgentTurnContext {
  return {
    message: { role: "assistant", stopReason, content: [], usage: { input: 0, output: 0 } },
    toolResults: [],
    context: { messages: [] },
    newMessages: [],
  } as any;
}

describe("createAgentLoopConfig", () => {
  it("maps shouldStopAfterTurn=true to finishTurn {action:'end'}", async () => {
    const config = createAgentLoopConfig({ model, shouldStopAfterTurn: () => true });
    await expect(config.finishTurn!(turn("stop"))).resolves.toEqual({ action: "end" });
  });

  it("keeps normal scheduling when the predicate says no", async () => {
    const config = createAgentLoopConfig({ model, shouldStopAfterTurn: () => false });
    await expect(config.finishTurn!(turn("toolUse"))).resolves.toBeUndefined();
  });

  it("ignores error and aborted responses without invoking the predicate", async () => {
    let calls = 0;
    const config = createAgentLoopConfig({
      model,
      shouldStopAfterTurn: () => {
        calls++;
        return true;
      },
    });
    await expect(config.finishTurn!(turn("error"))).resolves.toBeUndefined();
    await expect(config.finishTurn!(turn("aborted"))).resolves.toBeUndefined();
    expect(calls).toBe(0);
  });

  it("prepends the system prompt as the leading transcript message", async () => {
    const config = createAgentLoopConfig({ model, systemPrompt: "SYS" });
    const converted = await config.convertToLlm!([
      { role: "user", content: "hi", timestamp: 1 } as any,
    ]);
    expect(converted[0]).toMatchObject({ role: "system", content: "SYS" });
    expect(converted[1]).toMatchObject({ role: "user", content: "hi" });
  });

  it("re-evaluates a getter system prompt per request", async () => {
    let prompt = "one";
    const config = createAgentLoopConfig({ model, systemPrompt: () => prompt });
    prompt = "two";
    const converted = await config.convertToLlm!([
      { role: "user", content: "hi", timestamp: 1 } as any,
    ]);
    expect(converted[0]).toMatchObject({ role: "system", content: "two" });
  });

  it("omits the leading message when no system prompt is set", async () => {
    const config = createAgentLoopConfig({ model });
    const converted = await config.convertToLlm!([
      { role: "user", content: "hi", timestamp: 1 } as any,
    ]);
    expect(converted).toHaveLength(1);
    expect(converted[0]).toMatchObject({ role: "user" });
  });
});
