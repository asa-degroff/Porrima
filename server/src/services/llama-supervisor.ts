import { execFile } from "child_process";
import { promisify } from "util";
import type { Settings } from "../types.js";
import { extractOverrideBinaryPath, extractOverrideModelPath, readOverride, type OverrideInfo } from "./llama-overrides.js";
import { getDefaultLlamaBin, resolveBin } from "./llama-launch-templates.js";
import { getDefaultLlamaServerUrl } from "./llama-ports.js";

const execFileAsync = promisify(execFile);
const SYSTEMCTL = "systemctl";
const JOURNALCTL = "journalctl";
let lastObservedInferencePid: number | null = null;

export type LlamaServerId = "inference" | "extraction" | "reranker" | "embedding" | "title-generation";
export type LlamaServerAction = "start" | "stop" | "restart";

type SystemdActiveState = "active" | "activating" | "deactivating" | "inactive" | "failed" | "unknown";
type SystemdLoadState = "loaded" | "not-found" | "error" | "unknown";
type HttpHealthStatus = "ok" | "unavailable" | "unknown";

interface LlamaServerDefinition {
  id: LlamaServerId;
  label: string;
  role: string;
  unitName: string;
  unitNameCandidates?: string[];
  defaultUrl: string;
  description: string;
  settingsModelKey?: keyof Settings;
}

export interface LlamaServerStatus {
  id: LlamaServerId;
  label: string;
  role: string;
  description: string;
  url: string;
  unitName: string;
  appEnabled: boolean;
  expectedModel?: string;
  systemd: {
    loadState: SystemdLoadState;
    activeState: SystemdActiveState;
    subState: string;
    mainPid: number | null;
    execMainStatus: number | null;
    fragmentPath: string;
    workingDirectory: string;
    execStart: string;
    activeEnterTimestamp: string;
    stateChangeTimestamp: string;
    error?: string;
  };
  http: {
    status: HttpHealthStatus;
    modelIds: string[];
    error?: string;
    routerMode: boolean;
    loadedModelId?: string;
  };
  override: {
    active: boolean;
    path: string;
    modelPath?: string;
  };
  resolvedBinary: string;
  defaultBinary: string;
}

const DEFINITIONS: Record<LlamaServerId, LlamaServerDefinition> = {
  inference: {
    id: "inference",
    label: "Chat inference",
    role: "Router / chat completions",
    unitName: "llama-server.service",
    defaultUrl: getDefaultLlamaServerUrl("inference"),
    description: "Main llama.cpp router used by chat, vision, and model discovery",
    settingsModelKey: "defaultModelId",
  },
  extraction: {
    id: "extraction",
    label: "Extraction",
    role: "Background extraction",
    unitName: "extraction-model.service",
    unitNameCandidates: ["extraction-model.service", "llama-extraction.service"],
    defaultUrl: getDefaultLlamaServerUrl("extraction"),
    description: "Memory extraction model",
    settingsModelKey: "extractionModelId",
  },
  reranker: {
    id: "reranker",
    label: "Reranker",
    role: "Cross-encoder rerank",
    unitName: "reranker.service",
    defaultUrl: getDefaultLlamaServerUrl("reranker"),
    description: "Cross-encoder reranker for memory retrieval",
    settingsModelKey: "rerankerModelId",
  },
  embedding: {
    id: "embedding",
    label: "Embedding",
    role: "Vector embeddings",
    unitName: "embedding-model.service",
    unitNameCandidates: ["embedding-model.service", "embedding-server.service", "llama-embedding.service", "llama-embedding-server.service"],
    defaultUrl: getDefaultLlamaServerUrl("embedding"),
    description: "Embedding server for vectorizing memories",
    settingsModelKey: "embeddingModel",
  },
  "title-generation": {
    id: "title-generation",
    label: "Title generation",
    role: "Chat titles",
    unitName: "title-generation.service",
    defaultUrl: getDefaultLlamaServerUrl("title-generation"),
    description: "Generates titles for the chat list and message summaries for notifications",
    settingsModelKey: "titleGenerationModelId",
  },
};

function getDefinition(id: string): LlamaServerDefinition | null {
  if (
    id === "inference" ||
    id === "extraction" ||
    id === "reranker" ||
    id === "embedding" ||
    id === "title-generation"
  ) {
    return DEFINITIONS[id];
  }
  return null;
}

function getConfiguredUrl(def: LlamaServerDefinition, settings: Settings): string {
  if (def.id === "inference") return settings.llamacppUrl?.trim() || def.defaultUrl;
  if (def.id === "extraction") return settings.extractionModelUrl?.trim() || def.defaultUrl;
  if (def.id === "reranker") return settings.rerankerUrl?.trim() || def.defaultUrl;
  if (def.id === "embedding") {
    return settings.embeddingProvider === "llamacpp"
      ? settings.embeddingUrl?.trim() || def.defaultUrl
      : def.defaultUrl;
  }
  if (def.id === "title-generation") return settings.titleGenerationUrl?.trim() || def.defaultUrl;
  return def.defaultUrl;
}

