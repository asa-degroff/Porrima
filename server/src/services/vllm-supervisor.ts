import { spawn } from "child_process";
import type { ChildProcessByStdio } from "child_process";
import { existsSync } from "fs";
import { dirname, join, resolve } from "path";
import type { Readable } from "stream";
import { fileURLToPath } from "url";
import type { OllamaModel, Settings, VllmModelProfile } from "../types.js";
import { getSettings, saveSettings } from "./chat-storage.js";
import { activeStreamCount, waitForActiveCountAtMost } from "./llm-activity.js";

export const VLLM_DEFAULT_URL = "http://localhost:8095";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const VLLM_BIN = join(REPO_ROOT, ".venv-vllm", "bin", "vllm");
const OPENMPI_LIB = join(
  REPO_ROOT,
  ".venv-vllm",
  "openmpi4-root",
  "usr",
  "lib",
  "x86_64-linux-gnu"
);
const LOG_LIMIT = 250;
const START_TIMEOUT_MS = 30 * 60 * 1000;
const IDLE_WAIT_MS = 2 * 60 * 1000;

export const DEFAULT_VLLM_PROFILE: VllmModelProfile = {
  id: "qwen3.6-27b-ud-q4_k_xl",
  name: "Qwen3.6 27B UD Q4_K_XL",
  model: "unsloth/Qwen3.6-27B-GGUF:UD-Q4_K_XL",
  servedModelName: "qwen3.6-27b-ud-q4_k_xl",
  tokenizer: "Qwen/Qwen3.6-27B",
  hfConfigPath: "Qwen/Qwen3.6-27B",
  host: "127.0.0.1",
  port: 8095,
  rocrVisibleDevices: "0,1",
  tensorParallelSize: 2,
  maxModelLen: 16384,
  maxNumSeqs: 96,
  gpuMemoryUtilization: 0.82,
  dtype: "float16",
  reasoningParser: "qwen3",
  toolCallParser: "qwen3_coder",
  enableAutoToolChoice: true,
  languageModelOnly: true,
  kvCacheMetrics: true,
  extraArgs: [],
};

export type VllmSupervisorState =
  | "idle"
  | "starting"
  | "ready"
  | "stopping"
  | "failed";

export interface VllmSupervisorLog {
  timestamp: number;
  stream: "stdout" | "stderr" | "system";
  line: string;
}

export interface VllmSupervisorStatus {
  status: VllmSupervisorState;
  managedEnabled: boolean;
  currentProfileId?: string;
  activeProfileId?: string;
  pid?: number;
  url?: string;
  profile?: VllmModelProfile;
  profiles: VllmModelProfile[];
  command?: string[];
  vllmBin: string;
  vllmBinExists: boolean;
  startedAt?: string;
  readyAt?: string;
  lastError?: string;
  activeStreams: number;
  logs: VllmSupervisorLog[];
}

interface SupervisorState {
  child: VllmChildProcess | null;
  status: VllmSupervisorState;
  currentProfileId?: string;
  startedAt?: string;
  readyAt?: string;
  lastError?: string;
  lastCommand?: string[];
  logs: VllmSupervisorLog[];
}

type VllmChildProcess = ChildProcessByStdio<null, Readable, Readable>;

const state: SupervisorState = {
  child: null,
  status: "idle",
  logs: [],
};

let operationChain = Promise.resolve();

function appendLog(stream: VllmSupervisorLog["stream"], chunk: Buffer | string) {
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
  for (const line of text.replace(/\r/g, "").split("\n")) {
    if (!line.trim()) continue;
    state.logs.push({ timestamp: Date.now(), stream, line });
  }
  if (state.logs.length > LOG_LIMIT) {
    state.logs.splice(0, state.logs.length - LOG_LIMIT);
  }
}

