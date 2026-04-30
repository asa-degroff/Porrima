let automationLock: Promise<void> | null = null;
let automationLockResolver: (() => void) | null = null;
let activeAutomationTaskId: string | null = null;

export function getAutomationLock(): Promise<void> | null {
  return automationLock;
}

export function isAutomationActive(): boolean {
  return automationLock !== null;
}

export function getActiveAutomationTaskId(): string | null {
  return activeAutomationTaskId;
}

export async function acquireAutomationLock(taskId: string): Promise<void> {
  while (automationLock) {
    await automationLock;
  }
  activeAutomationTaskId = taskId;
  automationLock = new Promise<void>((resolve) => {
    automationLockResolver = resolve;
  });
}

export function releaseAutomationLock(taskId?: string): void {
  if (taskId && activeAutomationTaskId && activeAutomationTaskId !== taskId) {
    console.warn(
      `[automation] release requested by ${taskId}, but active task is ${activeAutomationTaskId}`,
    );
  }

  activeAutomationTaskId = null;
  const resolver = automationLockResolver;
  automationLockResolver = null;
  automationLock = null;
  resolver?.();
}
