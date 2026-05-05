import path from "path";
import os from "os";
import type { Settings } from "../types.js";
import type { LlamaServerId } from "./llama-supervisor.js";
import { getLlamaModelsDir } from "./llama-models-disk.js";

/**
 * Per-slot launch templates. Each template renders a complete ExecStart line
 * for a llama.cpp server given a model path + id + current settings. The
 * templates mirror the existing systemd unit files, so applying an override
 * for a slot keeps it functionally identical except for the loaded model.
 *
 * Slots covered: title-generation, extraction, reranker, embedding.
 * The "inference" slot already runs in router mode and switches models via
 * /models/load, so it is excluded — overrides are not used there.
 */

export type OverridableSlotId = Exclude<LlamaServerId, "inference">;

const LLAMA_BIN = path.join(os.homedir(), "bin", "llama-current", "llama-server");

export function getDefaultLlamaBin(): string {
  return LLAMA_BIN;
}

interface TemplateInput {
  ggufPath: string;
  modelId: string;
  settings: Settings;
}

/** Resolve the llama-server binary for a slot, using per-slot override if set. */
export function resolveBin(slotId: string, settings: Settings): string {
  return settings.llamaServerBins?.[slotId] || LLAMA_BIN;
}

/**
 * Resolve environment variables needed for a slot's binary.
 * Custom binaries (e.g. ik_llama.cpp with dynamic .so libs) need
 * LD_LIBRARY_PATH pointing to their library directory.
 */
export function resolveSlotEnvironment(slotId: string, settings: Settings): string[] {
  const bin = resolveBin(slotId, settings);
  if (bin === LLAMA_BIN) return [];
  // Custom binary — set LD_LIBRARY_PATH to the directory containing it
  // so dynamic .so libraries (libggml.so, libllama.so) can be found.
  return [`LD_LIBRARY_PATH=${path.dirname(bin)}`];
}

function joinArgs(parts: string[]): string {
  return parts.join(" \\\n    ");
}

function shellQuote(value: string): string {
  // Single-quote everything; embedded single quotes are escaped.
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function commonGpuOff(): string[] {
  return ["--n-gpu-layers", "0"];
}

function buildTitleGenerationExecStart(input: TemplateInput): string {
  const args = [
    resolveBin("title-generation", input.settings),
    "-m", shellQuote(input.ggufPath),
    "--alias", shellQuote(input.modelId),
    "--port", "8085",
    "--host", "127.0.0.1",
    ...commonGpuOff(),
    "--ctx-size", "4096",
    "--parallel", "1",
    "--reasoning-format", "deepseek",
    "--chat-template-kwargs", shellQuote(JSON.stringify({ enable_thinking: false })),
  ];
  return joinArgs(args);
}

function buildExtractionExecStart(input: TemplateInput): string {
  const ctx = Math.max(2048, Math.min(131072, input.settings.extractionCtxSize ?? 16384));
  const args = [
    resolveBin("extraction", input.settings),
    "-m", shellQuote(input.ggufPath),
    "--alias", shellQuote(input.modelId),
    "--port", "8083",
    "--host", "127.0.0.1",
    ...commonGpuOff(),
    "--ctx-size", String(ctx),
    "--parallel", "1",
    "--reasoning-format", "deepseek",
    "--chat-template-kwargs", shellQuote(JSON.stringify({ enable_thinking: false })),
  ];
  return joinArgs(args);
}

function buildRerankerExecStart(input: TemplateInput): string {
  const args = [
    resolveBin("reranker", input.settings),
    "-m", shellQuote(input.ggufPath),
    "--alias", shellQuote(input.modelId),
    "--embedding",
    "--pooling", "rank",
    "--reranking",
    "--port", "8082",
    "--host", "127.0.0.1",
    ...commonGpuOff(),
    "--ctx-size", "4096",
  ];
  return joinArgs(args);
}

function buildEmbeddingExecStart(input: TemplateInput): string {
  const args = [
    resolveBin("embedding", input.settings),
    "-m", shellQuote(input.ggufPath),
    "--alias", shellQuote(input.modelId),
    "--embedding",
    "--pooling", "mean",
    "--port", "8084",
    "--host", "127.0.0.1",
    ...commonGpuOff(),
    "--ctx-size", "8192",
    "--batch-size", "8192",
    "--ubatch-size", "8192",
  ];
  return joinArgs(args);
}

export function renderExecStart(slotId: OverridableSlotId, input: TemplateInput): string {
  switch (slotId) {
    case "title-generation":
      return buildTitleGenerationExecStart(input);
    case "extraction":
      return buildExtractionExecStart(input);
    case "reranker":
      return buildRerankerExecStart(input);
    case "embedding":
      return buildEmbeddingExecStart(input);
  }
}

export function isOverridableSlot(slotId: string): slotId is OverridableSlotId {
  return slotId === "title-generation" || slotId === "extraction" || slotId === "reranker" || slotId === "embedding";
}

export type RouterCapableSlotId = "title-generation" | "extraction";

export function isRouterCapableSlot(slotId: string): slotId is RouterCapableSlotId {
  return slotId === "title-generation" || slotId === "extraction";
}

/**
 * Render a router-mode ExecStart for slots that can multiplex models. Same
 * runtime flags as the single-model template (CPU-only, ctx, parallelism,
 * thinking/reasoning settings) but with `--models-dir` instead of `-m`/
 * `--alias`. Once installed via drop-in override, the slot enumerates every
 * GGUF in the models dir on /v1/models, and model swaps go through HTTP
 * /models/load — no systemd restart per swap. Slot's --ctx-size becomes the
 * default; per-load overrides are passed in /models/load `args`.
 */
export function renderRouterExecStart(slotId: RouterCapableSlotId, settings: Settings): string {
  const modelsDir = getLlamaModelsDir();
  if (slotId === "title-generation") {
    const args = [
      resolveBin("title-generation", settings),
      "--models-dir", shellQuote(modelsDir),
      "--port", "8085",
      "--host", "127.0.0.1",
      ...commonGpuOff(),
      "--ctx-size", "4096",
      "--parallel", "1",
      "--reasoning-format", "deepseek",
      "--chat-template-kwargs", shellQuote(JSON.stringify({ enable_thinking: false })),
    ];
    return joinArgs(args);
  }
  // extraction
  const ctx = Math.max(2048, Math.min(131072, settings.extractionCtxSize ?? 16384));
  const args = [
    resolveBin("extraction", settings),
    "--models-dir", shellQuote(modelsDir),
    "--port", "8083",
    "--host", "127.0.0.1",
    ...commonGpuOff(),
    "--ctx-size", String(ctx),
    "--parallel", "1",
    "--reasoning-format", "deepseek",
    "--chat-template-kwargs", shellQuote(JSON.stringify({ enable_thinking: false })),
  ];
  return joinArgs(args);
}