function recentFailureDetail(): string | undefined {
  const lines = state.logs
    .filter((log) => log.stream === "stderr" || log.stream === "system")
    .map((log) => log.line.trim())
    .reverse();

  for (const pattern of [/ValueError:\s*(.+)/, /RuntimeError:\s*(.+)/, /Exception:\s*(.+)/]) {
    for (const line of lines) {
      const match = line.match(pattern);
      if (!match) continue;
      const label = pattern.source.split(":")[0].replace("\\s*", "");
      const detail = `${label}: ${match[1]}`.replace(/\s+/g, " ").trim();
      return detail.length > 500 ? `${detail.slice(0, 497)}...` : detail;
    }
  }

  const fallback = lines.find((line) => /error|failed/i.test(line));
  if (!fallback) return undefined;
  return fallback.length > 500 ? `${fallback.slice(0, 497)}...` : fallback;
}

function appendFailureDetail(message: string): string {
  const detail = recentFailureDetail();
  return detail && !message.includes(detail) ? `${message}: ${detail}` : message;
}

function trim(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

function cloneDefaultProfile(): VllmModelProfile {
  return { ...DEFAULT_VLLM_PROFILE, extraArgs: [...(DEFAULT_VLLM_PROFILE.extraArgs ?? [])] };
}

function normalizeProfile(profile: VllmModelProfile): VllmModelProfile {
  const fallback = cloneDefaultProfile();
  const servedModelName = trim(profile.servedModelName) ?? trim(profile.id) ?? fallback.servedModelName;
  const id = trim(profile.id) ?? servedModelName;
  return {
    ...fallback,
    ...profile,
    id,
    name: trim(profile.name) ?? id,
    model: trim(profile.model) ?? fallback.model,
    servedModelName,
    tokenizer: trim(profile.tokenizer),
    hfConfigPath: trim(profile.hfConfigPath),
    host: trim(profile.host) ?? fallback.host,
    port: Number.isFinite(profile.port) && profile.port > 0 ? profile.port : fallback.port,
    rocrVisibleDevices: trim(profile.rocrVisibleDevices),
    tensorParallelSize:
      Number.isFinite(profile.tensorParallelSize) && (profile.tensorParallelSize ?? 0) > 0
        ? profile.tensorParallelSize
        : fallback.tensorParallelSize,
    maxModelLen:
      Number.isFinite(profile.maxModelLen) && profile.maxModelLen > 0
        ? profile.maxModelLen
        : fallback.maxModelLen,
    maxNumSeqs:
      Number.isFinite(profile.maxNumSeqs) && (profile.maxNumSeqs ?? 0) > 0
        ? profile.maxNumSeqs
        : fallback.maxNumSeqs,
    gpuMemoryUtilization:
      Number.isFinite(profile.gpuMemoryUtilization) &&
      (profile.gpuMemoryUtilization ?? 0) > 0 &&
      (profile.gpuMemoryUtilization ?? 0) < 1
        ? profile.gpuMemoryUtilization
        : fallback.gpuMemoryUtilization,
    dtype: profile.dtype ?? fallback.dtype,
    reasoningParser: trim(profile.reasoningParser),
    toolCallParser: trim(profile.toolCallParser),
    extraArgs: (profile.extraArgs ?? []).map((arg) => arg.trim()).filter(Boolean),
  };
}

export function getVllmProfiles(settings?: Settings): VllmModelProfile[] {
  const profiles = settings?.vllmProfiles?.length ? settings.vllmProfiles : [cloneDefaultProfile()];
  return profiles.map(normalizeProfile);
}

export function getVllmProfileUrl(profile: VllmModelProfile): string {
  const normalized = normalizeProfile(profile);
  const host = normalized.host || "127.0.0.1";
  const connectHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const bracketedHost = connectHost.includes(":") && !connectHost.startsWith("[")
    ? `[${connectHost}]`
    : connectHost;
  return `http://${bracketedHost}:${normalized.port}`;
}

export function profileToModel(profile: VllmModelProfile): OllamaModel {
  const normalized = normalizeProfile(profile);
  const family = normalized.model.toLowerCase();
  const supportsImages = !normalized.languageModelOnly &&
    /vision|-vl|llava|pixtral|qwen.*vl|gemma.*it.*mm/.test(family);
  return {
    id: normalized.servedModelName,
    name: normalized.name,
    parameterSize: "",
    family,
    contextWindow: normalized.maxModelLen,
    supportsImages,
    provider: "vllm",
  };
}

export function findVllmProfile(modelId: string, settings?: Settings): VllmModelProfile | undefined {
  return getVllmProfiles(settings).find((profile) =>
    profile.servedModelName === modelId ||
    profile.id === modelId ||
    profile.name === modelId
  );
}

export async function getVllmMetricsBaseUrl(settings?: Settings): Promise<string> {
  const s = settings ?? await getSettings();
  if (!s.vllmManagedEnabled) return s.vllmUrl?.trim() || VLLM_DEFAULT_URL;

  const profiles = getVllmProfiles(s);
  const profile = profiles.find((p) => p.id === state.currentProfileId)
    ?? profiles.find((p) => p.id === s.vllmActiveProfileId)
    ?? profiles[0];
  return profile ? getVllmProfileUrl(profile) : (s.vllmUrl?.trim() || VLLM_DEFAULT_URL);
}

function withOperation<T>(fn: () => Promise<T>): Promise<T> {
  const run = operationChain.catch(() => {}).then(fn);
  operationChain = run.then(() => undefined, () => undefined);
  return run;
}

function buildEnv(profile: VllmModelProfile): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const ldLibraryPath = [OPENMPI_LIB, env.LD_LIBRARY_PATH].filter(Boolean).join(":");
  env.LD_LIBRARY_PATH = ldLibraryPath;
  env.HF_HOME = env.HF_HOME || join(REPO_ROOT, ".cache", "huggingface");
  env.XDG_CACHE_HOME = env.XDG_CACHE_HOME || join(REPO_ROOT, ".cache");
  if (profile.rocrVisibleDevices) {
    env.ROCR_VISIBLE_DEVICES = profile.rocrVisibleDevices;
    delete env.HIP_VISIBLE_DEVICES;
  }
  return env;
}

