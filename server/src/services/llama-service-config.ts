import path from "path";
import { access } from "fs/promises";
import type { Settings } from "../types.js";
import type { LlamaServerId } from "./llama-supervisor.js";
import { getLlamaModelsDir } from "./llama-models-disk.js";
import { getDefaultLlamaBin, resolveBin, resolveSlotEnvironment } from "./llama-launch-templates.js";

export type LlamaServiceMode = "single" | "router";

export interface LlamaServiceConfig {
  mode: LlamaServiceMode;
  binaryPath: string;
  modelPath?: string;
  modelId?: string;
  modelsDir?: string;
  host: string;
  port: number;
  gpuLayers: number | "auto";
  ctxSize: number;
  parallel?: number;
  batchSize?: number;
  ubatchSize?: number;
  reasoningFormat?: string;
  chatTemplateKwargs?: string;
  extraArgs: string[];
  environment: string[];
}

export interface LlamaServiceConfigResponse {
  config: LlamaServiceConfig;
  defaults: LlamaServiceConfig;
  capabilities: {
    routerMode: boolean;
    singleMode: boolean;
    embedding: boolean;
    reranking: boolean;
    pooling?: "mean" | "rank";
  };
  unit: {
    unitName: string;
    enabled: boolean;
    enabledState: string;
    cat: string;
  };
  preview: {
    dropInPath: string;
    contents: string;
    execStart: string;
  };
}

interface PreviewInput {
  id: LlamaServerId;
  unitName: string;
  config: LlamaServiceConfig;
}

const ROLE_DEFAULTS: Record<LlamaServerId, Omit<LlamaServiceConfig, "binaryPath" | "modelId" | "modelPath" | "modelsDir" | "environment"> & {
  modelId?: (settings: Settings) => string | undefined;
  embedding?: boolean;
  reranking?: boolean;
  pooling?: "mean" | "rank";
}> = {
  inference: {
    mode: "router",
    modelId: (settings) => settings.defaultModelId,
    host: "127.0.0.1",
    port: 8080,
    gpuLayers: "auto",
    ctxSize: 131072,
    parallel: 1,
    batchSize: 4096,
    ubatchSize: 1024,
    reasoningFormat: "deepseek",
    extraArgs: [
      "--threads-batch", "10",
      "--threads", "12",
      "--flash-attn", "on",
      "--cache-ram", "32768",
      "--cache-idle-slots",
      "--kv_unified",
      "--split-mode", "tensor",
      "--tensor-split", "1,1",
      "--slot-prompt-similarity", "0.50",
      "--ctx-checkpoints", "128",
      "--sleep-idle-seconds", "172800",
      "--timeout", "86400",
    ],
  },
  extraction: {
    mode: "single",
    modelId: (settings) => settings.extractionModelId || settings.defaultModelId,
    host: "127.0.0.1",
    port: 8083,
    gpuLayers: 0,
    ctxSize: 16384,
    parallel: 1,
    reasoningFormat: "deepseek",
    chatTemplateKwargs: JSON.stringify({ enable_thinking: false }),
    extraArgs: [],
  },
  reranker: {
    mode: "single",
    modelId: (settings) => settings.rerankerModelId,
    host: "127.0.0.1",
    port: 8082,
    gpuLayers: 0,
    ctxSize: 4096,
    batchSize: 4096,
    ubatchSize: 4096,
    extraArgs: [],
    embedding: true,
    reranking: true,
    pooling: "rank",
  },
  embedding: {
    mode: "single",
    modelId: (settings) => settings.embeddingModel,
    host: "127.0.0.1",
    port: 8084,
    gpuLayers: 0,
    ctxSize: 8192,
    batchSize: 8192,
    ubatchSize: 8192,
    extraArgs: [],
    embedding: true,
    pooling: "mean",
  },
  "title-generation": {
    mode: "single",
    modelId: (settings) => settings.titleGenerationModelId,
    host: "127.0.0.1",
    port: 8085,
    gpuLayers: 0,
    ctxSize: 4096,
    parallel: 1,
    reasoningFormat: "deepseek",
    chatTemplateKwargs: JSON.stringify({ enable_thinking: false }),
    extraArgs: [],
  },
};