function getAppEnabled(def: LlamaServerDefinition, settings: Settings): boolean {
  if (def.id === "inference") return settings.llamacppEnabled === true;
  if (def.id === "extraction") return Boolean(settings.extractionModelUrl?.trim());
  if (def.id === "reranker") return settings.rerankerEnabled !== false;
  if (def.id === "embedding") return settings.embeddingProvider === "llamacpp";
  if (def.id === "title-generation") return settings.titleGenerationEnabled !== false;
  return false;
}

function getExpectedModel(def: LlamaServerDefinition, settings: Settings): string | undefined {
  if (!def.settingsModelKey) return undefined;
  const value = settings[def.settingsModelKey];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseSystemctlProperties(stdout: string): Record<string, string> {
  const props: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    props[line.slice(0, separator)] = line.slice(separator + 1);
  }
  return props;
}

function coerceActiveState(value: string | undefined): SystemdActiveState {
  if (value === "active" || value === "activating" || value === "deactivating" || value === "inactive" || value === "failed") {
    return value;
  }
  return "unknown";
}

function coerceLoadState(value: string | undefined): SystemdLoadState {
  if (value === "loaded" || value === "not-found" || value === "error") return value;
  return "unknown";
}

function parseNullableInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

async function getSystemdStatus(unitName: string): Promise<LlamaServerStatus["systemd"]> {
  try {
    const { stdout } = await execFileAsync(
      SYSTEMCTL,
      [
        "--user",
        "show",
        unitName,
        "-p", "LoadState",
        "-p", "ActiveState",
        "-p", "SubState",
        "-p", "MainPID",
        "-p", "ExecMainStatus",
        "-p", "FragmentPath",
        "-p", "WorkingDirectory",
        "-p", "ExecStart",
        "-p", "ActiveEnterTimestamp",
        "-p", "StateChangeTimestamp",
      ],
      { timeout: 5000, maxBuffer: 1024 * 512 }
    );
    const props = parseSystemctlProperties(stdout);
    return {
      loadState: coerceLoadState(props.LoadState),
      activeState: coerceActiveState(props.ActiveState),
      subState: props.SubState || "",
      mainPid: parseNullableInt(props.MainPID),
      execMainStatus: props.ExecMainStatus ? Number.parseInt(props.ExecMainStatus, 10) : null,
      fragmentPath: props.FragmentPath || "",
      workingDirectory: props.WorkingDirectory || "",
      execStart: props.ExecStart || "",
      activeEnterTimestamp: props.ActiveEnterTimestamp || "",
      stateChangeTimestamp: props.StateChangeTimestamp || "",
    };
  } catch (e: any) {
    return {
      loadState: "unknown",
      activeState: "unknown",
      subState: "",
      mainPid: null,
      execMainStatus: null,
      fragmentPath: "",
      workingDirectory: "",
      execStart: "",
      activeEnterTimestamp: "",
      stateChangeTimestamp: "",
      error: e?.message || "systemctl show failed",
    };
  }
}

async function resolveSystemdUnit(def: LlamaServerDefinition): Promise<{ unitName: string; systemd: LlamaServerStatus["systemd"] }> {
  const candidates = def.unitNameCandidates?.length ? def.unitNameCandidates : [def.unitName];
  let first: { unitName: string; systemd: LlamaServerStatus["systemd"] } | null = null;

  for (const unitName of candidates) {
    const systemd = await getSystemdStatus(unitName);
    const result = { unitName, systemd };
    if (!first) first = result;
    if (systemd.loadState === "loaded") return result;
  }

  return first ?? { unitName: def.unitName, systemd: await getSystemdStatus(def.unitName) };
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

async function getHttpStatus(baseUrl: string): Promise<LlamaServerStatus["http"]> {
  const url = normalizeBaseUrl(baseUrl);
  if (!url) return { status: "unknown", modelIds: [], routerMode: false, error: "No URL configured" };

  try {
    const health = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2500) });
    if (!health.ok) {
      return { status: "unavailable", modelIds: [], routerMode: false, error: `/health returned HTTP ${health.status}` };
    }
  } catch (e: any) {
    return { status: "unavailable", modelIds: [], routerMode: false, error: e?.message || "Health check failed" };
  }

  try {
    const modelsRes = await fetch(`${url}/v1/models`, { signal: AbortSignal.timeout(2500) });
    if (!modelsRes.ok) return { status: "ok", modelIds: [], routerMode: false };
    type RouterModelEntry = { id?: string; status?: { value?: string } };
    const data = await modelsRes.json().catch(() => null) as { data?: RouterModelEntry[] } | null;
    const entries = Array.isArray(data?.data) ? data!.data : [];
    const modelIds = entries.map((m) => m.id).filter((id): id is string => Boolean(id));
    // Router mode is the only context where llama-server emits a per-entry
    // `status` object on /v1/models (loaded/unloaded/loading/error). Single-
    // model servers omit it entirely. This is more reliable than counting
    // entries because a router with one GGUF in --models-dir would otherwise
    // look identical to a single-model launch.
    const routerMode = entries.some((m) => m.status && typeof m.status === "object");
    const loaded = entries.find((m) => m.status?.value === "loaded");
    return { status: "ok", modelIds, routerMode, loadedModelId: loaded?.id };
  } catch {
    return { status: "ok", modelIds: [], routerMode: false };
  }
}

