import { readdir, stat } from "fs/promises";
import { join } from "path";
import { homedir } from "os";
import { listChats } from "./chat-storage.js";
import { slotRegistry, type SlotAssignment } from "./kv-slot-registry.js";

const DEFAULT_KV_CACHE_DIR = join(homedir(), ".quje-agent", "kv-cache");

export interface KvCacheFileStatus {
  fileName: string;
  exists: boolean;
  sizeBytes?: number;
  mtimeMs?: number;
}

export interface KvCacheLiveSlot {
  id: number;
  nCtx?: number;
  nTokens?: number;
  isProcessing?: boolean;
  prompt?: string;
  raw: Record<string, unknown>;
}

export interface KvCacheAssignmentStatus extends SlotAssignment {
  chatTitle?: string;
  chatType?: string;
  file: KvCacheFileStatus;
}

export interface KvCachePoolStatus {
  poolKey: string;
  baseUrl: string;
  modelId: string;
  contextWindow?: number;
  isCurrent: boolean;
  assignments: KvCacheAssignmentStatus[];
}

export interface KvCacheStatus {
  baseUrl: string;
  role?: string;
  routerMode: boolean;
  loadedModelId?: string;
  maxInstances?: number;
  slotSavePathConfigured: boolean | null;
  slotSavePath?: string;
  liveSlots: KvCacheLiveSlot[];
  pools: KvCachePoolStatus[];
  summary: {
    assignedSlots: number;
    activeAssignments: number;
    currentPoolAssignments: number;
    savedFiles: number;
    orphanFiles: number;
  };
  errors: string[];
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function slotUrl(baseUrl: string, path: string): string {
  return `${normalizeBaseUrl(baseUrl)}${path}`;
}

async function fetchJson<T>(url: string): Promise<{ data?: T; status?: number; error?: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { status: res.status, error: text || `HTTP ${res.status}` };
    }
    return { data: await res.json() as T, status: res.status };
  } catch (e: any) {
    return { error: e?.message || "request failed" };
  }
}

function parseSlotSavePath(args?: unknown, preset?: unknown): string | undefined {
  if (Array.isArray(args)) {
    for (let i = 0; i < args.length; i++) {
      const item = String(args[i] ?? "");
      if (item === "--slot-save-path") {
        const next = args[i + 1];
        return typeof next === "string" && next.trim() ? next.trim() : undefined;
      }
      if (item.startsWith("--slot-save-path=")) {
        const value = item.slice("--slot-save-path=".length).trim();
        if (value) return value;
      }
    }
  }

  if (typeof preset === "string") {
    const match = preset.match(/^\s*slot-save-path\s*=\s*(.+?)\s*$/m);
    if (match?.[1]) return match[1].trim();
  }

  return undefined;
}

async function getFileStatus(cacheDir: string, fileName: string): Promise<KvCacheFileStatus> {
  try {
    const s = await stat(join(cacheDir, fileName));
    return {
      fileName,
      exists: s.isFile(),
      sizeBytes: s.size,
      mtimeMs: s.mtimeMs,
    };
  } catch {
    return { fileName, exists: false };
  }
}

async function countOrphanFiles(cacheDir: string, assignedFileNames: Set<string>): Promise<number> {
  try {
    const entries = await readdir(cacheDir, { withFileTypes: true });
    return entries.filter((entry) =>
      entry.isFile() &&
      entry.name.startsWith("slot_") &&
      entry.name.endsWith(".bin") &&
      !assignedFileNames.has(entry.name)
    ).length;
  } catch {
    return 0;
  }
}

function normalizeLiveSlot(raw: any): KvCacheLiveSlot | null {
  const id = typeof raw?.id === "number" ? raw.id : undefined;
  if (id == null) return null;
  return {
    id,
    nCtx: typeof raw.n_ctx === "number" ? raw.n_ctx : undefined,
    nTokens: typeof raw.n_tokens === "number" ? raw.n_tokens : undefined,
    isProcessing: typeof raw.is_processing === "boolean" ? raw.is_processing : undefined,
    prompt: typeof raw.prompt === "string" ? raw.prompt : undefined,
    raw: raw && typeof raw === "object" ? raw : {},
  };
}