export function canUseRouterMode(id: LlamaServerId): boolean {
  return id === "inference" || id === "extraction" || id === "title-generation";
}

export function getDefaultServiceConfig(id: LlamaServerId, settings: Settings): LlamaServiceConfig {
  const base = ROLE_DEFAULTS[id];
  const binaryPath = resolveBin(id, settings);
  const modelId = base.modelId?.(settings);
  const config: LlamaServiceConfig = {
    mode: base.mode,
    binaryPath,
    modelId,
    modelsDir: canUseRouterMode(id) ? getLlamaModelsDir() : undefined,
    host: base.host,
    port: base.port,
    gpuLayers: base.gpuLayers,
    ctxSize: id === "extraction" ? Math.max(2048, Math.min(131072, settings.extractionCtxSize ?? base.ctxSize)) : base.ctxSize,
    parallel: base.parallel,
    batchSize: base.batchSize,
    ubatchSize: base.ubatchSize,
    reasoningFormat: base.reasoningFormat,
    chatTemplateKwargs: base.chatTemplateKwargs,
    extraArgs: [],
    environment: resolveSlotEnvironment(id, settings),
  };
  return config;
}

export function getServiceCapabilities(id: LlamaServerId): LlamaServiceConfigResponse["capabilities"] {
  const base = ROLE_DEFAULTS[id];
  return {
    routerMode: canUseRouterMode(id),
    singleMode: true,
    embedding: base.embedding === true,
    reranking: base.reranking === true,
    pooling: base.pooling,
  };
}

export function mergeServiceConfig(id: LlamaServerId, settings: Settings, patch: Partial<LlamaServiceConfig>): LlamaServiceConfig {
  const defaults = getDefaultServiceConfig(id, settings);
  const next: LlamaServiceConfig = {
    ...defaults,
    ...patch,
    extraArgs: Array.isArray(patch.extraArgs) ? patch.extraArgs : defaults.extraArgs,
    environment: Array.isArray(patch.environment) ? patch.environment : defaults.environment,
  };
  if (!canUseRouterMode(id)) next.mode = "single";
  if (next.mode === "router") {
    next.modelsDir = (next.modelsDir || defaults.modelsDir || getLlamaModelsDir()).trim();
    next.modelPath = undefined;
  }
  return withRequiredExtraArgs(id, normalizeServiceConfig(next));
}

function normalizeServiceConfig(config: LlamaServiceConfig): LlamaServiceConfig {
  return {
    ...config,
    binaryPath: config.binaryPath.trim() || getDefaultLlamaBin(),
    modelPath: config.modelPath?.trim() || undefined,
    modelId: config.modelId?.trim() || undefined,
    modelsDir: config.modelsDir?.trim() || undefined,
    host: config.host.trim() || "127.0.0.1",
    port: clampInt(config.port, 1, 65535),
    gpuLayers: config.gpuLayers === "auto" ? "auto" : clampInt(config.gpuLayers, -1, 999),
    ctxSize: clampInt(config.ctxSize, 512, 262144),
    parallel: config.parallel === undefined ? undefined : clampInt(config.parallel, 1, 64),
    batchSize: config.batchSize === undefined ? undefined : clampInt(config.batchSize, 1, 262144),
    ubatchSize: config.ubatchSize === undefined ? undefined : clampInt(config.ubatchSize, 1, 262144),
    reasoningFormat: config.reasoningFormat?.trim() || undefined,
    chatTemplateKwargs: config.chatTemplateKwargs?.trim() || undefined,
    extraArgs: normalizeStringList(config.extraArgs),
    environment: normalizeStringList(config.environment),
  };
}

function normalizeStringList(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  return values.map((value) => String(value).trim()).filter(Boolean);
}

