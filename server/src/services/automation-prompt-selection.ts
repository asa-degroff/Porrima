import type { AutomationPromptDispatchMode, AutomationPromptStep, AutomationTask } from "../types.js";

export interface AutomationPromptSelection {
  mode: AutomationPromptDispatchMode;
  selectedSteps: AutomationPromptStep[];
  nextPromptStepId?: string;
}

function eligiblePromptSteps(task: Pick<AutomationTask, "promptSteps">): AutomationPromptStep[] {
  return task.promptSteps.filter((step) => step.prompt.trim().length > 0);
}

export function effectiveAutomationPromptDispatchMode(
  task: Pick<AutomationTask, "kind" | "promptDispatchMode">,
): AutomationPromptDispatchMode {
  if (task.kind === "synthesis") return "sequence";
  return task.promptDispatchMode === "random" || task.promptDispatchMode === "cycle"
    ? task.promptDispatchMode
    : "sequence";
}

function pickRandomIndex(length: number, random: () => number): number {
  if (length <= 1) return 0;
  const value = random();
  if (!Number.isFinite(value)) return 0;
  return Math.min(length - 1, Math.max(0, Math.floor(value * length)));
}

export function selectAutomationPromptStepsForRun(
  task: Pick<AutomationTask, "kind" | "promptDispatchMode" | "nextPromptStepId" | "promptSteps">,
  random: () => number = Math.random,
): AutomationPromptSelection {
  const steps = eligiblePromptSteps(task);
  const mode = effectiveAutomationPromptDispatchMode(task);

  if (mode === "random") {
    return {
      mode,
      selectedSteps: steps.length > 0 ? [steps[pickRandomIndex(steps.length, random)]] : [],
    };
  }

  if (mode === "cycle") {
    if (steps.length === 0) return { mode, selectedSteps: [] };
    const currentIndex = Math.max(0, steps.findIndex((step) => step.id === task.nextPromptStepId));
    const selectedStep = steps[currentIndex] ?? steps[0];
    const nextStep = steps[(currentIndex + 1) % steps.length] ?? selectedStep;
    return {
      mode,
      selectedSteps: [selectedStep],
      nextPromptStepId: nextStep.id,
    };
  }

  return {
    mode: "sequence",
    selectedSteps: steps,
  };
}
