import { createHash } from "crypto";
import { appendFile, mkdir } from "fs/promises";
import { dirname } from "path";
import { appDataPath } from "./paths.js";
import { describeTextTokenEstimate, type TokenEstimateKind } from "./token-count.js";

const TOKEN_ESTIMATE_LOG_PATH = appDataPath("diagnostics", "token-estimates.jsonl");

function truthyEnv(value: string | undefined): boolean {
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function isTokenEstimateObservabilityEnabled(): boolean {
  return truthyEnv(process.env.TOKEN_ESTIMATE_OBSERVABILITY) ||
    truthyEnv(process.env.PORRIMA_TOKEN_ESTIMATE_OBSERVABILITY);
}

export function getTokenEstimateLogPath(): string {
  return process.env.TOKEN_ESTIMATE_OBSERVABILITY_PATH || TOKEN_ESTIMATE_LOG_PATH;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function lineCount(content: string): number {
  if (!content) return 0;
  let lines = 1;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 10) lines++;
  }
  return lines;
}

function finiteRatio(numerator: number, denominator: number): number | undefined {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return undefined;
  return numerator / denominator;
}

export interface ToolResultExactTokenEstimateInput {
  chatId?: string;
  phase?: string;
  modelId?: string;
  label: string;
  toolName?: string;
  content: string;
  kind?: TokenEstimateKind;
  exactTokens: number;
  exactElapsedMs: number;
  exactCached: boolean;
}

export interface ContextEstimateObservationInput {
  chatId: string;
  modelId?: string;
  sourceIteration: number;
  observedIteration: number;
  sourceStopReason: string;
  observedStopReason: string;
  estimatedInputTokens: number;
  displayEstimatedInputTokens?: number;
  approximateTokens?: number;
  exactToolResultCount?: number;
  exactDelta?: number;
  signedExactDelta?: number;
  selectedEstimatePath?: "usage_anchor" | "char_estimate";
  pathAEstimateTokens?: number;
  pathBEstimateTokens?: number;
  lastUsageInputTokens?: number;
  lastUsageOutputTokens?: number;
  lastUsageTotalTokens?: number;
  postUsageAdditionalTokens?: number;
  toolCallCount?: number;
  toolResultCount?: number;
  contextWindow?: number;
  observedInputTokens: number;
  observedOutputTokens?: number;
  observedTotalTokens?: number;
}

export type TokenEstimateSample =
  | {
      schemaVersion: 1;
      sampleType: "tool_result_exact";
      observedAt: string;
      chatId?: string;
      phase?: string;
      modelId?: string;
      label: string;
      toolName?: string;
      contentHash: string;
      contentChars: number;
      lineCount: number;
      kind: TokenEstimateKind;
      heuristicBranch: string;
      dense: boolean;
      whitespaceRatio: number;
      digitSymbolRatio: number;
      heuristicCharsPerToken: number;
      heuristicTokens: number;
      exactTokens: number;
      deltaTokens: number;
      ratioEstimateToExact?: number;
      exactCharsPerToken?: number;
      tokenizeElapsedMs: number;
      tokenizeCached: boolean;
    }
  | {
      schemaVersion: 1;
      sampleType: "context_estimate_observed";
      observedAt: string;
      chatId: string;
      modelId?: string;
      sourceIteration: number;
      observedIteration: number;
      sourceStopReason: string;
      observedStopReason: string;
      estimatedInputTokens: number;
      displayEstimatedInputTokens?: number;
      approximateTokens?: number;
      exactToolResultCount?: number;
      exactDelta?: number;
      signedExactDelta?: number;
      selectedEstimatePath?: "usage_anchor" | "char_estimate";
      pathAEstimateTokens?: number;
      pathBEstimateTokens?: number;
      lastUsageInputTokens?: number;
      lastUsageOutputTokens?: number;
      lastUsageTotalTokens?: number;
      postUsageAdditionalTokens?: number;
      toolCallCount?: number;
      toolResultCount?: number;
      contextWindow?: number;
      observedInputTokens: number;
      observedOutputTokens?: number;
      observedTotalTokens?: number;
      ratioEstimateToObserved?: number;
      ratioDisplayEstimateToObserved?: number;
    };