function clampInt(value: unknown, min: number, max: number): number {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed)) return min;
  return Math.max(min, Math.min(max, parsed));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function joinArgs(parts: string[]): string {
  return parts.join(" \\\n    ");
}

export async function validateServiceConfig(id: LlamaServerId, config: LlamaServiceConfig): Promise<void> {
  if (config.mode === "router" && !canUseRouterMode(id)) {
    throw new Error(`${id} does not support router mode`);
  }
  if (config.mode === "single" && !config.modelPath) {
    throw new Error("modelPath is required in single-model mode");
  }
  if (config.mode === "router" && !config.modelsDir) {
    throw new Error("modelsDir is required in router mode");
  }
  if (config.extraArgs.some((arg) => /[\n\r]/.test(arg))) {
    throw new Error("extraArgs cannot contain newlines");
  }
  if (config.environment.some((line) => !/^[A-Za-z_][A-Za-z0-9_]*=.*$/.test(line))) {
    throw new Error("environment entries must look like NAME=value");
  }
  if (/\s/.test(config.host)) {
    throw new Error("host cannot contain whitespace");
  }
  await access(config.binaryPath);
  if (config.mode === "single" && config.modelPath) await access(config.modelPath);
  if (config.mode === "router" && config.modelsDir) await access(config.modelsDir);
}

export function renderServiceExecStart(id: LlamaServerId, config: LlamaServiceConfig): string {
  const args = [config.binaryPath];
  if (config.mode === "router") {
    args.push("--models-dir", shellQuote(config.modelsDir || getLlamaModelsDir()));
  } else {
    args.push("-m", shellQuote(config.modelPath || ""));
    if (config.modelId) args.push("--alias", shellQuote(config.modelId));
  }
  args.push("--port", String(config.port), "--host", config.host);
  if (ROLE_DEFAULTS[id].embedding) args.push("--embedding");
  if (ROLE_DEFAULTS[id].pooling) args.push("--pooling", ROLE_DEFAULTS[id].pooling);
  if (ROLE_DEFAULTS[id].reranking) args.push("--reranking");
  args.push("--n-gpu-layers", String(config.gpuLayers));
  args.push("--ctx-size", String(config.ctxSize));
  if (config.parallel) args.push("--parallel", String(config.parallel));
  if (config.batchSize) args.push("--batch-size", String(config.batchSize));
  if (config.ubatchSize) args.push("--ubatch-size", String(config.ubatchSize));
  if (config.reasoningFormat) args.push("--reasoning-format", config.reasoningFormat);
  if (config.chatTemplateKwargs) args.push("--chat-template-kwargs", shellQuote(config.chatTemplateKwargs));
  args.push(...config.extraArgs);
  return joinArgs(args);
}

export function renderManagedDropIn(input: PreviewInput): { dropInPath: string; contents: string; execStart: string } {
  const envLines = input.config.environment.map((value) => `Environment=${value}`).join("\n");
  const envSection = envLines ? `${envLines}\n` : "";
  const execStart = renderServiceExecStart(input.id, input.config);
  const contents = [
    "# Managed by Porrima - written by the llama.cpp service settings UI.",
    "# To change this service, use Settings > Inference Servers.",
    "[Service]",
    "ExecStart=",
    `${envSection}ExecStart=${execStart}`,
    "",
  ].join("\n");
  return {
    dropInPath: path.join(process.env.HOME || "", ".config", "systemd", "user", `${input.unitName}.d`, "zz-porrima-managed.conf"),
    contents,
    execStart,
  };
}

