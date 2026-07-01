// In-memory debugging observability for the memory-extraction agent.
//
// Every time the extraction LLM runs (delayed, immediate, or pre-compaction
// flush) we capture the input context, prompt, raw model output, and parsed
// results into a ring buffer and fan out a live event to any SSE subscribers.
// This gives the debug panel both a historical view (last ~20 runs) and a
// real-time stream, without touching persistent storage.

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

export type ExtractionTrigger = "immediate" | "delayed" | "pre-compaction" | "mid-turn-pulse" | "other";

export type ExtractionStatus = "running" | "success" | "error";

export interface ExtractionMessageView {
  role: string;
  content: string;
}

export interface ExtractionParsedFact {
  text: string;
  category?: string;
  importance?: number;
  sourceExchangeId?: string;
}

export interface ExtractionChunkInfo {
  count: number;
  failures: number;
  timingsMs: number[];
}

export interface ExtractionSupersessionResolution {
  newFactIndex: number;
  newFactText: string;
  existingMemoryId: string;
  existingMemoryText: string;
  embeddingSimilarity: number;
  textDiffOverlap: number;
  decision: "supersede" | "separate" | "unsure";
  reason?: string;
}

export interface ExtractionResults {
  facts: ExtractionParsedFact[];
  saved: number;
  superseded: number;
  skippedDuplicates: number;
  errors: number;
  /** Subject line from the extraction wrapper, providing conversational context. */
  subject?: string;
  /** Batched LLM comparison results for ambiguous supersession candidates. */
  supersessionResolutions?: ExtractionSupersessionResolution[];
  /** Count of supersession links resolved by the batch comparison step. */
  comparisonSuperseded?: number;
  /** Count of candidates left as separate facts by the batch comparison step. */
  comparisonSeparate?: number;
  /** Chunking metadata — present only when chunkCount > 1. */
  chunks?: ExtractionChunkInfo;
}

export interface ExtractionRunMetadata {
  sessionId?: string;
  queuedExchangeCount?: number;
  batchedExchangeCount?: number;
  sessionMessageCount?: number;
  promptChars?: number;
  estimatedPromptTokens?: number;
  prunedPriorMessages?: number;
  freshSessionReason?: string;
  chunkedFallback?: boolean;
}

export interface ExtractionRun {
  id: string;
  trigger: ExtractionTrigger;
  chatId?: string;
  chatTitle?: string;
  model: string;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  status: ExtractionStatus;
  priorMemoryCount: number;
  messages: ExtractionMessageView[];
  systemPrompt: string;
  userPrompt: string;
  rawOutput?: string;
  results?: ExtractionResults;
  error?: string;
  metadata?: ExtractionRunMetadata;
}

export interface ExtractionEvent {
  type: "start" | "output" | "complete" | "error";
  run: ExtractionRun;
}

const MAX_RUNS = 20;
const runs: ExtractionRun[] = [];
const emitter = new EventEmitter();
emitter.setMaxListeners(0);

function pushRun(run: ExtractionRun): void {
  runs.unshift(run);
  if (runs.length > MAX_RUNS) runs.length = MAX_RUNS;
}

function replaceRun(run: ExtractionRun): void {
  const idx = runs.findIndex((r) => r.id === run.id);
  if (idx === -1) pushRun(run);
  else runs[idx] = run;
}

function emit(event: ExtractionEvent): void {
  emitter.emit("event", event);
}

export function getRecentExtractionRuns(): ExtractionRun[] {
  return runs.slice();
}

export function subscribeExtractionEvents(listener: (e: ExtractionEvent) => void): () => void {
  emitter.on("event", listener);
  return () => emitter.off("event", listener);
}

export interface StartRunInput {
  trigger: ExtractionTrigger;
  chatId?: string;
  chatTitle?: string;
  model: string;
  priorMemoryCount: number;
  messages: ExtractionMessageView[];
  systemPrompt: string;
  userPrompt: string;
  metadata?: ExtractionRunMetadata;
}

export interface RunHandle {
  runId: string;
  attachOutput(raw: string): void;
  complete(results: ExtractionResults): void;
  fail(error: unknown): void;
}

export function startExtractionRun(input: StartRunInput): RunHandle {
  const id = randomUUID();
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const run: ExtractionRun = {
    id,
    trigger: input.trigger,
    chatId: input.chatId,
    chatTitle: input.chatTitle,
    model: input.model,
    startedAt,
    status: "running",
    priorMemoryCount: input.priorMemoryCount,
    messages: input.messages,
    systemPrompt: input.systemPrompt,
    userPrompt: input.userPrompt,
    metadata: input.metadata,
  };
  pushRun(run);
  emit({ type: "start", run });

  return {
    runId: id,
    attachOutput(raw: string) {
      run.rawOutput = raw;
      replaceRun(run);
      emit({ type: "output", run });
    },
    complete(results: ExtractionResults) {
      run.results = results;
      run.status = "success";
      run.completedAt = new Date().toISOString();
      run.durationMs = Date.now() - t0;
      replaceRun(run);
      emit({ type: "complete", run });
    },
    fail(err: unknown) {
      run.error = err instanceof Error ? err.message : String(err);
      run.status = "error";
      run.completedAt = new Date().toISOString();
      run.durationMs = Date.now() - t0;
      replaceRun(run);
      emit({ type: "error", run });
    },
  };
}
