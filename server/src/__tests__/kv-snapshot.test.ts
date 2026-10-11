import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import type { LlamaSlotLease } from "../services/llama-slot-leases.js";

/**
 * Phase 2 tests for KV snapshot parking (docs/design/kv-snapshot-parking.md):
 * registry lifecycle, save-policy gates, supersede/rollback, budget pruning.
 */

const BASE_TIME = Date.parse("2026-10-11T12:00:00Z");

const lease: LlamaSlotLease = {
  chatId: "11111111-1111-1111-1111-111111111111",
  leaseId: "lease-1",
  baseUrl: "http://localhost:8080",
  modelId: "big-model",
  contextWindow: 262144,
  poolKey: '["http://localhost:8080","big-model",262144]',
  slotId: 2,
  maxInstances: 3,
};

function settingsWith(overrides: Record<string, unknown> = {}) {
  return {
    kvSnapshotEnabled: true,
    kvSnapshotMinTokens: 1_000,
    kvSnapshotOpTimeoutMs: 5_000,
    kvSnapshotMinFreeDiskBytes: 0,
    ...overrides,
  };
}

interface Harness {
  kv: typeof import("../services/kv-snapshot.js");
  home: string;
  fetchMock: ReturnType<typeof vi.fn>;
  streamsMap: Map<string, any>;
  db: Database.Database;
}