let writeChain: Promise<void> = Promise.resolve();

export function recordTokenEstimateSample(sample: TokenEstimateSample): void {
  if (!isTokenEstimateObservabilityEnabled()) return;
  const path = getTokenEstimateLogPath();
  const line = `${JSON.stringify(sample)}\n`;
  writeChain = writeChain
    .then(async () => {
      await mkdir(dirname(path), { recursive: true });
      await appendFile(path, line, "utf8");
    })
    .catch((err) => {
      console.warn("[token-estimate] failed to write observability sample:", err instanceof Error ? err.message : err);
    });
}

export async function flushTokenEstimateObservability(): Promise<void> {
  await writeChain;
}

export function recordToolResultExactTokenEstimate(input: ToolResultExactTokenEstimateInput): void {
  if (!isTokenEstimateObservabilityEnabled()) return;
  const kind = input.kind ?? "tool_result";
  const description = describeTextTokenEstimate(input.content, kind);
  const sample: TokenEstimateSample = {
    schemaVersion: 1,
    sampleType: "tool_result_exact",
    observedAt: new Date().toISOString(),
    chatId: input.chatId,
    phase: input.phase,
    modelId: input.modelId,
    label: input.label,
    toolName: input.toolName,
    contentHash: hashContent(input.content),
    contentChars: input.content.length,
    lineCount: lineCount(input.content),
    kind,
    heuristicBranch: description.heuristicBranch,
    dense: description.dense,
    whitespaceRatio: description.whitespaceRatio,
    digitSymbolRatio: description.digitSymbolRatio,
    heuristicCharsPerToken: description.charsPerToken,
    heuristicTokens: description.estimatedTokens,
    exactTokens: input.exactTokens,
    deltaTokens: input.exactTokens - description.estimatedTokens,
    ratioEstimateToExact: finiteRatio(description.estimatedTokens, input.exactTokens),
    exactCharsPerToken: finiteRatio(input.content.length, input.exactTokens),
    tokenizeElapsedMs: input.exactElapsedMs,
    tokenizeCached: input.exactCached,
  };
  recordTokenEstimateSample(sample);
}

export function recordContextEstimateObservation(input: ContextEstimateObservationInput): void {
  if (!isTokenEstimateObservabilityEnabled()) return;
  const sample: TokenEstimateSample = {
    schemaVersion: 1,
    sampleType: "context_estimate_observed",
    observedAt: new Date().toISOString(),
    chatId: input.chatId,
    modelId: input.modelId,
    sourceIteration: input.sourceIteration,
    observedIteration: input.observedIteration,
    sourceStopReason: input.sourceStopReason,
    observedStopReason: input.observedStopReason,
    estimatedInputTokens: input.estimatedInputTokens,
    displayEstimatedInputTokens: input.displayEstimatedInputTokens,
    approximateTokens: input.approximateTokens,
    exactToolResultCount: input.exactToolResultCount,
    exactDelta: input.exactDelta,
    signedExactDelta: input.signedExactDelta,
    selectedEstimatePath: input.selectedEstimatePath,
    pathAEstimateTokens: input.pathAEstimateTokens,
    pathBEstimateTokens: input.pathBEstimateTokens,
    lastUsageInputTokens: input.lastUsageInputTokens,
    lastUsageOutputTokens: input.lastUsageOutputTokens,
    lastUsageTotalTokens: input.lastUsageTotalTokens,
    postUsageAdditionalTokens: input.postUsageAdditionalTokens,
    toolCallCount: input.toolCallCount,
    toolResultCount: input.toolResultCount,
    contextWindow: input.contextWindow,
    observedInputTokens: input.observedInputTokens,
    observedOutputTokens: input.observedOutputTokens,
    observedTotalTokens: input.observedTotalTokens,
    ratioEstimateToObserved: finiteRatio(input.estimatedInputTokens, input.observedInputTokens),
    ratioDisplayEstimateToObserved: input.displayEstimatedInputTokens !== undefined
      ? finiteRatio(input.displayEstimatedInputTokens, input.observedInputTokens)
      : undefined,
  };
  recordTokenEstimateSample(sample);
}