function buildArgs(profile: VllmModelProfile): string[] {
  const args = [
    "serve",
    profile.model,
    "--host",
    profile.host || "127.0.0.1",
    "--port",
    String(profile.port),
    "--served-model-name",
    profile.servedModelName,
    "--max-model-len",
    String(profile.maxModelLen),
  ];

  if (profile.maxNumSeqs) args.push("--max-num-seqs", String(profile.maxNumSeqs));
  if (profile.tokenizer) args.push("--tokenizer", profile.tokenizer);
  if (profile.hfConfigPath) args.push("--hf-config-path", profile.hfConfigPath);
  if (profile.tensorParallelSize) args.push("--tensor-parallel-size", String(profile.tensorParallelSize));
  if (profile.gpuMemoryUtilization) args.push("--gpu-memory-utilization", String(profile.gpuMemoryUtilization));
  if (profile.dtype) args.push("--dtype", profile.dtype);
  if (profile.reasoningParser) args.push("--reasoning-parser", profile.reasoningParser);
  if (profile.enableAutoToolChoice) args.push("--enable-auto-tool-choice");
  if (profile.toolCallParser) args.push("--tool-call-parser", profile.toolCallParser);
  if (profile.enforceEager) args.push("--enforce-eager");
  if (profile.languageModelOnly) args.push("--language-model-only");
  if (profile.kvCacheMetrics) args.push("--kv-cache-metrics");
  if (profile.extraArgs?.length) args.push(...profile.extraArgs);
  return args;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error("Aborted");
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForChildExit(child: VllmChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    const onExit = () => {
      cleanup();
      resolve(true);
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.off("exit", onExit);
    };
    child.once("exit", onExit);
  });
}

async function isProfileReady(profile: VllmModelProfile, signal?: AbortSignal): Promise<boolean> {
  throwIfAborted(signal);
  const url = getVllmProfileUrl(profile);
  try {
    const response = await fetch(`${url}/v1/models`, { signal: AbortSignal.timeout(3000) });
    if (!response.ok) return false;
    const data = (await response.json()) as { data?: Array<{ id: string }> };
    return !!data.data?.some((model) => model.id === profile.servedModelName);
  } catch {
    return false;
  }
}