export async function getKvCacheStatus(baseUrl: string): Promise<KvCacheStatus> {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const errors: string[] = [];

  const propsResult = await fetchJson<any>(slotUrl(normalizedBaseUrl, "/props"));
  if (propsResult.error) errors.push(`/props: ${propsResult.error}`);
  const maxInstances = typeof propsResult.data?.max_instances === "number"
    ? Math.max(1, propsResult.data.max_instances)
    : undefined;
  const role = typeof propsResult.data?.role === "string" ? propsResult.data.role : undefined;

  const modelsResult = await fetchJson<{ data?: Array<{ id?: string; status?: any }> }>(
    slotUrl(normalizedBaseUrl, "/v1/models")
  );
  if (modelsResult.error) errors.push(`/v1/models: ${modelsResult.error}`);
  const modelEntries = Array.isArray(modelsResult.data?.data) ? modelsResult.data!.data! : [];
  const routerMode = modelEntries.some((entry) => entry.status && typeof entry.status === "object");
  const loadedEntry = modelEntries.find((entry) => entry.status?.value === "loaded");
  const loadedModelId = loadedEntry?.id;
  const hasLaunchMetadata = modelEntries.some((entry) =>
    Array.isArray(entry.status?.args) || typeof entry.status?.preset === "string"
  );
  const slotSavePath = parseSlotSavePath(loadedEntry?.status?.args, loadedEntry?.status?.preset)
    ?? parseSlotSavePath(modelEntries[0]?.status?.args, modelEntries[0]?.status?.preset);
  const slotSavePathConfigured = hasLaunchMetadata
    ? Boolean(slotSavePath)
    : null;
  const cacheDir = slotSavePath || DEFAULT_KV_CACHE_DIR;

  let liveSlots: KvCacheLiveSlot[] = [];
  if (loadedModelId) {
    const url = new URL(slotUrl(normalizedBaseUrl, "/slots"));
    url.searchParams.set("model", loadedModelId);
    const slotsResult = await fetchJson<any[]>(url.toString());
    if (slotsResult.error) {
      errors.push(`/slots: ${slotsResult.error}`);
    } else if (Array.isArray(slotsResult.data)) {
      liveSlots = slotsResult.data
        .map(normalizeLiveSlot)
        .filter((slot): slot is KvCacheLiveSlot => Boolean(slot));
    }
  }

  const [registryPools, chats] = await Promise.all([
    slotRegistry.getPools(),
    listChats(),
  ]);
  const chatById = new Map(chats.map((chat) => [chat.id, chat]));
  const pools: KvCachePoolStatus[] = [];
  const assignedFileNames = new Set<string>();
  for (const pool of Object.values(registryPools)) {
    if (normalizeBaseUrl(pool.baseUrl) !== normalizedBaseUrl) continue;
    const assignments = await Promise.all(
      Object.values(pool.assignments)
        .sort((a, b) => a.slotId - b.slotId || b.lastUsedAt - a.lastUsedAt)
        .map(async (assignment): Promise<KvCacheAssignmentStatus> => {
          assignedFileNames.add(assignment.fileName);
          const chat = chatById.get(assignment.chatId);
          return {
            ...assignment,
            chatTitle: chat?.title,
            chatType: chat?.type,
            file: await getFileStatus(cacheDir, assignment.fileName),
          };
        })
    );
    pools.push({
      poolKey: pool.poolKey,
      baseUrl: pool.baseUrl,
      modelId: pool.modelId,
      contextWindow: pool.contextWindow,
      isCurrent: loadedModelId ? pool.modelId === loadedModelId : false,
      assignments,
    });
  }
  pools.sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || a.modelId.localeCompare(b.modelId));

  const assignedSlots = pools.reduce((sum, pool) => sum + pool.assignments.length, 0);
  const activeAssignments = pools.reduce((sum, pool) => sum + pool.assignments.filter((a) => a.active).length, 0);
  const currentPoolAssignments = pools
    .filter((pool) => pool.isCurrent)
    .reduce((sum, pool) => sum + pool.assignments.length, 0);
  const savedFiles = pools.reduce((sum, pool) => sum + pool.assignments.filter((a) => a.file.exists).length, 0);
  const orphanFiles = await countOrphanFiles(cacheDir, assignedFileNames);

  return {
    baseUrl: normalizedBaseUrl,
    role,
    routerMode,
    loadedModelId,
    maxInstances,
    slotSavePathConfigured,
    slotSavePath,
    liveSlots,
    pools,
    summary: {
      assignedSlots,
      activeAssignments,
      currentPoolAssignments,
      savedFiles,
      orphanFiles,
    },
    errors,
  };
}
