import { describe, expect, it } from "vitest";
import type { AutomationTask } from "../types.js";
import { selectAutomationPromptStepsForRun } from "../services/automation-prompt-selection.js";

function task(overrides: Partial<AutomationTask> = {}): AutomationTask {
  const now = "2026-06-07T00:00:00.000Z";
  return {
    id: "auto-test",
    kind: "custom",
    title: "Test Automation",
    enabled: true,
    builtIn: false,
    orderIndex: 0,
    chatId: "automation:auto-test",
    schedule: { type: "interval", everyMinutes: 60 },
    activationPolicy: "idle",
    promptSteps: [
      { id: "a", title: "Alpha", prompt: "Run alpha." },
      { id: "b", title: "Beta", prompt: "Run beta." },
      { id: "c", title: "Gamma", prompt: "Run gamma." },
    ],
    promptDispatchMode: "sequence",
    notifications: { enabled: false },
    maxIterations: 20,
    timeoutMs: 30 * 60 * 1000,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("selectAutomationPromptStepsForRun", () => {
  it("keeps existing sequence behavior by default", () => {
    const selection = selectAutomationPromptStepsForRun(task());

    expect(selection.mode).toBe("sequence");
    expect(selection.selectedSteps.map((step) => step.id)).toEqual(["a", "b", "c"]);
    expect(selection.nextPromptStepId).toBeUndefined();
  });

  it("selects one random prompt using the provided random source", () => {
    const selection = selectAutomationPromptStepsForRun(task({ promptDispatchMode: "random" }), () => 0.55);

    expect(selection.mode).toBe("random");
    expect(selection.selectedSteps.map((step) => step.id)).toEqual(["b"]);
    expect(selection.nextPromptStepId).toBeUndefined();
  });

  it("cycles from the stored cursor and returns the next cursor", () => {
    const selection = selectAutomationPromptStepsForRun(task({
      promptDispatchMode: "cycle",
      nextPromptStepId: "b",
    }));

    expect(selection.mode).toBe("cycle");
    expect(selection.selectedSteps.map((step) => step.id)).toEqual(["b"]);
    expect(selection.nextPromptStepId).toBe("c");
  });

  it("falls back to the first prompt when the cycle cursor was deleted", () => {
    const selection = selectAutomationPromptStepsForRun(task({
      promptDispatchMode: "cycle",
      nextPromptStepId: "deleted",
    }));

    expect(selection.selectedSteps.map((step) => step.id)).toEqual(["a"]);
    expect(selection.nextPromptStepId).toBe("b");
  });

  it("forces synthesis tasks to run all phase steps", () => {
    const selection = selectAutomationPromptStepsForRun(task({
      kind: "synthesis",
      builtIn: true,
      promptDispatchMode: "random",
      nextPromptStepId: "b",
    }));

    expect(selection.mode).toBe("sequence");
    expect(selection.selectedSteps.map((step) => step.id)).toEqual(["a", "b", "c"]);
    expect(selection.nextPromptStepId).toBeUndefined();
  });
});
