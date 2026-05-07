/**
 * KV Slot Registry — manages chat-to-slot leases for llama.cpp servers.
 *
 * Slot assignments are scoped by model pool. llama.cpp router mode only has
 * one loaded model per chat inference server in normal operation, but a slot
 * file is only valid for the model/context shape that created it. Keeping
 * separate pools prevents restoring a chat's Qwen cache into a Gemma worker or
 * reusing a context-window-incompatible file after model settings change.
 */

import { mkdir, readFile, writeFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

const BASE_DIR = join(homedir(), ".quje-agent");
const REGISTRY_PATH = join(BASE_DIR, "slot-registry.json");
const DISCOVERY_TTL_MS = 5 * 60 * 1000;

export interface SlotAssignment {
  chatId: string;
  slotId: number;
  fileName: string;
  lastUsedAt: number;
  active: boolean;
  leaseId?: string;
  lastRestoredAt?: number;
  lastRestoreOk?: boolean;
  lastRestoreStatus?: number;
  lastRestoreError?: string;
  lastRestoreTokens?: number;
  lastSavedAt?: number;
  lastSaveOk?: boolean;
  lastSaveStatus?: number;
  lastSaveError?: string;
  lastSaveTokens?: number;
}

export interface SlotPool {
  poolKey: string;
  baseUrl: string;
  modelId: string;
  contextWindow?: number;
  assignments: Record<string, SlotAssignment>;
}

interface BaseDiscovery {
  maxInstances: number | null;
  discoveredAt: number | null;
}

interface RegistryState {
  bases: Record<string, BaseDiscovery>;
  pools: Record<string, SlotPool>;
}

export interface AcquireSlotLeaseOptions {
  chatId: string;
  baseUrl: string;
  modelId: string;
  contextWindow?: number;
  fileName: string;
  leaseId: string;
}

export interface SlotLeaseRecord {
  chatId: string;
  baseUrl: string;
  modelId: string;
  contextWindow?: number;
  poolKey: string;
  leaseId: string;
  slotId: number | null;
  fileName: string;
  maxInstances: number;
  evictedChatId: string | null;
  disabledReason?: "single-slot" | "all-slots-active" | "discovery-failed";
}

export interface SlotActionRecord {
  ok: boolean;
  status?: number;
  error?: string;
  tokens?: number;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

export function slotPoolKey(baseUrl: string, modelId: string, contextWindow?: number): string {
  return [
    normalizeBaseUrl(baseUrl),
    modelId,
    contextWindow != null ? String(contextWindow) : "default",
  ].join("\u0000");
}

class SlotRegistry {
  private state: RegistryState = { bases: {}, pools: {} };
  private loaded = false;
  private lock: Promise<void> = Promise.resolve();

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.lock;
    let release!: () => void;
    this.lock = prev.then(() => new Promise<void>((resolve) => { release = resolve; }));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(REGISTRY_PATH, "utf-8");
      const parsed = JSON.parse(raw);
      this.state = this.normalizeState(parsed);
    } catch {
      // Fresh start — no registry file yet.
    }
    this.loaded = true;
  }

  private normalizeState(parsed: any): RegistryState {
    // Backward compatibility for the previous flat { assignments, maxInstances }
    // registry: keep discovered capacity, but drop assignments because they were
    // not model-aware and may point at incompatible slot files.
    if (parsed && !parsed.pools && parsed.assignments) {
      return {
        bases: {
          default: {
            maxInstances: typeof parsed.maxInstances === "number" ? parsed.maxInstances : null,
            discoveredAt: typeof parsed.discoveredAt === "number" ? parsed.discoveredAt : null,
          },
        },
        pools: {},
      };
    }

    const bases: Record<string, BaseDiscovery> = {};
    for (const [key, value] of Object.entries(parsed?.bases ?? {})) {
      const v = value as any;
      bases[key] = {
        maxInstances: typeof v?.maxInstances === "number" ? v.maxInstances : null,
        discoveredAt: typeof v?.discoveredAt === "number" ? v.discoveredAt : null,
      };
    }

    const pools: Record<string, SlotPool> = {};
    for (const [key, value] of Object.entries(parsed?.pools ?? {})) {
      const v = value as any;
      const assignments: Record<string, SlotAssignment> = {};
      for (const [chatId, assignment] of Object.entries(v?.assignments ?? {})) {
        const a = assignment as any;
        if (typeof a?.slotId !== "number" || typeof a?.fileName !== "string") continue;
        assignments[chatId] = {
          chatId,
          slotId: a.slotId,
          fileName: a.fileName,
          lastUsedAt: typeof a.lastUsedAt === "number" ? a.lastUsedAt : 0,
          active: false,
          lastRestoredAt: typeof a.lastRestoredAt === "number" ? a.lastRestoredAt : undefined,
          lastRestoreOk: typeof a.lastRestoreOk === "boolean" ? a.lastRestoreOk : undefined,
          lastRestoreStatus: typeof a.lastRestoreStatus === "number" ? a.lastRestoreStatus : undefined,
          lastRestoreError: typeof a.lastRestoreError === "string" ? a.lastRestoreError : undefined,
          lastRestoreTokens: typeof a.lastRestoreTokens === "number" ? a.lastRestoreTokens : undefined,
          lastSavedAt: typeof a.lastSavedAt === "number" ? a.lastSavedAt : undefined,
          lastSaveOk: typeof a.lastSaveOk === "boolean" ? a.lastSaveOk : undefined,
          lastSaveStatus: typeof a.lastSaveStatus === "number" ? a.lastSaveStatus : undefined,
          lastSaveError: typeof a.lastSaveError === "string" ? a.lastSaveError : undefined,
          lastSaveTokens: typeof a.lastSaveTokens === "number" ? a.lastSaveTokens : undefined,
        };
      }
      if (typeof v?.baseUrl !== "string" || typeof v?.modelId !== "string") continue;
      pools[key] = {
        poolKey: key,
        baseUrl: normalizeBaseUrl(v.baseUrl),
        modelId: v.modelId,
        contextWindow: typeof v.contextWindow === "number" ? v.contextWindow : undefined,
        assignments,
      };
    }

    return { bases, pools };
  }

  private async persist(): Promise<void> {
    try {
      await mkdir(BASE_DIR, { recursive: true });
      await writeFile(REGISTRY_PATH, JSON.stringify(this.state, null, 2), "utf-8");
    } catch (err) {
      console.warn("[kv-registry] failed to persist:", err);
    }
  }

  async discoverMaxInstances(baseUrl: string): Promise<number> {
    return this.withLock(async () => {
      await this.load();
      return this.discoverMaxInstancesUnlocked(baseUrl);
    });
  }

  private async discoverMaxInstancesUnlocked(baseUrl: string): Promise<number> {
    const baseKey = normalizeBaseUrl(baseUrl);
    const existing = this.state.bases[baseKey];
    if (
      existing?.maxInstances != null &&
      existing.discoveredAt != null &&
      Date.now() - existing.discoveredAt < DISCOVERY_TTL_MS
    ) {
      return existing.maxInstances;
    }

    try {
      const res = await fetch(`${baseKey}/props`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json();
        const maxInstances = typeof data.max_instances === "number" ? Math.max(1, data.max_instances) : 1;
        this.state.bases[baseKey] = { maxInstances, discoveredAt: Date.now() };
        await this.prunePoolsForCapacity(baseKey, maxInstances);
        await this.persist();
        console.log(`[kv-registry] discovered ${maxInstances} slot(s) at ${baseKey}`);
        return maxInstances;
      }
    } catch (err) {
      console.warn("[kv-registry] /props discovery failed:", err);
    }

    this.state.bases[baseKey] = { maxInstances: 1, discoveredAt: Date.now() };
    await this.persist();
    return 1;
  }

  async acquireSlotLease(options: AcquireSlotLeaseOptions): Promise<SlotLeaseRecord> {
    return this.withLock(async () => {
      await this.load();
      const baseUrl = normalizeBaseUrl(options.baseUrl);
      const maxInstances = await this.discoverMaxInstancesUnlocked(baseUrl);
      const poolKey = slotPoolKey(baseUrl, options.modelId, options.contextWindow);

      if (this.hasActiveAssignmentInOtherPool(options.chatId, poolKey)) {
        return {
          chatId: options.chatId,
          baseUrl,
          modelId: options.modelId,
          contextWindow: options.contextWindow,
          poolKey,
          leaseId: options.leaseId,
          slotId: null,
          fileName: options.fileName,
          maxInstances,
          evictedChatId: null,
          disabledReason: "all-slots-active",
        };
      }
      this.releaseInactiveChatFromOtherPools(options.chatId, poolKey);

      if (maxInstances <= 1) {
        return {
          chatId: options.chatId,
          baseUrl,
          modelId: options.modelId,
          contextWindow: options.contextWindow,
          poolKey,
          leaseId: options.leaseId,
          slotId: 0,
          fileName: options.fileName,
          maxInstances,
          evictedChatId: null,
          disabledReason: "single-slot",
        };
      }

      const pool = this.getOrCreatePool(poolKey, baseUrl, options.modelId, options.contextWindow);
      const now = Date.now();
      const existing = pool.assignments[options.chatId];
      if (existing) {
        if (existing.active && existing.leaseId && existing.leaseId !== options.leaseId) {
          await this.persist();
          return {
            chatId: options.chatId,
            baseUrl,
            modelId: options.modelId,
            contextWindow: options.contextWindow,
            poolKey,
            leaseId: options.leaseId,
            slotId: null,
            fileName: options.fileName,
            maxInstances,
            evictedChatId: null,
            disabledReason: "all-slots-active",
          };
        }
        existing.active = true;
        existing.leaseId = options.leaseId;
        existing.lastUsedAt = now;
        existing.fileName = options.fileName;
        await this.persist();
        return {
          chatId: options.chatId,
          baseUrl,
          modelId: options.modelId,
          contextWindow: options.contextWindow,
          poolKey,
          leaseId: options.leaseId,
          slotId: existing.slotId,
          fileName: options.fileName,
          maxInstances,
          evictedChatId: null,
        };
      }

      const usedSlots = new Set(Object.values(pool.assignments).map((a) => a.slotId));
      const freeSlot = this.findFreeSlot(usedSlots, maxInstances);
      if (freeSlot != null) {
        pool.assignments[options.chatId] = {
          chatId: options.chatId,
          slotId: freeSlot,
          fileName: options.fileName,
          lastUsedAt: now,
          active: true,
          leaseId: options.leaseId,
        };
        await this.persist();
        return {
          chatId: options.chatId,
          baseUrl,
          modelId: options.modelId,
          contextWindow: options.contextWindow,
          poolKey,
          leaseId: options.leaseId,
          slotId: freeSlot,
          fileName: options.fileName,
          maxInstances,
          evictedChatId: null,
        };
      }

      const evicted = this.evictInactiveLRU(pool);
      if (!evicted) {
        await this.persist();
        return {
          chatId: options.chatId,
          baseUrl,
          modelId: options.modelId,
          contextWindow: options.contextWindow,
          poolKey,
          leaseId: options.leaseId,
          slotId: null,
          fileName: options.fileName,
          maxInstances,
          evictedChatId: null,
          disabledReason: "all-slots-active",
        };
      }

      pool.assignments[options.chatId] = {
        chatId: options.chatId,
        slotId: evicted.slotId,
        fileName: options.fileName,
        lastUsedAt: now,
        active: true,
        leaseId: options.leaseId,
      };
      await this.persist();
      console.log(
        `[kv-registry] evicted chat ${evicted.chatId.slice(0, 8)}... ` +
        `(pool=${options.modelId}, slot ${evicted.slotId}) for ${options.chatId.slice(0, 8)}...`
      );
      return {
        chatId: options.chatId,
        baseUrl,
        modelId: options.modelId,
        contextWindow: options.contextWindow,
        poolKey,
        leaseId: options.leaseId,
        slotId: evicted.slotId,
        fileName: options.fileName,
        maxInstances,
        evictedChatId: evicted.chatId,
      };
    });
  }

  async releaseLease(lease: SlotLeaseRecord): Promise<void> {
    if (lease.slotId == null) return;
    await this.withLock(async () => {
      await this.load();
      const assignment = this.state.pools[lease.poolKey]?.assignments[lease.chatId];
      if (!assignment || assignment.leaseId !== lease.leaseId) return;
      assignment.active = false;
      delete assignment.leaseId;
      assignment.lastUsedAt = Date.now();
      await this.persist();
    });
  }

  async releaseChat(chatId: string): Promise<void> {
    await this.withLock(async () => {
      await this.load();
      for (const pool of Object.values(this.state.pools)) {
        delete pool.assignments[chatId];
      }
      await this.persist();
    });
  }

  async markRestore(lease: SlotLeaseRecord, result: boolean | SlotActionRecord): Promise<void> {
    await this.markLeaseResult(lease, "restore", result);
  }

  async markSave(lease: SlotLeaseRecord, result: boolean | SlotActionRecord): Promise<void> {
    await this.markLeaseResult(lease, "save", result);
  }

  async clear(): Promise<void> {
    await this.withLock(async () => {
      await this.load();
      this.state.pools = {};
      await this.persist();
    });
  }

  async getPools(): Promise<Record<string, SlotPool>> {
    return this.withLock(async () => {
      await this.load();
      return JSON.parse(JSON.stringify(this.state.pools)) as Record<string, SlotPool>;
    });
  }

  private getOrCreatePool(poolKey: string, baseUrl: string, modelId: string, contextWindow?: number): SlotPool {
    const existing = this.state.pools[poolKey];
    if (existing) return existing;
    const pool: SlotPool = {
      poolKey,
      baseUrl,
      modelId,
      contextWindow,
      assignments: {},
    };
    this.state.pools[poolKey] = pool;
    return pool;
  }

  private hasActiveAssignmentInOtherPool(chatId: string, keepPoolKey: string): boolean {
    for (const [poolKey, pool] of Object.entries(this.state.pools)) {
      if (poolKey === keepPoolKey) continue;
      if (pool.assignments[chatId]?.active) return true;
    }
    return false;
  }

  private releaseInactiveChatFromOtherPools(chatId: string, keepPoolKey: string): void {
    for (const [poolKey, pool] of Object.entries(this.state.pools)) {
      if (poolKey === keepPoolKey) continue;
      if (!pool.assignments[chatId]?.active) delete pool.assignments[chatId];
    }
  }

  private async prunePoolsForCapacity(baseUrl: string, maxInstances: number): Promise<void> {
    for (const pool of Object.values(this.state.pools)) {
      if (pool.baseUrl !== baseUrl) continue;
      for (const [chatId, assignment] of Object.entries(pool.assignments)) {
        if (assignment.slotId >= maxInstances) delete pool.assignments[chatId];
      }
    }
  }

  private findFreeSlot(usedSlots: Set<number>, maxInstances: number): number | null {
    for (let i = 0; i < maxInstances; i++) {
      if (!usedSlots.has(i)) return i;
    }
    return null;
  }

  private evictInactiveLRU(pool: SlotPool): { chatId: string; slotId: number } | null {
    let lruChatId: string | null = null;
    let lruTime = Infinity;

    for (const [chatId, assignment] of Object.entries(pool.assignments)) {
      if (assignment.active) continue;
      if (assignment.lastUsedAt < lruTime) {
        lruTime = assignment.lastUsedAt;
        lruChatId = chatId;
      }
    }

    if (lruChatId == null) return null;
    const slotId = pool.assignments[lruChatId].slotId;
    delete pool.assignments[lruChatId];
    return { chatId: lruChatId, slotId };
  }

  private async markLeaseResult(
    lease: SlotLeaseRecord,
    kind: "restore" | "save",
    result: boolean | SlotActionRecord,
  ): Promise<void> {
    if (lease.slotId == null) return;
    await this.withLock(async () => {
      await this.load();
      const assignment = this.state.pools[lease.poolKey]?.assignments[lease.chatId];
      if (!assignment || assignment.leaseId !== lease.leaseId) return;
      const record: SlotActionRecord = typeof result === "boolean" ? { ok: result } : result;
      const now = Date.now();
      if (kind === "restore") {
        assignment.lastRestoredAt = now;
        assignment.lastRestoreOk = record.ok;
        assignment.lastRestoreStatus = record.status;
        assignment.lastRestoreError = record.error;
        assignment.lastRestoreTokens = record.tokens;
      } else {
        assignment.lastSavedAt = now;
        assignment.lastSaveOk = record.ok;
        assignment.lastSaveStatus = record.status;
        assignment.lastSaveError = record.error;
        assignment.lastSaveTokens = record.tokens;
      }
      await this.persist();
    });
  }
}

export const slotRegistry = new SlotRegistry();
