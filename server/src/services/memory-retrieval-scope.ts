export const CROSS_PROJECT_SCORE_MULTIPLIER_DEFAULT = 0.3;
export const GLOBAL_PROJECT_SCORE_MULTIPLIER_DEFAULT = 1.0;

export function normalizeCrossProjectScoreMultiplier(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return CROSS_PROJECT_SCORE_MULTIPLIER_DEFAULT;
  }
  return Math.max(0, Math.min(1, value));
}

export function normalizeGlobalProjectScoreMultiplier(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return GLOBAL_PROJECT_SCORE_MULTIPLIER_DEFAULT;
  }
  return Math.max(0, Math.min(1, value));
}

export function isCrossProjectMemory(memoryProjectId: string | undefined, projectId?: string): boolean {
  return Boolean(projectId && memoryProjectId && memoryProjectId !== projectId);
}

export function isProjectScopedMemory(memoryProjectId: string | undefined): boolean {
  return Boolean(memoryProjectId);
}

export function applyCrossProjectScoreMultiplier<T extends { memory: { projectId?: string }; score: number }>(
  candidates: T[],
  projectId: string | undefined,
  multiplier: number,
): number {
  if (!projectId) return 0;
  const normalizedMultiplier = normalizeCrossProjectScoreMultiplier(multiplier);
  let count = 0;
  for (const candidate of candidates) {
    if (isCrossProjectMemory(candidate.memory.projectId, projectId)) {
      candidate.score *= normalizedMultiplier;
      count++;
    }
  }
  return count;
}

export function applyGlobalProjectScoreMultiplier<T extends { memory: { projectId?: string }; score: number }>(
  candidates: T[],
  multiplier: number,
): number {
  const normalizedMultiplier = normalizeGlobalProjectScoreMultiplier(multiplier);
  let count = 0;
  for (const candidate of candidates) {
    if (isProjectScopedMemory(candidate.memory.projectId)) {
      candidate.score *= normalizedMultiplier;
      count++;
    }
  }
  return count;
}

export function sortByAdjustedScore<T extends { score: number }>(candidates: T[]): T[] {
  return [...candidates].sort((a, b) => b.score - a.score);
}