async function waitForReady(
  profile: VllmModelProfile,
  child: VllmChildProcess,
  signal?: AbortSignal
): Promise<void> {
  const start = Date.now();
  const url = getVllmProfileUrl(profile);
  while (Date.now() - start < START_TIMEOUT_MS) {
    throwIfAborted(signal);
    if (child.exitCode !== null || child.signalCode !== null || state.child !== child) {
      throw new Error(appendFailureDetail(state.lastError || `vLLM exited before ${profile.servedModelName} became ready`));
    }

    try {
      const health = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
      if (health.ok) {
        const models = await fetch(`${url}/v1/models`, { signal: AbortSignal.timeout(5000) });
        if (models.ok) {
          const data = (await models.json()) as { data?: Array<{ id: string }> };
          if (data.data?.some((model) => model.id === profile.servedModelName)) {
            return;
          }
        }
      }
    } catch {
      // Startup is noisy: connection refused and short timeouts are expected
      // while the engine is loading weights and compiling kernels.
    }

    await delay(1000, signal);
  }
  throw new Error(`Timed out waiting for vLLM profile ${profile.id} to become ready`);
}

async function stopOwnedChildInternal(): Promise<void> {
  const child = state.child;
  if (!child) {
    state.status = "idle";
    state.currentProfileId = undefined;
    state.readyAt = undefined;
    return;
  }

  state.status = "stopping";
  appendLog("system", `Stopping vLLM pid ${child.pid ?? "unknown"}`);
  child.kill("SIGTERM");
  const exited = await waitForChildExit(child, 15_000);
  if (!exited && state.child === child) {
    appendLog("system", `vLLM pid ${child.pid ?? "unknown"} did not stop after SIGTERM; sending SIGKILL`);
    child.kill("SIGKILL");
    await waitForChildExit(child, 5_000);
  }

  if (state.child === child) {
    state.child = null;
  }
  state.status = "idle";
  state.currentProfileId = undefined;
  state.readyAt = undefined;
}