function formatOverrideInfo(info: OverrideInfo): LlamaServerStatus["override"] {
  return {
    active: info.exists,
    path: info.path,
    modelPath: extractOverrideModelPath(info.contents) ?? undefined,
  };
}

function extractSystemdExecBinary(execStart: string | undefined): string | null {
  if (!execStart) return null;
  const pathMatch = execStart.match(/(?:^|[{\s;])path=([^;\s}]+)/);
  if (pathMatch?.[1]) return pathMatch[1];

  const trimmed = execStart.trim();
  if (!trimmed || trimmed === "{}") return null;
  const value = trimmed.startsWith("ExecStart=")
    ? trimmed.replace(/^ExecStart=/, "").trim()
    : trimmed;
  const shellMatch = value.match(/^'([^']*)'|"([^"]*)"|(\S+)/);
  return shellMatch?.[1] || shellMatch?.[2] || shellMatch?.[3] || null;
}

function resolveStatusBinary(
  id: LlamaServerId,
  settings: Settings,
  systemd: LlamaServerStatus["systemd"],
  override: OverrideInfo
): string {
  return (
    extractOverrideBinaryPath(override.contents) ||
    extractSystemdExecBinary(systemd.execStart) ||
    resolveBin(id, settings)
  );
}

async function handleDetectedServerRestart(
  def: LlamaServerDefinition,
  url: string,
  mainPid: number | null,
  httpStatus: HttpHealthStatus
): Promise<void> {
  if (mainPid == null || httpStatus !== "ok") return;

  try {
    const firstInferencePidObservation = def.id === "inference" && lastObservedInferencePid == null;
    const inferencePidChanged = def.id === "inference" && lastObservedInferencePid != null && lastObservedInferencePid !== mainPid;
    if (def.id === "inference") lastObservedInferencePid = mainPid;

    const { checkLlamaServerRestart } = await import("./llama-cache-residency.js");
    const restarted = checkLlamaServerRestart(url, mainPid);
    if (def.id === "inference" && (firstInferencePidObservation || inferencePidChanged || restarted)) {
      const { invalidateModelCache } = await import("./models.js");
      invalidateModelCache();
    }
  } catch {
    // Non-fatal — residency/model metadata will self-correct on manual refresh.
  }
}

export async function getLlamaServerStatuses(settings: Settings): Promise<LlamaServerStatus[]> {
  const defaultBin = getDefaultLlamaBin();
  return Promise.all(
    Object.values(DEFINITIONS).map(async (def) => {
      const url = getConfiguredUrl(def, settings);
      const [unit, http] = await Promise.all([
        resolveSystemdUnit(def),
        getHttpStatus(url),
      ]);
      // Detect llama.cpp server restarts — when the PID changes, the KV cache
      // is wiped and any in-memory residency/model metadata becomes stale.
      await handleDetectedServerRestart(def, url, unit.systemd.mainPid, http.status);
      const overrideInfo = await readOverride(unit.unitName);
      const override = formatOverrideInfo(overrideInfo);
      return {
        id: def.id,
        label: def.label,
        role: def.role,
        description: def.description,
        url,
        unitName: unit.unitName,
        appEnabled: getAppEnabled(def, settings),
        expectedModel: getExpectedModel(def, settings),
        systemd: unit.systemd,
        http,
        override,
        resolvedBinary: resolveStatusBinary(def.id, settings, unit.systemd, overrideInfo),
        defaultBinary: defaultBin,
      };
    })
  );
}