export function parseManagedServiceConfig(id: LlamaServerId, contents: string, fallback: LlamaServiceConfig): LlamaServiceConfig {
  const execStart = extractExecStart(contents);
  if (!execStart) return fallback;

  const tokens = tokenizeExecStart(execStart);
  if (tokens.length === 0) return fallback;

  const next: LlamaServiceConfig = {
    ...fallback,
    binaryPath: tokens[0],
    extraArgs: [],
    environment: extractEnvironment(contents),
  };
  const knownWithValues = new Set([
    "-m",
    "--alias",
    "--models-dir",
    "--port",
    "--host",
    "--n-gpu-layers",
    "--ctx-size",
    "--parallel",
    "--batch-size",
    "--ubatch-size",
    "--pooling",
    "--reasoning-format",
    "--chat-template-kwargs",
  ]);
  const knownFlags = new Set(["--embedding", "--reranking"]);

  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i];
    const value = tokens[i + 1];
    if (token === "--models-dir" && value) {
      next.mode = "router";
      next.modelsDir = value;
      next.modelPath = undefined;
      i += 1;
    } else if (token === "-m" && value) {
      next.mode = "single";
      next.modelPath = value;
      i += 1;
    } else if (token === "--alias" && value) {
      next.modelId = value;
      i += 1;
    } else if (token === "--port" && value) {
      next.port = Number.parseInt(value, 10) || next.port;
      i += 1;
    } else if (token === "--host" && value) {
      next.host = value;
      i += 1;
    } else if (token === "--n-gpu-layers" && value) {
      next.gpuLayers = value === "auto" ? "auto" : Number.parseInt(value, 10) || 0;
      i += 1;
    } else if (token === "--ctx-size" && value) {
      next.ctxSize = Number.parseInt(value, 10) || next.ctxSize;
      i += 1;
    } else if (token === "--parallel" && value) {
      next.parallel = Number.parseInt(value, 10) || next.parallel;
      i += 1;
    } else if (token === "--batch-size" && value) {
      next.batchSize = Number.parseInt(value, 10) || next.batchSize;
      i += 1;
    } else if (token === "--ubatch-size" && value) {
      next.ubatchSize = Number.parseInt(value, 10) || next.ubatchSize;
      i += 1;
    } else if (token === "--reasoning-format" && value) {
      next.reasoningFormat = value;
      i += 1;
    } else if (token === "--chat-template-kwargs" && value) {
      next.chatTemplateKwargs = value;
      i += 1;
    } else if (knownWithValues.has(token)) {
      i += 1;
    } else if (!knownFlags.has(token)) {
      next.extraArgs.push(token);
    }
  }

  return withRequiredExtraArgs(id, normalizeServiceConfig(next));
}

function withRequiredExtraArgs(id: LlamaServerId, config: LlamaServiceConfig): LlamaServiceConfig {
  const required = ROLE_DEFAULTS[id].extraArgs || [];
  if (required.length === 0) return config;
  const extraArgs = [...config.extraArgs];
  for (let i = 0; i < required.length; i += 1) {
    const token = required[i];
    if (!token.startsWith("-")) continue;
    if (extraArgs.includes(token)) {
      if (i + 1 < required.length && !required[i + 1].startsWith("-")) i += 1;
      continue;
    }
    extraArgs.push(token);
    if (i + 1 < required.length && !required[i + 1].startsWith("-")) {
      extraArgs.push(required[i + 1]);
      i += 1;
    }
  }
  return { ...config, extraArgs };
}

function extractExecStart(contents: string): string | null {
  const lines = contents.split("\n");
  const execIndex = lines.findIndex((line) => line.trim().startsWith("ExecStart=") && line.trim() !== "ExecStart=");
  if (execIndex < 0) return null;

  const collected: string[] = [];
  for (let i = execIndex; i < lines.length; i += 1) {
    let line = lines[i].trim();
    if (i === execIndex) line = line.replace(/^ExecStart=/, "");
    const continued = line.endsWith("\\");
    collected.push(continued ? line.slice(0, -1).trim() : line);
    if (!continued) break;
  }
  return collected.join(" ");
}

function tokenizeExecStart(input: string): string[] {
  const tokens: string[] = [];
  const pattern = /'([^']*)'|"([^"]*)"|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input))) {
    tokens.push(match[1] ?? match[2] ?? match[3]);
  }
  return tokens;
}

function extractEnvironment(contents: string): string[] {
  return contents
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("Environment="))
    .map((line) => line.replace(/^Environment=/, "").trim())
    .filter(Boolean);
}