async function waitForCurrentStreams(signal?: AbortSignal, allowedActiveStreams = 0) {
  if (activeStreamCount() <= allowedActiveStreams) return;
  appendLog("system", `Waiting for ${activeStreamCount()} active LLM stream(s) before switching vLLM profile`);
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new Error(`Timed out after ${IDLE_WAIT_MS / 1000}s waiting for active streams`));
  }, IDLE_WAIT_MS);
  signal?.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  try {
    await waitForActiveCountAtMost(allowedActiveStreams, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

export async function startVllmProfile(
  profileId?: string,
  options: { waitForIdle?: boolean; signal?: AbortSignal; allowedActiveStreams?: number } = {}
): Promise<VllmSupervisorStatus> {
  return withOperation(async () => {
    const settings = await getSettings();
    const profiles = getVllmProfiles(settings);
    const requestedProfileId = profileId || settings.vllmActiveProfileId || profiles[0]?.id;
    const profile = profiles.find((p) => p.id === requestedProfileId || p.servedModelName === requestedProfileId);
    if (!profile) throw new Error(`Unknown vLLM profile: ${requestedProfileId}`);

    if (state.currentProfileId === profile.id && state.status === "ready" && await isProfileReady(profile, options.signal)) {
      return getVllmSupervisorStatus(settings);
    }

    throwIfAborted(options.signal);
    if (options.waitForIdle ?? true) {
      await waitForCurrentStreams(options.signal, options.allowedActiveStreams ?? 0);
    }
    await stopOwnedChildInternal();

    if (!existsSync(VLLM_BIN)) {
      throw new Error(`vLLM executable not found at ${VLLM_BIN}`);
    }

    const normalized = normalizeProfile(profile);
    const args = buildArgs(normalized);
    state.status = "starting";
    state.currentProfileId = normalized.id;
    state.startedAt = new Date().toISOString();
    state.readyAt = undefined;
    state.lastError = undefined;
    state.lastCommand = [VLLM_BIN, ...args];
    appendLog("system", `Starting vLLM profile ${normalized.id}: ${[VLLM_BIN, ...args].join(" ")}`);

    const child = spawn(VLLM_BIN, args, {
      cwd: REPO_ROOT,
      env: buildEnv(normalized),
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    state.child = child;
    child.stdout.on("data", (chunk) => appendLog("stdout", chunk));
    child.stderr.on("data", (chunk) => appendLog("stderr", chunk));
    child.on("error", (err) => {
      state.lastError = err.message;
      appendLog("system", `vLLM process error: ${err.message}`);
      if (state.child === child) {
        state.status = "failed";
        state.child = null;
      }
    });
    child.on("exit", (code, signal) => {
      appendLog("system", `vLLM exited with code ${code ?? "null"} signal ${signal ?? "null"}`);
      if (state.child !== child) return;
      state.child = null;
      if (state.status === "stopping") {
        state.status = "idle";
      } else if (code === 0) {
        state.status = "idle";
      } else {
        state.status = "failed";
        state.lastError = appendFailureDetail(`vLLM exited with code ${code ?? "null"} signal ${signal ?? "null"}`);
      }
    });

    await waitForReady(normalized, child, options.signal);
    state.status = "ready";
    state.readyAt = new Date().toISOString();
    await saveSettings({
      ...settings,
      vllmActiveProfileId: normalized.id,
      vllmUrl: getVllmProfileUrl(normalized),
    });
    appendLog("system", `vLLM profile ${normalized.id} is ready at ${getVllmProfileUrl(normalized)}`);
    return getVllmSupervisorStatus({ ...settings, vllmActiveProfileId: normalized.id });
  });
}

export async function stopVllmProfile(): Promise<VllmSupervisorStatus> {
  return withOperation(async () => {
    await stopOwnedChildInternal();
    return getVllmSupervisorStatus();
  });
}

export async function restartVllmProfile(profileId?: string): Promise<VllmSupervisorStatus> {
  const settings = await getSettings();
  const profiles = getVllmProfiles(settings);
  const requestedProfileId = profileId || state.currentProfileId || settings.vllmActiveProfileId || profiles[0]?.id;
  await stopVllmProfile();
  return startVllmProfile(requestedProfileId);
}

export async function ensureVllmProfile(modelId: string, signal?: AbortSignal): Promise<string> {
  const settings = await getSettings();
  if (!settings.vllmManagedEnabled) {
    return settings.vllmUrl?.trim() || VLLM_DEFAULT_URL;
  }

  const profile = findVllmProfile(modelId, settings);
  if (!profile) {
    throw new Error(`No managed vLLM profile found for model ${modelId}`);
  }

  if (state.currentProfileId === profile.id && state.status === "ready" && await isProfileReady(profile, signal)) {
    return getVllmProfileUrl(profile);
  }

  const status = await startVllmProfile(profile.id, { waitForIdle: true, signal, allowedActiveStreams: 1 });
  if (status.status !== "ready" || !status.url) {
    throw new Error(`vLLM profile ${profile.id} did not become ready`);
  }
  return status.url;
}

export async function getVllmSupervisorStatus(settings?: Settings): Promise<VllmSupervisorStatus> {
  const s = settings ?? await getSettings();
  const profiles = getVllmProfiles(s);
  const profile = profiles.find((p) => p.id === state.currentProfileId)
    ?? profiles.find((p) => p.id === s.vllmActiveProfileId);
  return {
    status: state.status,
    managedEnabled: s.vllmManagedEnabled ?? false,
    currentProfileId: state.currentProfileId,
    activeProfileId: s.vllmActiveProfileId,
    pid: state.child?.pid,
    url: profile ? getVllmProfileUrl(profile) : (s.vllmUrl?.trim() || VLLM_DEFAULT_URL),
    profile,
    profiles,
    command: state.lastCommand,
    vllmBin: VLLM_BIN,
    vllmBinExists: existsSync(VLLM_BIN),
    startedAt: state.startedAt,
    readyAt: state.readyAt,
    lastError: state.lastError,
    activeStreams: activeStreamCount(),
    logs: [...state.logs],
  };
}

process.once("exit", () => {
  if (state.child) {
    state.child.kill("SIGTERM");
  }
});