export async function getLlamaServerStatus(id: string, settings: Settings): Promise<LlamaServerStatus> {
  const def = getDefinition(id);
  if (!def) throw new Error(`Unknown llama.cpp server: ${id}`);
  const url = getConfiguredUrl(def, settings);
  const [unit, http] = await Promise.all([
    resolveSystemdUnit(def),
    getHttpStatus(url),
  ]);
  await handleDetectedServerRestart(def, url, unit.systemd.mainPid, http.status);
  const overrideInfo = await readOverride(unit.unitName);
  const override = formatOverrideInfo(overrideInfo);
  return {
    id: def.id,
    label: def.label,
    role: def.role,
    description: def.description,
    url,
    unitName: unit.unitName,
    appEnabled: getAppEnabled(def, settings),
    expectedModel: getExpectedModel(def, settings),
    systemd: unit.systemd,
    http,
    override,
    resolvedBinary: resolveStatusBinary(def.id, settings, unit.systemd, overrideInfo),
    defaultBinary: getDefaultLlamaBin(),
  };
}

/**
 * Resolve the systemd unit name for a slot id. Used by code paths that need
 * the exact unit name (override writers, etc.) without the full status.
 */
export async function resolveSlotUnitName(id: string): Promise<string> {
  const def = getDefinition(id);
  if (!def) throw new Error(`Unknown llama.cpp server: ${id}`);
  const unit = await resolveSystemdUnit(def);
  return unit.unitName;
}

export async function getLlamaUnitCat(id: string): Promise<{ unitName: string; contents: string }> {
  const def = getDefinition(id);
  if (!def) throw new Error(`Unknown llama.cpp server: ${id}`);
  const unit = await resolveSystemdUnit(def);
  const { stdout } = await execFileAsync(SYSTEMCTL, ["--user", "cat", unit.unitName], {
    timeout: 8000,
    maxBuffer: 1024 * 1024,
  });
  return { unitName: unit.unitName, contents: stdout };
}

export async function getLlamaUnitEnabled(id: string): Promise<{ unitName: string; enabled: boolean; state: string }> {
  const def = getDefinition(id);
  if (!def) throw new Error(`Unknown llama.cpp server: ${id}`);
  const unit = await resolveSystemdUnit(def);
  try {
    const { stdout } = await execFileAsync(SYSTEMCTL, ["--user", "is-enabled", unit.unitName], {
      timeout: 5000,
      maxBuffer: 1024 * 64,
    });
    const state = stdout.trim() || "unknown";
    return { unitName: unit.unitName, enabled: state === "enabled", state };
  } catch (e: any) {
    const state = typeof e?.stdout === "string" && e.stdout.trim() ? e.stdout.trim() : "disabled";
    return { unitName: unit.unitName, enabled: false, state };
  }
}

export async function setLlamaUnitEnabled(id: string, enabled: boolean): Promise<{ unitName: string; enabled: boolean; state: string }> {
  const def = getDefinition(id);
  if (!def) throw new Error(`Unknown llama.cpp server: ${id}`);
  const unit = await resolveSystemdUnit(def);
  await execFileAsync(SYSTEMCTL, ["--user", enabled ? "enable" : "disable", unit.unitName], {
    timeout: 10000,
    maxBuffer: 1024 * 256,
  });
  return getLlamaUnitEnabled(id);
}

export async function runLlamaServerAction(id: string, action: LlamaServerAction, settings: Settings): Promise<LlamaServerStatus> {
  const def = getDefinition(id);
  if (!def) throw new Error(`Unknown llama.cpp server: ${id}`);
  if (action !== "start" && action !== "stop" && action !== "restart") {
    throw new Error(`Unsupported action: ${action}`);
  }

  const unit = await resolveSystemdUnit(def);
  await execFileAsync(SYSTEMCTL, ["--user", action, unit.unitName], {
    timeout: action === "stop" ? 10000 : 20000,
    maxBuffer: 1024 * 256,
  });
  if (def.id === "inference") {
    const { invalidateModelCache } = await import("./models.js");
    invalidateModelCache();
  }

  // Give systemd and the HTTP listener a short moment to reflect the new state.
  await new Promise((resolve) => setTimeout(resolve, 750));
  return getLlamaServerStatus(id, settings);
}

export async function getLlamaServerLogs(id: string, lines = 200): Promise<{ unitName: string; logs: string }> {
  const def = getDefinition(id);
  if (!def) throw new Error(`Unknown llama.cpp server: ${id}`);
  const unit = await resolveSystemdUnit(def);
  const clampedLines = Math.max(1, Math.min(500, Math.floor(lines)));
  const { stdout } = await execFileAsync(
    JOURNALCTL,
    ["--user", "-u", unit.unitName, "-n", String(clampedLines), "--no-pager", "--output=short-iso"],
    { timeout: 8000, maxBuffer: 1024 * 1024 }
  );
  return { unitName: unit.unitName, logs: stdout };
}