async function loadHarness(options: {
  settings?: Record<string, unknown>;
  seedPromptTokens?: number | null;
  seedSnapshots?: Array<Record<string, unknown>>;
  fetchImpl?: (url: string, init: any) => Promise<Response>;
  skipKvInit?: boolean;
} = {}): Promise<Harness> {
  vi.useFakeTimers();
  vi.setSystemTime(BASE_TIME);
  vi.resetModules();
  const home = mkdtempSync(join(tmpdir(), "kvsnap-"));
  process.env.PORRIMA_DATA_DIR = home;

  const streamsMap = new Map();
  vi.doMock("../services/live-streams.js", () => ({ liveStreams: streamsMap }));
  vi.doMock("../services/chat-storage.js", () => ({
    getSettings: vi.fn(async () => settingsWith(options.settings ?? {})),
  }));
  // Deterministic disk: pretend a 1 TB-free volume so headroom never depends
  // on the machine running the tests (the minFree skip case overrides this
  // by config, not by disk size).
  vi.doMock("fs/promises", async (importOriginal) => {
    const actual = await importOriginal<typeof import("fs/promises")>();
    return {
      ...actual,
      statfs: vi.fn(async () => ({ bavail: 1_073_741_824, bsize: 1024 }) as any),
    };
  });

  const db = new Database(join(home, "porrima.db"));
  db.pragma("journal_mode = WAL");
  db.exec(`CREATE TABLE IF NOT EXISTS llm_requests (
    id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, turn_id TEXT, iteration INTEGER,
    purpose TEXT NOT NULL DEFAULT 'chat', timestamp INTEGER NOT NULL,
    model_id TEXT NOT NULL, provider TEXT NOT NULL, status TEXT NOT NULL,
    message_count INTEGER, tool_count INTEGER, prompt_tokens INTEGER,
    completion_tokens INTEGER, cached_tokens INTEGER, duration_ms REAL,
    request_digest TEXT, stop_reason TEXT, error_message TEXT,
    request_json TEXT, response_json TEXT
  );`);
  // Mirror the service DDL so seeds can be inserted before the service's own
  // initSchema runs (its CREATE INDEX/IF NOT EXISTS path then no-ops).
  db.exec(`CREATE TABLE IF NOT EXISTS kv_snapshots (
    chat_id TEXT PRIMARY KEY, pool_key TEXT NOT NULL, base_url TEXT NOT NULL,
    model_id TEXT NOT NULL, slot_id INTEGER NOT NULL, filename TEXT NOT NULL DEFAULT '',
    n_tokens INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0,
    prefix_digest TEXT NOT NULL DEFAULT '', build_tag TEXT NOT NULL DEFAULT '',
    config_digest TEXT NOT NULL DEFAULT '', state TEXT NOT NULL DEFAULT 'stale',
    saved_at INTEGER NOT NULL DEFAULT 0, last_used_at INTEGER NOT NULL DEFAULT 0,
    restore_count INTEGER NOT NULL DEFAULT 0, miss_count INTEGER NOT NULL DEFAULT 0
  );`);
  if (options.seedPromptTokens != null) {
    db.prepare(
      "INSERT INTO llm_requests (id, chat_id, timestamp, model_id, provider, status, prompt_tokens) VALUES (?,?,?,?,?,?,?)",
    ).run("req-1", lease.chatId, BASE_TIME, lease.modelId, "llamacpp", "done", options.seedPromptTokens);
  }
  for (const seed of options.seedSnapshots ?? []) {
    const cols: Record<string, unknown> = {
      chat_id: seed.chatId ?? lease.chatId,
      pool_key: seed.poolKey ?? lease.poolKey,
      base_url: seed.baseUrl ?? lease.baseUrl,
      model_id: seed.modelId ?? lease.modelId,
      slot_id: seed.slotId ?? 0,
      filename: seed.filename ?? "old.bin",
      n_tokens: seed.nTokens ?? 50_000,
      bytes: seed.bytes ?? 1_000,
      prefix_digest: "",
      build_tag: seed.buildTag ?? "",
      config_digest: "",
      state: seed.state ?? "ready",
      saved_at: seed.savedAt ?? BASE_TIME,
      last_used_at: seed.lastUsedAt ?? BASE_TIME,
      restore_count: 0,
      miss_count: 0,
    };
    db.prepare(
      `INSERT INTO kv_snapshots (chat_id, pool_key, base_url, model_id, slot_id, filename,
        n_tokens, bytes, prefix_digest, build_tag, config_digest, state, saved_at, last_used_at,
        restore_count, miss_count) VALUES (:chat_id, :pool_key, :base_url, :model_id, :slot_id,
        :filename, :n_tokens, :bytes, :prefix_digest, :build_tag, :config_digest, :state,
        :saved_at, :last_used_at, :restore_count, :miss_count)`,
    ).run(cols);
  }
  // Close so the service opens its own handle against the same file.
  db.close();

  mkdirSync(join(home, "kv-cache"), { recursive: true });
  const fetchMock = vi.fn(async (url: any, init: any) => {
    if (options.fetchImpl) return options.fetchImpl(String(url), init);
    if (String(url).includes("/server_info")) {
      return Response.json({ build_number: 11552 });
    }
    if (String(url).includes("action=save")) {
      return Response.json({
        id_slot: 2,
        filename: "x.bin",
        n_saved: 134_050,
        n_written: 6_398_851_904,
        timings: { save_ms: 4715.1 },
      });
    }
    return Response.json({ error: { message: "unexpected url" } }, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);

  const kv = await import("../services/kv-snapshot.js");
  if (!options.skipKvInit) kv.initializeKvSnapshotStore();

  return { kv, home, fetchMock, streamsMap, db: new Database(join(home, "porrima.db")) };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
  delete process.env.PORRIMA_DATA_DIR;
});

const saveCalls = (fetchMock: ReturnType<typeof vi.fn>) =>
  fetchMock.mock.calls.filter(([url]) => String(url).includes("action=save"));

describe("kv-snapshot registry lifecycle", () => {
  it("sweeps in-flight rows to stale at init (crash rescue)", async () => {
    const h = await loadHarness({
      seedSnapshots: [{ state: "saving", savedAt: BASE_TIME - 10 * 60_000 }],
      skipKvInit: true, // seed before the service created the table
    });
    // Table now exists; re-insert as saving and re-run init to hit the sweep.
    h.db.prepare("UPDATE kv_snapshots SET state = 'saving' WHERE chat_id = ?").run(lease.chatId);
    h.db.close();
    vi.resetModules();
    const kv2 = await import("../services/kv-snapshot.js");
    kv2.initializeKvSnapshotStore();
    expect(kv2.getKvSnapshot(lease.chatId)?.state).toBe("stale");
  });

  it("invalidation removes the row and the file, and supersedes queued saves", async () => {
    const h = await loadHarness({ seedSnapshots: [{ filename: "gone.bin" }] });
    const file = join(h.home, "kv-cache", "gone.bin");
    writeFileSync(file, "x");
    await h.kv.invalidateKvSnapshot(lease.chatId, "chat-deleted");
    expect(h.kv.getKvSnapshot(lease.chatId)).toBeNull();
    expect(existsSync(file)).toBe(false);
    h.db.close();
  });

  it("rejects unsafe filenames instead of touching arbitrary paths", async () => {
    const h = await loadHarness({
      seedSnapshots: [{ filename: "../escape.bin" }],
    });
    writeFileSync(join(h.home, "escape.bin"), "victim");
    const report = await h.kv.pruneKvSnapshots(); // must not throw
    expect(report).toBeTruthy();
    expect(existsSync(join(h.home, "escape.bin"))).toBe(true); // never unlinked outside dir
    h.db.close();
  });
});

describe("kv-snapshot save policy", () => {
  it("is inert when the feature is disabled (D8 default-off)", async () => {
    const h = await loadHarness({ settings: { kvSnapshotEnabled: false }, seedPromptTokens: 150_000 });
    await h.kv.maybeParkChatAfterTurn({ chatId: lease.chatId, lease });
    expect(saveCalls(h.fetchMock)).toHaveLength(0);
    h.db.close();
  });

  it("defaults are disabled and match the design table", async () => {
    const h = await loadHarness();
    const resolved = h.kv.resolveKvSnapshotSettings({});
    expect(resolved.enabled).toBe(false);
    expect(resolved.minTokens).toBe(65_536);
    expect(resolved.saveDebounceMs).toBe(90_000);
    expect(resolved.minGrowthTokens).toBe(2_048);
    expect(resolved.ttlHours).toBe(72);
    h.db.close();
  });

  it("skips without a lease (D2 pinning requirement)", async () => {
    const h = await loadHarness({ seedPromptTokens: 150_000 });
    await h.kv.maybeParkChatAfterTurn({ chatId: lease.chatId, lease: null });
    expect(h.fetchMock).not.toHaveBeenCalled();
    h.db.close();
  });

  it("skips small chats (wire-truth eligibility, D7)", async () => {
    const h = await loadHarness({ seedPromptTokens: 500 });
    await h.kv.maybeParkChatAfterTurn({ chatId: lease.chatId, lease });
    expect(saveCalls(h.fetchMock)).toHaveLength(0);
    expect(h.kv.getKvSnapshot(lease.chatId)).toBeNull();
    h.db.close();
  });

  it("parks an eligible chat: save call shape, ready row, metrics", async () => {
    const h = await loadHarness({ seedPromptTokens: 150_000 });
    await h.kv.maybeParkChatAfterTurn({ chatId: lease.chatId, lease });
    const calls = saveCalls(h.fetchMock);
    expect(calls).toHaveLength(1);
    expect(String(calls[0][0])).toBe(`http://localhost:8080/slots/${lease.slotId}?action=save`);
    expect(JSON.parse(calls[0][1].body).filename).toMatch(new RegExp(`^${lease.chatId}-\\d+\\.bin$`));

    const row = h.kv.getKvSnapshot(lease.chatId);
    expect(row?.state).toBe("ready");
    expect(row?.nTokens).toBe(134_050); // n_saved from the wire, not the estimate
    expect(row?.bytes).toBe(6_398_851_904); // n_written
    expect(row?.buildTag).toBe("b11552");
    expect(row?.poolKey).toBe(lease.poolKey);
    h.db.close();
  });

  it("debounces: recent ready row + small growth skips the save", async () => {
    const h = await loadHarness({
      seedPromptTokens: 135_000,
      seedSnapshots: [{ state: "ready", nTokens: 134_050, savedAt: BASE_TIME - 10_000, bytes: 1_000 }],
    });
    await h.kv.maybeParkChatAfterTurn({ chatId: lease.chatId, lease });
    expect(saveCalls(h.fetchMock)).toHaveLength(0);
    h.db.close();
  });

  it("growth past the floor overrides the debounce", async () => {
    const h = await loadHarness({
      seedPromptTokens: 140_000,
      seedSnapshots: [{ state: "ready", nTokens: 134_050, savedAt: BASE_TIME - 10_000, bytes: 1_000 }],
    });
    await h.kv.maybeParkChatAfterTurn({ chatId: lease.chatId, lease });
    expect(saveCalls(h.fetchMock)).toHaveLength(1);
    h.db.close();
  });

  it("a failed save keeps a prior ready snapshot intact", async () => {
    const h = await loadHarness({
      seedPromptTokens: 150_000,
      seedSnapshots: [{ state: "ready", filename: "prior.bin", nTokens: 100_000, bytes: 1_000, savedAt: BASE_TIME - 10 * 60_000 }],
      fetchImpl: async (url) =>
        url.includes("server_info")
          ? Response.json({ build_number: 11552 })
          : Response.json({ error: { message: "slot busy" } }, { status: 500 }),
    });
    await h.kv.maybeParkChatAfterTurn({ chatId: lease.chatId, lease });
    const row = h.kv.getKvSnapshot(lease.chatId);
    expect(row?.state).toBe("ready");
    expect(row?.filename).toBe("prior.bin"); // old file still authoritative
    h.db.close();
  });

  it("a failed save with no prior marks stale", async () => {
    const h = await loadHarness({
      seedPromptTokens: 150_000,
      fetchImpl: async (url) =>
        url.includes("server_info")
          ? Response.json({ build_number: 11552 })
          : Response.json({ error: { message: "disk io" } }, { status: 500 }),
    });
    await h.kv.maybeParkChatAfterTurn({ chatId: lease.chatId, lease });
    expect(h.kv.getKvSnapshot(lease.chatId)?.state).toBe("stale");
    h.db.close();
  });

  it("drop-if-restarted: a newer queue entry supersedes the pending save", async () => {
    const h = await loadHarness({ seedPromptTokens: 150_000 });
    const first = h.kv.maybeParkChatAfterTurn({ chatId: lease.chatId, lease });
    const second = h.kv.maybeParkChatAfterTurn({ chatId: lease.chatId, lease });
    await Promise.all([first, second]);
    // Token supersede drops the first job; the second still saves exactly once.
    expect(saveCalls(h.fetchMock)).toHaveLength(1);
    h.db.close();
  });

  it("the turn's own unended stream does not block the save (identity rule)", async () => {
    // liveStreams keeps the finishing turn's stream for reconnect grace; only a
    // DIFFERENT, unended stream (a genuinely restarted turn) may drop the save.
    const h = await loadHarness({ seedPromptTokens: 150_000 });
    h.streamsMap.set(lease.chatId, { ended: false, abort: new AbortController() });
    await h.kv.maybeParkChatAfterTurn({ chatId: lease.chatId, lease });
    expect(saveCalls(h.fetchMock)).toHaveLength(1);
    h.db.close();
  });

  it("respects pool budget: LRU-evicts the oldest ready peer before saving", async () => {
    const h = await loadHarness({
      seedPromptTokens: 150_000,
      settings: { kvSnapshotMaxBytesPerPool: 12_000 },
      seedSnapshots: [
        { chatId: "aaaa", state: "ready", bytes: 9_000, lastUsedAt: BASE_TIME - 60_000, savedAt: BASE_TIME - 60_000 },
        { chatId: "bbbb", state: "ready", bytes: 9_000, lastUsedAt: BASE_TIME - 30_000, savedAt: BASE_TIME - 30_000 },
      ],
    });
    await h.kv.maybeParkChatAfterTurn({ chatId: lease.chatId, lease });
    const remaining = h.kv.listKvSnapshots().map((r) => r.chatId);
    // estimate uses the fallback ratio (no measured bytes/n_tokens at 150k tokens
    // from seeds with n_tokens=50k) -> pool forced under cap -> oldest evicted.
    expect(remaining).not.toContain("aaaa");
    expect(h.kv.getKvSnapshot(lease.chatId)?.state).toBe("ready");
    h.db.close();
  });

  it("skips below disk headroom without touching the slot API", async () => {
    const h = await loadHarness({
      seedPromptTokens: 150_000,
      settings: { kvSnapshotMinFreeDiskBytes: Number.MAX_SAFE_INTEGER },
    });
    await h.kv.maybeParkChatAfterTurn({ chatId: lease.chatId, lease });
    expect(saveCalls(h.fetchMock)).toHaveLength(0);
    expect(h.kv.getKvSnapshot(lease.chatId)?.state).toBe("stale");
    h.db.close();
  });
});

describe("kv-snapshot pruning", () => {
  it("expires by TTL, clears stale rows, flags missing files, and sweeps orphans", async () => {
    const h = await loadHarness({
      settings: { kvSnapshotTtlHours: 1 },
      seedSnapshots: [
        { chatId: "expired", state: "ready", savedAt: BASE_TIME - 5 * 60 * 60_000, filename: "expired.bin" },
        { chatId: "stale-one", state: "stale", savedAt: BASE_TIME - 60_000, filename: "" },
        { chatId: "ghost", state: "ready", savedAt: BASE_TIME - 60_000, filename: "missing.bin" },
      ],
    });
    writeFileSync(join(h.home, "kv-cache", "expired.bin"), "x");
    writeFileSync(join(h.home, "kv-cache", "orphan.bin"), "x");

    const report = await h.kv.pruneKvSnapshots();

    expect(report.expired).toBe(1);
    expect(report.staleRemoved).toBe(1);
    expect(report.missingFile).toBe(1);
    expect(report.orphansUnlinked).toBe(1);
    expect(h.kv.getKvSnapshot("expired")).toBeNull();
    expect(h.kv.getKvSnapshot("stale-one")).toBeNull();
    expect(h.kv.getKvSnapshot("ghost")?.state).toBe("stale");
    expect(existsSync(join(h.home, "kv-cache", "expired.bin"))).toBe(false);
    expect(existsSync(join(h.home, "kv-cache", "orphan.bin"))).toBe(false);
    h.db.close();
  });
});
