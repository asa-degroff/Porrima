import { randomUUID } from "crypto";
import { mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

const BASE_DIR = join(homedir(), ".quje-agent");
const STATE_PATH = join(BASE_DIR, "llama-slot-bindings.json");
const DISCOVERY_TTL_MS = 5 * 60 * 1000;

export interface LlamaSlotLease {
  chatId: string;
  leaseId: string;
  baseUrl: string;
  modelId: string;
  contextWindow?: number;
  poolKey: string;
  slotId: number;
  maxInstances: number;
  evictedChatId?: string | null;
}

interface SlotAssignment {
  chatId: string;
  slotId: number;
  lastUsedAt: number;
  activeLeaseId?: string;
}

interface SlotPool {
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

interface SlotLeaseState {
  bases: Record<string, BaseDiscovery>;
  pools: Record<string, SlotPool>;
}

export interface AcquireLlamaSlotLeaseOptions {
  baseUrl: string;
  chatId: string;
  modelId: string;
  contextWindow?: number;
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function poolKey(baseUrl: string, modelId: string, contextWindow?: number): string {
  return JSON.stringify([normalizeBaseUrl(baseUrl), modelId, contextWindow ?? null]);
}

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}...` : id;
}

function slotBindingEnabled(): boolean {
  return process.env.LLAMACPP_ID_SLOT !== "0";
}

class LlamaSlotLeaseStore {
  private state: SlotLeaseState = { bases: {}, pools: {} };
  private loaded = false;
  private lock: Promise<void> = Promise.resolve();

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.lock;
    let release!: () => void;
    this.lock = previous.then(() => new Promise<void>((resolve) => { release = resolve; }));
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    try {
      const raw = await readFile(STATE_PATH, "utf-8");
      this.state = this.normalizeState(JSON.parse(raw));
    } catch {
      this.state = { bases: {}, pools: {} };
    }
    this.loaded = true;
  }

  private normalizeState(parsed: any): SlotLeaseState {
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
      if (typeof v?.baseUrl !== "string" || typeof v?.modelId !== "string") continue;
      const assignments: Record<string, SlotAssignment> = {};
      for (const [chatId, assignment] of Object.entries(v?.assignments ?? {})) {
        const a = assignment as any;
        if (typeof a?.slotId !== "number") continue;
        assignments[chatId] = {
          chatId,
          slotId: Math.max(0, Math.floor(a.slotId)),
          lastUsedAt: typeof a.lastUsedAt === "number" ? a.lastUsedAt : 0,
        };
      }
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
      await writeFile(STATE_PATH, JSON.stringify(this.serializeState(), null, 2), "utf-8");
    } catch (err) {
      console.warn("[llama-slot] failed to persist bindings:", err instanceof Error ? err.message : err);
    }
  }

  private serializeState(): SlotLeaseState {
    const pools: Record<string, SlotPool> = {};
    for (const [key, pool] of Object.entries(this.state.pools)) {
      const assignments: Record<string, SlotAssignment> = {};
      for (const [chatId, assignment] of Object.entries(pool.assignments)) {
        assignments[chatId] = {
          chatId,
          slotId: assignment.slotId,
          lastUsedAt: assignment.lastUsedAt,
        };
      }
      pools[key] = { ...pool, assignments };
    }
    return { bases: this.state.bases, pools };
  }

  async acquire(options: AcquireLlamaSlotLeaseOptions): Promise<LlamaSlotLease | null> {
    if (!slotBindingEnabled()) return null;

    return this.withLock(async () => {
      await this.load();
      const baseUrl = normalizeBaseUrl(options.baseUrl);
      const maxInstances = await this.discoverMaxInstancesUnlocked(baseUrl);
      if (maxInstances <= 0) return null;

      const key = poolKey(baseUrl, options.modelId, options.contextWindow);
      if (this.hasActiveChatLeaseInOtherPool(options.chatId, key)) {
        console.warn(
          `[llama-slot] chat=${shortId(options.chatId)} already has an active lease in another model pool; using automatic slot selection`,
        );
        return null;
      }
      this.dropInactiveChatAssignmentsInOtherPools(options.chatId, key);

      const pool = this.getOrCreatePool(key, baseUrl, options.modelId, options.contextWindow);
      this.prunePoolForCapacity(pool, maxInstances);

      const leaseId = randomUUID();
      const existing = pool.assignments[options.chatId];
      if (existing) {
        if (existing.activeLeaseId && existing.activeLeaseId !== leaseId) {
          console.warn(
            `[llama-slot] chat=${shortId(options.chatId)} already has active slot=${existing.slotId}; using automatic slot selection`,
          );
          return null;
        }
        existing.activeLeaseId = leaseId;
        existing.lastUsedAt = Date.now();
        await this.persist();
        console.log(
          `[llama-slot] acquired chat=${shortId(options.chatId)} model=${options.modelId} slot=${existing.slotId}/${maxInstances}`,
        );
        return this.toLease(options.chatId, leaseId, pool, existing.slotId, maxInstances, null);
      }

      const activeSlots = this.activeSlotsForBase(baseUrl);
      const usedInPool = new Set(Object.values(pool.assignments).map((assignment) => assignment.slotId));
      const freeSlot = this.findFreeSlot(maxInstances, usedInPool, activeSlots);
      if (freeSlot != null) {
        this.dropInactiveAssignmentsForSlot(baseUrl, key, freeSlot);
        pool.assignments[options.chatId] = {
          chatId: options.chatId,
          slotId: freeSlot,
          lastUsedAt: Date.now(),
          activeLeaseId: leaseId,
        };
        await this.persist();
        console.log(
          `[llama-slot] acquired chat=${shortId(options.chatId)} model=${options.modelId} slot=${freeSlot}/${maxInstances}`,
        );
        return this.toLease(options.chatId, leaseId, pool, freeSlot, maxInstances, null);
      }

      const evicted = this.evictInactiveLRU(pool);
      if (!evicted) {
        console.warn(
          `[llama-slot] no free inactive slot for chat=${shortId(options.chatId)} model=${options.modelId}; using automatic slot selection`,
        );
        await this.persist();
        return null;
      }

      pool.assignments[options.chatId] = {
        chatId: options.chatId,
        slotId: evicted.slotId,
        lastUsedAt: Date.now(),
        activeLeaseId: leaseId,
      };
      await this.persist();
      console.log(
        `[llama-slot] evicted chat=${shortId(evicted.chatId)} slot=${evicted.slotId} for chat=${shortId(options.chatId)} model=${options.modelId}`,
      );
      return this.toLease(options.chatId, leaseId, pool, evicted.slotId, maxInstances, evicted.chatId);
    });
  }

  async release(lease: LlamaSlotLease | null | undefined): Promise<void> {
    if (!lease) return;
    await this.withLock(async () => {
      await this.load();
      const assignment = this.state.pools[lease.poolKey]?.assignments[lease.chatId];
      if (!assignment || assignment.activeLeaseId !== lease.leaseId) return;
      delete assignment.activeLeaseId;
      assignment.lastUsedAt = Date.now();
      await this.persist();
      console.log(`[llama-slot] released chat=${shortId(lease.chatId)} slot=${lease.slotId}`);
    });
  }

  private async discoverMaxInstancesUnlocked(baseUrl: string): Promise<number> {
    const existing = this.state.bases[baseUrl];
    if (
      existing?.maxInstances != null &&
      existing.discoveredAt != null &&
      Date.now() - existing.discoveredAt < DISCOVERY_TTL_MS
    ) {
      return Math.max(1, existing.maxInstances);
    }

    let maxInstances = 1;
    try {
      const res = await fetch(`${baseUrl}/props`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json();
        if (typeof data?.max_instances === "number" && Number.isFinite(data.max_instances)) {
          maxInstances = Math.max(1, Math.floor(data.max_instances));
        }
      }
    } catch (err) {
      console.warn("[llama-slot] /props discovery failed:", err instanceof Error ? err.message : err);
    }

    this.state.bases[baseUrl] = { maxInstances, discoveredAt: Date.now() };
    await this.persist();
    return maxInstances;
  }

  private getOrCreatePool(poolKeyValue: string, baseUrl: string, modelId: string, contextWindow?: number): SlotPool {
    const existing = this.state.pools[poolKeyValue];
    if (existing) return existing;
    const pool: SlotPool = {
      poolKey: poolKeyValue,
      baseUrl,
      modelId,
      contextWindow,
      assignments: {},
    };
    this.state.pools[poolKeyValue] = pool;
    return pool;
  }

  private prunePoolForCapacity(pool: SlotPool, maxInstances: number): void {
    for (const [chatId, assignment] of Object.entries(pool.assignments)) {
      if (assignment.slotId >= maxInstances) delete pool.assignments[chatId];
    }
  }

  private hasActiveChatLeaseInOtherPool(chatId: string, currentPoolKey: string): boolean {
    return Object.entries(this.state.pools).some(([key, pool]) =>
      key !== currentPoolKey && !!pool.assignments[chatId]?.activeLeaseId
    );
  }

  private dropInactiveChatAssignmentsInOtherPools(chatId: string, currentPoolKey: string): void {
    for (const [key, pool] of Object.entries(this.state.pools)) {
      if (key === currentPoolKey) continue;
      const assignment = pool.assignments[chatId];
      if (assignment && !assignment.activeLeaseId) delete pool.assignments[chatId];
    }
  }

  private activeSlotsForBase(baseUrl: string): Set<number> {
    const active = new Set<number>();
    for (const pool of Object.values(this.state.pools)) {
      if (pool.baseUrl !== baseUrl) continue;
      for (const assignment of Object.values(pool.assignments)) {
        if (assignment.activeLeaseId) active.add(assignment.slotId);
      }
    }
    return active;
  }

  private findFreeSlot(maxInstances: number, usedInPool: Set<number>, activeSlots: Set<number>): number | null {
    for (let slotId = 0; slotId < maxInstances; slotId++) {
      if (!usedInPool.has(slotId) && !activeSlots.has(slotId)) return slotId;
    }
    return null;
  }

  private dropInactiveAssignmentsForSlot(baseUrl: string, currentPoolKey: string, slotId: number): void {
    for (const [key, pool] of Object.entries(this.state.pools)) {
      if (key === currentPoolKey || pool.baseUrl !== baseUrl) continue;
      for (const [chatId, assignment] of Object.entries(pool.assignments)) {
        if (assignment.slotId === slotId && !assignment.activeLeaseId) {
          delete pool.assignments[chatId];
        }
      }
    }
  }

  private evictInactiveLRU(pool: SlotPool): { chatId: string; slotId: number } | null {
    let lruChatId: string | null = null;
    let lruTime = Infinity;
    for (const [chatId, assignment] of Object.entries(pool.assignments)) {
      if (assignment.activeLeaseId) continue;
      if (assignment.lastUsedAt < lruTime) {
        lruTime = assignment.lastUsedAt;
        lruChatId = chatId;
      }
    }
    if (!lruChatId) return null;
    const slotId = pool.assignments[lruChatId].slotId;
    delete pool.assignments[lruChatId];
    return { chatId: lruChatId, slotId };
  }

  private toLease(
    chatId: string,
    leaseId: string,
    pool: SlotPool,
    slotId: number,
    maxInstances: number,
    evictedChatId: string | null,
  ): LlamaSlotLease {
    return {
      chatId,
      leaseId,
      baseUrl: pool.baseUrl,
      modelId: pool.modelId,
      contextWindow: pool.contextWindow,
      poolKey: pool.poolKey,
      slotId,
      maxInstances,
      evictedChatId,
    };
  }
}

const store = new LlamaSlotLeaseStore();

export function acquireLlamaSlotLease(options: AcquireLlamaSlotLeaseOptions): Promise<LlamaSlotLease | null> {
  return store.acquire(options);
}

export function releaseLlamaSlotLease(lease: LlamaSlotLease | null | undefined): Promise<void> {
  return store.release(lease);
}
